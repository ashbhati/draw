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
      expect.objectContaining({ id: "scene-4", type: "freedraw", points: [[0, 0], [12, 6, 0.6], [24, 0]] }),
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
});
