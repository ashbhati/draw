import { describe, expect, it } from "vitest";
import { parseMcpToolInput as parseMcpToolInputImpl, summarizeCurrentCanvas } from "./mcp-contract";

function parseMcpToolInput(name: string, input: any) {
  const mutating = ["create_diagram", "create_elements", "update_elements", "delete_elements", "duplicate_elements", "group_elements", "ungroup_elements", "arrange_elements", "undo_operation", "redo_operation", "set_canvas_settings"].includes(name);
  return parseMcpToolInputImpl(name, mutating && input && input.idempotencyKey === undefined ? { ...input, idempotencyKey: "test-idempotency-key" } : input);
}

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
        documentRevision: 0,
        viewRevision: 0,
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
        documentRevision: 0, viewRevision: 0,
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
        documentRevision: 0, viewRevision: 0,
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
        idempotencyKey: "test-idempotency-key",
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
      input: { idempotencyKey: "test-idempotency-key", updates: [{ id: "el-1", patch: { text: "Validation", x: 220, strokeColor: "#f3c94c" } }] },
    });
    expect(() =>
      parseMcpToolInput("update_elements", {
        updates: [{ id: "el-1", patch: { color: "#fff" } }],
      }),
    ).toThrow(/unsupported update field/i);
  });

  it("validates scene editing inputs with explicit document revisions", () => {
    expect(parseMcpToolInput("delete_elements", {
      documentId: "doc-1", expectedDocumentRevision: 4, ids: ["a", "b"],
    })).toEqual({ operation: "delete_elements", input: { documentId: "doc-1", expectedDocumentRevision: 4, idempotencyKey: "test-idempotency-key", ids: ["a", "b"] } });
    expect(() => parseMcpToolInput("delete_elements", {
      documentId: "doc-1", expectedDocumentRevision: 4, ids: ["a", "a"],
    })).toThrow(/duplicates/i);
    expect(() => parseMcpToolInput("arrange_elements", {
      documentId: "doc-1", expectedDocumentRevision: 0, ids: ["a"], action: "align", alignment: "left",
    })).toThrow(/at least two/i);
  });

  it("requires explicit document and view revisions for settings and viewport tools", () => {
    expect(parseMcpToolInput("set_canvas_settings", {
      documentId: "doc-1", expectedDocumentRevision: 2, background: "white", title: "Updated",
    })).toMatchObject({ operation: "set_canvas_settings", input: { background: "white", title: "Updated" } });
    expect(parseMcpToolInput("set_viewport", {
      documentId: "doc-1", expectedViewRevision: 1, idempotencyKey: "viewport-1", action: "set", x: -120, y: 30, zoom: 1.25,
    })).toMatchObject({ operation: "set_viewport", input: { x: -120, y: 30, zoom: 1.25 } });
    expect(() => parseMcpToolInput("set_viewport", {
      documentId: "doc-1", expectedViewRevision: 1, idempotencyKey: "viewport-invalid", action: "set", x: 0, y: 0, zoom: 20,
    })).toThrow(/zoom/i);
    expect(() => parseMcpToolInput("set_viewport", {
      documentId: "doc-1", expectedViewRevision: 1, action: "set", x: 0, y: 0, zoom: 1,
    })).toThrow(/idempotencyKey/i);
  });

  it("rejects absolute paths, traversal and mismatched file extensions", () => {
    const base = { documentId: "doc-1", expectedDocumentRevision: 0 };
    expect(() => parseMcpToolInput("open_document", { ...base, path: "../secret.draw" })).toThrow(/plain filename/i);
    expect(() => parseMcpToolInput("open_document", { ...base, path: "/tmp/private.draw" })).toThrow(/plain filename/i);
    expect(() => parseMcpToolInput("save_document", { ...base, path: "export.png" })).toThrow(/\.draw/i);
    expect(parseMcpToolInput("export_image", { ...base, format: "png", scope: "canvas", path: "flow.png" })).toMatchObject({ operation: "export_image" });
    expect(() => parseMcpToolInput("export_image", { ...base, format: "png", scope: "canvas", path: "flow.jpg" })).toThrow(/\.png/i);
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
      input: { idempotencyKey: "test-idempotency-key", elements: [
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

  it("accepts only embedded PNG or JPEG MCP image insertion with retained license metadata", () => {
    const attribution = { provider: "Openverse", providerId: "123e4567-e89b-12d3-a456-426614174000", title: "Chalk", creator: "Artist", sourceUrl: "https://example.test/work", license: "by", licenseVersion: "4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", capturedAt: "2026-01-01T00:00:00.000Z" };
    expect(parseMcpToolInputImpl("insert_image", {
      documentId: "doc-1", expectedDocumentRevision: 2, idempotencyKey: "image-1", x: 10, y: 20,
      dataURL: `data:image/png;base64,${"A".repeat(64)}`, mimeType: "image/png", width: 320, height: 180, attribution,
      idempotencyPayload: { imageId: attribution.providerId, x: 10, y: 20, width: 320, height: 180 },
    })).toMatchObject({ operation: "insert_image", input: { documentId: "doc-1", expectedDocumentRevision: 2, x: 10, y: 20, mimeType: "image/png", idempotencyPayload: { imageId: attribution.providerId, x: 10 }, attribution: { providerId: attribution.providerId, license: "by", verification: "unverified" } } });
    expect(parseMcpToolInputImpl("insert_openverse_image", {
      documentId: "doc-1", expectedDocumentRevision: 2, idempotencyKey: "verified-image-1", x: 10, y: 20,
      dataURL: `data:image/png;base64,${"A".repeat(64)}`, mimeType: "image/png", width: 320, height: 180,
      attribution: { ...attribution, verification: "unverified" },
      idempotencyPayload: { imageId: attribution.providerId, x: 10, y: 20, width: 320, height: 180 },
    })).toMatchObject({ operation: "insert_image", input: { attribution: { providerId: attribution.providerId, verification: "openverse-index" } } });
    expect(() => parseMcpToolInputImpl("insert_image", {
      documentId: "doc-1", expectedDocumentRevision: 2, idempotencyKey: "image-2", x: 10, y: 20,
      url: "https://evil.example/image.png", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", attribution,
    })).toThrow(/remote image URLs are not accepted/i);
    const unsafeLink = parseMcpToolInputImpl("insert_image", {
      documentId: "doc-1", expectedDocumentRevision: 2, idempotencyKey: "image-3", x: 10, y: 20,
      dataURL: `data:image/png;base64,${"A".repeat(64)}`, mimeType: "image/png", attribution: { ...attribution, creatorUrl: "https://user:pass@evil.example/" },
    });
    if (unsafeLink.operation !== "insert_image") throw new Error("Expected an image insertion command.");
    expect(unsafeLink.input.attribution).not.toHaveProperty("creatorUrl");
    expect(() => parseMcpToolInputImpl("insert_image", {
      documentId: "doc-1", expectedDocumentRevision: 2, idempotencyKey: "image-4", x: 10, y: 20,
      dataURL: `data:image/png;base64,${"A".repeat(64)}`, mimeType: "image/png", attribution: { ...attribution, title: "x".repeat(501) },
    })).toThrow(/valid Openverse ID/i);
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

  it("allows unbound arrows and requires both endpoints for a bound arrow", () => {
    expect(parseMcpToolInput("create_elements", { elements: [
      { id: "free", type: "arrow", x: 10, y: 20, points: [[0, 0], [80, 20]] },
    ] })).toMatchObject({ input: { elements: [{ id: "free", type: "arrow" }] } });
    expect(() => parseMcpToolInput("create_elements", { elements: [
      { id: "partial", type: "arrow", x: 10, y: 20, points: [[0, 0], [80, 20]], start: "shape" },
    ] })).toThrow(/must supply both start and end/i);
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
