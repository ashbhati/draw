import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { validateUnixSocketPath } from "./ipc-path";

export type DrawIpcHandler = (request: IncomingMessage, response: ServerResponse) => void;

export type PrivateIpcServer = {
  socketPath: string;
  close: () => Promise<void>;
};

export function getDefaultDrawRuntimeDirectory(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Draw", "run");
  if (platform === "linux") return join(env.XDG_RUNTIME_DIR || join(homedir(), ".local", "run"), "draw");
  throw new Error(`Draw's packaged MCP runtime currently supports macOS and Linux, not ${platform}.`);
}

/**
 * Listen on a private Unix socket for the local MCP host. The socket's parent
 * directory is restricted to the current OS user and the socket is mode 0600.
 * This keeps other local accounts and all loopback TCP clients outside the
 * MCP trust boundary; processes running as the same OS user remain trusted.
 */
export async function createPrivateIpcServer(runtimeDirectory: string, handler: DrawIpcHandler): Promise<PrivateIpcServer> {
  if (runtimeDirectory.includes("\0")) throw new Error("Invalid Draw runtime directory.");
  const absoluteRuntimeDirectory = resolve(runtimeDirectory);
  const socketPath = join(absoluteRuntimeDirectory, "bridge.sock");
  validateUnixSocketPath(socketPath);
  await mkdir(absoluteRuntimeDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(absoluteRuntimeDirectory);
  if (directoryInfo.isSymbolicLink()) throw new Error("Draw runtime directory must not be a symlink.");
  if (!directoryInfo.isDirectory()) throw new Error("Draw runtime path must be a directory.");
  if (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()) {
    throw new Error("Draw runtime directory must be owned by the current OS user.");
  }
  await chmod(absoluteRuntimeDirectory, 0o700);

  const existingSocket = await lstat(socketPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existingSocket) {
    if (existingSocket.isSymbolicLink() || !existingSocket.isSocket()) throw new Error("Draw IPC socket path is occupied by a non-socket file.");
    const { createConnection } = await import("node:net");
    const active = await new Promise<boolean>((resolveConnection) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); resolveConnection(true); });
      probe.once("error", (error: NodeJS.ErrnoException) => resolveConnection(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"));
    });
    if (active) throw new Error("A Draw runtime already owns this IPC socket. Close it before starting another instance.");
    await rm(socketPath, { force: true });
  }
  const server = createServer(handler);
  server.on("connection", (socket) => { (socket as typeof socket & { drawTrustedIpc?: boolean }).drawTrustedIpc = true; });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  try {
    await chmod(socketPath, 0o600);
    const socketInfo = await lstat(socketPath);
    if (!socketInfo.isSocket() || (typeof process.getuid === "function" && socketInfo.uid !== process.getuid())) {
      throw new Error("Draw IPC socket ownership could not be verified.");
    }
  } catch (error) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(socketPath, { force: true });
    throw error;
  }

  let closed = false;
  return {
    socketPath,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await rm(socketPath, { force: true });
    },
  };
}
