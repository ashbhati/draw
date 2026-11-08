import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { createDrawRuntimeServer } from "./server";
import { getDefaultDrawRuntimeDirectory } from "./ipc";

export type DrawCommand = "start" | "mcp" | "help";
export type DrawCommandOptions = { openBrowser?: boolean; port?: number };

export function parseDrawCommand(args: string[]): { command: DrawCommand; options: DrawCommandOptions } {
  const known = new Set<DrawCommand>(["start", "mcp", "help"]);
  const command = (args[0] ?? "start") as DrawCommand;
  if (!known.has(command)) throw new Error(`Unknown command: ${command}. Use draw start, draw mcp, or draw help.`);
  const options: DrawCommandOptions = {};
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open" && command === "start") options.openBrowser = false;
    else if (argument === "--port" && command === "start") {
      const port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Draw port must be an integer between 1 and 65535.");
      options.port = port;
    } else throw new Error(`Unknown ${command} option: ${argument}.`);
  }
  return { command, options };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.once("error", (error) => console.error(`Could not open a browser automatically: ${error.message}\nOpen ${url} manually.`));
  child.unref();
}

async function startApp(options: DrawCommandOptions): Promise<void> {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const runtimeDirectory = process.env.DRAW_RUNTIME_DIR ?? getDefaultDrawRuntimeDirectory();
  const configuredPort = options.port ?? Number(process.env.DRAW_PORT ?? 4173);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) throw new Error("DRAW_PORT must be an integer between 1 and 65535.");
  const server = await createDrawRuntimeServer({
    distDirectory: process.env.DRAW_DIST_DIR ?? join(packageRoot, "dist"),
    runtimeDirectory,
    port: configuredPort,
  });
  process.env.DRAW_MCP_SOCKET_PATH = server.socketPath;
  console.log(`Draw is running at ${server.url}`);
  console.log(`MCP socket: ${server.socketPath}`);
  const shutdown = () => { void server.close().finally(() => process.exit(0)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (options.openBrowser ?? process.stdout.isTTY) openBrowser(server.url);
}

async function runMcpHost(): Promise<void> {
  if (!process.env.DRAW_MCP_SOCKET_PATH) {
    process.env.DRAW_MCP_SOCKET_PATH = join(process.env.DRAW_RUNTIME_DIR ?? getDefaultDrawRuntimeDirectory(), "bridge.sock");
  }
  await import("../integrations/mcp-server");
}

export async function runDrawCli(args = process.argv.slice(2)): Promise<void> {
  const { command, options } = parseDrawCommand(args);
  if (command === "help") {
    console.log("Draw — editable local diagram canvas\n\nUsage:\n  draw start [--port PORT] [--no-open]\n  draw mcp\n  draw help\n");
  } else if (command === "start") await startApp(options);
  else await runMcpHost();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDrawCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
