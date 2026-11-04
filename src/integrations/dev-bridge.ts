import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import type { DrawDocument } from "../document/document";
import { validateDrawDocument } from "../document/document";
import type { McpCommand } from "./mcp-contract";
import { parseMcpToolInput } from "./mcp-contract";

export type DrawDocumentBridgeValue = DrawDocument;

type BridgeAck = {
  id: string;
  clientId: string;
  document?: DrawDocumentBridgeValue;
  result?: unknown;
  error?: string;
};

type PendingCommand = {
  clientId: string;
  resolve: (ack: BridgeAck) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type DrawMcpBridgeOptions = {
  commandTimeoutMs?: number;
  maxBodyBytes?: number;
};

const API_ROOT = "/__draw/api";
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function isDrawDocument(value: unknown): value is DrawDocumentBridgeValue {
  try {
    validateDrawDocument(value);
    return true;
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) throw new Error(`Request body exceeds ${maxBodyBytes} bytes.`);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
}

function asMcpCommand(body: unknown): McpCommand {
  if (!isRecord(body) || typeof body.operation !== "string") throw new Error("Command must include an operation.");
  return parseMcpToolInput(body.operation, body.input);
}

export function createDrawMcpPlugin(options: DrawMcpBridgeOptions = {}): Plugin {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const pending = new Map<string, PendingCommand>();
  let document: DrawDocumentBridgeValue | null = null;
  let activeClientId: string | null = null;
  let commandSequence = 0;

  return {
    name: "draw-local-mcp-bridge",
    configureServer(server: ViteDevServer) {
      const respond = async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
        const path = requestPath(request);
        if (!path.startsWith(API_ROOT)) return next();

        if (!isLoopbackAddress(request.socket.remoteAddress)) {
          sendJson(response, 403, { error: "Draw MCP bridge accepts loopback requests only." });
          return;
        }

        const origin = request.headers.origin;
        const host = request.headers.host;
        if (typeof origin === "string" && (!host || origin !== `http://${host}`)) {
          sendJson(response, 403, { error: "Draw MCP bridge accepts same-origin browser requests only." });
          return;
        }
        if (["PUT", "POST", "PATCH", "DELETE"].includes(request.method ?? "")) {
          const contentType = request.headers["content-type"];
          if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
            sendJson(response, 415, { error: "Draw MCP bridge mutations require application/json." });
            return;
          }
        }

        try {
          if (request.method === "GET" && path === `${API_ROOT}/health`) {
            sendJson(response, 200, { ok: true, documentReady: document !== null, clientReady: activeClientId !== null });
            return;
          }

          if (request.method === "PUT" && path === `${API_ROOT}/client`) {
            const body = await readJsonBody(request, maxBodyBytes);
            if (!isRecord(body) || typeof body.clientId !== "string" || body.clientId.length < 1 || body.clientId.length > 200) {
              sendJson(response, 400, { error: "clientId must be a non-empty string of at most 200 characters." });
              return;
            }
            activeClientId = body.clientId;
            sendJson(response, 200, { ok: true, clientId: activeClientId });
            return;
          }

          if (request.method === "PUT" && path === `${API_ROOT}/document`) {
            const body = await readJsonBody(request, maxBodyBytes);
            if (!isDrawDocument(body)) {
              sendJson(response, 400, { error: "Body must be a valid Draw document (format draw, version 1)." });
              return;
            }
            document = body;
            sendJson(response, 200, { ok: true, documentId: document.document.id });
            return;
          }

          if (request.method === "GET" && path === `${API_ROOT}/document`) {
            if (!document) {
              sendJson(response, 404, { error: "No Draw document is open in the app." });
              return;
            }
            sendJson(response, 200, document);
            return;
          }

          if (request.method === "POST" && path === `${API_ROOT}/commands`) {
            const body = await readJsonBody(request, maxBodyBytes);
            const command = asMcpCommand(body);
            if (!document) {
              sendJson(response, 409, { error: "Open a Draw document in the app before using MCP tools." });
              return;
            }
            if (!activeClientId) {
              sendJson(response, 409, { error: "No Draw canvas is connected to the MCP bridge." });
              return;
            }

            commandSequence += 1;
            const id = `draw-command-${Date.now().toString(36)}-${commandSequence.toString(36)}`;
            const clientId = activeClientId;
            const ackPromise = new Promise<BridgeAck>((resolve, reject) => {
              const timeout = setTimeout(() => {
                pending.delete(id);
                reject(new Error("The Draw canvas did not acknowledge the MCP command in time."));
              }, commandTimeoutMs);
              pending.set(id, {
                clientId,
                resolve: (ack) => resolve(ack),
                timeout,
              });
            });
            server.ws.send("draw:mcp-command", { id, clientId, ...command });

            try {
              const ack = await ackPromise;
              if (ack.error) {
                sendJson(response, 422, { error: ack.error });
                return;
              }
              if (ack.document) {
                if (!isDrawDocument(ack.document)) {
                  sendJson(response, 500, { error: "Canvas acknowledged the command without a valid Draw document." });
                  return;
                }
                document = ack.document;
              }
              if (!document) {
                sendJson(response, 500, { error: "Canvas command finished before the Draw document was synchronized." });
                return;
              }
              sendJson(response, 200, { ok: true, documentId: document.document.id, result: ack.result ?? null });
            } catch (error) {
              sendJson(response, 504, { error: error instanceof Error ? error.message : "MCP command timed out." });
            }
            return;
          }

          const ackMatch = path.match(/^\/__draw\/api\/commands\/([^/]+)\/ack$/);
          if (request.method === "POST" && ackMatch) {
            const body = await readJsonBody(request, maxBodyBytes);
            if (!isRecord(body) || typeof body.clientId !== "string" || !body.clientId) {
              sendJson(response, 400, { error: "Ack must include clientId." });
              return;
            }
            const id = decodeURIComponent(ackMatch[1]);
            const waiting = pending.get(id);
            if (!waiting) {
              sendJson(response, 404, { error: "No pending Draw MCP command matches this acknowledgement." });
              return;
            }
            if (body.clientId !== waiting.clientId || body.clientId !== activeClientId) {
              sendJson(response, 409, { error: "Acknowledgement came from a canvas that is no longer active." });
              return;
            }
            if (body.error !== undefined && typeof body.error !== "string") {
              sendJson(response, 400, { error: "Ack error must be a string." });
              return;
            }
            if (body.document !== undefined && !isDrawDocument(body.document)) {
              sendJson(response, 400, { error: "Acknowledgement document must be a valid Draw document." });
              return;
            }
            clearTimeout(waiting.timeout);
            pending.delete(id);
            waiting.resolve({
              id,
              clientId: body.clientId,
              ...(typeof body.error === "string" ? { error: body.error } : {}),
              ...(isDrawDocument(body.document) ? { document: body.document } : {}),
              ...(body.result !== undefined ? { result: body.result } : {}),
            });
            sendJson(response, 200, { ok: true });
            return;
          }

          sendJson(response, 404, { error: "Unknown Draw MCP bridge route." });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid Draw MCP bridge request.";
          sendJson(response, message.startsWith("Request body exceeds") ? 413 : 400, { error: message });
        }
      };
      server.middlewares.use((request, response, next) => {
        void respond(request, response, next);
      });
    },
  };
}
