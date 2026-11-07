import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../document/document";
import { canRestoreCancelledMcpCommand } from "./mcp-cancellation";

describe("MCP command cancellation rollback", () => {
  it("allows rollback at the baseline or command result revision", () => {
    const baseline = createEmptyDocument("baseline");
    const result = structuredClone(baseline);
    result.document.documentRevision += 1;
    expect(canRestoreCancelledMcpCommand(baseline, result, baseline)).toBe(true);
    expect(canRestoreCancelledMcpCommand(baseline, result, result)).toBe(true);
  });

  it("does not overwrite a later human edit or reopened document", () => {
    const baseline = createEmptyDocument("baseline");
    const result = structuredClone(baseline);
    result.document.documentRevision += 1;
    const laterHumanEdit = structuredClone(result);
    laterHumanEdit.document.documentRevision += 1;
    const laterHumanPan = structuredClone(result);
    laterHumanPan.document.viewRevision += 1;
    const reopened = createEmptyDocument("another document");
    expect(canRestoreCancelledMcpCommand(baseline, result, laterHumanEdit)).toBe(false);
    expect(canRestoreCancelledMcpCommand(baseline, result, laterHumanPan)).toBe(false);
    expect(canRestoreCancelledMcpCommand(baseline, result, reopened)).toBe(false);
    expect(canRestoreCancelledMcpCommand(baseline, result, null)).toBe(false);
  });
});
