import { describe, expect, it } from "vitest";
import { drawStartRequiredError } from "./mcp-transport-error";

describe("MCP transport connection errors", () => {
  it.each(["ENOENT", "ECONNREFUSED", "ECONNRESET"])("maps %s to actionable Draw startup guidance", (code) => {
    const error = Object.assign(new Error("socket unavailable"), { code });
    expect(drawStartRequiredError(error, true)?.message).toMatch(/Cannot reach Draw over local IPC.*Start Draw.*retry/i);
    expect(drawStartRequiredError(error, false)?.message).toMatch(/Cannot reach Draw.*Start Draw.*retry/i);
  });

  it("leaves unrelated errors to their existing handling", () => {
    expect(drawStartRequiredError(new Error("bad request"), true)).toBeNull();
    expect(drawStartRequiredError(Object.assign(new Error(), { code: "EACCES" }), true)).toBeNull();
  });
});
