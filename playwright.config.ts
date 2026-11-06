import { defineConfig, devices } from "@playwright/test";
import { createE2EServerConfig, resolveAndStoreE2EBaseURL } from "./tests/e2e/config";

const baseURL = await resolveAndStoreE2EBaseURL();

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: "**/*.test.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: createE2EServerConfig(baseURL),
});
