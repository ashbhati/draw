import { describe, expect, it } from "vitest";
import { applyElementUpdates, routeBoundArrows } from "./scene-updates";

describe("MCP scene updates", () => {
  it("moves container labels and recomputes both ends of connected arrows", () => {
    const scene = [
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 80, version: 1, versionNonce: 10, boundElements: [{ id: "label-a", type: "text" }, { id: "arrow", type: "arrow" }] },
      { id: "label-a", type: "text", x: 20, y: 20, width: 60, height: 30, fontSize: 20, text: "A", originalText: "A", containerId: "a", version: 1, versionNonce: 11 },
      { id: "b", type: "rectangle", x: 200, y: 0, width: 100, height: 80, version: 1, versionNonce: 12, boundElements: [{ id: "arrow", type: "arrow" }] },
      { id: "label-b", type: "text", x: 220, y: 20, width: 60, height: 30, fontSize: 20, text: "B", originalText: "B", containerId: "b", version: 1, versionNonce: 13 },
      { id: "arrow", type: "arrow", x: 50, y: 40, width: 150, height: 0, points: [[0, 0], [150, 0]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" }, version: 1, versionNonce: 14 },
    ];

    const result = applyElementUpdates(scene, [{ id: "a", patch: { x: 20, y: 10, width: 120 } }]);
    expect(result.elements.find((element) => element.id === "label-a")).toMatchObject({ x: 50, y: 35 });
    const arrow = result.elements.find((element) => element.id === "arrow");
    expect(arrow?.x).toBeCloseTo(140);
    expect((arrow?.x ?? 0) + (arrow?.points?.[0]?.[0] ?? 0)).toBeCloseTo(140);
    expect((arrow?.x ?? 0) + (arrow?.points?.[1]?.[0] ?? 0)).toBeCloseTo(200);
    expect(result.updatedIds).toEqual(expect.arrayContaining(["a", "label-a", "arrow"]));
  });

  it("routes text patches on a container to the visible label only", () => {
    const scene = [
      { id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 60, version: 1, versionNonce: 1 },
      { id: "label", type: "text", x: 10, y: 10, width: 80, height: 30, text: "Before", originalText: "Before", containerId: "box", version: 1, versionNonce: 2 },
    ];
    const result = applyElementUpdates(scene, [{ id: "box", patch: { text: "After" } }]);
    expect(result.elements.find((element) => element.id === "label")).toMatchObject({ text: "After", originalText: "After" });
    expect(result.elements.find((element) => element.id === "box")).not.toHaveProperty("text");
  });

  it("refreshes changed text dimensions and keeps the label inside its container", () => {
    const scene = [
      { id: "box", type: "rectangle", x: 0, y: 0, width: 120, height: 64, boundElements: [{ id: "label", type: "text" }] },
      { id: "label", type: "text", x: 20, y: 17, width: 80, height: 30, fontSize: 20, fontFamily: 1, text: "A", originalText: "A", containerId: "box", textAlign: "center", verticalAlign: "middle", lineHeight: 1.25 },
    ];
    const originalText = "A much longer label that needs several lines";
    const measure = (text: string) => {
      const lines = text.split("\n");
      return { width: Math.max(...lines.map((line) => line.length * 10), 1), height: lines.length * 24 };
    };
    const result = applyElementUpdates(scene, [{ id: "box", patch: { text: originalText } }], measure);
    const label = result.elements.find((element) => element.id === "label");
    const box = result.elements.find((element) => element.id === "box");
    expect(label?.text).toContain("\n");
    expect(label?.text?.split("\n").join(" ")).toBe(originalText);
    expect(label?.originalText).toBe(originalText);
    expect(Math.max(...(label?.text?.split("\n").map((line) => line.length * 10) ?? []))).toBeLessThanOrEqual(100);
    expect(label?.height).toBeGreaterThan(30);
    expect(box?.height).toBeGreaterThan(64);
    expect((label?.x ?? 0) + (label?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0));
    expect((label?.y ?? 0) + (label?.height ?? 0)).toBeLessThanOrEqual((box?.y ?? 0) + (box?.height ?? 0));
  });

  it.each(["ellipse", "diamond"] as const)("keeps long labels inside the %s inscribed text area", (shapeType) => {
    const scene = [
      { id: "shape", type: shapeType, x: 20, y: 30, width: 180, height: 72 },
      { id: "label", type: "text", x: 30, y: 50, width: 160, height: 24, fontSize: 20, text: "Short", originalText: "Short", containerId: "shape" },
    ];
    const measure = (text: string) => ({
      width: Math.max(...text.split("\n").map((line) => line.length * 10), 1),
      height: text.split("\n").length * 24,
    });
    const result = applyElementUpdates(scene, [{ id: "shape", patch: { text: "A considerably longer label that should wrap to several lines inside this shape" } }], measure);
    const shape = result.elements.find((element) => element.id === "shape")!;
    const label = result.elements.find((element) => element.id === "label")!;
    const widthRatio = (label.width ?? 0) / (shape.width ?? 1);
    const heightRatio = (label.height ?? 0) / (shape.height ?? 1);
    if (shapeType === "ellipse") expect(widthRatio ** 2 + heightRatio ** 2).toBeLessThanOrEqual(1);
    else expect(widthRatio + heightRatio).toBeLessThanOrEqual(1);
    expect(label.text).toContain("\n");
  });

  it("repositions a bound arrow to the resized ellipse boundary after a label grows", () => {
    const scene = [
      { id: "ellipse", type: "ellipse", x: 20, y: 30, width: 180, height: 72, boundElements: [{ id: "ellipse-label", type: "text" }] },
      { id: "ellipse-label", type: "text", x: 30, y: 50, width: 160, height: 24, fontSize: 20, text: "Short", originalText: "Short", containerId: "ellipse" },
      { id: "box", type: "rectangle", x: 360, y: 60, width: 120, height: 72 },
      { id: "arrow", type: "arrow", x: 200, y: 66, width: 160, height: 0, points: [[0, 0], [160, 0]], startBinding: { elementId: "ellipse" }, endBinding: { elementId: "box" }, version: 1, versionNonce: 3 },
    ];
    const result = applyElementUpdates(scene, [{ id: "ellipse", patch: { text: "A long label that grows the ellipse and should keep its connector on the edge" } }], (text) => ({ width: 160, height: text.split("\n").length * 24 }));
    const ellipse = result.elements.find((element) => element.id === "ellipse")!;
    const arrow = result.elements.find((element) => element.id === "arrow")!;
    const [x, y] = arrow.points![0];
    const absoluteX = (arrow.x ?? 0) + x;
    const absoluteY = (arrow.y ?? 0) + y;
    const centerX = (ellipse.x ?? 0) + (ellipse.width ?? 0) / 2;
    const centerY = (ellipse.y ?? 0) + (ellipse.height ?? 0) / 2;
    expect(((absoluteX - centerX) / ((ellipse.width ?? 1) / 2)) ** 2 + ((absoluteY - centerY) / ((ellipse.height ?? 1) / 2)) ** 2).toBeCloseTo(1, 2);
    expect(result.updatedIds).toContain("arrow");
  });

  it("routes newly converted MCP arrows from shape boundaries", () => {
    const routed = routeBoundArrows([
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 80 },
      { id: "b", type: "diamond", x: 240, y: 0, width: 100, height: 80 },
      { id: "arrow", type: "arrow", x: 50, y: 40, width: 240, height: 0, points: [[0, 0], [240, 0]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
    ]);
    const arrow = routed.find((element) => element.id === "arrow")!;
    expect((arrow.x ?? 0) + arrow.points![0][0]).toBeCloseTo(100);
    expect((arrow.x ?? 0) + arrow.points![arrow.points!.length - 1][0]).toBeCloseTo(240);
  });

  it("rejects points patches because linear geometry needs endpoint-aware rescaling", () => {
    const scene = [{ id: "arrow", type: "arrow", x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] }];
    expect(() => applyElementUpdates(scene, [{ id: "arrow", patch: { points: [[0, 0], [200, 0]] } } as never])).toThrow(/points.*unsupported|unsupported.*points/i);
  });

  it("recenters and resizes an edited arrow label without changing the arrow points", () => {
    const scene = [
      { id: "arrow", type: "arrow", x: 10, y: 20, width: 100, height: 0, points: [[0, 0], [100, 0]] },
      { id: "label", type: "text", x: 40, y: 5, width: 40, height: 30, text: "old", originalText: "old", containerId: "arrow", fontSize: 20 },
    ];
    const result = applyElementUpdates(scene, [{ id: "label", patch: { text: "a longer arrow label" } }]);
    const arrow = result.elements.find((element) => element.id === "arrow");
    const label = result.elements.find((element) => element.id === "label");
    expect(arrow?.points).toEqual([[0, 0], [100, 0]]);
    expect((label?.x ?? 0) + (label?.width ?? 0) / 2).toBeCloseTo(60);
    expect((label?.y ?? 0) + (label?.height ?? 0)).toBeLessThan((arrow?.y ?? 0) + (arrow?.points?.[0]?.[1] ?? 0));
    expect(result.updatedIds).toContain("arrow");
  });

  it("moves labels bound to arrows when a connected node moves", () => {
    const scene = [
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 80 },
      { id: "b", type: "rectangle", x: 200, y: 0, width: 100, height: 80 },
      { id: "arrow", type: "arrow", x: 100, y: 40, width: 100, height: 0, points: [[0, 0], [100, 0]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
      { id: "edge-label", type: "text", x: 135, y: 25, width: 30, height: 30, text: "uses", containerId: "arrow" },
    ];
    const result = applyElementUpdates(scene, [{ id: "a", patch: { x: 40 } }]);
    const arrow = result.elements.find((element) => element.id === "arrow");
    const label = result.elements.find((element) => element.id === "edge-label");
    const midpoint = ((arrow?.x ?? 0) + (arrow?.points?.[0]?.[0] ?? 0) + (arrow?.x ?? 0) + (arrow?.points?.[1]?.[0] ?? 0)) / 2;
    expect((label?.x ?? 0) + (label?.width ?? 0) / 2).toBeCloseTo(midpoint);
    expect(result.updatedIds).toContain("edge-label");
  });

  it("rejects missing or deleted targets", () => {
    expect(() => applyElementUpdates([], [{ id: "missing", patch: { x: 1 } }])).toThrow(/active editable element/i);
    expect(() => applyElementUpdates([{ id: "gone", type: "rectangle", isDeleted: true }], [{ id: "gone", patch: { x: 1 } }])).toThrow(/active editable element/i);
  });
});
