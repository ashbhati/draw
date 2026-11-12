import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackagePtyArgs } from "./package-pty";

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  const { port } = address;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startInstalledMcp(bin: string, runtimeDirectory: string, configHome: string, cwd: string) {
  const child = spawn(process.execPath, [bin, "mcp"], {
    cwd,
    env: {
      ...process.env,
      DRAW_RUNTIME_DIR: runtimeDirectory,
      DRAW_MCP_CLIENT_NAME: "Installed package Chrome E2E",
      DRAW_MCP_DOCUMENT_DIR: join(configHome, "documents"),
      XDG_CONFIG_HOME: configHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffered = "";
  let errors = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  let id = 0;
  const request = (method: string, params: unknown = {}) => {
    const requestId = ++id;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP ${method} timed out: ${errors}`)); }, 15_000);
      pending.set(requestId, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    return promise;
  };
  await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "draw-package-e2e", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    tool: (name: string, arguments_: Record<string, unknown> = {}) => request("tools/call", { name, arguments: arguments_ }),
    close: async () => {
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      pending.clear();
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

async function runInstalledCommand(bin: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

test("installed npm package serves the production app and MCP edits it over local IPC", async ({ page }) => {
  test.setTimeout(60_000);
  const bin = process.env.DRAW_PACKAGE_BIN;
  test.skip(!bin, "Set DRAW_PACKAGE_BIN to the installed npm package's bin/draw.js path.");
  if (!bin) return;

  const root = await mkdtemp(join("/tmp", "draw-pkg-"));
  const configHome = await mkdtemp(join(tmpdir(), "draw-pkg-config-"));
  const neutralCwd = join(root, "neutral-cwd");
  await mkdir(neutralCwd);
  await expect(access(join(neutralCwd, "node_modules"))).rejects.toThrow();
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}/`;
  let output = "";
  let runtimeProcess: ChildProcessWithoutNullStreams | undefined;
  let mcp: Awaited<ReturnType<typeof startInstalledMcp>> | undefined;
  try {
    const help = await runInstalledCommand(bin, ["help"], neutralCwd);
    expect(help.code, help.output).toBe(0);
    expect(help.output).toContain("draw start");
    // `script` gives the installed CLI a real terminal so launch-code display
    // follows the same trusted-terminal path users receive.
    runtimeProcess = spawn("script", buildPackagePtyArgs(bin, ["start", "--port", String(port), "--no-open"]), {
      cwd: neutralCwd,
      env: { ...process.env, DRAW_RUNTIME_DIR: join(root, "run") },
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    runtimeProcess.stdout.setEncoding("utf8");
    runtimeProcess.stderr.setEncoding("utf8");
    runtimeProcess.stdout.on("data", (chunk: string) => { output += chunk; });
    runtimeProcess.stderr.on("data", (chunk: string) => { output += chunk; });
    await expect.poll(async () => {
      try { return (await fetch(`${url}__draw/api/health`)).status; } catch { return 0; }
    }, { timeout: 15_000 }).toBe(200);
    const launchCode = await expect.poll(() => output.match(/Draw editor launch code[^\n]*: ([A-F\d]{12})/)?.[1] ?? "", { timeout: 5_000 }).not.toBe("");
    void launchCode;
    const code = output.match(/Draw editor launch code[^\n]*: ([A-F\d]{12})/)?.[1];
    if (!code) throw new Error(`The installed CLI did not print its terminal launch code. ${output}`);

    await page.goto(url);
    await page.getByRole("button", { name: "Connect MCP" }).click();
    await page.getByLabel("Launch code").fill(code);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("button", { name: "MCP connected" })).toBeVisible();
    mcp = await startInstalledMcp(bin, join(root, "run"), configHome, neutralCwd);
    const pairing = mcp.tool("pair_mcp_client", {});
    await expect(page.getByRole("heading", { name: "Approve MCP client?" })).toBeVisible();
    await page.getByRole("button", { name: "Approve client" }).click();
    expect((await pairing).result.isError).not.toBe(true);

    expect((await page.request.get(`${url}__draw/api/document?flush=1`)).status()).toBe(403);
    const current = JSON.parse((await mcp.tool("get_current_canvas", {})).result.content[0].text);
    const changed = await mcp.tool("create_diagram", {
      documentId: current.documentId,
      expectedDocumentRevision: current.documentRevision,
      idempotencyKey: "installed-package-e2e-1",
      title: "Installed npm package",
      nodes: [{ id: "package-node", label: "Created by installed Draw CLI", x: 120, y: 140, width: 260, height: 100 }],
      edges: [],
    });
    expect(changed.result.isError).not.toBe(true);
    const verified = JSON.parse((await mcp.tool("get_current_canvas", {})).result.content[0].text);
    expect(JSON.stringify(verified)).toContain("Created by installed Draw CLI");

    await mcp.close();
    mcp = await startInstalledMcp(bin, join(root, "run"), configHome, neutralCwd);
    const afterHostRestart = JSON.parse((await mcp.tool("get_current_canvas", {})).result.content[0].text);
    expect(afterHostRestart.documentId).toBe(current.documentId);
    expect(JSON.stringify(afterHostRestart)).toContain("Created by installed Draw CLI");

    runtimeProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!runtimeProcess || runtimeProcess.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { runtimeProcess?.kill("SIGKILL"); resolve(); }, 3_000);
      runtimeProcess.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    runtimeProcess = undefined;
    const unavailable = await mcp.tool("get_current_canvas", {});
    expect(unavailable.result.isError).toBe(true);
    expect(JSON.stringify(unavailable.result.content)).toMatch(/Cannot reach Draw over local IPC.*Start Draw.*retry/i);
  } finally {
    await mcp?.close();
    runtimeProcess?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!runtimeProcess || runtimeProcess.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { runtimeProcess?.kill("SIGKILL"); resolve(); }, 3_000);
      runtimeProcess.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await rm(root, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});
