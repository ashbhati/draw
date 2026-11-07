import type { DrawDocument } from "../document/document";

function sameRevision(left: DrawDocument, right: DrawDocument): boolean {
  return left.document.id === right.document.id &&
    left.document.documentRevision === right.document.documentRevision &&
    left.document.viewRevision === right.document.viewRevision;
}

/** A canceled command can be rolled back only if no later human/document edit has advanced the canvas. */
export function canRestoreCancelledMcpCommand(
  baseline: DrawDocument,
  commandResult: DrawDocument,
  latest: DrawDocument | null,
): boolean {
  return Boolean(latest && (sameRevision(latest, baseline) || sameRevision(latest, commandResult)));
}
