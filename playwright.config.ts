import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5181";

export default defineConfig({
  testDir: "./tests/e2e",
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
  webServer: {
    command: "npm run dev -- --port 5181",
    url: `${baseURL}/__draw/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
