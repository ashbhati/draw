import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { createDrawMcpPlugin, isMcpOnlyRoute, type DrawMcpBridgeOptions } from "../integrations/dev-bridge";
import { createPrivateIpcServer, getDefaultDrawRuntimeDirectory } from "./ipc";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export type DrawRuntimeServer = {
  url: string;
  socketPath: string;
  close: () => Promise<void>;
};

export type DrawRuntimeServerOptions = {
  distDirectory: string;
  runtimeDirectory?: string;
  host?: "127.0.0.1";
  port?: number;
  bridgeOptions?: DrawMcpBridgeOptions;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function sendSse(response: ServerResponse, event: string, data: unknown): void {
  for (const line of JSON.stringify(data).split("\n")) response.write(`event: ${event}\ndata: ${line}\n`);
  response.write("\n");
}

export async function createDrawRuntimeServer(options: DrawRuntimeServerOptions): Promise<DrawRuntimeServer> {
  const distDirectory = resolve(options.distDirectory);
  const distInfo = await stat(distDirectory).catch(() => null);
  if (!distInfo?.isDirectory()) throw new Error(`Draw production files were not found at ${distDirectory}. Run npm run build first.`);

  const eventStreams = new Set<ServerResponse>();
  let bridgeMiddleware: ((request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void) | null = null;
  const config = { mode: "production", isProduction: true, server: { host: "127.0.0.1", port: options.port ?? 0 }, logger: { warn: () => undefined } };
  const httpServer = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const serverFacade = {
    config,
    httpServer,
    middlewares: { use: (middleware: typeof bridgeMiddleware) => { bridgeMiddleware = middleware; } },
    ws: {
      send: (event: string, data: unknown) => {
        for (const response of eventStreams) {
          if (response.destroyed || response.writableEnded) eventStreams.delete(response);
          else sendSse(response, event, data);
        }
      },
    },
  };
  const plugin = createDrawMcpPlugin(options.bridgeOptions) as Plugin;
  const configureServer = plugin.configureServer as unknown as ((server: ViteDevServer) => unknown) | undefined;
  if (typeof configureServer !== "function") throw new Error("Draw MCP bridge did not expose its server runtime.");
  await configureServer(serverFacade as unknown as ViteDevServer);
  if (!bridgeMiddleware) throw new Error("Draw MCP bridge failed to initialize its API routes.");

  async function serveFile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(url.pathname); }
    catch { sendJson(response, 400, { error: "Invalid URL path." }); return; }
    if (decodedPath.includes("\\") || decodedPath.split("/").includes("..") || decodedPath.startsWith("/.")) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    const candidate = resolve(join(distDirectory, `.${decodedPath}`));
    if (candidate !== distDirectory && !candidate.startsWith(`${distDirectory}${sep}`)) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    let filePath = candidate;
    let info = await stat(filePath).catch(() => null);
    if (!info?.isFile() && !extname(decodedPath)) {
      filePath = join(distDirectory, "index.html");
      info = await stat(filePath).catch(() => null);
    }
    if (!info?.isFile()) { sendJson(response, 404, { error: "Not found." }); return; }
    response.statusCode = 200;
    response.setHeader("content-type", MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("content-length", info.size);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable");
    if (request.method === "HEAD") { response.end(); return; }
    createReadStream(filePath).pipe(response);
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD" && !request.url?.startsWith("/__draw/api/")) {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path.startsWith("/__draw/api/")) {
      const middleware = bridgeMiddleware;
      if (!middleware) { sendJson(response, 503, { error: "Draw runtime is starting." }); return; }
      if (path === "/__draw/api/events" && request.method === "GET") {
        const originalWrite = response.write.bind(response);
        response.write = ((chunk: any, ...args: any[]) => {
          if (response.statusCode === 200) eventStreams.add(response);
          return originalWrite(chunk, ...args);
        }) as typeof response.write;
        response.once("close", () => eventStreams.delete(response));
      }
      middleware(request, response, () => {
        if (path.startsWith("/__draw/api/")) sendJson(response, 404, { error: "Unknown Draw API route." });
        else void serveFile(request, response);
      });
      return;
    }
    await serveFile(request, response);
  }

  const runtimeDirectory = options.runtimeDirectory ?? getDefaultDrawRuntimeDirectory();
  const ipc = await createPrivateIpcServer(runtimeDirectory, (request, response) => {
    const path = new URL(request.url ?? "/", "http://draw.local").pathname;
    if (!isMcpOnlyRoute(request.method, path)) {
      sendJson(response, 403, { error: "The Draw IPC socket accepts MCP tool routes only." });
      return;
    }
    if (!bridgeMiddleware) { sendJson(response, 503, { error: "Draw runtime is starting." }); return; }
    bridgeMiddleware(request, response, () => sendJson(response, 404, { error: "Unknown Draw MCP route." }));
  });

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      httpServer.off("error", reject);
      const address = httpServer.address();
      if (!address || typeof address === "string") { reject(new Error("Could not resolve Draw's loopback address.")); return; }
      config.server.port = address.port;
      resolveListen();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Draw did not bind its loopback address.");
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    socketPath: ipc.socketPath,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const response of eventStreams) response.end();
      eventStreams.clear();
      await ipc.close();
      await new Promise<void>((resolveClose, reject) => httpServer.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}
