import { describe, expect, it } from "vitest";
import { buildDiagramSkeletons } from "./diagram-builder";

describe("MCP diagram construction", () => {
  it("creates bound node and arrow labels, connection bindings, and input-to-element ids", () => {
    let sequence = 0;
    const result = buildDiagramSkeletons({
      title: "Release flow",
      nodes: [
        { id: "spec", label: "Specification", x: 10, y: 20 },
        { id: "ship", label: "Implementation", x: 310, y: 20, shape: "ellipse" },
      ],
      edges: [{ from: "spec", to: "ship", label: "Builds" }],
    }, "blackboard", () => `id-${++sequence}`);

    expect(result.nodeElementIds).toEqual({ spec: "id-2", ship: "id-3" });
    expect(result.edgeElementIds).toEqual(["id-4"]);
    expect(result.skeletons).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "id-1", type: "text", text: "Release flow" }),
      expect.objectContaining({ id: "id-2", type: "rectangle", label: { text: "Specification", fontSize: 20, strokeColor: "#f6f2e9" } }),
      expect.objectContaining({ id: "id-3", type: "ellipse", label: { text: "Implementation", fontSize: 20, strokeColor: "#f6f2e9" } }),
      expect.objectContaining({
        id: "id-4", type: "arrow", endArrowhead: "arrow",
        start: { id: "id-2" }, end: { id: "id-3" },
        label: { text: "Builds", fontSize: 16, strokeColor: "#f6f2e9" },
      }),
    ]));
  });

  it("uses Draw's recolorable default for a white canvas while respecting explicit colors", () => {
    const result = buildDiagramSkeletons({
      nodes: [
        { id: "default", label: "Default", x: 0, y: 0 },
        { id: "custom", label: "Custom", x: 220, y: 0, color: "#147a55" },
      ],
      edges: [],
    }, "white", () => "node-id");

    expect(result.skeletons[0]).toMatchObject({
      id: "node-id", type: "rectangle", strokeColor: "#1e1e1e", backgroundColor: "#ffffff",
    });
    expect(result.skeletons[1]).toMatchObject({
      id: "node-id", type: "rectangle", strokeColor: "#147a55", backgroundColor: "#ffffff",
      label: { text: "Custom", strokeColor: "#147a55" },
    });
  });
});
