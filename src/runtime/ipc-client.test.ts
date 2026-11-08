import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateIpcServer } from "./ipc";
import { requestDrawIpc } from "./ipc-client";
import { assertPrivateIpcMetadata, validateClientSocketPath } from "./ipc-client";

describe("MCP Unix-socket request transport", () => {
  const roots: string[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("sends JSON MCP requests through IPC and returns parsed status and body", async () => {
    const root = await mkdtemp(join(tmpdir(), "draw-ipc-client-test-"));
    roots.push(root);
    const endpoint = await createPrivateIpcServer(join(root, "runtime"), async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, method: request.method, body: Buffer.concat(chunks).toString("utf8") }));
    });
    servers.push(endpoint);

    const result = await requestDrawIpc(endpoint.socketPath, "/__draw/api/commands", {
      method: "POST",
      body: JSON.stringify({ operation: "create_diagram" }),
      headers: { "x-draw-client-identity": "client-1", authorization: "Bearer capability" },
    }, 1_000);
    expect(result).toEqual({
      status: 201,
      body: { path: "/__draw/api/commands", method: "POST", body: JSON.stringify({ operation: "create_diagram" }) },
    });
  });

  it("rejects paths that could escape the API root", async () => {
    await expect(requestDrawIpc("/tmp/unused.sock", "//example.com/path")).rejects.toThrow(/absolute local API path/i);
  });

  it("rejects overlong socket paths before connecting and suggests DRAW_RUNTIME_DIR", async () => {
    const longPath = `/tmp/${"d".repeat(140)}/bridge.sock`;
    expect(() => validateClientSocketPath(longPath, "darwin")).toThrow(/too long.*DRAW_RUNTIME_DIR/i);
    expect(() => validateClientSocketPath(longPath, "linux")).toThrow(/too long.*DRAW_RUNTIME_DIR/i);
    await expect(requestDrawIpc(longPath, "/__draw/api/document")).rejects.toThrow(/DRAW_RUNTIME_DIR/i);
  });

  it("rejects an IPC endpoint owned by another user or with open permissions", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const directory = { uid, mode: 0o40700, isSymbolicLink: () => false, isDirectory: () => true };
    const socket = { uid, mode: 0o140600, isSymbolicLink: () => false, isSocket: () => true };
    expect(() => assertPrivateIpcMetadata(directory, socket, uid)).not.toThrow();
    expect(() => assertPrivateIpcMetadata({ ...directory, uid: uid + 1 }, socket, uid)).toThrow(/owned by the current OS user/i);
    expect(() => assertPrivateIpcMetadata({ ...directory, mode: 0o40755 }, socket, uid)).toThrow(/private/i);
    expect(() => assertPrivateIpcMetadata(directory, { ...socket, mode: 0o140666 }, uid)).toThrow(/private/i);
  });

  it("checks socket directory permissions before transmitting authorization headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "draw-ipc-private-check-"));
    roots.push(root);
    let requests = 0;
    const runtimeDirectory = join(root, "runtime");
    const endpoint = await createPrivateIpcServer(runtimeDirectory, (_request, response) => {
      requests += 1;
      response.end("{}");
    });
    servers.push(endpoint);
    await chmod(runtimeDirectory, 0o755);

    await expect(requestDrawIpc(endpoint.socketPath, "/__draw/api/commands", {
      method: "POST", body: "{}", headers: { authorization: "Bearer sensitive-capability" },
    })).rejects.toThrow(/private permissions/i);
    expect(requests).toBe(0);
  });
});
