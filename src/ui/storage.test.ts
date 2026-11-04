import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { createEmptyDocument } from "../document/document";
import { loadCurrentDocument, saveCurrentDocument } from "./storage";

describe("local Draw autosave", () => {
  beforeEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("draw-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  });

  it("saves and restores an editable Draw document without flattening it", async () => {
    const doc = createEmptyDocument("Research map");
    doc.document.elements.push({
      id: "card-1",
      type: "rectangle",
      x: 20,
      y: 40,
      width: 260,
      height: 120,
      strokeColor: "#ffffff",
    });
    doc.document.canvas.background.preset = "white";
    doc.document.canvas.viewport = { x: -20, y: -40, zoom: 0.8 };

    await saveCurrentDocument(doc);
    const restored = await loadCurrentDocument();

    expect(restored).toEqual(doc);
    expect(restored?.document.elements[0]).toMatchObject({ id: "card-1", type: "rectangle" });
    expect(restored?.document.canvas.background.preset).toBe("white");
  });

  it("returns null before the first autosave", async () => {
    expect(await loadCurrentDocument()).toBeNull();
  });
});
