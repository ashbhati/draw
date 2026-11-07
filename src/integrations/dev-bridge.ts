import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Plugin, ViteDevServer } from "vite";
import type { DrawDocument } from "../document/document";
import { parseDrawFile, validateDrawDocument } from "../document/document";
import type { McpCommand } from "./mcp-contract";
import { parseMcpToolInput } from "./mcp-contract";
import { createEditorAuthManager, createFileEditorAuthStore, type EditorAuthOptions, type EditorAuthManager } from "./editor-auth";

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

type PendingConfirmation = {
  token: string;
  clientId: string;
  documentId: string;
  expectedDocumentRevision: number;
  filename: string;
  fingerprint: string;
  expiresAt: number;
  decision: "pending" | "approved" | "denied";
};

export type DrawMcpBridgeOptions = {
  commandTimeoutMs?: number;
  flushTimeoutMs?: number;
  lateAckRetentionMs?: number;
  maxBodyBytes?: number;
  /** Test seam for deterministic launch-code exchange. Production uses an interactive trusted terminal. */
  editorAuthForTests?: Partial<EditorAuthOptions>;
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
  const command = parseMcpToolInput(body.operation, body.input);
  if (command.operation === "open_document") {
    if (!isDrawDocument(body.document)) throw new Error("open_document must include a valid Draw document loaded from the configured folder.");
    return { ...command, document: parseDrawFile(body.document) };
  }
  return command;
}

export function createDrawMcpPlugin(options: DrawMcpBridgeOptions = {}): Plugin {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const flushTimeoutMs = options.flushTimeoutMs ?? 1_000;
  const lateAckRetentionMs = options.lateAckRetentionMs ?? DEFAULT_LATE_ACK_RETENTION_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const pending = new Map<string, PendingCommand>();
  const pendingFlushes = new Map<string, PendingFlush>();
  const confirmations = new Map<string, PendingConfirmation>();
  let document: DrawDocumentBridgeValue | null = null;
  let activeClientId: string | null = null;
  let editorAuth: Promise<EditorAuthManager> | null = null;
  let commandSequence = 0;

  return {
    name: "draw-local-mcp-bridge",
    configureServer(server: ViteDevServer) {
      const testAuth = options.editorAuthForTests;
      const isE2ETestMode = server.config.mode === "e2e" && typeof process.env.DRAW_E2E_EDITOR_CODE === "string";
      let e2eLaunchCodeSequence = 0n;
      const generateE2ELaunchCode = () => {
        const base = BigInt(`0x${process.env.DRAW_E2E_EDITOR_CODE}`);
        const code = (base + e2eLaunchCodeSequence).toString(16).toUpperCase().slice(-12).padStart(12, "0");
        e2eLaunchCodeSequence += 1n;
        return code;
      };
      const displayLaunchCode = testAuth?.displayLaunchCode ?? (isE2ETestMode ? (() => true) : ((code: string) => {
        // Never put authentication material in Vite's logger, browser traffic,
        // command arguments, or tool output. Pairing requires a trusted TTY.
        if (!process.stdout.isTTY) return false;
        process.stdout.write(`\nDraw editor launch code (expires in 60 seconds): ${code}\nEnter it in Draw's Connect MCP dialog.\n\n`);
        return true;
      }));
      editorAuth = createEditorAuthManager({
        displayLaunchCode,
        ...(isE2ETestMode ? { generateLaunchCode: generateE2ELaunchCode } : {}),
        ...(testAuth?.now ? { now: testAuth.now } : {}),
        ...(testAuth?.generateLaunchCode ? { generateLaunchCode: testAuth.generateLaunchCode } : {}),
        ...(testAuth?.generateSecret ? { generateSecret: testAuth.generateSecret } : {}),
        ...(testAuth?.store ? { store: testAuth.store } : { store: createFileEditorAuthStore() }),
      });
      const getAuth = () => {
        if (!editorAuth) throw new Error("Editor authentication is unavailable.");
        return editorAuth;
      };
      const authorizedEditor = async (request: IncomingMessage): Promise<{ auth: EditorAuthManager; clientId: string } | null> => {
        const auth = await getAuth();
        const clientId = auth.getActiveClientId();
        const token = request.headers["x-draw-editor-secret"];
        return clientId && auth.authorize(clientId, token) ? { auth, clientId } : null;
      };
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
          const authManager = await getAuth();
          if (request.method === "GET" && path === `${API_ROOT}/health`) {
            sendJson(response, 200, { ok: true, documentReady: document !== null, clientReady: activeClientId !== null });
            return;
          }

          if (request.method === "POST" && path === `${API_ROOT}/editor/bootstrap`) {
            const body = await readJsonBody(request, maxBodyBytes);
            const clientId = isRecord(body) && typeof body.clientId === "string" ? body.clientId : "";
            const launchCode = isRecord(body) ? body.launchCode : undefined;
            if (!clientId || clientId.length > 200) {
              sendJson(response, 401, { status: "INVALID", error: "Could not authenticate this Draw editor session." });
              return;
            }
            const result = await authManager.exchangeLaunchCode(launchCode, clientId);
            if (result.status !== "AUTHENTICATED") {
              const statusCode = result.status === "LOCKED" ? 429 : result.status === "UNAVAILABLE" ? 503 : 401;
              sendJson(response, statusCode, { status: result.status, error: "Could not authenticate this Draw editor session. Check the trusted terminal and retry." });
              return;
            }
            if (activeClientId) {
              for (const [id, waiting] of pending) {
                clearTimeout(waiting.timeout);
                if (waiting.cleanupTimeout) clearTimeout(waiting.cleanupTimeout);
                waiting.resolve({ id, clientId: waiting.clientId, error: "The active Draw editor session was replaced." });
                pending.delete(id);
              }
              for (const [id, waiting] of pendingFlushes) {
                clearTimeout(waiting.timeout);
                waiting.reject(new Error("The active Draw editor session was replaced."));
                pendingFlushes.delete(id);
              }
              confirmations.clear();
              server.ws.send("draw:editor-lease-revoked", { clientId: activeClientId });
            }
            activeClientId = clientId;
            sendJson(response, 200, { status: "AUTHENTICATED", clientId, editorSecret: result.editorSecret });
            return;
          }

          if (request.method === "PUT" && path === `${API_ROOT}/client`) {
            sendJson(response, 401, { error: "Editor registration requires the authenticated bootstrap flow." });
            return;
          }

          if (request.method === "PUT" && path === `${API_ROOT}/document`) {
            const authenticated = await authorizedEditor(request);
            if (!authenticated) {
              sendJson(response, 401, { error: "Editor authentication is required to sync a Draw document." });
              return;
            }
            const body = await readJsonBody(request, maxBodyBytes);
            if (!isRecord(body) || typeof body.clientId !== "string" || body.clientId !== authenticated.clientId) {
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

          if (request.method === "POST" && path === `${API_ROOT}/confirmations`) {
            const body = await readJsonBody(request, maxBodyBytes);
            if (!isRecord(body) || body.action !== "open_document" || typeof body.documentId !== "string" || typeof body.expectedDocumentRevision !== "number" || typeof body.filename !== "string" || typeof body.fingerprint !== "string" || !/^[a-f\d]{64}$/i.test(body.fingerprint)) {
              sendJson(response, 400, { error: "Confirmation request is invalid." });
              return;
            }
            if (!document || !activeClientId || body.documentId !== document.document.id || body.expectedDocumentRevision !== document.document.documentRevision) {
              sendJson(response, 409, { error: "Confirmation context is stale. Read the active canvas again." });
              return;
            }
            if (body.filename.length > 160 || body.filename.includes("/") || body.filename.includes("\\")) {
              sendJson(response, 400, { error: "Confirmation filename must be a basename." });
              return;
            }
            const token = randomUUID();
            const expiresAt = Date.now() + 120_000;
            confirmations.set(token, {
              token, clientId: activeClientId, documentId: document.document.id,
              expectedDocumentRevision: document.document.documentRevision, filename: body.filename,
              fingerprint: body.fingerprint, expiresAt, decision: "pending",
            });
            server.ws.send("draw:confirmation-required", { token, clientId: activeClientId, action: "open_document", filename: body.filename, expiresAt });
            sendJson(response, 202, { status: "NEEDS_CONFIRMATION", confirmationToken: token, expiresAt });
            return;
          }

          const confirmationRespondMatch = path.match(/^\/__draw\/api\/confirmations\/([^/]+)\/respond$/);
          if (request.method === "POST" && confirmationRespondMatch) {
            const authenticated = await authorizedEditor(request);
            if (!authenticated) {
              sendJson(response, 401, { error: "Only the authenticated active Draw editor can relay a human confirmation." });
              return;
            }
            const body = await readJsonBody(request, maxBodyBytes);
            const token = decodeURIComponent(confirmationRespondMatch[1]);
            const confirmation = confirmations.get(token);
            if (!confirmation || confirmation.expiresAt <= Date.now()) {
              confirmations.delete(token);
              sendJson(response, 410, { status: "EXPIRED" });
              return;
            }
            if (!isRecord(body) || body.clientId !== confirmation.clientId || body.clientId !== authenticated.clientId || typeof body.approved !== "boolean") {
              sendJson(response, 409, { error: "Confirmation response came from a stale or invalid editor session." });
              return;
            }
            if (confirmation.decision !== "pending") {
              sendJson(response, 409, { error: "Confirmation token has already been used." });
              return;
            }
            confirmation.decision = body.approved ? "approved" : "denied";
            sendJson(response, 200, { status: body.approved ? "APPROVED" : "DENIED" });
            return;
          }

          const confirmationConsumeMatch = path.match(/^\/__draw\/api\/confirmations\/([^/]+)\/consume$/);
          if (request.method === "POST" && confirmationConsumeMatch) {
            const body = await readJsonBody(request, maxBodyBytes);
            const token = decodeURIComponent(confirmationConsumeMatch[1]);
            const confirmation = confirmations.get(token);
            if (!confirmation || confirmation.expiresAt <= Date.now()) {
              confirmations.delete(token);
              sendJson(response, 200, { status: "EXPIRED" });
              return;
            }
            if (!isRecord(body) || confirmation.clientId !== activeClientId || body.action !== "open_document" || body.documentId !== confirmation.documentId || body.expectedDocumentRevision !== confirmation.expectedDocumentRevision || body.filename !== confirmation.filename || body.fingerprint !== confirmation.fingerprint || !document || document.document.id !== confirmation.documentId || document.document.documentRevision !== confirmation.expectedDocumentRevision) {
              confirmations.delete(token);
              sendJson(response, 200, { status: "STALE" });
              return;
            }
            if (confirmation.decision === "pending") {
              sendJson(response, 200, { status: "PENDING" });
              return;
            }
            confirmations.delete(token);
            sendJson(response, 200, { status: confirmation.decision === "approved" ? "APPROVED" : "DENIED" });
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
            const authenticated = await authorizedEditor(request);
            if (!authenticated) {
              sendJson(response, 401, { error: "Editor authentication is required for a document flush acknowledgement." });
              return;
            }
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
            if (body.clientId !== waiting.clientId || body.clientId !== authenticated.clientId) {
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

            const commandInput = command.input as Record<string, unknown>;
            const expectedDocumentRevision = commandInput.expectedDocumentRevision;
            const expectedViewRevision = commandInput.expectedViewRevision;
            if (typeof commandInput.documentId === "string" && command.operation !== "open_document" && commandInput.documentId !== document.document.id) {
              sendJson(response, 409, { error: "Document ID does not match the active Draw canvas." });
              return;
            }
            if (typeof commandInput.documentId === "string" && command.operation === "open_document" && commandInput.documentId !== document.document.id) {
              sendJson(response, 409, { error: "Open context document ID does not match the active Draw canvas." });
              return;
            }
            if (typeof expectedDocumentRevision === "number" && expectedDocumentRevision !== (document.document.documentRevision ?? 0)) {
              sendJson(response, 409, { error: `Document revision conflict. Expected ${expectedDocumentRevision}; current revision is ${document.document.documentRevision ?? 0}. Read the current canvas before retrying.` });
              return;
            }
            if (typeof expectedViewRevision === "number" && expectedViewRevision !== (document.document.viewRevision ?? 0)) {
              sendJson(response, 409, { error: `View revision conflict. Expected ${expectedViewRevision}; current revision is ${document.document.viewRevision ?? 0}. Read the current canvas before retrying.` });
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
                  documentRevision: document.document.documentRevision ?? 0,
                  viewRevision: document.document.viewRevision ?? 0,
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
            const authenticated = await authorizedEditor(request);
            if (!authenticated) {
              sendJson(response, 401, { error: "Editor authentication is required for an MCP command acknowledgement." });
              return;
            }
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
            if (body.clientId !== waiting.clientId || body.clientId !== authenticated.clientId) {
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
