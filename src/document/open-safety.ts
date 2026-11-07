import type { DrawDocument } from "./document";

/** A save-worthy change makes replacement confirmation necessary, even after delete-all. */
export function shouldRequireOpenConfirmation(document: DrawDocument): boolean {
  return (
    document.document.documentRevision > 0 ||
    document.document.title !== "Untitled drawing" ||
    document.document.canvas.background.preset !== "blackboard" ||
    document.document.elements.some((element) => !element.isDeleted) ||
    Object.keys(document.document.assets).length > 0
  );
}

/** Keep revision checks monotonic when reopening a prior copy of this document. */
export function rebaseOpenedDocument(current: DrawDocument, opened: DrawDocument): DrawDocument {
  const next = structuredClone(opened);
  if (current.document.id === opened.document.id) {
    next.document.documentRevision = Math.max(current.document.documentRevision, opened.document.documentRevision) + 1;
    next.document.viewRevision = Math.max(current.document.viewRevision, opened.document.viewRevision) + 1;
  }
  return next;
}
