import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateIpcServer } from "./ipc";
import { requestDrawIpc } from "./ipc-client";

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
});
