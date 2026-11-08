import { describe, expect, it, vi } from "vitest";
import type { DrawAsset, DrawElement } from "../document/document";
import { cloneLibraryElements, collectLibrarySelection, collectReferencedLibraryAssets, libraryItemsEquivalentForPersistence, reloadLibraryAfterConflict, shouldPersistLibraryChange } from "./draw-library";

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

  it("ignores Excalidraw library bookkeeping but detects content and order changes", () => {
    const saved = [{ id: "item", name: "Saved", created: 1, status: "unpublished", elements: [{ id: "shape", type: "rectangle" }], assets: {} }];
    expect(libraryItemsEquivalentForPersistence(saved, [{ ...saved[0], created: 9, status: "published" }])).toBe(true);
    expect(libraryItemsEquivalentForPersistence(saved, [{ ...saved[0], name: "Renamed" }])).toBe(false);
    expect(libraryItemsEquivalentForPersistence(saved, [{ ...saved[0], elements: [{ id: "other", type: "rectangle" }] }])).toBe(false);
  });

  it("never persists a stale tab snapshot without the writer lock", () => {
    const stale = [{ id: "old", name: "Old snapshot", elements: [{ id: "old-shape" }], assets: {} }];
    const saved = [...stale, { id: "new", name: "Newer item", elements: [{ id: "new-shape" }], assets: {} }];
    expect(shouldPersistLibraryChange(false, stale, saved)).toBe(false);
    expect(shouldPersistLibraryChange(true, saved, saved)).toBe(false);
    expect(shouldPersistLibraryChange(true, stale, saved)).toBe(true);
  });

  it("distinguishes a library conflict reload from a workspace deleted during reload", async () => {
    const directConflict = new Error("The library changed.");
    directConflict.name = "WorkspaceLibraryConflictError";
    await expect(reloadLibraryAfterConflict(directConflict, async () => ({ revision: 3 }))).resolves.toEqual({ state: { revision: 3 } });
    await expect(reloadLibraryAfterConflict(new Error("Workspace does not exist."), async () => ({ revision: 3 }))).resolves.toEqual({ deleted: true });
    const conflict = new Error("A library changed elsewhere.");
    conflict.name = "WorkspaceLibraryConflictError";
    await expect(reloadLibraryAfterConflict(conflict, async () => { throw new Error("Workspace does not exist."); })).resolves.toEqual({ deleted: true });
    const shouldNotReload = vi.fn(async () => ({ revision: 3 }));
    await expect(reloadLibraryAfterConflict(new Error("Workspace does not exist."), shouldNotReload)).resolves.toEqual({ deleted: true });
    expect(shouldNotReload).not.toHaveBeenCalled();
    await expect(reloadLibraryAfterConflict(new Error("IndexedDB is unavailable."), async () => ({ revision: 3 }))).rejects.toThrow("IndexedDB is unavailable");
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
