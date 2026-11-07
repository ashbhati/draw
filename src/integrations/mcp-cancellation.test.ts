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
    laterHumanEdit.document.title = "Human changed the title";
    const laterHumanPan = structuredClone(result);
    laterHumanPan.document.viewRevision += 1;
    laterHumanPan.document.canvas.viewport.x += 100;
    const reopened = createEmptyDocument("another document");
    expect(canRestoreCancelledMcpCommand(baseline, result, laterHumanEdit)).toBe(false);
    expect(canRestoreCancelledMcpCommand(baseline, result, laterHumanPan)).toBe(false);
    expect(canRestoreCancelledMcpCommand(baseline, result, reopened)).toBe(false);
    expect(canRestoreCancelledMcpCommand(baseline, result, null)).toBe(false);
  });

  it("checks the live API viewport so a pan inside the persistence debounce is preserved", () => {
    const baseline = createEmptyDocument("baseline");
    const result = structuredClone(baseline);
    result.document.documentRevision += 1;
    const justPanned = { ...baseline.document.canvas.viewport, x: baseline.document.canvas.viewport.x + 80 };
    expect(canRestoreCancelledMcpCommand(baseline, result, baseline, justPanned)).toBe(false);
    expect(canRestoreCancelledMcpCommand(baseline, result, baseline, baseline.document.canvas.viewport)).toBe(true);
  });

  it("allows revision-counter churn only when semantic state and live selection still match", () => {
    const baseline = createEmptyDocument("baseline");
    const result = structuredClone(baseline);
    result.document.documentRevision += 1;
    result.document.elements.push({ id: "mcp-node", type: "rectangle" } as any);
    const latest = structuredClone(result);
    latest.document.documentRevision += 1;
    expect(canRestoreCancelledMcpCommand(baseline, result, latest, baseline.document.canvas.viewport, {})).toBe(true);
    latest.document.elements[0].version = 99;
    latest.document.elements[0].versionNonce = 42;
    latest.document.elements[0].updated = Date.now();
    latest.document.elements[0].index = "z9";
    expect(canRestoreCancelledMcpCommand(baseline, result, latest, baseline.document.canvas.viewport, {})).toBe(true);
    expect(canRestoreCancelledMcpCommand(baseline, result, latest, baseline.document.canvas.viewport, { humanSelection: true })).toBe(false);
    latest.document.elements[0].x = 100;
    expect(canRestoreCancelledMcpCommand(baseline, result, latest, baseline.document.canvas.viewport, {})).toBe(false);
  });
});
