import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCTION_E2E_RUNTIME_ROOT } from "./production-runtime-constants";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

async function startMcpHost(socketPath: string, configHome: string) {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/integrations/mcp-server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DRAW_MCP_SOCKET_PATH: socketPath,
      DRAW_MCP_CLIENT_NAME: "Draw production E2E",
      DRAW_MCP_DOCUMENT_DIR: join(configHome, "documents"),
      XDG_CONFIG_HOME: configHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  let errors = "";
  const pending = new Map<number, Pending>();
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    while (output.includes("\n")) {
      const end = output.indexOf("\n");
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message);
      }
    }
  });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  let sequence = 0;
  const call = (method: string, params: unknown = {}) => {
    const id = ++sequence;
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out. ${errors}`)); }, 15_000);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  };
  const initialized = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "draw-production-e2e", version: "1.0" } });
  if (initialized.error) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)} ${errors}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    call,
    tool: async (name: string, arguments_: Record<string, unknown> = {}) => call("tools/call", { name, arguments: arguments_ }),
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

test("packaged production app pairs through private IPC and keeps host access after host restart", async ({ page }) => {
  test.setTimeout(60_000);
  const configHome = await mkdtemp(join(tmpdir(), "draw-production-mcp-e2e-"));
  let mcp: Awaited<ReturnType<typeof startMcpHost>> | undefined;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Connect MCP" }).click();
    await page.getByLabel("Launch code").fill("A1B2C3D4E5F6");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("button", { name: "MCP connected" })).toBeVisible();

    mcp = await startMcpHost(join(PRODUCTION_E2E_RUNTIME_ROOT, "run", "bridge.sock"), configHome);

    const pairing = mcp.tool("pair_mcp_client", {});
    await expect(page.getByRole("heading", { name: "Approve MCP client?" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Approve MCP client?" })).toContainText("Draw production E2E");
    await page.getByRole("button", { name: "Approve client" }).click();
    const pairingResult = await pairing;
    expect(pairingResult.result.isError).not.toBe(true);
    const pairedClient = JSON.parse(pairingResult.result.content[0].text);

    const untrustedLoopbackRead = await page.request.get("/__draw/api/document?flush=1");
    expect(untrustedLoopbackRead.status()).toBe(403);
    const untrustedLoopbackPair = await page.request.post("/__draw/api/mcp/pair", { data: { clientName: "Untrusted", fingerprint: "f".repeat(64) } });
    expect(untrustedLoopbackPair.status()).toBe(403);

    const initialMessage = await mcp.tool("get_current_canvas", {});
    const initial = JSON.parse(initialMessage.result.content[0].text);
    const created = await mcp.tool("create_diagram", {
      documentId: initial.documentId,
      expectedDocumentRevision: initial.documentRevision,
      idempotencyKey: "production-ipc-create-1",
      title: "Production IPC fixture",
      nodes: [{ id: "left", label: "Created through private IPC", x: 120, y: 140, width: 240, height: 100 }],
      edges: [],
    });
    expect(created.result.isError).not.toBe(true);
    const freshMessage = await mcp.tool("get_current_canvas", {});
    const fresh = JSON.parse(freshMessage.result.content[0].text);
    expect(JSON.stringify(fresh)).toContain("Created through private IPC");
    expect(fresh.documentId).toBe(initial.documentId);

    await mcp.close();
    mcp = await startMcpHost(join(PRODUCTION_E2E_RUNTIME_ROOT, "run", "bridge.sock"), configHome);
    const afterHostRestart = JSON.parse((await mcp.tool("get_current_canvas", {})).result.content[0].text);
    expect(afterHostRestart.documentId).toBe(initial.documentId);
    expect(JSON.stringify(afterHostRestart)).toContain("Created through private IPC");

    const credentialPath = join(configHome, "draw", "mcp-client-credential.json");
    const legacyHostCredential = JSON.parse(await readFile(credentialPath, "utf8"));
    await writeFile(credentialPath, JSON.stringify({ ...legacyHostCredential, expiresAt: Date.now() - 1 }));
    const expiredLegacyLocalDeadline = await mcp.tool("get_current_canvas", {});
    expect(expiredLegacyLocalDeadline.result.isError).not.toBe(true);

    await page.getByRole("button", { name: "MCP clients" }).click();
    const clientRow = page.locator(".mcp-client-row").filter({ hasText: pairedClient.clientIdentity });
    await clientRow.getByRole("button", { name: "Revoke" }).click();
    await expect(clientRow).toContainText("revoked");
    const staleHostCall = await mcp.tool("get_current_canvas", {});
    expect(staleHostCall.result.isError).toBe(true);
    expect(staleHostCall.result.content[0].text).toContain("Draw no longer authorizes this MCP host");
  } finally {
    await mcp?.close();
    await rm(configHome, { recursive: true, force: true });
  }
});
