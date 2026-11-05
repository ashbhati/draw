import type { ElementUpdateInput } from "./mcp-contract";

export type EditableSceneElement = {
  id: string;
  type: string;
  isDeleted?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: number[][];
  containerId?: string | null;
  startBinding?: { elementId?: string | null } | null;
  endBinding?: { elementId?: string | null } | null;
  text?: string;
  originalText?: string;
  version?: number;
  versionNonce?: number;
  [key: string]: unknown;
};
export type TextMetrics = { width: number; height: number };
export type MeasureText = (text: string, fontSize: number, element: EditableSceneElement) => TextMetrics;

function touch(element: EditableSceneElement, patch: Record<string, unknown> = {}): EditableSceneElement {
  return {
    ...element,
    ...patch,
    version: (element.version ?? 0) + 1,
    versionNonce: (element.versionNonce ?? 0) + 1,
  };
}

const EDITABLE_PATCH_FIELDS = new Set([
  "text", "x", "y", "width", "height", "strokeColor", "backgroundColor",
]);

function measureApproximateText(text: string, fontSize: number, maxWidth: number): { width: number; height: number } {
  const characterWidth = Math.max(1, fontSize * 0.58);
  const capacity = Math.max(1, Math.floor(maxWidth / characterWidth));
  let lineCount = 0;
  let widestLine = 0;
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lineCount += 1;
      continue;
    }
    let lineLength = 0;
    for (const word of words) {
      let remaining = word.length;
      while (remaining > 0) {
        const gap = lineLength ? 1 : 0;
        const room = capacity - lineLength - gap;
        if (room <= 0) {
          widestLine = Math.max(widestLine, lineLength);
          lineCount += 1;
          lineLength = 0;
          continue;
        }
        const taken = Math.min(remaining, room);
        lineLength += gap + taken;
        remaining -= taken;
        if (remaining > 0) {
          widestLine = Math.max(widestLine, lineLength);
          lineCount += 1;
          lineLength = 0;
        }
      }
    }
    widestLine = Math.max(widestLine, lineLength);
    lineCount += 1;
  }
  const lineHeight = fontSize * 1.25;
  return { width: Math.min(maxWidth, Math.max(characterWidth, widestLine * characterWidth)), height: Math.max(lineHeight, lineCount * lineHeight) };
}

function refreshUpdatedText(
  elements: EditableSceneElement[],
  textElementId: string,
  measureText: MeasureText,
): void {
  const textIndex = elements.findIndex((element) => element.id === textElementId && !element.isDeleted);
  if (textIndex < 0) return;
  const textElement = elements[textIndex];
  if (textElement.type !== "text" || typeof textElement.text !== "string") return;
  const container = textElement.containerId
    ? elements.find((element) => element.id === textElement.containerId && !element.isDeleted)
    : undefined;
  const shapeContainer = container && ["rectangle", "ellipse", "diamond"].includes(container.type) ? container : undefined;
  const fontSize = typeof textElement.fontSize === "number" && textElement.fontSize > 0 ? textElement.fontSize : 20;
  const rawText = textElement.originalText ?? textElement.text;
  const ratio = shapeContainer?.type === "ellipse" ? 0.7 : shapeContainer?.type === "diamond" ? 0.5 : 1;
  const maxWidth = shapeContainer
    ? Math.max(1, ((shapeContainer.width ?? textElement.width ?? 1) - 20) * ratio)
    : Math.max(1, textElement.width ?? rawText.length * fontSize * 0.58);
  const wrappedText = shapeContainer
    ? wrapTextToWidth(rawText, maxWidth, (line) => measureText(line, fontSize, { ...textElement, width: maxWidth }).width)
    : rawText;
  const dimensions = measureText(wrappedText, fontSize, { ...textElement, width: maxWidth });
  const width = shapeContainer ? maxWidth : dimensions.width;
  const height = dimensions.height;
  const nextText = touch(textElement, {
    text: wrappedText,
    originalText: rawText,
    width,
    height,
    ...(shapeContainer ? {
      x: (shapeContainer.x ?? 0) + ((shapeContainer.width ?? width) - width) / 2,
      y: (shapeContainer.y ?? 0) + ((shapeContainer.height ?? height) - height) / 2,
    } : {}),
  });
  elements[textIndex] = nextText;

  // Rectangles can use the full inner box. Ellipses and diamonds need a
  // narrower inscribed label box; grow both dimensions to retain that margin.
  if (shapeContainer) {
    const containerIndex = elements.findIndex((element) => element.id === shapeContainer.id);
    if (containerIndex >= 0) {
      const newWidth = Math.max(shapeContainer.width ?? 0, Math.ceil((width + 20) / ratio));
      const newHeight = Math.max(shapeContainer.height ?? 0, Math.ceil((height + 20) / ratio));
      if (newWidth === shapeContainer.width && newHeight === shapeContainer.height) return;
      const nextContainer = touch(elements[containerIndex], { width: newWidth, height: newHeight });
      elements[containerIndex] = nextContainer;
      elements[textIndex] = touch(elements[textIndex], {
        x: (nextContainer.x ?? 0) + (newWidth - width) / 2,
        y: (nextContainer.y ?? 0) + (newHeight - height) / 2,
      });
    }
  }
}

function wrapTextToWidth(text: string, maxWidth: number, measureLine: (text: string) => number): string {
  return text.split("\n").map((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const pieces = measureLine(word) > maxWidth ? Array.from(word) : [word];
      for (const piece of pieces) {
        const candidate = line ? `${line} ${piece}` : piece;
        if (!line || measureLine(candidate) <= maxWidth) line = candidate;
        else { lines.push(line); line = piece; }
      }
    }
    if (line) lines.push(line);
    return lines.join("\n");
  }).join("\n");
}

function fallbackMeasureText(text: string, fontSize: number, element: EditableSceneElement): TextMetrics {
  const availableWidth = Math.max(1, element.width ?? text.length * fontSize * 0.58);
  return measureApproximateText(text, fontSize, availableWidth);
}

function center(element: EditableSceneElement): [number, number] {
  return [(element.x ?? 0) + (element.width ?? 0) / 2, (element.y ?? 0) + (element.height ?? 0) / 2];
}

function getBoundaryPoint(element: EditableSceneElement, toward: [number, number]): [number, number] {
  const [cx, cy] = center(element);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  const rx = Math.max(1, (element.width ?? 1) / 2);
  const ry = Math.max(1, (element.height ?? 1) / 2);
  if (Math.abs(dx) + Math.abs(dy) < 0.001) return [cx, cy];
  let scale: number;
  if (element.type === "ellipse") {
    scale = 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
  } else if (element.type === "diamond") {
    scale = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
  } else {
    scale = Math.min(Math.abs(dx) < 0.001 ? Infinity : rx / Math.abs(dx), Math.abs(dy) < 0.001 ? Infinity : ry / Math.abs(dy));
  }
  return [cx + dx * scale, cy + dy * scale];
}

function repositionBoundText(
  elements: EditableSceneElement[],
  oldShape: EditableSceneElement,
  newShape: EditableSceneElement,
): void {
  const labels = elements.filter((element) => element.containerId === newShape.id && !element.isDeleted);
  const dx = (newShape.x ?? 0) - (oldShape.x ?? 0);
  const dy = (newShape.y ?? 0) - (oldShape.y ?? 0);
  for (const label of labels) {
    const maxWidth = Math.max(1, (newShape.width ?? label.width ?? 1) - 20);
    const maxHeight = Math.max(1, (newShape.height ?? label.height ?? 1) - 20);
    const width = Math.min(label.width ?? maxWidth, maxWidth);
    const height = Math.min(label.height ?? maxHeight, maxHeight);
    const geometryChanged = oldShape.width !== newShape.width || oldShape.height !== newShape.height;
    elements[elements.indexOf(label)] = touch(label, {
      x: geometryChanged ? (newShape.x ?? 0) + ((newShape.width ?? width) - width) / 2 : (label.x ?? 0) + dx,
      y: geometryChanged ? (newShape.y ?? 0) + ((newShape.height ?? height) - height) / 2 : (label.y ?? 0) + dy,
      width,
      height,
    });
  }
}

function repositionBoundArrows(
  elements: EditableSceneElement[],
  changedShapes: Map<string, EditableSceneElement>,
): void {
  const shapeById = new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
  for (let index = 0; index < elements.length; index += 1) {
    const arrow = elements[index];
    if ((arrow.type !== "arrow" && arrow.type !== "line") || !Array.isArray(arrow.points) || arrow.points.length < 2) continue;
    const startShapeId = arrow.startBinding?.elementId;
    const endShapeId = arrow.endBinding?.elementId;
    if (!changedShapes.has(startShapeId ?? "") && !changedShapes.has(endShapeId ?? "")) continue;
    const points = arrow.points.map(([x, y]) => [(arrow.x ?? 0) + x, (arrow.y ?? 0) + y] as [number, number]);
    const lastIndex = points.length - 1;
    if (startShapeId && changedShapes.has(startShapeId)) {
      const boundShape = shapeById.get(startShapeId);
      const otherShape = endShapeId ? shapeById.get(endShapeId) : undefined;
      if (boundShape) points[0] = getBoundaryPoint(boundShape, otherShape ? center(otherShape) : points[lastIndex]);
    }
    if (endShapeId && changedShapes.has(endShapeId)) {
      const boundShape = shapeById.get(endShapeId);
      const otherShape = startShapeId ? shapeById.get(startShapeId) : undefined;
      if (boundShape) points[lastIndex] = getBoundaryPoint(boundShape, otherShape ? center(otherShape) : points[0]);
    }
    const minX = Math.min(...points.map(([x]) => x));
    const minY = Math.min(...points.map(([, y]) => y));
    const maxX = Math.max(...points.map(([x]) => x));
    const maxY = Math.max(...points.map(([, y]) => y));
    elements[index] = touch(arrow, {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      points: points.map(([x, y]) => [x - minX, y - minY]),
    });
  }
}

function repositionBoundArrowLabels(
  elements: EditableSceneElement[],
  updatedIds: Set<string>,
): void {
  for (const arrow of elements) {
    if (!updatedIds.has(arrow.id) || (arrow.type !== "arrow" && arrow.type !== "line") || !arrow.points || arrow.points.length < 2) continue;
    const first = arrow.points[0];
    const last = arrow.points[arrow.points.length - 1];
    const midpointX = (arrow.x ?? 0) + (first[0] + last[0]) / 2;
    const midpointY = (arrow.y ?? 0) + (first[1] + last[1]) / 2;
    for (let index = 0; index < elements.length; index += 1) {
      const label = elements[index];
      if (label.containerId !== arrow.id || label.isDeleted) continue;
      const width = label.width ?? 0;
      const height = label.height ?? 0;
      // Keep edge labels readable by placing them above the connector line.
      elements[index] = touch(label, { x: midpointX - width / 2, y: midpointY - height - 8 });
      updatedIds.add(label.id);
    }
  }
}

/** Recompute the endpoints of converted MCP arrows against their bound shapes. */
export function routeBoundArrows(scene: readonly EditableSceneElement[]): EditableSceneElement[] {
  const elements = scene.map((element) => ({ ...element }));
  const changedShapes = new Map(
    elements
      .filter((element) => ["rectangle", "ellipse", "diamond"].includes(element.type) && !element.isDeleted)
      .map((element) => [element.id, element]),
  );
  repositionBoundArrows(elements, changedShapes);
  const updatedIds = new Set(elements
    .filter((element) => (element.type === "arrow" || element.type === "line") &&
      (changedShapes.has(element.startBinding?.elementId ?? "") || changedShapes.has(element.endBinding?.elementId ?? "")))
    .map((element) => element.id));
  repositionBoundArrowLabels(elements, updatedIds);
  return elements;
}

export function applyElementUpdates(
  scene: readonly EditableSceneElement[],
  updates: readonly ElementUpdateInput[],
  measureText: MeasureText = fallbackMeasureText,
): { elements: EditableSceneElement[]; updatedIds: string[] } {
  const elements = scene.map((element) => ({ ...element }));
  const updatedIds = new Set<string>();
  const changedShapes = new Map<string, EditableSceneElement>();

  for (const update of updates) {
    const index = elements.findIndex((element) => element.id === update.id && !element.isDeleted);
    if (index < 0) throw new Error(`No active editable element found with id "${update.id}".`);
    const target = elements[index];
    const patchFields = Object.keys(update.patch as Record<string, unknown>);
    const unsupportedField = patchFields.find((field) => !EDITABLE_PATCH_FIELDS.has(field));
    if (unsupportedField) throw new Error(`Update field "${unsupportedField}" is unsupported.`);
    if ((target.type === "arrow" || target.type === "line" || target.type === "freedraw") &&
      Array.isArray(target.points) && ("width" in update.patch || "height" in update.patch)) {
      throw new Error("Width or height updates are unsupported for points-based geometry; provide endpoint-aware point scaling instead.");
    }
    const { text, ...geometryPatch } = update.patch;
    if (Object.keys(geometryPatch).length) {
      const changed = touch(target, geometryPatch);
      elements[index] = changed;
      updatedIds.add(target.id);
      if (["rectangle", "ellipse", "diamond"].includes(target.type)) {
        changedShapes.set(target.id, changed);
        repositionBoundText(elements, target, changed);
        for (const label of elements.filter((element) => element.containerId === target.id && !element.isDeleted)) updatedIds.add(label.id);
      }
    }
    if (text !== undefined) {
      const labelIndex = target.containerId
        ? index
        : elements.findIndex((element) => element.containerId === target.id && !element.isDeleted);
      if (labelIndex < 0 && target.type !== "text") {
        throw new Error(`Element "${target.id}" has no editable text label.`);
      }
      const textIndex = labelIndex >= 0 ? labelIndex : index;
      elements[textIndex] = touch(elements[textIndex], { text, originalText: text });
      updatedIds.add(elements[textIndex].id);
      const oldContainer = elements[textIndex].containerId
        ? elements.find((element) => element.id === elements[textIndex].containerId)
        : undefined;
      refreshUpdatedText(elements, elements[textIndex].id, measureText);
      const containerId = elements[textIndex].containerId;
      if (containerId) {
        updatedIds.add(containerId);
        const newContainer = elements.find((element) => element.id === containerId);
        if (oldContainer && newContainer && (oldContainer.width !== newContainer.width || oldContainer.height !== newContainer.height)) {
          changedShapes.set(containerId, newContainer);
        }
      }
    }
  }

  repositionBoundArrows(elements, changedShapes);
  for (const element of elements) {
    if ((element.type === "arrow" || element.type === "line") &&
      (changedShapes.has(element.startBinding?.elementId ?? "") || changedShapes.has(element.endBinding?.elementId ?? ""))) {
      updatedIds.add(element.id);
    }
  }
  repositionBoundArrowLabels(elements, updatedIds);
  return { elements, updatedIds: [...updatedIds] };
}
