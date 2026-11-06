import { createServer } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

export async function resolveE2EBaseURL(configuredURL = process.env.DRAW_E2E_BASE_URL): Promise<string> {
  if (!configuredURL) {
    const port = await findAvailablePort();
    return `http://${LOOPBACK_HOST}:${port}`;
  }

  let url: URL;
  try {
    url = new URL(configuredURL);
  } catch {
    throw new Error("E2E base URL must be a valid HTTP URL.");
  }
  if (url.protocol !== "http:") throw new Error("E2E base URL must use HTTP.");
  if (url.hostname !== LOOPBACK_HOST && url.hostname !== "localhost") {
    throw new Error("E2E base URL must use a loopback host.");
  }
  if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new Error("E2E base URL must include a valid port.");
  }
  return url.origin;
}

export async function resolveAndStoreE2EBaseURL(): Promise<string> {
  const baseURL = await resolveE2EBaseURL();
  process.env.DRAW_E2E_BASE_URL = baseURL;
  return baseURL;
}

export function createE2EServerConfig(
  baseURL: string,
  reuseExistingServer = process.env.DRAW_E2E_REUSE_SERVER === "1",
) {
  const url = new URL(baseURL);
  const port = Number(url.port);
  return {
    command: `npm run dev -- --host ${LOOPBACK_HOST} --port ${port} --strictPort`,
    url: `${url.origin}/__draw/api/health`,
    reuseExistingServer,
    timeout: 30_000,
  };
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not allocate a loopback port for Playwright.");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
