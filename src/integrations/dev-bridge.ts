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
  warning?: string;
};

type PendingCommand = {
  clientId: string;
  resolve: (ack: BridgeAck) => void;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
};

type PendingFlush = {
  clientId: string;
  resolve: (document: DrawDocumentBridgeValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type DrawMcpBridgeOptions = {
  commandTimeoutMs?: number;
  flushTimeoutMs?: number;
  lateAckRetentionMs?: number;
  maxBodyBytes?: number;
};

const API_ROOT = "/__draw/api";
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_LATE_ACK_RETENTION_MS = 60_000;
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
  const flushTimeoutMs = options.flushTimeoutMs ?? 1_000;
  const lateAckRetentionMs = options.lateAckRetentionMs ?? DEFAULT_LATE_ACK_RETENTION_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const pending = new Map<string, PendingCommand>();
  const pendingFlushes = new Map<string, PendingFlush>();
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
        const allowedHosts = new Set([
          `127.0.0.1:${server.config.server.port}`,
          `localhost:${server.config.server.port}`,
          `[::1]:${server.config.server.port}`,
        ]);
        if (typeof host !== "string" || !allowedHosts.has(host.toLowerCase())) {
          sendJson(response, 403, { error: "Draw MCP bridge accepts only its configured loopback host." });
          return;
        }
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
            if (!isRecord(body) || typeof body.clientId !== "string" || body.clientId !== activeClientId) {
              sendJson(response, 409, { error: "Only the active Draw canvas may sync its document." });
              return;
            }
            if (!isDrawDocument(body.document)) {
              sendJson(response, 400, { error: "Body must include a valid Draw document (format draw, version 1)." });
              return;
            }
            document = body.document;
            sendJson(response, 200, { ok: true, documentId: document.document.id });
            return;
          }

          if (request.method === "GET" && path === `${API_ROOT}/document`) {
            if (!document) {
              sendJson(response, 404, { error: "No Draw document is open in the app." });
              return;
            }
            const flushRequested = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("flush") === "1";
            if (flushRequested && activeClientId) {
              const clientId = activeClientId;
              commandSequence += 1;
              const id = `draw-flush-${Date.now().toString(36)}-${commandSequence.toString(36)}`;
              const freshDocument = await new Promise<DrawDocumentBridgeValue>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  pendingFlushes.delete(id);
                  reject(new Error("Timed out waiting for the active Draw canvas to flush its latest edit."));
                }, flushTimeoutMs);
                pendingFlushes.set(id, { clientId, resolve, reject, timeout });
                server.ws.send("draw:flush-document", { id, clientId });
              }).catch((error: unknown) => {
                sendJson(response, 504, { error: error instanceof Error ? error.message : "Timed out waiting for Draw." });
                return null;
              });
              if (!freshDocument) return;
              document = freshDocument;
            } else if (flushRequested) {
              sendJson(response, 409, { error: "No active Draw canvas is connected to flush its latest edit." });
              return;
            }
            sendJson(response, 200, document);
            return;
          }

          const flushAckMatch = path.match(/^\/__draw\/api\/document\/flush\/([^/]+)$/);
          if (request.method === "POST" && flushAckMatch) {
            const body = await readJsonBody(request, maxBodyBytes);
            if (!isRecord(body) || typeof body.clientId !== "string" || (body.error === undefined && !isDrawDocument(body.document)) || (body.error !== undefined && typeof body.error !== "string")) {
              sendJson(response, 400, { error: "Flush acknowledgement must include a clientId and a valid Draw document or error." });
              return;
            }
            const id = decodeURIComponent(flushAckMatch[1]);
            const waiting = pendingFlushes.get(id);
            if (!waiting) {
              sendJson(response, 404, { error: "No pending Draw document flush matches this acknowledgement." });
              return;
            }
            if (body.clientId !== waiting.clientId || body.clientId !== activeClientId) {
              sendJson(response, 409, { error: "Flush acknowledgement came from a canvas that is no longer active." });
              return;
            }
            clearTimeout(waiting.timeout);
            pendingFlushes.delete(id);
            if (typeof body.error === "string") {
              waiting.reject(new Error(body.error));
            } else {
              if (!isDrawDocument(body.document)) {
                sendJson(response, 400, { error: "Flush acknowledgement document is invalid." });
                return;
              }
              document = body.document;
              waiting.resolve(body.document);
            }
            sendJson(response, 200, { ok: true });
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
                const waiting = pending.get(id);
                if (!waiting) return;
                waiting.timedOut = true;
                waiting.cleanupTimeout = setTimeout(() => pending.delete(id), lateAckRetentionMs);
                reject(new Error("Timed out waiting for the Draw canvas. Call get_current_canvas before retrying, because the edit may already have been applied."));
              }, commandTimeoutMs);
              pending.set(id, {
                clientId,
                resolve: (ack) => resolve(ack),
                timeout,
                timedOut: false,
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
              sendJson(response, 200, {
                ok: true,
                documentId: document.document.id,
                result: ack.result ?? null,
                ...(ack.warning ? { warning: ack.warning } : {}),
              });
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
            if (waiting.cleanupTimeout) clearTimeout(waiting.cleanupTimeout);
            pending.delete(id);
            if (isDrawDocument(body.document)) document = body.document;
            waiting.resolve({
              id,
              clientId: body.clientId,
              ...(typeof body.error === "string" ? { error: body.error } : {}),
              ...(typeof body.warning === "string" ? { warning: body.warning } : {}),
              ...(isDrawDocument(body.document) ? { document: body.document } : {}),
              ...(body.result !== undefined ? { result: body.result } : {}),
            });
            sendJson(response, 200, { ok: true, late: waiting.timedOut });
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
