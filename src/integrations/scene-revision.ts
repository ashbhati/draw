import type { DrawDocument } from "../document/document";

type SceneElement = { id?: unknown; version?: unknown; versionNonce?: unknown; isDeleted?: unknown };

/** Cheap identity/version signature; intentionally never serializes image payloads. */
export function hasSceneContentChanged(
  document: DrawDocument,
  elements: readonly unknown[],
  files: Record<string, unknown>,
  backgroundPreset: string,
): boolean {
  const previous = document.document.elements as SceneElement[];
  if (backgroundPreset !== document.document.canvas.background.preset || previous.length !== elements.length) return true;
  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index];
    const b = elements[index] as SceneElement;
    if (a.id !== b?.id || a.version !== b?.version || a.versionNonce !== b?.versionNonce || a.isDeleted !== b?.isDeleted) return true;
  }
  // File map identity/key changes are sufficient; dataURL contents are not traversed.
  const previousKeys = Object.keys(document.document.assets);
  const nextKeys = Object.keys(files);
  return previousKeys.length !== nextKeys.length || previousKeys.some((key, i) => key !== nextKeys[i]);
}

export function sceneElementsChanged(before: readonly unknown[], after: readonly unknown[]): boolean {
  // Used only to verify a completed undo/redo, not on editor change events.
  return JSON.stringify(before) !== JSON.stringify(after);
}
