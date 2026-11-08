import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateIpcServer } from "./ipc";
import { validateUnixSocketPath } from "./ipc-path";

describe("Draw production MCP IPC", () => {
  const directories: string[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates a private per-user socket directory and a mode-0600 socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "draw-ipc-test-"));
    directories.push(root);
    const runtimeDirectory = join(root, "runtime");
    const endpoint = await createPrivateIpcServer(runtimeDirectory, (_request, response) => {
      response.end("ok");
    });
    servers.push(endpoint);

    expect((await lstat(runtimeDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(endpoint.socketPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(endpoint.socketPath)).isSocket()).toBe(true);
  });

  it("marks only requests accepted through the Unix socket as IPC-authenticated", async () => {
    const root = await mkdtemp(join(tmpdir(), "draw-ipc-request-test-"));
    directories.push(root);
    const endpoint = await createPrivateIpcServer(join(root, "runtime"), (request, response) => {
      response.end(String((request.socket as typeof request.socket & { drawTrustedIpc?: boolean }).drawTrustedIpc === true));
    });
    servers.push(endpoint);

    const result = await new Promise<string>((resolve, reject) => {
      const call = request({ socketPath: endpoint.socketPath, path: "/probe", method: "GET" }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      call.on("error", reject);
      call.end();
    });
    expect(result).toBe("true");
  });

  it("rejects a symlink as the runtime directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "draw-ipc-symlink-test-"));
    directories.push(root);
    const target = join(root, "target");
    const link = join(root, "link");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o700);
    await symlink(target, link);

    await expect(createPrivateIpcServer(link, () => undefined)).rejects.toThrow(/symlink/i);
  });

  it("rejects socket paths beyond the platform limit with runtime directory guidance", () => {
    const longPath = `/tmp/${"d".repeat(140)}/bridge.sock`;
    expect(() => validateUnixSocketPath(longPath, "darwin")).toThrow(/too long.*DRAW_RUNTIME_DIR/i);
    expect(() => validateUnixSocketPath(longPath, "linux")).toThrow(/too long.*DRAW_RUNTIME_DIR/i);
  });
});
