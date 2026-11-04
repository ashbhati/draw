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
});
