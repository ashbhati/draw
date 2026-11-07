import type { DrawDocument } from "../document/document";

export type CancellationViewport = { x: number; y: number; zoom: number };
export type CancellationSelection = Record<string, boolean>;

function sameCanvasState(left: DrawDocument, right: DrawDocument): boolean {
  const elementSignature = (document: DrawDocument) => JSON.stringify({
    order: [...document.document.elements].sort((left, right) => String(left.index ?? "").localeCompare(String(right.index ?? ""))).map((element) => element.id),
    elements: document.document.elements.map((element) => {
      const { index: _index, version: _version, versionNonce: _versionNonce, updated: _updated, ...sceneState } = element as typeof element & Record<string, unknown>;
      return sceneState;
    }),
  });
  return left.document.id === right.document.id &&
    left.document.title === right.document.title &&
    JSON.stringify(left.document.canvas.background) === JSON.stringify(right.document.canvas.background) &&
    JSON.stringify(left.document.canvas.viewport) === JSON.stringify(right.document.canvas.viewport) &&
    elementSignature(left) === elementSignature(right) &&
    JSON.stringify(left.document.assets) === JSON.stringify(right.document.assets) &&
    JSON.stringify(left.document.appState) === JSON.stringify(right.document.appState);
}

/** Ignore revision counter churn, but refuse rollback if any persisted canvas state changed later. */
export function canRestoreCancelledMcpCommand(
  baseline: DrawDocument,
  commandResult: DrawDocument,
  latest: DrawDocument | null,
  liveViewport?: CancellationViewport,
  liveSelection?: CancellationSelection,
): boolean {
  if (!latest || (!sameCanvasState(latest, baseline) && !sameCanvasState(latest, commandResult))) return false;
  if (liveViewport) {
    const matches = (viewport: CancellationViewport) => Math.abs(liveViewport.x - viewport.x) < 0.01 &&
      Math.abs(liveViewport.y - viewport.y) < 0.01 && Math.abs(liveViewport.zoom - viewport.zoom) < 0.0001;
    // onChange persists viewport revisions on a debounce. Compare the live API
    // state as well so a recent pan cannot be overwritten during that window.
    if (!matches(baseline.document.canvas.viewport) && !matches(commandResult.document.canvas.viewport)) return false;
  }
  if (liveSelection) {
    const normalizedSelection = (selection: CancellationSelection) => JSON.stringify(Object.keys(selection).filter((id) => selection[id]).sort());
    const selectionMatches = (document: DrawDocument) => normalizedSelection(liveSelection) ===
      normalizedSelection((document.document.appState.selectedElementIds as CancellationSelection | undefined) ?? {});
    if (!selectionMatches(baseline) && !selectionMatches(commandResult)) return false;
  }
  return true;
}
