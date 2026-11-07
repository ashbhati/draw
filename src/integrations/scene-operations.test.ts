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

  it("moves bound labels with aligned nodes and reroutes arrows", () => {
    const connected = [
      { id: "left", type: "rectangle", x: 100, y: 40, width: 100, height: 80, boundElements: [{ id: "left-label", type: "text" }, { id: "flow", type: "arrow" }] },
      { id: "left-label", type: "text", x: 120, y: 60, width: 60, height: 30, containerId: "left" },
      { id: "right", type: "ellipse", x: 360, y: 180, width: 120, height: 80, boundElements: [{ id: "right-label", type: "text" }, { id: "flow", type: "arrow" }] },
      { id: "right-label", type: "text", x: 380, y: 205, width: 80, height: 30, containerId: "right" },
      { id: "flow", type: "arrow", x: 150, y: 80, width: 270, height: 140, points: [[0, 0], [270, 140]], startBinding: { elementId: "left" }, endBinding: { elementId: "right" } },
    ];
    const aligned = applySceneEdit(connected, { action: "align", alignment: "left", ids: ["left", "right"] }, () => "unused");
    expect(aligned.elements.find((element) => element.id === "right")).toMatchObject({ x: 100, y: 180 });
    expect(aligned.elements.find((element) => element.id === "right-label")).toMatchObject({ x: 120, y: 205 });
    const arrow = aligned.elements.find((element) => element.id === "flow")!;
    const arrowStart = { x: (arrow.x ?? 0) + (arrow.points?.[0]?.[0] ?? 0), y: (arrow.y ?? 0) + (arrow.points?.[0]?.[1] ?? 0) };
    const arrowEnd = { x: (arrow.x ?? 0) + (arrow.points?.[1]?.[0] ?? 0), y: (arrow.y ?? 0) + (arrow.points?.[1]?.[1] ?? 0) };
    expect(arrowStart.y).toBeCloseTo(120);
    expect(arrowStart.x).toBeGreaterThanOrEqual(100);
    expect(arrowStart.x).toBeLessThanOrEqual(200);
    expect(arrowEnd.y).toBeCloseTo(180, 1);
    expect(arrowEnd.x).toBeGreaterThanOrEqual(100);
    expect(arrowEnd.x).toBeLessThanOrEqual(220);
  });

  it("moves labels while distributing and clears arrow bindings when a shape is deleted", () => {
    const connected = [
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60, boundElements: [{ id: "a-label", type: "text" }, { id: "ab", type: "arrow" }] },
      { id: "a-label", type: "text", x: 20, y: 20, width: 60, height: 20, containerId: "a" },
      { id: "b", type: "rectangle", x: 180, y: 90, width: 100, height: 60, boundElements: [{ id: "b-label", type: "text" }, { id: "ab", type: "arrow" }, { id: "bc", type: "arrow" }] },
      { id: "b-label", type: "text", x: 200, y: 110, width: 60, height: 20, containerId: "b" },
      { id: "c", type: "rectangle", x: 500, y: 0, width: 100, height: 60, boundElements: [{ id: "c-label", type: "text" }, { id: "bc", type: "arrow" }] },
      { id: "c-label", type: "text", x: 520, y: 20, width: 60, height: 20, containerId: "c" },
      { id: "ab", type: "arrow", x: 50, y: 30, width: 180, height: 90, points: [[0, 0], [180, 90]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
      { id: "bc", type: "arrow", x: 230, y: 120, width: 320, height: -90, points: [[0, 0], [320, -90]], startBinding: { elementId: "b" }, endBinding: { elementId: "c" } },
    ];
    const distributed = applySceneEdit(connected, { action: "distribute", axis: "horizontal", ids: ["a", "b", "c"] }, () => "unused");
    expect(distributed.elements.find((element) => element.id === "b-label")!.x).toBe(270);
    const deleted = applySceneEdit(distributed.elements, { action: "delete", ids: ["b"] }, () => "unused");
    const ab = deleted.elements.find((element) => element.id === "ab")!;
    expect(ab.endBinding).toBeNull();
    expect(ab.startBinding).toEqual({ elementId: "a" });
    expect(deleted.elements.find((element) => element.id === "a")!.boundElements).toContainEqual({ id: "ab", type: "arrow" });
    expect(deleted.elements.filter((element) => element.isDeleted !== true).flatMap((element) => [element.startBinding?.elementId, element.endBinding?.elementId])).not.toContain("b");
  });
});
