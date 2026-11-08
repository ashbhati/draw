import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createDrawRuntimeServer } from "../../src/runtime/server";
import { createFileEditorAuthStore } from "../../src/integrations/editor-auth";
import { createFileMcpClientAuthStore } from "../../src/integrations/mcp-client-auth";

const root = process.env.DRAW_RUNTIME_E2E_ROOT;
if (!root) throw new Error("DRAW_RUNTIME_E2E_ROOT is required for the isolated production E2E server.");
await mkdir(root, { recursive: true, mode: 0o700 });
const runtime = await createDrawRuntimeServer({
  distDirectory: resolve("dist"),
  runtimeDirectory: join(root, "run"),
  host: "127.0.0.1",
  port: 4189,
  bridgeOptions: {
    editorAuthForTests: {
      generateLaunchCode: () => "A1B2C3D4E5F6",
      displayLaunchCode: () => true,
      store: createFileEditorAuthStore(join(root, "editor-auth.json")),
    },
    mcpClientAuthForTests: { store: createFileMcpClientAuthStore(join(root, "mcp-clients.json")) },
  },
});
console.log(`Production Draw E2E server ready at ${runtime.url}`);
const close = () => { void runtime.close().then(() => rm(root, { recursive: true, force: true })).finally(() => process.exit(0)); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
