import { describe, expect, it, vi } from "vitest";
import { inspectDrawHealth } from "./doctor";

describe("Draw doctor", () => {
  it("checks the local app, private MCP socket, editor session, and active canvas", async () => {
    const requestSocket = vi.fn(async (socketPath: string) => {
      expect(socketPath).toBe("/private/draw/run/bridge.sock");
      return { status: 200, body: { ok: true, editorConnected: true, documentLoaded: true } };
    });
    const probeHttp = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:4173/__draw/api/health");
      return { status: 200, body: { ok: true, editorConnected: true, documentLoaded: true } };
    });
    const report = await inspectDrawHealth({ runtimeDirectory: "/private/draw/run", env: {}, requestSocket, probeHttp, loadActivePairedClientCount: async () => 1 });
    expect(report).toMatchObject({ ready: true, transport: "private-socket" });
    expect(report.checks.map((check) => check.id)).toEqual(["app", "mcp", "paired", "editor", "canvas"]);
  });

  it("uses a configured loopback HTTP bridge for a development MCP setup", async () => {
    const requestSocket = vi.fn();
    const probeHttp = vi.fn(async () => ({ status: 200, body: { ok: true, editorConnected: false, documentLoaded: false } }));
    const report = await inspectDrawHealth({ runtimeDirectory: "/private/draw/run", env: { DRAW_MCP_BASE_URL: "http://127.0.0.1:5173" }, requestSocket, probeHttp, loadActivePairedClientCount: async () => 0 });
    expect(report.transport).toBe("http");
    expect(requestSocket).not.toHaveBeenCalled();
    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === "editor")?.status).toBe("warning");
    expect(report.checks.find((check) => check.id === "canvas")?.status).toBe("warning");
  });

  it("refuses a non-loopback MCP base URL without making a network request", async () => {
    const probeHttp = vi.fn();
    const report = await inspectDrawHealth({ runtimeDirectory: "/private/draw/run", env: { DRAW_MCP_BASE_URL: "https://example.com" }, requestSocket: vi.fn(), probeHttp, loadActivePairedClientCount: async () => 1 });
    expect(report.ready).toBe(false);
    expect(probeHttp).not.toHaveBeenCalled();
    expect(report.checks.find((check) => check.id === "app")?.detail).toMatch(/loopback/i);
  });
});
