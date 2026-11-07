import type { DrawElement } from "../document/document";

export type SceneEditInput = {
  action: "delete" | "duplicate" | "group" | "ungroup" | "bring_to_front" | "send_to_back" | "align" | "distribute";
  ids: string[];
  offsetX?: number;
  offsetY?: number;
  alignment?: "left" | "right" | "top" | "bottom" | "center_x" | "center_y";
  axis?: "horizontal" | "vertical";
};

type SceneElement = DrawElement & {
  groupIds?: string[];
  containerId?: string | null;
  boundElements?: Array<{ id: string; type: string }> | null;
  startBinding?: { elementId?: string | null } | null;
  endBinding?: { elementId?: string | null } | null;
  isDeleted?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  version?: number;
  versionNonce?: number;
};

export interface SceneEditResult {
  elements: SceneElement[];
  affectedIds: string[];
  createdIds: string[];
  failed: Array<{ id: string; reason: string }>;
}

function touch(element: SceneElement, patch: Partial<SceneElement> = {}): SceneElement {
  return { ...element, ...patch, version: (element.version ?? 0) + 1, versionNonce: (element.versionNonce ?? 0) + 1 };
}

function bounds(elements: SceneElement[]) {
  const left = Math.min(...elements.map((element) => element.x ?? 0));
  const top = Math.min(...elements.map((element) => element.y ?? 0));
  const right = Math.max(...elements.map((element) => (element.x ?? 0) + (element.width ?? 0)));
  const bottom = Math.max(...elements.map((element) => (element.y ?? 0) + (element.height ?? 0)));
  return { left, top, right, bottom };
}

function selectedIndices(elements: SceneElement[], ids: Set<string>) {
  return elements.map((element, index) => ({ element, index })).filter(({ element }) => ids.has(element.id) && !element.isDeleted);
}

export function applySceneEdit(
  source: readonly DrawElement[],
  input: SceneEditInput,
  createId: () => string,
): SceneEditResult {
  let elements = source.map((element) => ({ ...element })) as SceneElement[];
  const available = new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
  const requested = [...new Set(input.ids)];
  const validIds = requested.filter((id) => available.has(id));
  const validSet = new Set(validIds);
  const failed = requested.filter((id) => !available.has(id)).map((id) => ({ id, reason: "Element was not found on the active canvas." }));
  const createdIds: string[] = [];
  const affectedIds = new Set<string>();

  if (input.action === "delete") {
    const deletion = new Set(validIds);
    for (const element of elements) if (!element.isDeleted && element.containerId && deletion.has(element.containerId)) deletion.add(element.id);
    elements = elements.map((element) => {
      if (!deletion.has(element.id) || element.isDeleted) return element;
      affectedIds.add(element.id);
      return touch(element, { isDeleted: true });
    });
  } else if (input.action === "duplicate") {
    const duplicateSet = new Set(validIds);
    for (const element of elements) if (!element.isDeleted && element.containerId && duplicateSet.has(element.containerId)) duplicateSet.add(element.id);
    const selected = elements.filter((element) => duplicateSet.has(element.id) && !element.isDeleted);
    const idMap = new Map(selected.map((element) => [element.id, createId()]));
    const groupMap = new Map<string, string>();
    for (const element of selected) for (const groupId of element.groupIds ?? []) if (!groupMap.has(groupId)) groupMap.set(groupId, createId());
    const copies = selected.map((element) => {
      const id = idMap.get(element.id)!;
      createdIds.push(id);
      affectedIds.add(id);
      return {
        ...element,
        id,
        x: (element.x ?? 0) + (input.offsetX ?? 24),
        y: (element.y ?? 0) + (input.offsetY ?? 24),
        containerId: element.containerId ? idMap.get(element.containerId) ?? null : null,
        boundElements: element.boundElements?.flatMap((bound) => idMap.has(bound.id) ? [{ ...bound, id: idMap.get(bound.id)! }] : []) ?? null,
        startBinding: element.startBinding?.elementId && idMap.has(element.startBinding.elementId)
          ? { ...element.startBinding, elementId: idMap.get(element.startBinding.elementId)! } : null,
        endBinding: element.endBinding?.elementId && idMap.has(element.endBinding.elementId)
          ? { ...element.endBinding, elementId: idMap.get(element.endBinding.elementId)! } : null,
        groupIds: element.groupIds?.map((groupId) => groupMap.get(groupId) ?? groupId) ?? [],
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      } as SceneElement;
    });
    elements.push(...copies);
  } else if (input.action === "group") {
    if (validIds.length < 2) {
      failed.push({ id: "", reason: "Select at least two existing elements to group." });
    } else {
      const groupId = createId();
      elements = elements.map((element) => {
        if (!validSet.has(element.id)) return element;
        affectedIds.add(element.id);
        return touch(element, { groupIds: [...(element.groupIds ?? []), groupId] });
      });
      createdIds.push(groupId);
    }
  } else if (input.action === "ungroup") {
    for (const id of validIds) {
      const element = available.get(id)!;
      const groups = element.groupIds ?? [];
      if (!groups.length) {
        failed.push({ id, reason: "Element is not in a group." });
        continue;
      }
      const groupId = groups[groups.length - 1];
      for (const member of elements) {
        if (!(member.groupIds ?? []).includes(groupId)) continue;
        member.groupIds = (member.groupIds ?? []).filter((candidate) => candidate !== groupId);
        member.version = (member.version ?? 0) + 1;
        member.versionNonce = (member.versionNonce ?? 0) + 1;
        affectedIds.add(member.id);
      }
    }
  } else if (input.action === "bring_to_front" || input.action === "send_to_back") {
    for (const element of elements) if (!element.isDeleted && element.containerId && validSet.has(element.containerId)) validSet.add(element.id);
    const selected = elements.filter((element) => validSet.has(element.id));
    const unselected = elements.filter((element) => !validSet.has(element.id));
    elements = input.action === "bring_to_front" ? [...unselected, ...selected] : [...selected, ...unselected];
    validIds.forEach((id) => affectedIds.add(id));
  } else if (input.action === "align") {
    if (validIds.length < 2 || !input.alignment) {
      failed.push({ id: "", reason: "Align requires at least two elements and an alignment." });
    } else {
      const selected = validIds.map((id) => available.get(id)!);
      const rect = bounds(selected);
      elements = elements.map((element) => {
        if (!validSet.has(element.id)) return element;
        const width = element.width ?? 0;
        const height = element.height ?? 0;
        const position = {
          left: { x: rect.left },
          right: { x: rect.right - width },
          top: { y: rect.top },
          bottom: { y: rect.bottom - height },
          center_x: { x: (rect.left + rect.right - width) / 2 },
          center_y: { y: (rect.top + rect.bottom - height) / 2 },
        }[input.alignment!];
        affectedIds.add(element.id);
        return touch(element, position);
      });
    }
  } else if (input.action === "distribute") {
    if (validIds.length < 3 || !input.axis) {
      failed.push({ id: "", reason: "Distribute requires at least three elements and an axis." });
    } else {
      const sorted = validIds.map((id) => available.get(id)!).sort((a, b) =>
        input.axis === "horizontal" ? (a.x ?? 0) - (b.x ?? 0) : (a.y ?? 0) - (b.y ?? 0));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const horizontal = input.axis === "horizontal";
      const start = horizontal ? first.x ?? 0 : first.y ?? 0;
      const end = horizontal ? (last.x ?? 0) + (last.width ?? 0) : (last.y ?? 0) + (last.height ?? 0);
      const occupied = sorted.reduce((sum, element) => sum + (horizontal ? element.width ?? 0 : element.height ?? 0), 0);
      const gap = (end - start - occupied) / (sorted.length - 1);
      let cursor = start;
      const nextPositions = new Map<string, number>();
      for (const element of sorted) {
        nextPositions.set(element.id, cursor);
        cursor += (horizontal ? element.width ?? 0 : element.height ?? 0) + gap;
      }
      elements = elements.map((element) => {
        if (!nextPositions.has(element.id)) return element;
        affectedIds.add(element.id);
        return touch(element, horizontal ? { x: nextPositions.get(element.id)! } : { y: nextPositions.get(element.id)! });
      });
    }
  }

  return { elements, affectedIds: [...affectedIds], createdIds, failed };
}
