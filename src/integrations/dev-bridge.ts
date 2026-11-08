import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Plugin, ViteDevServer } from "vite";
import type { DrawDocument } from "../document/document";
import { parseDrawFile, validateDrawDocument } from "../document/document";
import type { McpCommand } from "./mcp-contract";
import { parseMcpToolInput } from "./mcp-contract";
import { createEditorAuthManager, createFileEditorAuthStore, type EditorAuthOptions, type EditorAuthManager } from "./editor-auth";
import { createMcpClientAuthManager, createFileMcpClientAuthStore, type McpClientAuthOptions, type McpClientAuthManager, type McpClientAuthState } from "./mcp-client-auth";

export type DrawDocumentBridgeValue = DrawDocument;

type BridgeAck = {
  id: string;
  clientId: string;
  clientIdentity?: string;
  document?: DrawDocumentBridgeValue;
  result?: unknown;
  error?: string;
  warning?: string;
  revoked?: boolean;
};

type PendingCommand = {
  clientId: string;
  clientIdentity: string;
  resolve: (ack: BridgeAck) => void;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
};

type PendingFlush = {
  clientId: string;
  clientIdentity: string;
  resolve: (document: DrawDocumentBridgeValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingConfirmation = {
  token: string;
  clientId: string;
  clientIdentity: string;
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
  /** Deterministic auth seams for isolated bridge tests. */
  mcpClientAuthForTests?: Partial<McpClientAuthOptions>;
};

const API_ROOT = "/__draw/api";
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_LATE_ACK_RETENTION_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;

export function isMcpOnlyRoute(method: string | undefined, path: string): boolean {
  return (method === "GET" && path === `${API_ROOT}/document`)
    || (method === "POST" && [ `${API_ROOT}/mcp/pair`, `${API_ROOT}/commands`, `${API_ROOT}/confirmations` ].includes(path))
    || (method === "POST" && /^\/__draw\/api\/confirmations\/[^/]+\/consume$/.test(path));
}

function isMcpRoute(method: string | undefined, path: string): boolean {
  return isMcpOnlyRoute(method, path)
    || (method === "GET" && path === `${API_ROOT}/mcp/clients`)
    || (method === "POST" && path === `${API_ROOT}/mcp/pairing-secret`)
    || (method === "PUT" && /^\/__draw\/api\/mcp\/clients\/[^/]+$/.test(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function isLoopbackHost(host: unknown): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(resolve(directory), resolve(candidate));
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
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
  const revokedCommands = new Map<string, { clientIdentity: string; expiresAt: number }>();
  const pendingFlushes = new Map<string, PendingFlush>();
  const confirmations = new Map<string, PendingConfirmation>();
  const pendingMcpPairings = new Map<string, { clientId: string; resolve: (value: { clientIdentity: string; capability: string; expiresAt: number } | null) => void; timer: ReturnType<typeof setTimeout> }>();
      const eventTickets = new Map<string, { clientId: string; expiresAt: number }>();
  let document: DrawDocumentBridgeValue | null = null;
  let activeClientId: string | null = null;
  let editorAuth: Promise<EditorAuthManager> | null = null;
  let mcpClientAuth: Promise<McpClientAuthManager> | null = null;
  let commandSequence = 0;

  return {
    name: "draw-local-mcp-bridge",
    configureServer(server: ViteDevServer) {
      const testAuth = options.editorAuthForTests;
      const e2eCode = process.env.DRAW_E2E_EDITOR_CODE;
      const e2eAuthStatePath = process.env.DRAW_E2E_AUTH_STATE_PATH;
      const isE2ETestMode = server.config.mode === "e2e"
        && !server.config.isProduction
        && isLoopbackHost(server.config.server.host)
        && typeof e2eCode === "string"
        && /^[A-F\d]{12}$/i.test(e2eCode)
        && typeof e2eAuthStatePath === "string"
        && isWithinDirectory(tmpdir(), e2eAuthStatePath);
      let e2eLaunchCodeSequence = 0n;
      let activeE2ELaunchCode: string | null = null;
      const generateE2ELaunchCode = () => {
        const base = BigInt(`0x${e2eCode}`);
        const code = (base + e2eLaunchCodeSequence).toString(16).toUpperCase().slice(-12).padStart(12, "0");
        e2eLaunchCodeSequence += 1n;
        activeE2ELaunchCode = code;
        return code;
      };
      if (isE2ETestMode) {
        server.config.logger.warn("Draw E2E-only editor auth provider is active on loopback. Its per-run test code and test endpoint are for isolated automation only; never use this mode with real drawings or outside an isolated test run.");
      }
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
        ...(testAuth?.store
          ? { store: testAuth.store }
          : { store: createFileEditorAuthStore(isE2ETestMode ? e2eAuthStatePath : undefined) }),
      });
      const mcpAuthTest = options.mcpClientAuthForTests;
      const e2eMcpClientId = process.env.DRAW_E2E_MCP_CLIENT_ID;
      const e2eMcpCapability = process.env.DRAW_E2E_MCP_CLIENT_SECRET;
      let e2eMcpState: McpClientAuthState | null = isE2ETestMode && e2eMcpClientId && /^[a-f\d]{64}$/i.test(e2eMcpCapability ?? "") ? {
        failedAttempts: 0,
        lockedUntil: 0,
        clients: [{
          clientIdentity: e2eMcpClientId,
          name: "Isolated Playwright MCP client",
          fingerprint: createHash("sha256").update(e2eMcpClientId).digest("hex"),
          secretHash: createHash("sha256").update(e2eMcpCapability!).digest("hex"),
          createdAt: Date.now(), expiresAt: Date.now() + 60 * 60_000, revokedAt: null,
        }],
      } : null;
      mcpClientAuth = createMcpClientAuthManager({
        ...(mcpAuthTest?.now ? { now: mcpAuthTest.now } : {}),
        ...(mcpAuthTest?.generatePairingCode ? { generatePairingCode: mcpAuthTest.generatePairingCode } : {}),
        ...(mcpAuthTest?.generateIdentity ? { generateIdentity: mcpAuthTest.generateIdentity } : {}),
        ...(mcpAuthTest?.generateCapability ? { generateCapability: mcpAuthTest.generateCapability } : {}),
        ...(mcpAuthTest?.generateRequestId ? { generateRequestId: mcpAuthTest.generateRequestId } : {}),
        ...(mcpAuthTest?.pairingCodeTtlMs ? { pairingCodeTtlMs: mcpAuthTest.pairingCodeTtlMs } : {}),
        ...(mcpAuthTest?.maxFailedAttempts ? { maxFailedAttempts: mcpAuthTest.maxFailedAttempts } : {}),
        ...(mcpAuthTest?.store ? { store: mcpAuthTest.store } : e2eMcpState ? {
          store: { load: async () => structuredClone(e2eMcpState!), save: async (state: McpClientAuthState) => { e2eMcpState = structuredClone(state); } },
        } : { store: createFileMcpClientAuthStore() }),
      });
      if (isE2ETestMode && e2eAuthStatePath) {
        server.httpServer?.once("close", () => { void rm(e2eAuthStatePath, { force: true }); });
      }
      const getAuth = () => {
        if (!editorAuth) throw new Error("Editor authentication is unavailable.");
        return editorAuth;
      };
      const getMcpAuth = () => {
        if (!mcpClientAuth) throw new Error("MCP client authentication is unavailable.");
        return mcpClientAuth;
      };
      const authenticatedMcpClient = async (request: IncomingMessage) => {
        const identity = request.headers["x-draw-client-identity"];
        const authorization = request.headers.authorization;
        const capability = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
        const auth = await getMcpAuth();
        return auth.authenticate(identity, capability) ? { clientIdentity: identity as string } : null;
      };
      const cancelMcpClientWork = (clientIdentity: string) => {
        for (const [id, waiting] of pending) {
          if (waiting.clientIdentity !== clientIdentity) continue;
          clearTimeout(waiting.timeout);
          if (waiting.cleanupTimeout) clearTimeout(waiting.cleanupTimeout);
          pending.delete(id);
          for (const [revokedId, tombstone] of revokedCommands) if (tombstone.expiresAt <= Date.now()) revokedCommands.delete(revokedId);
          revokedCommands.set(id, { clientIdentity, expiresAt: Date.now() + lateAckRetentionMs });
          while (revokedCommands.size > 1_000) revokedCommands.delete(revokedCommands.keys().next().value!);
        server.ws.send("draw:mcp-command-revoked", { id, clientId: waiting.clientId, clientIdentity });
          waiting.resolve({ id, clientId: waiting.clientId, clientIdentity, revoked: true, error: "This MCP client was revoked while its request was in flight." });
        }
        for (const [id, waiting] of pendingFlushes) {
          if (waiting.clientIdentity !== clientIdentity) continue;
          clearTimeout(waiting.timeout);
          pendingFlushes.delete(id);
          waiting.reject(new Error("This MCP client was revoked while its read was in flight."));
        }
        for (const [token, confirmation] of confirmations) {
          if (confirmation.clientIdentity !== clientIdentity) continue;
          confirmations.delete(token);
          server.ws.send("draw:confirmation-revoked", { token, clientId: confirmation.clientId, clientIdentity });
        }
      };
      const cancelEditorPairings = async (clientId: string) => {
        const auth = await getMcpAuth();
        for (const [requestId, pairing] of pendingMcpPairings) {
          if (pairing.clientId !== clientId) continue;
          clearTimeout(pairing.timer);
          pendingMcpPairings.delete(requestId);
          await auth.cancelPairing(requestId);
          pairing.resolve(null);
        }
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

        const trustedIpc = (request.socket as typeof request.socket & { drawTrustedIpc?: boolean }).drawTrustedIpc === true;
        if (server.config.isProduction && (trustedIpc ? !isMcpRoute(request.method, path) : isMcpOnlyRoute(request.method, path))) {
          sendJson(response, 403, { error: "This Draw API route is not available over this transport." });
          return;
        }
        if (!trustedIpc && !isLoopbackAddress(request.socket.remoteAddress)) {
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
        if (!trustedIpc && (typeof host !== "string" || !allowedHosts.has(host.toLowerCase()))) {
          sendJson(response, 403, { error: "Draw MCP bridge accepts only its configured loopback host." });
          return;
        }
        if (!trustedIpc && typeof origin === "string" && (!host || origin !== `http://${host}`)) {
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
            sendJson(response, 200, { ok: true });
            return;
          }

          if (server.config.isProduction && request.method === "POST" && path === `${API_ROOT}/events/ticket`) {
            const authenticated = await authorizedEditor(request);
            if (!authenticated || origin !== `http://${host}` || authenticated.clientId !== activeClientId) {
              sendJson(response, 401, { error: "Draw events require the active editor session." });
              return;
            }
            const ticket = randomBytes(32).toString("hex");
            eventTickets.set(ticket, { clientId: authenticated.clientId, expiresAt: Date.now() + 30_000 });
            for (const [expired, value] of eventTickets) if (value.expiresAt <= Date.now()) eventTickets.delete(expired);
            sendJson(response, 200, { ticket });
            return;
          }

          if (server.config.isProduction && request.method === "GET" && path === `${API_ROOT}/events`) {
            const ticket = new URL(request.url ?? "/", `http://${host}`).searchParams.get("ticket") ?? "";
            const grant = eventTickets.get(ticket);
            eventTickets.delete(ticket);
            if (!grant || grant.expiresAt <= Date.now() || grant.clientId !== activeClientId || (typeof origin === "string" && origin !== `http://${host}`)) {
              sendJson(response, 401, { error: "The Draw event ticket is missing, expired, or already used." });
              return;
            }
            (response as ServerResponse & { drawClientId?: string }).drawClientId = grant.clientId;
            response.statusCode = 200;
            response.setHeader("content-type", "text/event-stream; charset=utf-8");
            response.setHeader("cache-control", "no-store");
            response.setHeader("connection", "keep-alive");
            response.write(": connected\n\n");
            const heartbeat = setInterval(() => response.write(": ping\n\n"), 15_000);
            heartbeat.unref();
            response.once("close", () => clearInterval(heartbeat));
            return;
          }

          // This endpoint exists only for isolated, loopback Playwright runs.
          // Production builds and normal Vite modes never expose test credentials.
          if (isE2ETestMode && request.method === "GET" && path === `${API_ROOT}/e2e/active-launch-code`) {
            if (origin !== `http://${host}` || !activeE2ELaunchCode) {
              sendJson(response, 403, { error: "The isolated E2E launch code is unavailable." });
              return;
            }
            sendJson(response, 200, { code: activeE2ELaunchCode });
            return;
          }

          if (request.method === "POST" && path === `${API_ROOT}/editor/reissue-code`) {
            if (origin !== `http://${host}`) {
              sendJson(response, 403, { error: "A fresh editor code can be requested only from Draw." });
              return;
            }
            const result = await authManager.requestFreshLaunchCode();
            if (result !== "ISSUED") {
              sendJson(response, result === "LOCKED" || result === "THROTTLED" ? 429 : 503, {
                status: result,
                error: result === "THROTTLED"
                  ? "A code was requested recently. Wait before requesting another code."
                  : "No code was issued. Start Draw from a trusted interactive terminal and check that terminal.",
              });
              return;
            }
            sendJson(response, 200, { status: "ISSUED" });
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
              const statusCode = result.status === "LOCKED" ? 429 : result.status === "UNAVAILABLE" ? 503 : result.status === "EXPIRED" ? 410 : 401;
              const error = result.status === "EXPIRED"
                ? "This code may have expired. Request a fresh code and check the trusted terminal."
                : "Could not authenticate this Draw editor session. Check the trusted terminal and retry.";
              sendJson(response, statusCode, { status: result.status, error });
              return;
            }
            if (activeClientId) {
              await cancelEditorPairings(activeClientId);
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

          if (request.method === "POST" && path === `${API_ROOT}/mcp/pairing-secret`) {
            const authenticated = await authorizedEditor(request);
            if (!authenticated || origin !== `http://${host}` || authenticated.clientId !== activeClientId) {
              sendJson(response, 401, { error: "MCP pairing must be started from the active Draw editor." });
              return;
            }
            const pairingSecret = await (await getMcpAuth()).issuePairingCode();
            if (!pairingSecret) {
              sendJson(response, 429, { error: "A pairing request is already pending or pairing is temporarily unavailable." });
              return;
            }
            sendJson(response, 200, { pairingSecret, expiresInMs: 5 * 60_000 });
            return;
          }

          if (request.method === "POST" && path === `${API_ROOT}/mcp/pair`) {
            const body = await readJsonBody(request, maxBodyBytes);
            if (!isRecord(body)) { sendJson(response, 401, { error: "MCP pairing is unavailable. Check Draw and retry." }); return; }
            if (!activeClientId) {
              sendJson(response, 409, { error: "Open Draw and connect its editor before pairing an MCP client." });
              return;
            }
            const clientId = activeClientId;
            let pairingRequest;
            try {
              pairingRequest = await (await getMcpAuth()).beginPairing(body.pairingSecret, body.clientName, body.fingerprint);
            } catch {
              sendJson(response, 401, { error: "MCP pairing is unavailable. Check Draw and retry." });
              return;
            }
            if (activeClientId !== clientId) {
              await (await getMcpAuth()).cancelPairing(pairingRequest.requestId);
              sendJson(response, 409, { error: "Open Draw and connect its editor before pairing an MCP client." });
              return;
            }
            server.ws.send("draw:mcp-pairing-required", { requestId: pairingRequest.requestId, clientId, name: pairingRequest.name, fingerprint: pairingRequest.fingerprint, expiresAt: pairingRequest.expiresAt, replacesName: pairingRequest.replacesName });
            const credential = await new Promise<{ clientIdentity: string; capability: string; expiresAt: number } | null>((resolve) => {
              const timer = setTimeout(() => {
                pendingMcpPairings.delete(pairingRequest.requestId);
                void (async () => {
                  try { await (await getMcpAuth()).cancelPairing(pairingRequest.requestId); }
                  finally { resolve(null); }
                })();
              }, Math.max(1, pairingRequest.expiresAt - Date.now()));
              pendingMcpPairings.set(pairingRequest.requestId, { clientId, resolve, timer });
            });
            if (!credential) {
              sendJson(response, 410, { error: "MCP pairing was denied or expired." });
              return;
            }
            sendJson(response, 200, credential);
            return;
          }

          const pairingResponseMatch = path.match(/^\/__draw\/api\/mcp\/pairings\/([^/]+)\/respond$/);
          if (request.method === "POST" && pairingResponseMatch) {
            const authenticated = await authorizedEditor(request);
            const body = await readJsonBody(request, maxBodyBytes);
            const requestId = decodeURIComponent(pairingResponseMatch[1]);
            const pendingPairing = pendingMcpPairings.get(requestId);
            if (!authenticated) {
              sendJson(response, 401, { error: "Editor authentication is required." });
              return;
            }
            if (!isRecord(body) || body.clientId !== authenticated.clientId || body.clientId !== activeClientId || !pendingPairing || pendingPairing.clientId !== authenticated.clientId || typeof body.approved !== "boolean") {
              sendJson(response, 409, { error: "This pairing request is stale or unavailable." });
              return;
            }
            clearTimeout(pendingPairing.timer);
            pendingMcpPairings.delete(requestId);
            const resolution = await (await getMcpAuth()).resolvePairing(requestId, body.approved);
            if (resolution?.replacedClientIdentity) {
              cancelMcpClientWork(resolution.replacedClientIdentity);
              server.ws.send("draw:mcp-client-revoked", { clientIdentity: resolution.replacedClientIdentity });
            }
            pendingPairing.resolve(resolution?.credential ?? null);
            sendJson(response, 200, { status: resolution ? "APPROVED" : "DENIED" });
            return;
          }

          if (request.method === "GET" && path === `${API_ROOT}/mcp/clients`) {
            if (!(await authorizedEditor(request))) { sendJson(response, 401, { error: "Editor authentication is required." }); return; }
            sendJson(response, 200, { clients: (await getMcpAuth()).list() });
            return;
          }

          const revokeMcpMatch = path.match(/^\/__draw\/api\/mcp\/clients\/([^/]+)$/);
          if (request.method === "DELETE" && revokeMcpMatch) {
            if (!(await authorizedEditor(request))) { sendJson(response, 401, { error: "Editor authentication is required." }); return; }
            const revoked = await (await getMcpAuth()).revoke(decodeURIComponent(revokeMcpMatch[1]));
            if (revoked) {
              const clientIdentity = decodeURIComponent(revokeMcpMatch[1]);
              cancelMcpClientWork(clientIdentity);
              server.ws.send("draw:mcp-client-revoked", { clientIdentity });
            }
            sendJson(response, revoked ? 200 : 404, { revoked });
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
            const authenticated = await authenticatedMcpClient(request);
            if (!authenticated) { sendJson(response, 401, { error: "MCP authentication is required." }); return; }
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
              token, clientId: activeClientId, clientIdentity: authenticated.clientIdentity, documentId: document.document.id,
              expectedDocumentRevision: document.document.documentRevision, filename: body.filename,
              fingerprint: body.fingerprint, expiresAt, decision: "pending",
            });
            server.ws.send("draw:confirmation-required", { token, clientId: activeClientId, clientIdentity: authenticated.clientIdentity, action: "open_document", filename: body.filename, expiresAt });
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
            const authenticated = await authenticatedMcpClient(request);
            if (!authenticated) { sendJson(response, 401, { error: "MCP authentication is required." }); return; }
            const body = await readJsonBody(request, maxBodyBytes);
            const token = decodeURIComponent(confirmationConsumeMatch[1]);
            const confirmation = confirmations.get(token);
            if (!confirmation || confirmation.expiresAt <= Date.now()) {
              confirmations.delete(token);
              sendJson(response, 200, { status: "EXPIRED" });
              return;
            }
            if (confirmation.clientIdentity !== authenticated.clientIdentity) {
              sendJson(response, 404, { status: "EXPIRED" });
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
            const authenticated = await authenticatedMcpClient(request);
            if (!authenticated) { sendJson(response, 401, { error: "MCP authentication is required." }); return; }
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
                pendingFlushes.set(id, { clientId, clientIdentity: authenticated.clientIdentity, resolve, reject, timeout });
                server.ws.send("draw:flush-document", { id, clientId, clientIdentity: authenticated.clientIdentity });
              }).catch(async (error: unknown) => {
                if (!(await authenticatedMcpClient(request))) sendJson(response, 401, { error: "MCP authentication is required." });
                else sendJson(response, 504, { error: error instanceof Error ? error.message : "Timed out waiting for Draw." });
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
            if (body.clientId !== waiting.clientId || body.clientId !== authenticated.clientId || body.clientIdentity !== waiting.clientIdentity) {
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
            const authenticated = await authenticatedMcpClient(request);
            if (!authenticated) { sendJson(response, 401, { error: "MCP authentication is required." }); return; }
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
            if (typeof commandInput.documentId === "string" && command.operation !== "open_document" && commandInput.documentId !== document.document.id) {
              sendJson(response, 409, { error: "Document ID does not match the active Draw canvas." });
              return;
            }
            if (typeof commandInput.documentId === "string" && command.operation === "open_document" && commandInput.documentId !== document.document.id) {
              sendJson(response, 409, { error: "Open context document ID does not match the active Draw canvas." });
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
                clientIdentity: authenticated.clientIdentity,
                resolve: (ack) => resolve(ack),
                timeout,
                timedOut: false,
              });
            });
            server.ws.send("draw:mcp-command", { id, clientId, clientIdentity: authenticated.clientIdentity, ...command });

            try {
              const ack = await ackPromise;
              if (ack.revoked || !(await authenticatedMcpClient(request))) {
                sendJson(response, 401, { error: "MCP authentication is required." });
                return;
              }
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
                clientIdentity: authenticated.clientIdentity,
                documentId: document.document.id,
                  documentRevision: document.document.documentRevision ?? 0,
                  viewRevision: document.document.viewRevision ?? 0,
                result: ack.result ?? null,
                ...(ack.warning ? { warning: ack.warning } : {}),
              });
            } catch (error) {
              if (!(await authenticatedMcpClient(request))) sendJson(response, 401, { error: "MCP authentication is required." });
              else sendJson(response, 504, { error: error instanceof Error ? error.message : "MCP command timed out." });
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
              const revoked = revokedCommands.get(id);
              if (revoked && revoked.expiresAt > Date.now() && revoked.clientIdentity === body.clientIdentity) {
                revokedCommands.delete(id);
                sendJson(response, 410, { revoked: true, error: "This command was canceled because its MCP client was revoked." });
                return;
              }
              revokedCommands.delete(id);
              sendJson(response, 404, { error: "No pending Draw MCP command matches this acknowledgement." });
              return;
            }
            if (body.clientId !== waiting.clientId || body.clientId !== authenticated.clientId || body.clientIdentity !== waiting.clientIdentity) {
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
              clientIdentity: waiting.clientIdentity,
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
