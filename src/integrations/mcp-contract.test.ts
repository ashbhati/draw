import { describe, expect, it } from "vitest";
import { parseMcpToolInput, summarizeCurrentCanvas } from "./mcp-contract";

describe("MCP tool input contract", () => {
  it("summarizes active elements and keeps the newest IDs in large canvases", () => {
    const elements = [
      { id: "deleted", type: "rectangle", isDeleted: true },
      { id: "old", type: "text" },
      { id: "new-1", type: "text" },
      { id: "new-2", type: "text" },
    ];
    const summary = summarizeCurrentCanvas({
      format: "draw",
      formatVersion: 1,
      document: {
        id: "doc-1",
        title: "Flow",
        canvas: { infinite: true, background: { preset: "blackboard", styleVersion: 1 }, viewport: { x: 0, y: 0, zoom: 1 } },
        elements,
        appState: {},
        assets: {},
      },
    }, 2);
    expect(summary.elementCount).toBe(3);
    expect(summary.elements.map((element) => element.id)).toEqual(["new-1", "new-2"]);
    expect(summary.truncated).toBe(true);
    expect(summary.offset).toBe(1);
    expect(summary.hasMore).toBe(false);
    expect(summary.nextOffset).toBeNull();
  });

  it("paginates canvas elements from the beginning and includes edit context", () => {
    const elements = [
      { id: "container", type: "rectangle", x: 12, y: 24, width: 180, height: 80, containerId: null, boundElements: [{ id: "label", type: "text" }], strokeColor: "#123456", backgroundColor: "#ffffff" },
      { id: "label", type: "text", text: "Node label", containerId: "container", x: 24, y: 44, width: 100, height: 20, strokeColor: "#654321", backgroundColor: "transparent" },
      { id: "third", type: "ellipse", x: 320, y: 40, width: 80, height: 60 },
    ];
    const document = {
      format: "draw" as const,
      formatVersion: 1 as const,
      document: {
        id: "doc-1", title: "Flow",
        canvas: { infinite: true as const, background: { preset: "white" as const, styleVersion: 1 }, viewport: { x: 0, y: 0, zoom: 1 } },
        elements, appState: {}, assets: {},
      },
    };

    const firstPage = summarizeCurrentCanvas(document, { offset: 0, limit: 2 });
    expect(firstPage.elements).toEqual([
      expect.objectContaining({
        id: "container", containerId: null,
        boundElements: [{ id: "label", type: "text" }],
        strokeColor: "#123456", backgroundColor: "#ffffff",
      }),
      expect.objectContaining({ id: "label", containerId: "container", strokeColor: "#654321", backgroundColor: "transparent" }),
    ]);
    expect(firstPage).toMatchObject({ offset: 0, limit: 2, nextOffset: 2, hasMore: true });

    const secondPage = summarizeCurrentCanvas(document, { offset: 2, limit: 2 });
    expect(secondPage.elements.map((element) => element.id)).toEqual(["third"]);
    expect(secondPage).toMatchObject({ offset: 2, limit: 2, nextOffset: null, hasMore: false });
  });

  it("rejects out-of-range canvas pagination options", () => {
    const document = {
      format: "draw" as const, formatVersion: 1 as const,
      document: {
        id: "doc-1", title: "Empty",
        canvas: { infinite: true as const, background: { preset: "white" as const, styleVersion: 1 }, viewport: { x: 0, y: 0, zoom: 1 } },
        elements: [], appState: {}, assets: {},
      },
    };
    expect(() => summarizeCurrentCanvas(document, { offset: -1, limit: 10 })).toThrow(/offset/i);
    expect(() => summarizeCurrentCanvas(document, { offset: 0, limit: 251 })).toThrow(/limit/i);
  });

  it("accepts an editable node-and-edge diagram specification", () => {
    expect(
      parseMcpToolInput("create_diagram", {
        title: "Spec to validation",
        nodes: [
          { id: "spec", label: "Specification\nWhat & why", x: 40, y: 60, shape: "rectangle", color: "#f3c94c" },
          { id: "build", label: "Implementation", x: 340, y: 60, shape: "diamond" },
        ],
        edges: [{ from: "spec", to: "build", label: "How" }],
      }),
    ).toEqual({
      operation: "create_diagram",
      input: {
        title: "Spec to validation",
        nodes: [
          { id: "spec", label: "Specification\nWhat & why", x: 40, y: 60, shape: "rectangle", color: "#f3c94c" },
          { id: "build", label: "Implementation", x: 340, y: 60, shape: "diamond" },
        ],
        edges: [{ from: "spec", to: "build", label: "How" }],
      },
    });
  });

  it("requires at least one node and rejects duplicate node ids", () => {
    expect(() => parseMcpToolInput("create_diagram", { nodes: [], edges: [] })).toThrow(/at least one node/i);
    expect(() =>
      parseMcpToolInput("create_diagram", {
        nodes: [
          { id: "same", label: "One", x: 0, y: 0 },
          { id: "same", label: "Two", x: 0, y: 200 },
        ],
        edges: [],
      }),
    ).toThrow(/duplicate node id/i);
  });

  it("rejects dangling edges and invalid coordinates", () => {
    expect(() =>
      parseMcpToolInput("create_diagram", {
        nodes: [{ id: "a", label: "A", x: 0, y: 0 }],
        edges: [{ from: "a", to: "missing" }],
      }),
    ).toThrow(/unknown node/i);
    expect(() =>
      parseMcpToolInput("create_diagram", {
        nodes: [{ id: "a", label: "A", x: Number.NaN, y: 0 }],
        edges: [],
      }),
    ).toThrow(/finite/i);
  });

  it("validates and normalizes targeted element updates", () => {
    expect(
      parseMcpToolInput("update_elements", {
        updates: [{ id: "el-1", patch: { text: "Validation", x: 220, strokeColor: "#f3c94c" } }],
      }),
    ).toEqual({
      operation: "update_elements",
      input: { updates: [{ id: "el-1", patch: { text: "Validation", x: 220, strokeColor: "#f3c94c" } }] },
    });
    expect(() =>
      parseMcpToolInput("update_elements", {
        updates: [{ id: "el-1", patch: { color: "#fff" } }],
      }),
    ).toThrow(/unsupported update field/i);
  });

  it("accepts native standalone text, line, arrow, and freehand elements", () => {
    expect(parseMcpToolInput("create_elements", {
      elements: [
        { id: "title", type: "text", x: 20, y: 30, text: "Decision point", fontSize: 24 },
        { id: "connector", type: "line", x: 10, y: 80, points: [[0, 0], [120, 30]] },
        { id: "flow", type: "arrow", x: 10, y: 140, points: [[0, 0], [120, 30]], endArrowhead: "arrow" },
        { id: "chalk", type: "freedraw", x: 10, y: 200, points: [[0, 0], [24, 12], [48, 0]] },
      ],
    })).toEqual({
      operation: "create_elements",
      input: { elements: [
        { id: "title", type: "text", x: 20, y: 30, text: "Decision point", fontSize: 24 },
        { id: "connector", type: "line", x: 10, y: 80, points: [[0, 0], [120, 30]] },
        { id: "flow", type: "arrow", x: 10, y: 140, points: [[0, 0], [120, 30]], endArrowhead: "arrow" },
        { id: "chalk", type: "freedraw", x: 10, y: 200, points: [[0, 0], [24, 12], [48, 0]] },
      ] },
    });
  });

  it("accepts wrapped text, shape labels, arrow labels, and endpoint bindings", () => {
    const command = parseMcpToolInput("create_elements", { elements: [
      { id: "source", type: "rectangle", x: 0, y: 0, label: "Source" },
      { id: "target", type: "ellipse", x: 260, y: 0 },
      { id: "note", type: "text", x: 0, y: 120, text: "A long note", maxWidth: 320 },
      { id: "connection", type: "arrow", x: 180, y: 36, points: [[0, 0], [80, 0]], start: "source", end: "target", label: "feeds" },
    ] });
    expect(command).toMatchObject({
      operation: "create_elements",
      input: { elements: [
        { id: "source", type: "rectangle", label: "Source" },
        { id: "target", type: "ellipse" },
        { id: "note", type: "text", maxWidth: 320 },
        { id: "connection", type: "arrow", start: "source", end: "target", label: "feeds" },
      ] },
    });
  });

  it("rejects pressure values on lines and arrows and rejects zero-length paths", () => {
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "line", type: "line", x: 0, y: 0, points: [[0, 0, 0.5], [10, 10, 0.5]] },
    ] })).toThrow(/pressure is only supported for freedraw/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "arrow", type: "arrow", x: 0, y: 0, points: [[0, 0], [10, 10, 0.5]] },
    ] })).toThrow(/pressure is only supported for freedraw/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "line", type: "line", x: 0, y: 0, points: [[5, 5], [5, 5]] },
    ] })).toThrow(/zero-length/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "arrow", type: "arrow", x: 0, y: 0, points: [[5, 5], [5, 5]] },
    ] })).toThrow(/zero-length/i);
  });

  it("rejects malformed primitive geometry and duplicate input IDs", () => {
    expect(() => parseMcpToolInput("create_elements", { elements: [] })).toThrow(/at least one element/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "dup", type: "text", x: 0, y: 0, text: "A" },
      { id: "dup", type: "text", x: 0, y: 0, text: "B" },
    ] })).toThrow(/duplicate/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "bad", type: "freedraw", x: 0, y: 0, points: [[0, 0]] },
    ] })).toThrow(/between 2 and/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "bad", type: "shape", x: 0, y: 0, width: 20, height: 20 },
    ] })).toThrow(/type is unsupported/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "bad", type: "text", x: 0, y: 0, text: "A", strokeWidth: 2 },
    ] })).toThrow(/unsupported field/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "bad", type: "rectangle", x: 0, y: 0, strokeColor: "transparent" },
    ] })).toThrow(/six-digit hex/i);
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "bad", type: "arrow", x: 0, y: 0, points: [[0, 0], [10, 0]], start: "missing", end: "also-missing" },
    ] })).toThrow(/reference valid shapes/i);
  });
});
