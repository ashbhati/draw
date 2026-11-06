import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { createE2EServerConfig, isSameOriginURL, resolveAndStoreE2EBaseURL, resolveE2EBaseURL } from "./config";

describe("Playwright E2E server configuration", () => {
  it("chooses an ephemeral default URL and accepts an explicit per-run loopback URL", async () => {
    const dynamicUrl = await resolveE2EBaseURL(undefined);
    expect(new URL(dynamicUrl).hostname).toBe("127.0.0.1");
    expect(Number(new URL(dynamicUrl).port)).toBeGreaterThan(0);
    expect(await resolveE2EBaseURL("http://127.0.0.1:5197/ignored/path")).toBe("http://127.0.0.1:5197");
  });

  it("persists the selected base URL so repeated config loads share one port", async () => {
    const previous = process.env.DRAW_E2E_BASE_URL;
    try {
      delete process.env.DRAW_E2E_BASE_URL;
      const first = await resolveAndStoreE2EBaseURL();
      expect(process.env.DRAW_E2E_BASE_URL).toBe(first);
      expect(await resolveAndStoreE2EBaseURL()).toBe(first);
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(Number(new URL(first).port), "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    } finally {
      if (previous === undefined) delete process.env.DRAW_E2E_BASE_URL;
      else process.env.DRAW_E2E_BASE_URL = previous;
    }
  });

  it("rejects invalid, non-loopback, and portless URLs", async () => {
    await expect(resolveE2EBaseURL("https://127.0.0.1:5197")).rejects.toThrow(/http/i);
    await expect(resolveE2EBaseURL("http://example.com:5197")).rejects.toThrow(/loopback/i);
    await expect(resolveE2EBaseURL("http://127.0.0.1")).rejects.toThrow(/port/i);
  });

  it("starts its own Vite server on the configured strict port", () => {
    const previous = process.env.DRAW_E2E_REUSE_SERVER;
    try {
      delete process.env.DRAW_E2E_REUSE_SERVER;
      expect(createE2EServerConfig("http://127.0.0.1:5197")).toEqual({
        command: "npm run dev -- --host 127.0.0.1 --port 5197 --strictPort",
        url: "http://127.0.0.1:5197/__draw/api/health",
        reuseExistingServer: false,
        timeout: 30_000,
      });
      process.env.DRAW_E2E_REUSE_SERVER = "1";
      expect(createE2EServerConfig("http://127.0.0.1:5197").reuseExistingServer).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DRAW_E2E_REUSE_SERVER;
      else process.env.DRAW_E2E_REUSE_SERVER = previous;
    }
  });

  it("matches exact parsed origins instead of port prefixes", () => {
    const origin = "http://127.0.0.1:5197";
    expect(isSameOriginURL(`${origin}/fonts/Excalifont/font.woff2`, origin)).toBe(true);
    expect(isSameOriginURL("http://127.0.0.1:51970/fonts/Excalifont/font.woff2", origin)).toBe(false);
  });

  it("handles data and blob URLs without throwing or accepting foreign origins", () => {
    const origin = "http://127.0.0.1:5197";
    expect(isSameOriginURL("data:font/woff2;base64,AA==", origin)).toBe(false);
    expect(isSameOriginURL("blob:http://127.0.0.1:5197/9e34", origin)).toBe(true);
    expect(isSameOriginURL("blob:http://127.0.0.1:51970/9e34", origin)).toBe(false);
    expect(isSameOriginURL("blob:null/9e34", origin)).toBe(false);
    expect(isSameOriginURL("not a URL", origin)).toBe(false);
  });
});
