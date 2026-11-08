import { describe, expect, it } from "vitest";
import type { DrawAsset, DrawElement } from "../document/document";
import { cloneLibraryElements, collectLibrarySelection, collectReferencedLibraryAssets } from "./draw-library";

describe("Draw reusable library items", () => {
  it("captures selected elements with bound labels and preserves element relationships", () => {
    const elements = [
      { id: "shape", type: "rectangle", x: 20, y: 30, boundElements: [{ id: "label", type: "text" }] },
      { id: "label", type: "text", containerId: "shape", text: "Reusable step" },
      { id: "unselected", type: "ellipse" },
    ] satisfies DrawElement[];
    const copied = collectLibrarySelection(elements, { shape: true });
    expect(copied).toEqual(elements.slice(0, 2));
  });

  it("includes only image assets referenced by the selected library elements", () => {
    const elements = [
      { id: "image", type: "image", fileId: "used" },
      { id: "shape", type: "rectangle" },
    ] satisfies DrawElement[];
    const assets = {
      used: { id: "used", dataURL: "data:image/png;base64,AA==" },
      unused: { id: "unused", dataURL: "data:image/png;base64,BB==" },
    } satisfies Record<string, DrawAsset>;
    expect(collectReferencedLibraryAssets(elements, assets)).toEqual({ used: assets.used });
  });

  it("inserts independent copies with fresh IDs and remapped labels, bindings, and groups", () => {
    let id = 0;
    const copies = cloneLibraryElements([
      { id: "shape", type: "rectangle", x: 10, y: 20, groupIds: ["group"], boundElements: [{ id: "label", type: "text" }] },
      { id: "label", type: "text", x: 20, y: 30, containerId: "shape", groupIds: ["group"] },
    ] as any, () => `copy-${++id}`);
    expect(copies.map((element) => element.id)).toEqual(["copy-1", "copy-2"]);
    expect(copies[0]).toMatchObject({ x: 34, y: 44, boundElements: [{ id: "copy-2", type: "text" }], groupIds: ["copy-3"] });
    expect(copies[1]).toMatchObject({ x: 44, y: 54, containerId: "copy-1", groupIds: ["copy-3"] });
  });
});
