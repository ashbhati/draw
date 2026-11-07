import { Readable } from "node:stream";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/document";
import { createDrawMcpPlugin, type DrawMcpBridgeOptions } from "./dev-bridge";

type CapturedResponse = { status: number; body: any };
type Middleware = (request: any, response: any, next: (error?: unknown) => void) => void;

function createBridgeHarness(options: DrawMcpBridgeOptions = {}) {
  let middleware: Middleware | undefined;
  const events: Array<{ event: string; data: any }> = [];
  let launchCode = "";
  const sessions = new Map<string, { clientId: string; editorSecret: string }>();
  let authState = { failedAttempts: 0, lockedUntil: 0 };
  const bridgePlugin = createDrawMcpPlugin({ ...options, editorAuthForTests: {
    displayLaunchCode: (code) => { launchCode = code; return true; },
    store: { load: async () => ({ ...authState }), save: async (state) => { authState = { ...state }; } },
  } });
  const server = {
    config: { server: { port: 5173 } },
    middlewares: { use: (fn: Middleware) => (middleware = fn) },
    ws: { send: (event: string, data: unknown) => events.push({ event, data }) },
  } as unknown as ViteDevServer;
  if (typeof bridgePlugin.configureServer === "function") bridgePlugin.configureServer.call({} as never, server);
  if (!middleware) throw new Error("Plugin did not register middleware.");

  const request = (method: string, path: string, body?: unknown, remoteAddress = "127.0.0.1", headers: Record<string, string> = {}) => {
    return new Promise<CapturedResponse>((resolve, reject) => {
      const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
        method,
        url: path,
        headers: { host: "127.0.0.1:5173", "content-type": "application/json", ...headers },
        socket: { remoteAddress },
      });
      let payload = "";
      const res = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) { this.headers[name] = value; },
        end(data = "") {
          payload += String(data);
          try {
            resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null });
          } catch (error) {
            reject(error);
          }
        },
      };
      middleware?.(req, res, (error) => error ? reject(error) : resolve({ status: 404, body: null }));
    });
  };

  const registerClient = async (clientId: string) => {
    // Auth manager initialization loads its lockout state asynchronously and
    // emits the initial test launch code during that setup.
    await new Promise((resolve) => setImmediate(resolve));
    const response = await request("POST", "/__draw/api/editor/bootstrap", { clientId, launchCode });
    const session = response.status === 200 ? { clientId, editorSecret: response.body.editorSecret as string } : null;
    if (session) sessions.set(clientId, session);
    return { response, session };
  };
  const editorRequest = (clientId: string, method: string, path: string, body?: unknown) => {
    const session = sessions.get(clientId);
    if (!session) throw new Error(`No authenticated session for ${clientId}`);
    return request(method, path, body, "127.0.0.1", { "x-draw-editor-secret": session.editorSecret });
  };
  return { request, editorRequest, registerClient, events };
}

describe("Draw MCP Vite bridge", () => {
  it("only accepts loopback requests", async () => {
    const bridge = createBridgeHarness();
    const response = await bridge.request("GET", "/__draw/api/health", undefined, "192.168.1.2");
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/loopback/i);
  });

  it("rejects cross-origin browser requests and non-JSON mutations", async () => {
    const bridge = createBridgeHarness();
    const crossOrigin = await bridge.request("POST", "/__draw/api/commands", { operation: "update_elements", input: {} }, "127.0.0.1", { origin: "https://attacker.example" });
    expect(crossOrigin.status).toBe(403);
    const wrongType = await bridge.request("PUT", "/__draw/api/client", { clientId: "web" }, "127.0.0.1", { "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);
  });

  it("rejects matching attacker-controlled Host and Origin values", async () => {
    const bridge = createBridgeHarness();
    const response = await bridge.request("GET", "/__draw/api/health", undefined, "127.0.0.1", {
      host: "evil.example:5173",
      origin: "http://evil.example:5173",
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/configured loopback host/i);
  });

  it("delivers a command to the active canvas and stores its acknowledged scene", async () => {
    const bridge = createBridgeHarness({ commandTimeoutMs: 1_000 });
    const document = createEmptyDocument("MCP test");
    expect((await bridge.registerClient("tab-1")).response.status).toBe(200);
    expect((await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document })).status).toBe(200);

    const commandResponse = bridge.request("POST", "/__draw/api/commands", {
      operation: "create_diagram",
      input: {
        title: "Flow",
        nodes: [
          { id: "a", label: "Specification", x: 0, y: 0 },
          { id: "b", label: "Implementation", x: 240, y: 0 },
        ],
        edges: [{ from: "a", to: "b" }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = bridge.events.find(({ event }) => event === "draw:mcp-command")?.data;
    expect(message).toMatchObject({ clientId: "tab-1", operation: "create_diagram" });
    expect(message.id).toBeTruthy();

    const updated = structuredClone(document);
    updated.document.elements.push({ id: "one", type: "rectangle", x: 0, y: 0 });
    const documentSync = await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document: updated });
    expect(documentSync.status).toBe(200);
    const ack = await bridge.editorRequest("tab-1", "POST", `/__draw/api/commands/${message.id}/ack`, {
      id: message.id,
      clientId: "tab-1",
      result: { addedElementIds: ["one"] },
    });
    expect(ack.status).toBe(200);

    const result = await commandResponse;
    expect(result.status).toBe(200);
    expect(result.body.result).toEqual({ addedElementIds: ["one"] });
    const current = await bridge.request("GET", "/__draw/api/document");
    expect(current.body.document.elements).toHaveLength(1);
    expect(current.body.document.elements[0].id).toBe("one");
  });

  it("rejects document syncs from tabs that do not own the active canvas", async () => {
    const bridge = createBridgeHarness();
    const active = createEmptyDocument("Active tab");
    const stale = createEmptyDocument("Stale tab");
    await bridge.registerClient("tab-1");
    await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document: active });
    await bridge.registerClient("tab-2");

    const staleWrite = await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document: stale });

    expect(staleWrite.status).toBe(401);
    const current = await bridge.request("GET", "/__draw/api/document");
    expect(current.body.document.title).toBe("Active tab");
  });

  it("rejects caller-supplied takeover, sync, and command acknowledgements while accepting the active tab", async () => {
    const bridge = createBridgeHarness({ commandTimeoutMs: 1_000 });
    const active = createEmptyDocument("Authenticated tab");
    const initial = await bridge.registerClient("tab-1");
    expect(initial.response.status).toBe(200);
    expect((await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document: active })).status).toBe(200);

    expect((await bridge.request("PUT", "/__draw/api/client", { clientId: "attacker" })).status).toBe(401);
    expect((await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document: createEmptyDocument("Spoofed") })).status).toBe(401);

    const commandPromise = bridge.request("POST", "/__draw/api/commands", { operation: "create_diagram", input: { nodes: [{ id: "node", label: "Node", x: 0, y: 0 }], edges: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = bridge.events.find(({ event }) => event === "draw:mcp-command")?.data;
    expect(command?.clientId).toBe("tab-1");
    const ackBody = { id: command.id, clientId: "tab-1", document: active, result: { background: "white" } };
    const spoofedAck = await bridge.request("POST", `/__draw/api/commands/${command.id}/ack`, ackBody);
    expect(spoofedAck.status).toBe(401);
    const validAck = await bridge.editorRequest("tab-1", "POST", `/__draw/api/commands/${command.id}/ack`, ackBody);
    expect(validAck.status).toBe(200);
    expect((await commandPromise).status).toBe(200);

    const flushPromise = bridge.request("GET", "/__draw/api/document?flush=1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const flush = bridge.events.find(({ event }) => event === "draw:flush-document")?.data;
    const flushBody = { id: flush.id, clientId: "tab-1", document: active };
    expect((await bridge.request("POST", `/__draw/api/document/flush/${flush.id}`, flushBody)).status).toBe(401);
    expect((await bridge.editorRequest("tab-1", "POST", `/__draw/api/document/flush/${flush.id}`, flushBody)).status).toBe(200);
    expect((await flushPromise).status).toBe(200);

    const takeover = await bridge.registerClient("tab-2");
    expect(takeover.response.status).toBe(200);
    expect(bridge.events.some(({ event, data }) => event === "draw:editor-lease-revoked" && data.clientId === "tab-1")).toBe(true);
    expect((await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document: active })).status).toBe(401);
    const replacement = createEmptyDocument("Replacement tab");
    expect((await bridge.editorRequest("tab-2", "PUT", "/__draw/api/document", { clientId: "tab-2", document: replacement })).status).toBe(200);
    expect((await bridge.request("GET", "/__draw/api/document")).body.document.title).toBe("Replacement tab");
  });

  it("binds dirty-open confirmation tokens to the active document revision and consumes them once", async () => {
    const bridge = createBridgeHarness();
    const document = createEmptyDocument("Active canvas");
    document.document.elements.push({ id: "existing", type: "rectangle" });
    await bridge.registerClient("tab-1");
    await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document });
    const challengeResponse = await bridge.request("POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "a".repeat(64),
    });
    expect(challengeResponse.status).toBe(202);
    expect(challengeResponse.body.status).toBe("NEEDS_CONFIRMATION");
    const challenge = bridge.events.find(({ event }) => event === "draw:confirmation-required")?.data;
    expect(challenge).toMatchObject({ clientId: "tab-1", action: "open_document", filename: "incoming.draw" });

    expect((await bridge.editorRequest("tab-1", "POST", `/__draw/api/confirmations/${challengeResponse.body.confirmationToken}/respond`, { clientId: "tab-1", approved: true })).body.status).toBe("APPROVED");
    const changed = structuredClone(document);
    changed.document.documentRevision = 1;
    await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document: changed });
    const stale = await bridge.request("POST", `/__draw/api/confirmations/${challengeResponse.body.confirmationToken}/consume`, {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "a".repeat(64),
    });
    expect(stale.body.status).toBe("STALE");
    const reused = await bridge.request("POST", `/__draw/api/confirmations/${challengeResponse.body.confirmationToken}/consume`, {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "a".repeat(64),
    });
    expect(reused.body.status).toBe("EXPIRED");

    await bridge.registerClient("tab-1");
    const takeoverChallenge = await bridge.request("POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: changed.document.id, expectedDocumentRevision: 1,
      filename: "incoming.draw", fingerprint: "b".repeat(64),
    });
    await bridge.editorRequest("tab-1", "POST", `/__draw/api/confirmations/${takeoverChallenge.body.confirmationToken}/respond`, { clientId: "tab-1", approved: true });
    await bridge.registerClient("tab-2");
    const takenOver = await bridge.request("POST", `/__draw/api/confirmations/${takeoverChallenge.body.confirmationToken}/consume`, {
      action: "open_document", documentId: changed.document.id, expectedDocumentRevision: 1,
      filename: "incoming.draw", fingerprint: "b".repeat(64),
    });
    expect(takenOver.body.status).toBe("EXPIRED");
  });

  it("rejects unauthenticated self-approval while the authenticated browser editor can approve", async () => {
    const bridge = createBridgeHarness();
    const document = createEmptyDocument("Active canvas");
    await bridge.registerClient("active-tab");
    await bridge.editorRequest("active-tab", "PUT", "/__draw/api/document", { clientId: "active-tab", document });
    const challenge = await bridge.request("POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "c".repeat(64),
    });
    const spoofedApproval = await bridge.request("POST", `/__draw/api/confirmations/${challenge.body.confirmationToken}/respond`, {
      clientId: "active-tab", approved: true,
    });
    expect(spoofedApproval.status).toBe(401);
    expect((await bridge.request("POST", `/__draw/api/confirmations/${challenge.body.confirmationToken}/consume`, {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "c".repeat(64),
    })).body.status).toBe("PENDING");
    const browserApproval = await bridge.editorRequest("active-tab", "POST", `/__draw/api/confirmations/${challenge.body.confirmationToken}/respond`, {
      clientId: "active-tab", approved: true,
    });
    expect(browserApproval.body.status).toBe("APPROVED");
  });

  it("expires dirty-open confirmation tokens at the two-minute deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const bridge = createBridgeHarness();
      const document = createEmptyDocument("Active canvas");
      await bridge.registerClient("tab-1");
      await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document });
      const challenge = await bridge.request("POST", "/__draw/api/confirmations", {
        action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
        filename: "incoming.draw", fingerprint: "d".repeat(64),
      });
      vi.setSystemTime(Number(challenge.body.expiresAt) + 1);
      const expired = await bridge.request("POST", `/__draw/api/confirmations/${challenge.body.confirmationToken}/consume`, {
        action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
        filename: "incoming.draw", fingerprint: "d".repeat(64),
      });
      expect(expired.body.status).toBe("EXPIRED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the active tab before a freshness-requested canvas read", async () => {
    const bridge = createBridgeHarness({ flushTimeoutMs: 1_000 });
    const original = createEmptyDocument("Before edit");
    await bridge.registerClient("tab-1");
    await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document: original });

    const readPromise = bridge.request("GET", "/__draw/api/document?flush=1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = bridge.events.find(({ event }) => event === "draw:flush-document")?.data;
    expect(message).toMatchObject({ clientId: "tab-1" });

    const edited = structuredClone(original);
    edited.document.elements.push({ id: "immediate-edit", type: "rectangle" });
    const ack = await bridge.editorRequest("tab-1", "POST", `/__draw/api/document/flush/${message.id}`, {
      clientId: "tab-1", document: edited,
    });
    expect(ack.status).toBe(200);
    const read = await readPromise;
    expect(read.status).toBe(200);
    expect(read.body.document.elements[0].id).toBe("immediate-edit");
  });

  it("accepts a late acknowledgement after returning a timeout and tells callers to inspect before retrying", async () => {
    const bridge = createBridgeHarness({ commandTimeoutMs: 5, lateAckRetentionMs: 1_000 });
    const document = createEmptyDocument("MCP timeout");
    await bridge.registerClient("tab-1");
    await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document });
    const commandResponse = bridge.request("POST", "/__draw/api/commands", {
      operation: "create_diagram",
      input: { nodes: [{ id: "a", label: "A", x: 0, y: 0 }], edges: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = bridge.events.find(({ event }) => event === "draw:mcp-command")?.data;
    const timeout = await commandResponse;
    expect(timeout.status).toBe(504);
    expect(timeout.body.error).toMatch(/get_current_canvas.*before retrying/i);

    const lateDocument = structuredClone(document);
    lateDocument.document.elements.push({ id: "late-shape", type: "rectangle" });
    const ack = await bridge.editorRequest("tab-1", "POST", `/__draw/api/commands/${message.id}/ack`, {
      clientId: "tab-1",
      document: lateDocument,
      result: { addedElementIds: ["late-shape"] },
    });
    expect(ack.status).toBe(200);
    expect(ack.body.late).toBe(true);
    expect((await bridge.request("GET", "/__draw/api/document")).body.document.elements[0].id).toBe("late-shape");
  });

  it("returns a clear conflict when no canvas client is registered", async () => {
    const bridge = createBridgeHarness();
    const response = await bridge.request("POST", "/__draw/api/commands", {
      operation: "create_diagram",
      input: { nodes: [{ id: "a", label: "A", x: 0, y: 0 }], edges: [] },
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/open a draw document/i);
  });
});
