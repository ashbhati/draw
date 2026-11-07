import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/document";
import { createDrawMcpPlugin, type DrawMcpBridgeOptions } from "./dev-bridge";
import type { McpClientAuthState } from "./mcp-client-auth";

type CapturedResponse = { status: number; body: any };
type Middleware = (request: any, response: any, next: (error?: unknown) => void) => void;

function createBridgeHarness(options: DrawMcpBridgeOptions = {}, config: { mode?: string; host?: string; isProduction?: boolean; useFileStore?: boolean; extraMcpClients?: Array<{ identity: string; capability: string }> } = {}) {
  let middleware: Middleware | undefined;
  const events: Array<{ event: string; data: any }> = [];
  let launchCode = "";
  const sessions = new Map<string, { clientId: string; editorSecret: string }>();
  let authState = { failedAttempts: 0, lockedUntil: 0 };
  const mcpCapability = "f".repeat(64);
  let mcpState: McpClientAuthState = {
    failedAttempts: 0,
    lockedUntil: 0,
    clients: [
      { clientIdentity: "test-mcp-client", name: "Test MCP", fingerprint: "a".repeat(64), secretHash: createHash("sha256").update(mcpCapability).digest("hex"), createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, revokedAt: null },
      ...(config.extraMcpClients ?? []).map(({ identity, capability }, index) => ({ clientIdentity: identity, name: identity, fingerprint: `${index + 1}`.repeat(64), secretHash: createHash("sha256").update(capability).digest("hex"), createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, revokedAt: null })),
    ],
  };
  const injectedAuth = config.useFileStore ? {} : { editorAuthForTests: {
    displayLaunchCode: (code: string) => { launchCode = code; return true; },
    store: { load: async () => ({ ...authState }), save: async (state: { failedAttempts: number; lockedUntil: number }) => { authState = { ...state }; } },
  } };
  const bridgePlugin = createDrawMcpPlugin({ ...options, ...injectedAuth, mcpClientAuthForTests: options.mcpClientAuthForTests ?? {
    generatePairingCode: () => "a".repeat(64), generateIdentity: () => "paired-client", generateCapability: () => "b".repeat(64), generateRequestId: () => "pair-request-1",
    store: { load: async () => structuredClone(mcpState), save: async (state: typeof mcpState) => { mcpState = structuredClone(state); } },
  } });
  const server = {
    config: { mode: config.mode ?? "development", isProduction: config.isProduction ?? false, server: { port: 5173, host: config.host ?? "127.0.0.1" }, logger: { warn: vi.fn() } },
    httpServer: { once: vi.fn() },
    middlewares: { use: (fn: Middleware) => (middleware = fn) },
    ws: { send: (event: string, data: unknown) => events.push({ event, data }) },
  } as unknown as ViteDevServer;
  if (typeof bridgePlugin.configureServer === "function") bridgePlugin.configureServer.call({} as never, server);
  if (!middleware) throw new Error("Plugin did not register middleware.");

  const request = (method: string, path: string, body?: unknown, remoteAddress = "127.0.0.1", headers: Record<string, string> = {}, paired = true) => {
    return new Promise<CapturedResponse>((resolve, reject) => {
      const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
        method,
        url: path,
        headers: { host: "127.0.0.1:5173", "content-type": "application/json", ...(paired ? { "x-draw-client-identity": "test-mcp-client", authorization: `Bearer ${mcpCapability}` } : {}), ...headers },
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
    return request(method, path, body, "127.0.0.1", { origin: "http://127.0.0.1:5173", "x-draw-editor-secret": session.editorSecret });
  };
  const reissueCode = () => request("POST", "/__draw/api/editor/reissue-code", {}, "127.0.0.1", { origin: "http://127.0.0.1:5173" });
  const mcpRequest = (identity: string, capability: string, method: string, path: string, body?: unknown) => request(method, path, body, "127.0.0.1", { "x-draw-client-identity": identity, authorization: `Bearer ${capability}` }, false);
  return { request, editorRequest, registerClient, reissueCode, mcpRequest, events, getLaunchCode: () => launchCode, getSession: (clientId: string) => sessions.get(clientId) };
}

describe("Draw MCP Vite bridge", () => {
  it("rejects unpaired local processes on document, confirmation, and command routes", async () => {
    const bridge = createBridgeHarness();
    const commandCount = bridge.events.length;
    expect((await bridge.request("GET", "/__draw/api/document", undefined, "127.0.0.1", {}, false)).status).toBe(401);
    expect((await bridge.request("POST", "/__draw/api/confirmations", {}, "127.0.0.1", {}, false)).status).toBe(401);
    expect((await bridge.request("POST", "/__draw/api/commands", { operation: "create_diagram", input: {} }, "127.0.0.1", {}, false)).status).toBe(401);
    expect(bridge.events).toHaveLength(commandCount);
  });

  it("uses the same MCP authentication failure for wrong and unknown identities", async () => {
    const bridge = createBridgeHarness();
    const knownIdWrongToken = await bridge.request("GET", "/__draw/api/document", undefined, "127.0.0.1", {
      "x-draw-client-identity": "test-mcp-client", authorization: `Bearer ${"0".repeat(64)}`,
    });
    const unknownIdKnownToken = await bridge.request("GET", "/__draw/api/document", undefined, "127.0.0.1", {
      "x-draw-client-identity": "unknown-client", authorization: `Bearer ${"f".repeat(64)}`,
    });
    expect(knownIdWrongToken.status).toBe(401);
    expect(unknownIdKnownToken).toEqual(knownIdWrongToken);
  });

  it("pairs only after approval by the active authenticated editor and keeps revocation separate from the editor lease", async () => {
    const bridge = createBridgeHarness();
    expect((await bridge.registerClient("pairing-tab")).response.status).toBe(200);
    const secretResponse = await bridge.editorRequest("pairing-tab", "POST", "/__draw/api/mcp/pairing-secret", {});
    expect(secretResponse.status).toBe(200);
    const pairing = bridge.request("POST", "/__draw/api/mcp/pair", {
      pairingSecret: secretResponse.body.pairingSecret,
      clientName: "Claude Code",
      fingerprint: "9".repeat(64),
    }, "127.0.0.1", {}, false);
    await new Promise((resolve) => setImmediate(resolve));
    const requestEvent = bridge.events.find((event) => event.event === "draw:mcp-pairing-required");
    expect(requestEvent?.data).toMatchObject({ clientId: "pairing-tab", name: "Claude Code", fingerprint: "9".repeat(64) });
    expect((await bridge.request("POST", `/__draw/api/mcp/pairings/${requestEvent!.data.requestId}/respond`, { clientId: "pairing-tab", approved: true }, "127.0.0.1", {}, false)).status).toBe(401);
    expect((await bridge.editorRequest("pairing-tab", "POST", `/__draw/api/mcp/pairings/${requestEvent!.data.requestId}/respond`, { clientId: "pairing-tab", approved: true })).body.status).toBe("APPROVED");
    const paired = await pairing;
    expect(paired.status).toBe(200);
    expect(paired.body.clientIdentity).toBe("paired-client");
    expect(paired.body.capability).toBe("b".repeat(64));
    expect((await bridge.request("GET", "/__draw/api/document", undefined, "127.0.0.1", {
      "x-draw-client-identity": paired.body.clientIdentity, authorization: `Bearer ${paired.body.capability}`,
    })).status).toBe(404);

    expect((await bridge.editorRequest("pairing-tab", "DELETE", `/__draw/api/mcp/clients/${paired.body.clientIdentity}`)).body.revoked).toBe(true);
    expect((await bridge.request("GET", "/__draw/api/document", undefined, "127.0.0.1", {
      "x-draw-client-identity": paired.body.clientIdentity, authorization: `Bearer ${paired.body.capability}`,
    })).status).toBe(401);
    expect((await bridge.editorRequest("pairing-tab", "PUT", "/__draw/api/document", { clientId: "pairing-tab", document: createEmptyDocument("Editor remains connected") })).status).toBe(200);
  });

  it("does not consume a pairing code when no editor is connected", async () => {
    const bridge = createBridgeHarness();
    const unavailable = await bridge.request("POST", "/__draw/api/mcp/pair", {
      pairingSecret: "a".repeat(64), clientName: "MCP host", fingerprint: "9".repeat(64),
    }, "127.0.0.1", {}, false);
    expect(unavailable.status).toBe(409);
    expect((await bridge.registerClient("connected-tab")).response.status).toBe(200);
    const code = await bridge.editorRequest("connected-tab", "POST", "/__draw/api/mcp/pairing-secret", {});
    expect(code.status).toBe(200);
    expect(code.body.pairingSecret).toMatch(/^[a-f\d]{64}$/i);
  });

  it("binds pending commands and flushes to the authenticated MCP identity and cancels them on revocation", async () => {
    const capabilityA = "a".repeat(64);
    const capabilityB = "b".repeat(64);
    const bridge = createBridgeHarness({ commandTimeoutMs: 1_000, flushTimeoutMs: 1_000 }, {
      extraMcpClients: [{ identity: "client-A", capability: capabilityA }, { identity: "client-B", capability: capabilityB }],
    });
    const document = createEmptyDocument("Identity-bound work");
    await bridge.registerClient("editor-tab");
    await bridge.editorRequest("editor-tab", "PUT", "/__draw/api/document", { clientId: "editor-tab", document });

    const commandA = bridge.mcpRequest("client-A", capabilityA, "POST", "/__draw/api/commands", { operation: "create_diagram", input: { nodes: [{ id: "a", label: "A", x: 0, y: 0 }], edges: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    const eventA = bridge.events.find(({ event }) => event === "draw:mcp-command")?.data;
    expect(eventA).toMatchObject({ clientIdentity: "client-A" });

    const flushA = bridge.mcpRequest("client-A", capabilityA, "GET", "/__draw/api/document?flush=1");
    await new Promise((resolve) => setImmediate(resolve));
    const flushEventA = bridge.events.find(({ event }) => event === "draw:flush-document")?.data;
    expect(flushEventA).toMatchObject({ clientIdentity: "client-A" });

    expect((await bridge.editorRequest("editor-tab", "DELETE", "/__draw/api/mcp/clients/client-A")).body.revoked).toBe(true);
    expect((await commandA).status).toBe(401);
    expect((await flushA).status).toBe(401);
    expect((await bridge.editorRequest("editor-tab", "POST", `/__draw/api/commands/${eventA.id}/ack`, {
      id: eventA.id, clientId: "editor-tab", clientIdentity: "client-A", document,
    })).status).toBe(410);
    expect((await bridge.mcpRequest("client-B", capabilityB, "GET", "/__draw/api/document")).body).toEqual(document);
    expect((await bridge.editorRequest("editor-tab", "POST", `/__draw/api/document/flush/${flushEventA.id}`, {
      id: flushEventA.id, clientId: "editor-tab", clientIdentity: "client-A", document,
    })).status).toBe(404);

    const commandB = bridge.mcpRequest("client-B", capabilityB, "POST", "/__draw/api/commands", { operation: "create_diagram", input: { nodes: [{ id: "b", label: "B", x: 0, y: 0 }], edges: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    const eventB = bridge.events.filter(({ event }) => event === "draw:mcp-command").at(-1)?.data;
    expect(eventB).toMatchObject({ clientIdentity: "client-B" });
    expect((await bridge.editorRequest("editor-tab", "POST", `/__draw/api/commands/${eventB.id}/ack`, {
      id: eventB.id, clientId: "editor-tab", clientIdentity: "client-B", document, result: { ok: true },
    })).status).toBe(200);
    expect((await commandB).status).toBe(200);
    expect((await bridge.editorRequest("editor-tab", "PUT", "/__draw/api/document", { clientId: "editor-tab", document })).status).toBe(200);
  });

  it("cancels old MCP commands and confirmation when approval replaces the same fingerprint", async () => {
    const bridge = createBridgeHarness({ commandTimeoutMs: 1_000 });
    const document = createEmptyDocument("Replace paired host");
    await bridge.registerClient("editor-tab");
    await bridge.editorRequest("editor-tab", "PUT", "/__draw/api/document", { clientId: "editor-tab", document });
    const oldCommand = bridge.request("POST", "/__draw/api/commands", {
      operation: "create_diagram", input: { nodes: [{ id: "old", label: "Old", x: 0, y: 0 }], edges: [] },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const oldCommandEvent = bridge.events.find(({ event }) => event === "draw:mcp-command")?.data;
    const confirmation = await bridge.request("POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "c".repeat(64),
    });
    expect(confirmation.status).toBe(202);

    const pairingSecret = await bridge.editorRequest("editor-tab", "POST", "/__draw/api/mcp/pairing-secret", {});
    const replacementPairing = bridge.request("POST", "/__draw/api/mcp/pair", {
      pairingSecret: pairingSecret.body.pairingSecret, clientName: "Replacement host", fingerprint: "a".repeat(64),
    }, "127.0.0.1", {}, false);
    await new Promise((resolve) => setImmediate(resolve));
    const pairingEvent = bridge.events.filter(({ event }) => event === "draw:mcp-pairing-required").slice(-1)[0]?.data;
    expect(pairingEvent).toMatchObject({ replacesName: "Test MCP" });
    expect((await bridge.editorRequest("editor-tab", "POST", `/__draw/api/mcp/pairings/${pairingEvent.requestId}/respond`, {
      clientId: "editor-tab", approved: true,
    })).body.status).toBe("APPROVED");

    const replacement = await replacementPairing;
    expect(replacement.status).toBe(200);
    expect((await oldCommand).status).toBe(401);
    expect((await bridge.request("POST", `/__draw/api/confirmations/${confirmation.body.confirmationToken}/consume`, {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "c".repeat(64),
    })).status).toBe(401);
    expect((await bridge.editorRequest("editor-tab", "POST", `/__draw/api/commands/${oldCommandEvent.id}/ack`, {
      id: oldCommandEvent.id, clientId: "editor-tab", clientIdentity: "test-mcp-client", document,
    })).status).toBe(410);
    expect(bridge.events.some(({ event, data }) => event === "draw:confirmation-revoked" && data.token === confirmation.body.confirmationToken)).toBe(true);
    expect(bridge.events.some(({ event, data }) => event === "draw:mcp-client-revoked" && data.clientIdentity === "test-mcp-client")).toBe(true);
  });

  it("binds dirty-open confirmations to their creator and removes them on revocation", async () => {
    const capabilityA = "a".repeat(64);
    const capabilityB = "b".repeat(64);
    const bridge = createBridgeHarness({}, {
      extraMcpClients: [{ identity: "client-A", capability: capabilityA }, { identity: "client-B", capability: capabilityB }],
    });
    const document = createEmptyDocument("Active confirmation canvas");
    await bridge.registerClient("editor-tab");
    await bridge.editorRequest("editor-tab", "PUT", "/__draw/api/document", { clientId: "editor-tab", document });
    const challenge = await bridge.mcpRequest("client-A", capabilityA, "POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "incoming.draw", fingerprint: "c".repeat(64),
    });
    expect(challenge.status).toBe(202);
    expect(bridge.events.find(({ event }) => event === "draw:confirmation-required")?.data).toMatchObject({ clientIdentity: "client-A" });
    const consumeBody = { action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0, filename: "incoming.draw", fingerprint: "c".repeat(64) };
    expect((await bridge.mcpRequest("client-B", capabilityB, "POST", `/__draw/api/confirmations/${challenge.body.confirmationToken}/consume`, consumeBody)).status).toBe(404);
    expect((await bridge.mcpRequest("client-A", capabilityA, "POST", `/__draw/api/confirmations/${challenge.body.confirmationToken}/consume`, consumeBody)).body.status).toBe("PENDING");
    expect((await bridge.editorRequest("editor-tab", "DELETE", "/__draw/api/mcp/clients/client-A")).body.revoked).toBe(true);
    expect((await bridge.mcpRequest("client-A", capabilityA, "POST", `/__draw/api/confirmations/${challenge.body.confirmationToken}/consume`, consumeBody)).status).toBe(401);
    expect(bridge.events.some(({ event, data }) => event === "draw:confirmation-revoked" && data.token === challenge.body.confirmationToken)).toBe(true);
    expect((await bridge.mcpRequest("client-B", capabilityB, "GET", "/__draw/api/document")).status).toBe(200);
  });

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

    const active = await bridge.registerClient("host-check-tab");
    expect(active.response.status).toBe(200);
    const document = createEmptyDocument("Host check");
    await bridge.editorRequest("host-check-tab", "PUT", "/__draw/api/document", { clientId: "host-check-tab", document });
    const forgedOriginWithSecret = await bridge.request("PUT", "/__draw/api/document", { clientId: "host-check-tab", document }, "127.0.0.1", {
      host: "127.0.0.1:5173", origin: "http://attacker.example", "x-draw-editor-secret": active.session!.editorSecret,
    });
    expect(forgedOriginWithSecret.status).toBe(403);
    const forgedHostWithSecret = await bridge.request("PUT", "/__draw/api/document", { clientId: "host-check-tab", document }, "127.0.0.1", {
      host: "evil.example:5173", origin: "http://evil.example:5173", "x-draw-editor-secret": active.session!.editorSecret,
    });
    expect(forgedHostWithSecret.status).toBe(403);
  });

  it("enables the isolated E2E provider only on loopback in test mode and writes lockout state only under temp", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-e2e-auth-isolation-"));
    const statePath = join(directory, "e2e-auth-state.json");
    const fallbackConfig = join(directory, "fallback-config");
    vi.stubEnv("DRAW_E2E_EDITOR_CODE", "ABCDEF123456");
    vi.stubEnv("DRAW_E2E_AUTH_STATE_PATH", statePath);
    vi.stubEnv("XDG_CONFIG_HOME", fallbackConfig);
    try {
      for (const config of [
        { mode: "development", host: "127.0.0.1" },
        { mode: "e2e", host: "0.0.0.0" },
        { mode: "e2e", host: "127.0.0.1", isProduction: true },
      ]) {
        const disabled = createBridgeHarness({}, { ...config, useFileStore: true });
        const response = await disabled.request("POST", "/__draw/api/editor/bootstrap", { clientId: "tab", launchCode: "ABCDEF123456" });
        expect(response.status).toBe(503);
        expect(response.body.status).toBe("UNAVAILABLE");
        expect((await disabled.request("GET", "/__draw/api/e2e/active-launch-code", undefined, "127.0.0.1", { origin: "http://127.0.0.1:5173" })).status).toBe(404);
      }

      const e2e = createBridgeHarness({}, { mode: "e2e", host: "127.0.0.1", useFileStore: true });
      expect((await e2e.request("GET", "/__draw/api/e2e/active-launch-code", undefined, "127.0.0.1", { origin: "http://127.0.0.1:5173" })).status).toBe(200);
      expect((await e2e.request("GET", "/__draw/api/e2e/active-launch-code")).status).toBe(403);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await e2e.request("POST", "/__draw/api/editor/bootstrap", { clientId: "attacker", launchCode: "WRONG0000000" });
        expect(response.status).toBe(attempt === 4 ? 429 : 401);
      }
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ failedAttempts: 5 });
      await expect(access(join(fallbackConfig, "draw", "editor-auth-state.json"))).rejects.toThrow();
      expect(e2e.events).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
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
    expect(message.clientIdentity).toBe("test-mcp-client");
    expect(message.id).toBeTruthy();

    const updated = structuredClone(document);
    updated.document.elements.push({ id: "one", type: "rectangle", x: 0, y: 0 });
    const documentSync = await bridge.editorRequest("tab-1", "PUT", "/__draw/api/document", { clientId: "tab-1", document: updated });
    expect(documentSync.status).toBe(200);
    const ack = await bridge.editorRequest("tab-1", "POST", `/__draw/api/commands/${message.id}/ack`, {
      id: message.id,
      clientId: "tab-1",
      clientIdentity: message.clientIdentity,
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
    expect((await bridge.request("PUT", "/__draw/api/document", { clientId: "tab-1", document: createEmptyDocument("Wrong token") }, "127.0.0.1", { "x-draw-editor-secret": "b".repeat(64) })).status).toBe(401);

    const commandPromise = bridge.request("POST", "/__draw/api/commands", { operation: "create_diagram", input: { nodes: [{ id: "node", label: "Node", x: 0, y: 0 }], edges: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = bridge.events.find(({ event }) => event === "draw:mcp-command")?.data;
    expect(command?.clientId).toBe("tab-1");
    const ackBody = { id: command.id, clientId: "tab-1", clientIdentity: command.clientIdentity, document: active, result: { background: "white" } };
    const spoofedAck = await bridge.request("POST", `/__draw/api/commands/${command.id}/ack`, ackBody);
    expect(spoofedAck.status).toBe(401);
    const wrongSecretAck = await bridge.request("POST", `/__draw/api/commands/${command.id}/ack`, ackBody, "127.0.0.1", { "x-draw-editor-secret": "c".repeat(64) });
    expect(wrongSecretAck.status).toBe(401);
    const forgedHostAck = await bridge.request("POST", `/__draw/api/commands/${command.id}/ack`, ackBody, "127.0.0.1", {
      host: "evil.example:5173", origin: "http://evil.example:5173", "x-draw-editor-secret": bridge.getSession("tab-1")?.editorSecret ?? "",
    });
    expect(forgedHostAck.status).toBe(403);
    const validAck = await bridge.editorRequest("tab-1", "POST", `/__draw/api/commands/${command.id}/ack`, ackBody);
    expect(validAck.status).toBe(200);
    expect((await commandPromise).status).toBe(200);

    const flushPromise = bridge.request("GET", "/__draw/api/document?flush=1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const flush = bridge.events.find(({ event }) => event === "draw:flush-document")?.data;
    const flushBody = { id: flush.id, clientId: "tab-1", clientIdentity: flush.clientIdentity, document: active };
    expect((await bridge.request("POST", `/__draw/api/document/flush/${flush.id}`, flushBody)).status).toBe(401);
    expect((await bridge.request("POST", `/__draw/api/document/flush/${flush.id}`, flushBody, "127.0.0.1", { "x-draw-editor-secret": "d".repeat(64) })).status).toBe(401);
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

  it("keeps an authenticated editor and its pending work alive through five junk bootstrap requests", async () => {
    const bridge = createBridgeHarness({ commandTimeoutMs: 1_000, flushTimeoutMs: 1_000 });
    const document = createEmptyDocument("Live authenticated tab");
    const registered = await bridge.registerClient("live-tab");
    expect(registered.response.status).toBe(200);
    await bridge.editorRequest("live-tab", "PUT", "/__draw/api/document", { clientId: "live-tab", document });

    const pendingCommand = bridge.request("POST", "/__draw/api/commands", {
      operation: "create_diagram", input: { nodes: [{ id: "pending", label: "Pending", x: 0, y: 0 }], edges: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = bridge.events.find(({ event }) => event === "draw:mcp-command")?.data;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await bridge.request("POST", "/__draw/api/editor/bootstrap", { clientId: "attacker", launchCode: "000000000000" });
      expect(response.status).toBe(attempt === 4 ? 429 : 401);
    }
    expect(bridge.events.some(({ event, data }) => event === "draw:editor-lease-revoked" && data.clientId === "live-tab")).toBe(false);
    expect((await bridge.editorRequest("live-tab", "PUT", "/__draw/api/document", { clientId: "live-tab", document })).status).toBe(200);
    expect((await bridge.editorRequest("live-tab", "POST", `/__draw/api/commands/${command.id}/ack`, {
      id: command.id, clientId: "live-tab", clientIdentity: command.clientIdentity, document, result: { survived: true },
    })).status).toBe(200);
    expect((await pendingCommand).body.result).toEqual({ survived: true });

    const confirmation = await bridge.request("POST", "/__draw/api/confirmations", {
      action: "open_document", documentId: document.document.id, expectedDocumentRevision: 0,
      filename: "preserve.draw", fingerprint: "e".repeat(64),
    });
    const token = confirmation.body.confirmationToken;
    expect((await bridge.request("POST", `/__draw/api/confirmations/${token}/respond`, { clientId: "live-tab", approved: true })).status).toBe(401);
    expect((await bridge.request("POST", `/__draw/api/confirmations/${token}/respond`, { clientId: "live-tab", approved: true }, "127.0.0.1", { "x-draw-editor-secret": "f".repeat(64) })).status).toBe(401);
    expect((await bridge.editorRequest("live-tab", "POST", `/__draw/api/confirmations/${token}/respond`, { clientId: "live-tab", approved: true })).body.status).toBe("APPROVED");
  });

  it("reprints the active code without rotating it, throttles repeated reissue, and keeps it off HTTP", async () => {
    const bridge = createBridgeHarness();
    const initial = await bridge.registerClient("tab-a");
    expect(initial.response.status).toBe(200);
    const activeSecret = initial.session!.editorSecret;
    const oldCode = bridge.getLaunchCode();
    expect((await bridge.request("POST", "/__draw/api/editor/reissue-code", {})).status).toBe(403);

    const requested = await bridge.reissueCode();
    expect(requested.status).toBe(200);
    expect(requested.body).toEqual({ status: "ISSUED" });
    const freshCode = bridge.getLaunchCode();
    expect(freshCode).toBe(oldCode);
    expect(JSON.stringify(requested.body)).not.toContain(freshCode);
    expect((await bridge.editorRequest("tab-a", "PUT", "/__draw/api/document", { clientId: "tab-a", document: createEmptyDocument("Still active") })).status).toBe(200);

    const repeated = await bridge.reissueCode();
    expect(repeated.status).toBe(429);
    expect(repeated.body.status).toBe("THROTTLED");
    expect(bridge.getLaunchCode()).toBe(oldCode);

    const takeover = await bridge.registerClient("tab-b");
    expect(takeover.response.status).toBe(200);
    expect((await bridge.editorRequest("tab-a", "PUT", "/__draw/api/document", { clientId: "tab-a", document: createEmptyDocument("Revoked") })).status).toBe(401);
    expect(takeover.session?.editorSecret).not.toBe(activeSecret);
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
    expect(message.clientIdentity).toBe("test-mcp-client");

    const edited = structuredClone(original);
    edited.document.elements.push({ id: "immediate-edit", type: "rectangle" });
    const ack = await bridge.editorRequest("tab-1", "POST", `/__draw/api/document/flush/${message.id}`, {
      clientId: "tab-1", clientIdentity: message.clientIdentity, document: edited,
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
      clientIdentity: message.clientIdentity,
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
