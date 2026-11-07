import { describe, expect, it } from "vitest";
import { applySceneEdit } from "./scene-operations";

const base = [
  { id: "a", type: "rectangle", x: 10, y: 20, width: 100, height: 60, version: 1, versionNonce: 1, groupIds: [] },
  { id: "a-label", type: "text", x: 20, y: 40, width: 80, height: 20, containerId: "a", version: 1, versionNonce: 1 },
  { id: "b", type: "ellipse", x: 200, y: 100, width: 100, height: 60, version: 1, versionNonce: 1, groupIds: [] },
  { id: "c", type: "diamond", x: 400, y: 160, width: 100, height: 60, version: 1, versionNonce: 1, groupIds: [] },
];

describe("MCP scene operations", () => {
  it("soft deletes requested elements and bound labels while reporting missing IDs", () => {
    const result = applySceneEdit(base, { action: "delete", ids: ["a", "missing"] }, () => "new-id");
    expect(result.elements.filter((element) => element.isDeleted).map((element) => element.id)).toEqual(["a", "a-label"]);
    expect(result.failed).toEqual([{ id: "missing", reason: "Element was not found on the active canvas." }]);
  });

  it("duplicates bound shapes and labels with remapped relationships", () => {
    let nextId = 0;
    const result = applySceneEdit(base, { action: "duplicate", ids: ["a"], offsetX: 24, offsetY: 12 }, () => `copy-${++nextId}`);
    expect(result.elements.slice(-2)).toMatchObject([
      { id: "copy-1", x: 34, y: 32 },
      { id: "copy-2", x: 44, y: 52, containerId: "copy-1" },
    ]);
    expect(result.createdIds).toEqual(["copy-1", "copy-2"]);
  });

  it("groups and ungroups valid elements without dropping other groups", () => {
    const grouped = applySceneEdit(base, { action: "group", ids: ["a", "b"] }, () => "group-1");
    expect(grouped.elements.slice(0, 3).map((element) => element.groupIds)).toEqual([["group-1"], undefined, ["group-1"]]);
    const ungrouped = applySceneEdit(grouped.elements, { action: "ungroup", ids: ["a", "b"] }, () => "unused");
    expect(ungrouped.elements.filter((element) => element.id === "a" || element.id === "b").map((element) => element.groupIds)).toEqual([[], []]);
  });

  it("aligns and distributes selection using geometry", () => {
    const aligned = applySceneEdit(base, { action: "align", alignment: "left", ids: ["a", "b", "c"] }, () => "unused");
    expect(aligned.elements.filter((element) => ["a", "b", "c"].includes(element.id)).map((element) => element.x)).toEqual([10, 10, 10]);
    const distributed = applySceneEdit(base, { action: "distribute", axis: "horizontal", ids: ["a", "b", "c"] }, () => "unused");
    expect(distributed.elements.filter((element) => ["a", "b", "c"].includes(element.id)).map((element) => element.x)).toEqual([10, 205, 400]);
  });

  it("brings only selected elements forward and preserves relative order", () => {
    const result = applySceneEdit(base, { action: "bring_to_front", ids: ["a", "c"] }, () => "unused");
    expect(result.elements.map((element) => element.id)).toEqual(["b", "a", "a-label", "c"]);
  });
});
