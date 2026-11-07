import { describe, expect, it } from "vitest";
import { readConfiguredPairingSecret } from "./mcp-pairing-config";

describe("MCP host pairing configuration", () => {
  it("fails closed when the protected pairing secret is missing or malformed", () => {
    expect(() => readConfiguredPairingSecret({})).toThrow(/DRAW_MCP_PAIRING_SECRET/);
    expect(() => readConfiguredPairingSecret({ DRAW_MCP_PAIRING_SECRET: "secret" })).toThrow(/DRAW_MCP_PAIRING_SECRET/);
    expect(() => readConfiguredPairingSecret({ DRAW_MCP_PAIRING_SECRET: "a".repeat(64) })).not.toThrow();
  });
});
