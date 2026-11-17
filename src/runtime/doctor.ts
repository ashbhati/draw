import { join } from "node:path";
import { getDefaultDrawRuntimeDirectory } from "./ipc";
import { requestDrawIpc } from "./ipc-client";
import { createFileMcpClientAuthStore } from "../integrations/mcp-client-auth";

export type DrawDoctorCheck = { id: "app" | "mcp" | "paired" | "editor" | "canvas"; label: string; status: "pass" | "warning" | "fail"; detail: string };
export type DrawDoctorReport = { ready: boolean; transport: "private-socket" | "http"; checks: DrawDoctorCheck[] };
type ProbeResult = { status: number; body: unknown };
type DrawHealth = { ok: true; editorConnected: boolean; documentLoaded: boolean };

function isDrawHealth(value: unknown): value is DrawHealth {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).ok === true
    && typeof (value as Record<string, unknown>).editorConnected === "boolean"
    && typeof (value as Record<string, unknown>).documentLoaded === "boolean";
}

function loopbackBaseUrl(env: NodeJS.ProcessEnv, port?: number): URL {
  const configured = env.DRAW_MCP_BASE_URL;
  const candidate = configured ?? `http://127.0.0.1:${port ?? Number(env.DRAW_PORT ?? 4173)}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Draw health checks only connect to a loopback HTTP URL such as http://127.0.0.1:4173.");
  }
  const numericPort = url.port ? Number(url.port) : 80;
  if (numericPort < 1 || numericPort > 65535) throw new Error("Draw health check port must be between 1 and 65535.");
  return url;
}

async function defaultHttpProbe(url: string): Promise<ProbeResult> {
  const response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(1_500) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function defaultSocketProbe(socketPath: string): Promise<ProbeResult> {
  const response = await requestDrawIpc(socketPath, "/__draw/api/health", {}, 1_500);
  return { status: response.status, body: response.body };
}

/** Read-only check of the local app, the configured MCP transport, and its editor/canvas readiness. */
export async function inspectDrawHealth(options: {
  env?: NodeJS.ProcessEnv;
  runtimeDirectory?: string;
  port?: number;
  requestSocket?: (socketPath: string) => Promise<ProbeResult>;
  probeHttp?: (url: string) => Promise<ProbeResult>;
  loadActivePairedClientCount?: () => Promise<number>;
} = {}): Promise<DrawDoctorReport> {
  const env = options.env ?? process.env;
  const transport = env.DRAW_MCP_BASE_URL ? "http" : "private-socket";
  const checks: DrawDoctorCheck[] = [];
  let appHealth: DrawHealth | null = null;
  let appDetail = "";
  try {
    const base = loopbackBaseUrl(env, options.port);
    const app = await (options.probeHttp ?? defaultHttpProbe)(new URL("/__draw/api/health", base).href);
    if (app.status === 200 && isDrawHealth(app.body)) {
      appHealth = app.body;
      appDetail = `Responding at ${base.origin}.`;
    } else {
      appDetail = `Health endpoint returned HTTP ${app.status} or an invalid response at ${base.origin}.`;
    }
  } catch (error) {
    appDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({ id: "app", label: "Draw app", status: appHealth ? "pass" : "fail", detail: appHealth ? appDetail : `${appDetail} Start Draw and leave its local app running.` });

  let socketHealth: DrawHealth | null = null;
  if (transport === "http") {
    checks.push({ id: "mcp", label: "MCP transport", status: appHealth ? "pass" : "fail", detail: appHealth ? "Using the configured loopback HTTP bridge." : "The configured HTTP bridge is unavailable. Check DRAW_MCP_BASE_URL and start Draw." });
  } else {
    const runtimeDirectory = options.runtimeDirectory ?? env.DRAW_RUNTIME_DIR ?? getDefaultDrawRuntimeDirectory(env);
    const socketPath = join(runtimeDirectory, "bridge.sock");
    try {
      const socket = await (options.requestSocket ?? defaultSocketProbe)(socketPath);
      if (socket.status === 200 && isDrawHealth(socket.body)) socketHealth = socket.body;
      checks.push({ id: "mcp", label: "MCP transport", status: socketHealth ? "pass" : "fail", detail: socketHealth ? `Private Draw socket is responding at ${socketPath}.` : `Private Draw socket health check returned HTTP ${socket.status}. Run draw start and use the same DRAW_RUNTIME_DIR for Draw and MCP.` });
    } catch (error) {
      checks.push({ id: "mcp", label: "MCP transport", status: "fail", detail: `${error instanceof Error ? error.message : String(error)} Start Draw with draw start; the MCP host uses the per-user private socket.` });
    }
  }

  try {
    const count = await (options.loadActivePairedClientCount ?? (async () => {
      const state = await createFileMcpClientAuthStore().load();
      const now = Date.now();
      return state.clients.filter((client) => client.revokedAt === null && (client.persistentAccess === true || client.expiresAt === undefined || client.expiresAt > now)).length;
    }))();
    checks.push({ id: "paired", label: "Paired MCP clients", status: count > 0 ? "pass" : "warning", detail: count > 0 ? `${count} active MCP client${count === 1 ? "" : "s"} can authenticate. Names and credentials are not shown.` : "No active MCP client is paired. Connect an agent in Draw and approve its request." });
  } catch (error) {
    checks.push({ id: "paired", label: "Paired MCP clients", status: "fail", detail: `Could not safely read the local MCP client state: ${error instanceof Error ? error.message : String(error)}.` });
  }

  const health = appHealth ?? socketHealth;
  checks.push({ id: "editor", label: "Editor connection", status: health?.editorConnected ? "pass" : "warning", detail: health?.editorConnected ? "A Draw editor is connected." : "Open Draw in a browser and wait for the editor to connect." });
  checks.push({ id: "canvas", label: "Active workspace", status: health?.documentLoaded ? "pass" : "warning", detail: health?.documentLoaded ? "An editable workspace is loaded." : "Wait for a workspace to finish loading in Draw." });
  return { ready: checks.every((check) => check.status === "pass"), transport, checks };
}

export function formatDrawDoctorReport(report: DrawDoctorReport): string {
  const icon = { pass: "✓", warning: "!", fail: "✗" } as const;
  return [
    `Draw doctor: ${report.ready ? "ready" : "not ready"}`,
    ...report.checks.map((check) => `${icon[check.status]} ${check.label}: ${check.detail}`),
    ...(report.ready ? [] : ["", "When the editor and active workspace are ready, retry the agent's MCP call."]),
  ].join("\n");
}
