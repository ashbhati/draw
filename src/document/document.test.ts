import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  type DrawElement,
  DrawDocumentError,
  fromExcalidrawScene,
  normalizeLegacyDraw,
  parseDrawFile,
  serializeDrawFile,
  toExcalidrawScene,
  validateDrawDocument,
} from "./document";

const exampleElement = {
  id: "shape-1",
  type: "rectangle",
  x: 20,
  y: 30,
  width: 240,
  height: 120,
  strokeColor: "#f5f1e8",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  angle: 0,
  seed: 42,
  version: 1,
  versionNonce: 9,
  isDeleted: false,
  groupIds: [],
  customData: { purpose: "editable scene metadata" },
};

describe("Draw document contract", () => {
  it("creates a single infinite canvas with a usable default background and viewport", () => {
    const doc = createEmptyDocument("My diagram");

    expect(doc.format).toBe("draw");
    expect(doc.formatVersion).toBe(1);
    expect(doc.document.title).toBe("My diagram");
    expect(doc.document.canvas).toMatchObject({
      infinite: true,
      background: { preset: "blackboard", styleVersion: 1 },
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(doc.document.appState.currentItemStrokeColor).toBe("#f6f2e9");
    expect(doc.document.elements).toEqual([]);
    expect(doc.document.assets).toEqual({});
  });

  it("round-trips editable elements, app state, embedded assets, background, and viewport", () => {
    const doc = createEmptyDocument("Round trip");
    doc.document.canvas.background = {
      preset: "white",
      styleVersion: 1,
      color: "#ffffff",
    };
    doc.document.canvas.viewport = { x: -482.25, y: 196.5, zoom: 1.75 };
    doc.document.elements = [exampleElement];
    doc.document.appState = {
      viewBackgroundColor: "#ffffff",
      gridSize: null,
      selectedElementIds: { "shape-1": true },
      scrollX: -482.25,
      scrollY: 196.5,
      zoom: { value: 1.75 },
    };
    doc.document.assets = {
      "image-1": {
        id: "image-1",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,aGVsbG8=",
        created: 123,
      },
    };

    const reopened = parseDrawFile(serializeDrawFile(doc));

    expect(reopened).toEqual(doc);
    expect(reopened.document.elements[0]).toEqual(exampleElement);
    expect(reopened.document.assets["image-1"]).toEqual(doc.document.assets["image-1"]);
  });

  it("round-trips an Excalidraw scene through the document adapters without losing engine fields", () => {
    const scene = {
      elements: [exampleElement],
      appState: { viewBackgroundColor: "transparent", scrollX: 12, scrollY: -7, zoom: { value: 2 } },
      files: {
        "image-1": {
          id: "image-1",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,aGVsbG8=",
          created: 321,
        },
      },
    };

    const doc = fromExcalidrawScene(scene, {
      id: "scene-wrapper",
      title: "Imported scene",
      background: { preset: "blackboard", styleVersion: 1, texture: "chalk-smudge-v1" },
      viewport: { x: 12, y: -7, zoom: 2 },
    });

    expect(toExcalidrawScene(doc)).toEqual(scene);
  });

  it("copies Openverse attribution from image elements into the self-contained asset record", () => {
    const attribution = { provider: "Openverse", providerId: "123e4567-e89b-12d3-a456-426614174000", title: "Chalk arrows", creator: "Artist", sourceUrl: "https://example.test/source", license: "by", licenseVersion: "4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", capturedAt: "2026-01-01T00:00:00.000Z" };
    const doc = fromExcalidrawScene({
      elements: [{ ...exampleElement, type: "image", fileId: "asset-1", customData: { drawAttribution: attribution } }],
      files: { "asset-1": { id: "asset-1", mimeType: "image/png", dataURL: "data:image/png;base64,aGVsbG8=", created: 1 } },
    });
    expect(doc.document.assets["asset-1"]).toMatchObject({ dataURL: "data:image/png;base64,aGVsbG8=", attribution });
    expect(parseDrawFile(serializeDrawFile(doc)).document.assets["asset-1"]?.attribution).toEqual(attribution);
  });

  it("omits ephemeral collaborators from persisted Excalidraw app state", () => {
    const doc = fromExcalidrawScene({
      elements: [],
      appState: { viewBackgroundColor: "#18191a", collaborators: {} },
    });

    expect(doc.document.appState).not.toHaveProperty("collaborators");
    expect(toExcalidrawScene(doc).appState).not.toHaveProperty("collaborators");
  });

  it("migrates the existing plan.draw diagram into an editable version 1 Draw document", async () => {
    const raw = await readFile(resolve(process.cwd(), "plan.draw"), "utf8");
    const parsed = parseDrawFile(raw);

    expect(parsed.format).toBe("draw");
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.document.title).toContain("Draw: From First Canvas");
    expect(parsed.document.canvas.background.preset).toBe("blackboard");
    expect(parsed.document.elements).toHaveLength(32);
    expect(parsed.document.elements.find((element) => element.id === "title")).toMatchObject({
      type: "text",
      text: "DRAW",
      fontSize: 64,
      strokeColor: "#f6f2e9",
    });
    expect(parsed.document.elements.find((element) => element.id === "now-heading")?.strokeColor).toBe("#f3c94c");
    expect(parsed.document.elements.find((element) => element.id === "edit-card")).toMatchObject({
      type: "rectangle",
      width: 448,
      height: 176,
    });
    expect(parsed.document.elements.find((element) => element.id === "proof-line")).toMatchObject({
      type: "line",
      x: 78,
      y: 1510,
      points: [[0, 0], [924, 0]],
    });
    expect(parsed.document.elements.find((element) => element.id === "next-arrow")).toMatchObject({
      type: "arrow",
      x: 540,
      y: 1048,
      points: [[0, 0], [0, 46]],
    });
    expect(parsed.document.assets["chalk-smudge-v1"]).toMatchObject({
      kind: "procedural-background",
    });
  });

  it("rejects an unknown format or unsupported document version with a useful error", () => {
    expect(() => parseDrawFile(JSON.stringify({ format: "other", formatVersion: 1 }))).toThrow(
      DrawDocumentError,
    );
    expect(() => parseDrawFile(JSON.stringify({ format: "draw", formatVersion: 99 }))).toThrow(
      /Unsupported Draw format version 99/,
    );
  });

  it.each([
    ["unknown background preset", { preset: "wood", styleVersion: 1 }],
    ["zero zoom", { preset: "white", styleVersion: 1 }],
  ])("rejects invalid document state (%s)", (_caseName, background) => {
    const doc = createEmptyDocument();
    doc.document.canvas.background = background as typeof doc.document.canvas.background;
    if (_caseName === "zero zoom") doc.document.canvas.viewport.zoom = 0;

    expect(() => validateDrawDocument(doc)).toThrow(DrawDocumentError);
  });

  it("rejects malformed or duplicate scene element IDs", () => {
    const doc = createEmptyDocument();
    doc.document.elements = [
      { ...exampleElement },
      { ...exampleElement, type: "ellipse" },
    ];

    expect(() => validateDrawDocument(doc)).toThrow(/duplicate element id/i);

    doc.document.elements = [{ type: "rectangle" } as unknown as DrawElement];
    expect(() => validateDrawDocument(doc)).toThrow(/element id/i);
  });

  it("rejects malformed embedded assets instead of silently dropping their data", () => {
    const doc = createEmptyDocument();
    doc.document.assets = { "bad-image": { id: "different-id", mimeType: "image/png" } };

    expect(() => validateDrawDocument(doc)).toThrow(/asset/i);
  });

  it("does not accept non-JSON input or non-finite viewport values", () => {
    expect(() => parseDrawFile("not json")).toThrow(DrawDocumentError);

    const doc = createEmptyDocument();
    doc.document.canvas.viewport.x = Number.NaN;
    expect(() => validateDrawDocument(doc)).toThrow(/viewport/i);
  });

  it.each([
    ["missing elements", (raw: Record<string, any>) => { delete raw.document.elements; }],
    ["misspelled elements", (raw: Record<string, any>) => { raw.document.elments = raw.document.elements; delete raw.document.elements; }],
    ["non-array elements", (raw: Record<string, any>) => { raw.document.elements = {}; }],
    ["non-object background", (raw: Record<string, any>) => { raw.document.canvas.background = "blackboard"; }],
    ["non-finite viewport", (raw: Record<string, any>) => { raw.document.canvas.viewport.x = Infinity; }],
    ["non-finite zoom", (raw: Record<string, any>) => { raw.document.canvas.viewport.zoom = NaN; }],
    ["non-positive zoom", (raw: Record<string, any>) => { raw.document.canvas.viewport.zoom = 0; }],
  ])("rejects malformed V1 structure (%s) as INVALID_DOCUMENT", (_name, corrupt) => {
    const raw = JSON.parse(serializeDrawFile(createEmptyDocument()));
    corrupt(raw);

    try {
      parseDrawFile(raw);
      throw new Error("Expected invalid document to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(DrawDocumentError);
      expect((error as DrawDocumentError).code).toBe("INVALID_DOCUMENT");
    }
  });

  it("refuses values that JSON would silently discard from an editable document", () => {
    const doc = createEmptyDocument();
    doc.document.elements = [
      { ...exampleElement, customData: { callback: () => "not portable" } },
    ];

    expect(() => serializeDrawFile(doc)).toThrow(/JSON-safe/i);
  });

  it("normalizes legacy custom primitives without flattening them", async () => {
    const raw = await readFile(resolve(process.cwd(), "plan.draw"), "utf8");
    const legacy = JSON.parse(raw);
    const normalized = normalizeLegacyDraw(legacy);

    expect(normalized.document.elements.every((element) => element.id && element.type)).toBe(true);
    expect(normalized.document.elements.some((element) => element.type === "text")).toBe(true);
    expect(normalized.document.elements.some((element) => element.type === "rectangle")).toBe(true);
    expect(normalized.document.elements.some((element) => element.type === "arrow")).toBe(true);
    expect(normalized.document.elements.some((element) => element.type === "line")).toBe(true);
    expect(normalized.document.elements.find((element) => element.id === "now-body")?.text).toContain("pick up later");
  });
});
