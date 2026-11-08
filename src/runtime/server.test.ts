import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDrawRuntimeServer, type DrawRuntimeServer } from "./server";
import type { McpClientAuthState } from "../integrations/mcp-client-auth";
import { requestDrawIpc } from "./ipc-client";

describe("production Draw runtime", () => {
  const roots: string[] = [];
  const running: DrawRuntimeServer[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function startRuntime(bridgeOptions?: Parameters<typeof createDrawRuntimeServer>[0]["bridgeOptions"]) {
    const root = await mkdtemp(join(tmpdir(), "draw-runtime-test-"));
    roots.push(root);
    const dist = join(root, "dist");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dist));
    await writeFile(join(dist, "index.html"), "<!doctype html><title>production draw</title>");
    const server = await createDrawRuntimeServer({ distDirectory: dist, runtimeDirectory: join(root, "run"), ...(bridgeOptions ? { bridgeOptions } : {}) });
    running.push(server);
    return server;
  }

  it("serves the built UI on loopback and denies unauthenticated HTTP MCP operations", async () => {
    const server = await startRuntime();
    const home = await fetch(server.url);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("production draw");

    for (const [path, init] of [
      ["/__draw/api/document?flush=1", { method: "GET" }],
      ["/__draw/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "pair_mcp_client", input: {} }) }],
      ["/__draw/api/mcp/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }],
      ["/__draw/api/confirmations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }],
    ] as const) {
      const response = await fetch(new URL(path, server.url), init);
      expect(response.status, `${path} must not be callable over loopback HTTP`).toBe(403);
    }
    for (const path of ["/__draw/api/mcp/clients", "/__draw/api/mcp/pairing-secret"]) {
      const response = await fetch(new URL(path, server.url), {
        method: path.endsWith("pairing-secret") ? "POST" : "GET",
        headers: path.endsWith("pairing-secret") ? { "content-type": "application/json" } : {},
        ...(path.endsWith("pairing-secret") ? { body: "{}" } : {}),
      });
      expect(response.status, `${path} must require the active editor secret`).toBe(401);
      expect(await response.text()).not.toContain("clientIdentity");
    }
  });

  it("rejects loopback pairing attempts before touching paired-client lockout state", async () => {
    let loadCount = 0;
    let saveCount = 0;
    let state: McpClientAuthState = { failedAttempts: 0, lockedUntil: 0, clients: [] };
    const server = await startRuntime({
      mcpClientAuthForTests: {
        store: {
          load: async () => { loadCount += 1; return structuredClone(state); },
          save: async (next) => { saveCount += 1; state = structuredClone(next); },
        },
      },
    });
    const initializedLoads = loadCount;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(new URL("/__draw/api/mcp/pair", server.url), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingSecret: "wrong" }),
      });
      expect(response.status).toBe(403);
    }
    expect(loadCount).toBe(initializedLoads);
    expect(saveCount).toBe(0);
    expect(state).toMatchObject({ failedAttempts: 0, lockedUntil: 0, clients: [] });
  });

  it("accepts only MCP API traffic through the protected socket and rejects editor endpoints there", async () => {
    const server = await startRuntime();
    const response = await requestDrawIpc(server.socketPath, "/__draw/api/mcp/pair", {
      method: "POST", body: JSON.stringify({}),
    });
    expect(response.status).not.toBe(403);

    const editorResponse = await requestDrawIpc(server.socketPath, "/__draw/api/editor/bootstrap", {
      method: "POST", body: JSON.stringify({ clientId: "attacker", launchCode: "000000000000" }),
    });
    expect(editorResponse.status).toBe(403);
  });

  it("closes a superseded editor's production event stream after its lease is revoked", async () => {
    const launchCodes = ["AAAAAAAAAAAA", "BBBBBBBBBBBB"];
    let generatedSecrets = 0;
    const server = await startRuntime({
      editorAuthForTests: {
        displayLaunchCode: () => true,
        generateLaunchCode: () => launchCodes.shift() ?? "CCCCCCCCCCCC",
        generateSecret: () => `${++generatedSecrets}`.padStart(64, "a"),
        store: { load: async () => ({ failedAttempts: 0, lockedUntil: 0 }), save: async () => undefined },
      },
    });
    const origin = new URL(server.url).origin;
    const authenticate = async (clientId: string, launchCode: string) => {
      const response = await fetch(new URL("/__draw/api/editor/bootstrap", server.url), {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ clientId, launchCode }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ editorSecret: string }>;
    };
    const first = await authenticate("editor-one", "AAAAAAAAAAAA");
    const ticketResponse = await fetch(new URL("/__draw/api/events/ticket", server.url), {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-draw-editor-secret": first.editorSecret },
      body: "{}",
    });
    const { ticket } = await ticketResponse.json() as { ticket: string };
    const streamResponse = await fetch(new URL(`/__draw/api/events?ticket=${encodeURIComponent(ticket)}`, server.url), { headers: { origin } });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain(": connected");

    await authenticate("editor-two", "BBBBBBBBBBBB");
    const revoked = await reader.read();
    expect(revoked.done).toBe(false);
    expect(decoder.decode(revoked.value)).toContain("draw:editor-lease-revoked");
    const closed = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Superseded editor stream stayed open.")), 1_000);
      reader.read().then((result) => { clearTimeout(timeout); resolve(result); }, reject);
    });
    expect(closed.done).toBe(true);
  });
});
