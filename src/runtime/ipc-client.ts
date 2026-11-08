import { request as httpRequest } from "node:http";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Stats } from "node:fs";
import { validateUnixSocketPath } from "./ipc-path";

export function validateClientSocketPath(socketPath: string, platform = process.platform): void {
  validateUnixSocketPath(socketPath, platform);
}

export function assertPrivateIpcMetadata(
  directoryInfo: Pick<Stats, "uid" | "mode" | "isSymbolicLink" | "isDirectory">,
  socketInfo: Pick<Stats, "uid" | "mode" | "isSymbolicLink" | "isSocket">,
  currentUid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): void {
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error("Draw IPC socket parent must be a real private directory.");
  if (socketInfo.isSymbolicLink() || !socketInfo.isSocket()) throw new Error("Draw IPC path is not a Unix socket.");
  if (currentUid !== null && (directoryInfo.uid !== currentUid || socketInfo.uid !== currentUid)) {
    throw new Error("Draw IPC socket and parent must be owned by the current OS user.");
  }
  if ((directoryInfo.mode & 0o077) !== 0 || (socketInfo.mode & 0o077) !== 0) {
    throw new Error("Draw IPC socket and parent must have private permissions (0700 directory and 0600 socket). Set DRAW_RUNTIME_DIR to a private per-user directory.");
  }
}

export type DrawIpcRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type DrawIpcResponse = { status: number; body: any };

export function requestDrawIpc(
  socketPath: string,
  path: string,
  options: DrawIpcRequestOptions = {},
  timeoutMs = 25_000,
): Promise<DrawIpcResponse> {
  const absoluteSocketPath = resolve(socketPath);
  try {
    validateClientSocketPath(absoluteSocketPath);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!path.startsWith("/__draw/api/") || path.startsWith("//") || /[\r\n]/.test(path)) {
    return Promise.reject(new Error("Draw IPC requests must use an absolute local API path."));
  }
  return (async () => {
    const [directoryInfo, socketInfo] = await Promise.all([lstat(dirname(absoluteSocketPath)), lstat(absoluteSocketPath)]);
    assertPrivateIpcMetadata(directoryInfo, socketInfo);
    return new Promise<DrawIpcResponse>((resolve, reject) => {
      const call = httpRequest({
        socketPath: absoluteSocketPath,
        path,
        method: options.method ?? "GET",
        headers: { host: "draw.local", ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: response.statusCode ?? 500, body: text ? JSON.parse(text) : {} });
          } catch {
            reject(new Error("Draw IPC returned an invalid JSON response."));
          }
        });
      });
      call.setTimeout(timeoutMs, () => call.destroy(new Error("Timed out waiting for the Draw runtime over local IPC.")));
      call.once("error", reject);
      call.end(options.body);
    });
  })();
}
