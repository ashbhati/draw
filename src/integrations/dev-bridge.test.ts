import { Readable } from "node:stream";
import type { Plugin, ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/document";
import { createDrawMcpPlugin } from "./dev-bridge";

type CapturedResponse = { status: number; body: any };
type Middleware = (request: any, response: any, next: (error?: unknown) => void) => void;

function createBridgeHarness(plugin: Plugin) {
  let middleware: Middleware | undefined;
  const events: Array<{ event: string; data: any }> = [];
  const server = {
    config: { server: { port: 5173 } },
    middlewares: { use: (fn: Middleware) => (middleware = fn) },
    ws: { send: (event: string, data: unknown) => events.push({ event, data }) },
  } as unknown as ViteDevServer;
  if (typeof plugin.configureServer === "function") plugin.configureServer.call({} as never, server);
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

  return { request, events };
}

describe("Draw MCP Vite bridge", () => {
  it("only accepts loopback requests", async () => {
    const bridge = createBridgeHarness(createDrawMcpPlugin());
    const response = await bridge.request("GET", "/__draw/api/health", undefined, "192.168.1.2");
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/loopback/i);
  });

  it("rejects cross-origin browser requests and non-JSON mutations", async () => {
    const bridge = createBridgeHarness(createDrawMcpPlugin());
    const crossOrigin = await bridge.request("POST", "/__draw/api/commands", { operation: "update_elements", input: {} }, "127.0.0.1", { origin: "https://attacker.example" });
    expect(crossOrigin.status).toBe(403);
    const wrongType = await bridge.request("PUT", "/__draw/api/client", { clientId: "web" }, "127.0.0.1", { "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);
  });

  it("rejects matching attacker-controlled Host and Origin values", async () => {
    const bridge = createBridgeHarness(createDrawMcpPlugin());
    const response = await bridge.request("GET", "/__draw/api/health", undefined, "127.0.0.1", {
      host: "evil.example:5173",
      origin: "http://evil.example:5173",
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/configured loopback host/i);
  });

  it("delivers a command to the active canvas and stores its acknowledged scene", async () => {
    const bridge = createBridgeHarness(createDrawMcpPlugin({ commandTimeoutMs: 1_000 }));
    const document = createEmptyDocument("MCP test");
    expect((await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-1" })).status).toBe(200);
    expect((await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document })).status).toBe(200);

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
    const documentSync = await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document: updated });
    expect(documentSync.status).toBe(200);
    const ack = await bridge.request("POST", `/__draw/api/commands/${message.id}/ack`, {
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
    const bridge = createBridgeHarness(createDrawMcpPlugin());
    const active = createEmptyDocument("Active tab");
    const stale = createEmptyDocument("Stale tab");
    await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-1" });
    await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document: active });
    await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-2" });

    const staleWrite = await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document: stale });

    expect(staleWrite.status).toBe(409);
    const current = await bridge.request("GET", "/__draw/api/document");
    expect(current.body.document.title).toBe("Active tab");
  });

  it("binds dirty-open confirmation tokens to the active document revision and consumes them once", async () => {
    const bridge = createBridgeHarness(createDrawMcpPlugin());
    const document = createEmptyDocument("Active canvas");
    document.document.elements.push({ id: "existing", type: "rectangle" });
    await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-1" });
    await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document });
    const challengeResponse = await bridge.request("POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "a".repeat(64),
    });
    expect(challengeResponse.status).toBe(202);
    expect(challengeResponse.body.status).toBe("NEEDS_CONFIRMATION");
    const challenge = bridge.events.find(({ event }) => event === "draw:confirmation-required")?.data;
    expect(challenge).toMatchObject({ clientId: "tab-1", action: "open_document", filename: "incoming.draw" });

    expect((await bridge.request("POST", `/__draw/api/confirmations/${challengeResponse.body.confirmationToken}/respond`, { clientId: "tab-1", approved: true })).body.status).toBe("APPROVED");
    const changed = structuredClone(document);
    changed.document.documentRevision = 1;
    await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document: changed });
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

    await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-1" });
    const takeoverChallenge = await bridge.request("POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: changed.document.id, expectedDocumentRevision: 1,
      filename: "incoming.draw", fingerprint: "b".repeat(64),
    });
    await bridge.request("POST", `/__draw/api/confirmations/${takeoverChallenge.body.confirmationToken}/respond`, { clientId: "tab-1", approved: true });
    await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-2" });
    const takenOver = await bridge.request("POST", `/__draw/api/confirmations/${takeoverChallenge.body.confirmationToken}/consume`, {
      action: "open_document", documentId: changed.document.id, expectedDocumentRevision: 1,
      filename: "incoming.draw", fingerprint: "b".repeat(64),
    });
    expect(takenOver.body.status).toBe("STALE");
  });

  it("documents the known dev-bridge gap: a local caller can spoof the clientId approval UX guard", async () => {
    const bridge = createBridgeHarness(createDrawMcpPlugin());
    const document = createEmptyDocument("Active canvas");
    await bridge.request("PUT", "/__draw/api/client", { clientId: "active-tab" });
    await bridge.request("PUT", "/__draw/api/document", { clientId: "active-tab", document });
    const challenge = await bridge.request("POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "c".repeat(64),
    });
    // This is a deliberate vulnerability reproduction, not a security guarantee:
    // /__draw is loopback-only and the clientId is caller supplied. Issue #41 tracks auth.
    const spoofedApproval = await bridge.request("POST", `/__draw/api/confirmations/${challenge.body.confirmationToken}/respond`, {
      clientId: "active-tab", approved: true,
    });
    expect(spoofedApproval.body.status).toBe("APPROVED");
  });

  it("expires dirty-open confirmation tokens at the two-minute deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const bridge = createBridgeHarness(createDrawMcpPlugin());
      const document = createEmptyDocument("Active canvas");
      await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-1" });
      await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document });
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
    const bridge = createBridgeHarness(createDrawMcpPlugin({ flushTimeoutMs: 1_000 }));
    const original = createEmptyDocument("Before edit");
    await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-1" });
    await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document: original });

    const readPromise = bridge.request("GET", "/__draw/api/document?flush=1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = bridge.events.find(({ event }) => event === "draw:flush-document")?.data;
    expect(message).toMatchObject({ clientId: "tab-1" });

    const edited = structuredClone(original);
    edited.document.elements.push({ id: "immediate-edit", type: "rectangle" });
    const ack = await bridge.request("POST", `/__draw/api/document/flush/${message.id}`, {
      clientId: "tab-1", document: edited,
    });
    expect(ack.status).toBe(200);
    const read = await readPromise;
    expect(read.status).toBe(200);
    expect(read.body.document.elements[0].id).toBe("immediate-edit");
  });

  it("accepts a late acknowledgement after returning a timeout and tells callers to inspect before retrying", async () => {
    const bridge = createBridgeHarness(createDrawMcpPlugin({ commandTimeoutMs: 5, lateAckRetentionMs: 1_000 }));
    const document = createEmptyDocument("MCP timeout");
    await bridge.request("PUT", "/__draw/api/client", { clientId: "tab-1" });
    await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document });
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
    const ack = await bridge.request("POST", `/__draw/api/commands/${message.id}/ack`, {
      clientId: "tab-1",
      document: lateDocument,
      result: { addedElementIds: ["late-shape"] },
    });
    expect(ack.status).toBe(200);
    expect(ack.body.late).toBe(true);
    expect((await bridge.request("GET", "/__draw/api/document")).body.document.elements[0].id).toBe("late-shape");
  });

  it("returns a clear conflict when no canvas client is registered", async () => {
    const bridge = createBridgeHarness(createDrawMcpPlugin());
    const response = await bridge.request("POST", "/__draw/api/commands", {
      operation: "create_diagram",
      input: { nodes: [{ id: "a", label: "A", x: 0, y: 0 }], edges: [] },
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/open a draw document/i);
  });
});
