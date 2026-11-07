import { describe, expect, it } from "vitest";
import { hasSceneContentChanged } from "./scene-revision";
import { createEmptyDocument } from "../document/document";

describe("cheap scene change detection", () => {
  it("uses ordered element IDs and Excalidraw versions without serializing embedded data URLs", () => {
    const document = createEmptyDocument();
    document.document.elements.push({ id: "shape", type: "rectangle", version: 1, versionNonce: 10, x: 0, y: 0 });
    const dataURL = `data:image/png;base64,${"x".repeat(200_000)}`;
    document.document.assets.image = { id: "image", dataURL, mimeType: "image/png" };
    const files = { image: document.document.assets.image };
    expect(hasSceneContentChanged(document, structuredClone(document.document.elements), files, "blackboard")).toBe(false);
    const edited = structuredClone(document.document.elements);
    edited[0].version = 2;
    expect(hasSceneContentChanged(document, edited, files, "blackboard")).toBe(true);
    expect(hasSceneContentChanged(document, document.document.elements, files, "white")).toBe(true);
  });
});
