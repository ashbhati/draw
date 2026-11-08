import { describe, expect, it } from "vitest";
import { parseDrawCommand } from "./cli";

describe("Draw CLI command parsing", () => {
  it("defaults to start and supports the installed production runtime commands", () => {
    expect(parseDrawCommand([])).toEqual({ command: "start", options: {} });
    expect(parseDrawCommand(["mcp"])).toEqual({ command: "mcp", options: {} });
    expect(parseDrawCommand(["start", "--no-open"])).toEqual({ command: "start", options: { openBrowser: false } });
  });

  it("rejects unknown commands and malformed port values", () => {
    expect(() => parseDrawCommand(["dev"])).toThrow(/unknown command/i);
    expect(() => parseDrawCommand(["start", "--port", "0"])).toThrow(/port/i);
  });
});
