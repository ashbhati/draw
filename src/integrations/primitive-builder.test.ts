import { describe, expect, it } from "vitest";
import { buildPrimitiveSkeletons } from "./primitive-builder";

describe("MCP native primitive construction", () => {
  it("builds editable standalone text, line, arrow, and freehand skeletons with stable IDs", () => {
    let sequence = 0;
    const built = buildPrimitiveSkeletons({ elements: [
      { id: "heading", type: "text", x: 10, y: 20, text: "Intent", fontSize: 28 },
      { id: "line", type: "line", x: 12, y: 60, points: [[0, 0], [80, 30]] },
      { id: "arrow", type: "arrow", x: 100, y: 60, points: [[0, 0], [80, 30]], endArrowhead: "triangle" },
      { id: "chalk", type: "freedraw", x: 10, y: 120, points: [[0, 0], [12, 6, 0.6], [24, 0]] },
    ] }, "blackboard", () => `scene-${++sequence}`);

    expect(built.elementIds).toEqual({ heading: "scene-1", line: "scene-2", arrow: "scene-3", chalk: "scene-4" });
    expect(built.skeletons).toEqual([
      expect.objectContaining({ id: "scene-1", type: "text", text: "Intent", fontSize: 28, strokeColor: "#f6f2e9" }),
      expect.objectContaining({ id: "scene-2", type: "line", points: [[0, 0], [80, 30]], strokeColor: "#f6f2e9" }),
      expect.objectContaining({ id: "scene-3", type: "arrow", endArrowhead: "triangle", points: [[0, 0], [80, 30]] }),
      expect.objectContaining({ id: "scene-4", type: "freedraw", points: [[0, 0], [12, 6], [24, 0]], pressures: [0.5, 0.6, 0.5], simulatePressure: false, width: 24, height: 6 }),
    ]);
  });

  it("uses legible defaults and keeps explicit styles for shapes", () => {
    const built = buildPrimitiveSkeletons({ elements: [
      { id: "plain", type: "rectangle", x: 0, y: 0 },
      { id: "accent", type: "ellipse", x: 200, y: 0, width: 120, height: 70, strokeColor: "#e64b45", backgroundColor: "#202020", fillStyle: "hachure", strokeStyle: "dashed" },
    ] }, "white", () => "scene-id");

    expect(built.skeletons[0]).toMatchObject({
      type: "rectangle", width: 180, height: 72, strokeColor: "#1e1e1e", backgroundColor: "#ffffff", fillStyle: "solid",
    });
    expect(built.skeletons[1]).toMatchObject({
      type: "ellipse", width: 120, height: 70, strokeColor: "#e64b45", backgroundColor: "#202020", fillStyle: "hachure", strokeStyle: "dashed",
    });
  });

  it("normalizes line and arrow bounds, binds labeled arrows, and supplies drawable pressure geometry", () => {
    const built = buildPrimitiveSkeletons({ elements: [
      { id: "source", type: "rectangle", x: 100, y: 80, width: 120, height: 60, label: "Source" },
      { id: "target", type: "ellipse", x: 400, y: 80, width: 120, height: 60 },
      { id: "edge", type: "arrow", x: 160, y: 110, points: [[0, 0], [300, 0]], start: "source", end: "target", label: "feeds" },
      { id: "line", type: "line", x: 50, y: 300, points: [[10, 20], [60, 70]] },
      { id: "chalk", type: "freedraw", x: 200, y: 300, points: [[-10, 5], [0, 12], [10, 25, 0.7]] },
      { id: "sketch", type: "freedraw", x: 300, y: 300, points: [[0, 0], [10, 10]] },
    ] }, "blackboard", (() => { let sequence = 0; return () => `scene-${++sequence}`; })());

    expect(built.elementIds).toEqual({ source: "scene-1", target: "scene-2", edge: "scene-3", line: "scene-4", chalk: "scene-5", sketch: "scene-6" });
    expect(built.skeletons[0]).toMatchObject({
      id: "scene-1", type: "rectangle", label: { text: "Source", strokeColor: "#f6f2e9" },
    });
    expect(built.skeletons[2]).toMatchObject({
      id: "scene-3", type: "arrow", x: 160, y: 110, start: { id: "scene-1" }, end: { id: "scene-2" },
      label: { text: "feeds", strokeColor: "#f6f2e9" }, points: [[0, 0], [300, 0]], width: 300, height: 1,
    });
    expect(built.skeletons[3]).toMatchObject({ type: "line", x: 60, y: 320, points: [[0, 0], [50, 50]], width: 50, height: 50 });
    expect(built.skeletons[4]).toMatchObject({
      type: "freedraw", x: 190, y: 305, points: [[0, 0], [10, 7], [20, 20]], pressures: [0.5, 0.5, 0.7], simulatePressure: false, width: 20, height: 20,
    });
    expect(built.skeletons[5]).toMatchObject({ type: "freedraw", points: [[0, 0], [10, 10]], pressures: [], simulatePressure: true });
  });

  it("uses only caller-supplied points for free arrows and bindings for bound arrows", () => {
    const built = buildPrimitiveSkeletons({ elements: [
      { id: "start", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      { id: "end", type: "ellipse", x: 300, y: 0, width: 100, height: 50 },
      { id: "free", type: "arrow", x: 20, y: 100, points: [[0, 0], [80, 30]] },
      { id: "bound", type: "arrow", x: 20, y: 160, points: [[0, 0], [80, 30]], start: "start", end: "end" },
    ] }, "white", (() => { let sequence = 0; return () => `id-${++sequence}`; })());

    expect(built.skeletons[2]).toMatchObject({ x: 20, y: 100, points: [[0, 0], [80, 30]] });
    expect(built.skeletons[3]).toMatchObject({ start: { id: "id-1" }, end: { id: "id-2" }, x: 50, y: 25, points: [[0, 0], [300, 0]], width: 300, height: 1 });
  });
});
