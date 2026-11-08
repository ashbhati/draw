import { defineConfig, devices } from "@playwright/test";
import { PRODUCTION_E2E_RUNTIME_ROOT } from "./tests/e2e/production-runtime-constants";

const baseURL = "http://127.0.0.1:4189";
// macOS limits Unix socket path lengths; the fixed test-only path stays short.

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "production-runtime.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL, browserName: "chromium", headless: true, trace: "retain-on-failure" },
  webServer: {
    command: "node --import tsx/esm tests/e2e/production-server.ts",
    url: `${baseURL}/__draw/api/health`,
    env: { ...process.env, DRAW_RUNTIME_E2E_ROOT: PRODUCTION_E2E_RUNTIME_ROOT },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
