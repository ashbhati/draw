import type { DrawAsset, DrawElement } from "../document/document";

/** Include Excalidraw-bound text and group members with selected elements. */
export function collectLibrarySelection(
  elements: readonly DrawElement[],
  selectedElementIds: Record<string, boolean> | undefined,
): DrawElement[] {
  if (!selectedElementIds) return [];
  const selected = new Set(Object.keys(selectedElementIds).filter((id) => selectedElementIds[id]));
  const selectedGroups = new Set<string>();
  for (const element of elements) {
    if (!selected.has(element.id)) continue;
    for (const groupId of Array.isArray(element.groupIds) ? element.groupIds : []) {
      if (typeof groupId === "string") selectedGroups.add(groupId);
    }
    for (const bound of Array.isArray(element.boundElements) ? element.boundElements : []) {
      if (typeof bound === "object" && bound !== null && (bound as { type?: unknown }).type === "text" && typeof (bound as { id?: unknown }).id === "string") {
        selected.add((bound as { id: string }).id);
      }
    }
  }
  for (const element of elements) {
    if (Array.isArray(element.groupIds) && element.groupIds.some((groupId) => typeof groupId === "string" && selectedGroups.has(groupId))) selected.add(element.id);
  }
  return elements.filter((element) => element.isDeleted !== true && selected.has(element.id)).map((element) => structuredClone(element));
}

export function collectReferencedLibraryAssets(
  elements: readonly DrawElement[],
  assets: Record<string, DrawAsset>,
): Record<string, DrawAsset> {
  const referenced = new Set(elements.map((element) => element.fileId).filter((fileId): fileId is string => typeof fileId === "string"));
  return Object.fromEntries([...referenced].flatMap((id) => assets[id] ? [[id, structuredClone(assets[id])]] : []));
}

type LibraryPersistenceItem = {
  id: string;
  name?: string;
  elements: unknown;
  assets?: Record<string, unknown>;
  /** Excalidraw library lifecycle metadata is not persisted by Draw. */
  created?: unknown;
  status?: unknown;
};

export function libraryItemsEquivalentForPersistence(
  left: readonly LibraryPersistenceItem[],
  right: readonly LibraryPersistenceItem[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return Boolean(other && item.id === other.id && item.name === other.name
      && JSON.stringify(item.elements) === JSON.stringify(other.elements)
      && JSON.stringify(item.assets ?? {}) === JSON.stringify(other.assets ?? {}));
  });
}

export function shouldPersistLibraryChange(
  writerOwned: boolean,
  previous: readonly LibraryPersistenceItem[],
  next: readonly LibraryPersistenceItem[],
): boolean {
  return writerOwned && !libraryItemsEquivalentForPersistence(previous, next);
}

export async function reloadLibraryAfterConflict<T>(saveError: unknown, loadLatest: () => Promise<T>): Promise<{ state: T } | { deleted: true }> {
  if (!(saveError instanceof Error)) throw saveError;
  if (/workspace does not exist/i.test(saveError.message)) return { deleted: true };
  if (saveError.name !== "WorkspaceLibraryConflictError") throw saveError;
  try { return { state: await loadLatest() }; }
  catch (error) {
    if (error instanceof Error && /workspace does not exist/i.test(error.message)) return { deleted: true };
    throw error;
  }
}

export function cloneLibraryElements<T extends DrawElement>(elements: readonly T[], createId: () => string, offset = 24): T[] {
  const idMap = new Map(elements.map((element) => [element.id, createId()]));
  const groupMap = new Map<string, string>();
  for (const element of elements as readonly any[]) for (const groupId of element.groupIds ?? []) if (!groupMap.has(groupId)) groupMap.set(groupId, createId());
  return elements.map((source) => {
    const element = source as any;
    return {
      ...element,
      id: idMap.get(element.id)!,
      x: (element.x ?? 0) + offset,
      y: (element.y ?? 0) + offset,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      containerId: element.containerId ? idMap.get(element.containerId) ?? null : null,
      boundElements: element.boundElements?.flatMap((bound: any) => idMap.has(bound.id) ? [{ ...bound, id: idMap.get(bound.id)! }] : []) ?? null,
      startBinding: element.startBinding?.elementId && idMap.has(element.startBinding.elementId) ? { ...element.startBinding, elementId: idMap.get(element.startBinding.elementId)! } : null,
      endBinding: element.endBinding?.elementId && idMap.has(element.endBinding.elementId) ? { ...element.endBinding, elementId: idMap.get(element.endBinding.elementId)! } : null,
      groupIds: element.groupIds?.map((groupId: string) => groupMap.get(groupId) ?? groupId) ?? [],
    } as T;
  });
}
