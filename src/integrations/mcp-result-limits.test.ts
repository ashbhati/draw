import { describe, expect, it } from "vitest";
import { assertInlineArtifactSize, MAX_INLINE_ARTIFACT_BYTES } from "./mcp-result-limits";

describe("MCP inline artifact bounds", () => {
  it("allows results through 1 MiB and rejects larger inline Draw or image output", () => {
    expect(assertInlineArtifactSize(MAX_INLINE_ARTIFACT_BYTES, "Draw file")).toBe(MAX_INLINE_ARTIFACT_BYTES);
    expect(() => assertInlineArtifactSize(MAX_INLINE_ARTIFACT_BYTES + 1, "Draw file")).toThrow(/exceeds the 1 MiB inline limit/i);
    expect(() => assertInlineArtifactSize(8 * MAX_INLINE_ARTIFACT_BYTES, "PNG image")).toThrow(/provide a path/i);
  });
});
