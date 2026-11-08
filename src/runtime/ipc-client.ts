import { request as httpRequest } from "node:http";

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
  if (!path.startsWith("/__draw/api/") || path.startsWith("//") || /[\r\n]/.test(path)) {
    return Promise.reject(new Error("Draw IPC requests must use an absolute local API path."));
  }
  return new Promise((resolve, reject) => {
    const call = httpRequest({
      socketPath,
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
}
