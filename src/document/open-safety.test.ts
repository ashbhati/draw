import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "./document";
import { rebaseOpenedDocument, shouldRequireOpenConfirmation } from "./open-safety";

describe("opening a Draw document safely", () => {
  it("requires confirmation after delete-all and for title, background, or asset-only changes", () => {
    const empty = createEmptyDocument();
    expect(shouldRequireOpenConfirmation(empty)).toBe(false);
    const deletedAll = structuredClone(empty);
    deletedAll.document.documentRevision = 2;
    deletedAll.document.elements.push({ id: "deleted", type: "rectangle", isDeleted: true });
    expect(shouldRequireOpenConfirmation(deletedAll)).toBe(true);
    const renamed = structuredClone(empty);
    renamed.document.title = "Project notes";
    expect(shouldRequireOpenConfirmation(renamed)).toBe(true);
    const whiteboard = structuredClone(empty);
    whiteboard.document.canvas.background.preset = "white";
    expect(shouldRequireOpenConfirmation(whiteboard)).toBe(true);
    const assetOnly = structuredClone(empty);
    assetOnly.document.assets.asset = { id: "asset", dataURL: "data:image/png;base64,AA==" };
    expect(shouldRequireOpenConfirmation(assetOnly)).toBe(true);
  });

  it("keeps document and view revisions monotonic when reopening an older copy of the same document", () => {
    const current = createEmptyDocument("Current");
    current.document.documentRevision = 12;
    current.document.viewRevision = 7;
    const older = structuredClone(current);
    older.document.documentRevision = 3;
    older.document.viewRevision = 2;
    const opened = rebaseOpenedDocument(current, older);
    expect(opened.document.documentRevision).toBe(13);
    expect(opened.document.viewRevision).toBe(8);
    const different = createEmptyDocument("Other document");
    expect(rebaseOpenedDocument(current, different).document.id).toBe(different.document.id);
  });
});
