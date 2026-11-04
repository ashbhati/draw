/** Portable, self-contained Draw document format. Version 1 stores editor
 * elements and app state verbatim so opening a file restores editable content. */

export type DrawBackgroundPreset = "blackboard" | "white";

export interface DrawViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface DrawBackground {
  preset: DrawBackgroundPreset;
  styleVersion: number;
  color?: string;
  texture?: string;
}

export type DrawElement = Record<string, unknown> & {
  id: string;
  type: string;
  text?: string;
  fontSize?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: number[][];
};

export type DrawAsset = Record<string, unknown> & {
  id: string;
  dataURL?: string;
  kind?: string;
};

export interface DrawDocument {
  format: "draw";
  formatVersion: 1;
  document: {
    id: string;
    title: string;
    canvas: {
      infinite: true;
      background: DrawBackground;
      viewport: DrawViewport;
      previewBounds?: { x: number; y: number; width: number; height: number };
    };
    elements: DrawElement[];
    appState: Record<string, unknown>;
    assets: Record<string, DrawAsset>;
  };
}

export interface ExcalidrawSceneInput {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export interface DrawDocumentMetadata {
  id?: string;
  title?: string;
  background?: DrawBackground;
  viewport?: DrawViewport;
}

export class DrawDocumentError extends Error {
  readonly code: "INVALID_DOCUMENT" | "UNSUPPORTED_VERSION" | "FILE_TOO_LARGE";

  constructor(
    message: string,
    code: DrawDocumentError["code"] = "INVALID_DOCUMENT",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DrawDocumentError";
    this.code = code;
  }
}

const FORMAT_VERSION = 1 as const;
const MAX_DRAW_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_BLACKBOARD_COLOR = "#18191a";
const DEFAULT_WHITE_COLOR = "#ffffff";
const DEFAULT_BACKGROUND: DrawBackground = {
  preset: "blackboard",
  styleVersion: 1,
  color: DEFAULT_BLACKBOARD_COLOR,
  texture: "chalk-smudge-v1",
};

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const makeId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `draw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

const copyJsonValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const defaultAppState = (background: DrawBackground, viewport: DrawViewport) => ({
  viewBackgroundColor:
    background.color ??
    (background.preset === "white" ? DEFAULT_WHITE_COLOR : DEFAULT_BLACKBOARD_COLOR),
  scrollX: viewport.x,
  scrollY: viewport.y,
  zoom: { value: viewport.zoom },
  currentItemStrokeColor: background.preset === "blackboard" ? "#f6f2e9" : "#1e1e1e",
});

export function createEmptyDocument(title = "Untitled drawing"): DrawDocument {
  const background = { ...DEFAULT_BACKGROUND };
  const viewport = { x: 0, y: 0, zoom: 1 };
  return {
    format: "draw",
    formatVersion: FORMAT_VERSION,
    document: {
      id: makeId(),
      title,
      canvas: {
        infinite: true,
        background,
        viewport,
      },
      elements: [],
      appState: defaultAppState(background, viewport),
      assets: {},
    },
  };
}

export function validateDrawDocument(value: unknown): asserts value is DrawDocument {
  if (!isRecord(value) || value.format !== "draw") {
    throw new DrawDocumentError('Expected a Draw document with format "draw".');
  }
  if (value.formatVersion !== FORMAT_VERSION) {
    throw new DrawDocumentError(
      `Unsupported Draw format version ${String(value.formatVersion)}.`,
      "UNSUPPORTED_VERSION",
    );
  }

  const document = value.document;
  if (!isRecord(document)) throw new DrawDocumentError("Draw document is missing its document data.");
  if (typeof document.id !== "string" || document.id.length === 0) {
    throw new DrawDocumentError("Document id must be a non-empty string.");
  }
  if (typeof document.title !== "string") {
    throw new DrawDocumentError("Document title must be a string.");
  }

  const canvas = document.canvas;
  if (!isRecord(canvas) || canvas.infinite !== true) {
    throw new DrawDocumentError("Canvas must be an infinite Draw canvas.");
  }
  const background = canvas.background;
  if (!isRecord(background)) throw new DrawDocumentError("Canvas background is missing.");
  if (background.preset !== "blackboard" && background.preset !== "white") {
    throw new DrawDocumentError('Background preset must be "blackboard" or "white".');
  }
  if (!Number.isInteger(background.styleVersion) || Number(background.styleVersion) < 1) {
    throw new DrawDocumentError("Background styleVersion must be a positive integer.");
  }
  if (background.color !== undefined && typeof background.color !== "string") {
    throw new DrawDocumentError("Background color must be a CSS color string.");
  }
  if (background.texture !== undefined && typeof background.texture !== "string") {
    throw new DrawDocumentError("Background texture must be a string asset id.");
  }

  const viewport = canvas.viewport;
  if (
    !isRecord(viewport) ||
    !finite(viewport.x) ||
    !finite(viewport.y) ||
    !finite(viewport.zoom) ||
    viewport.zoom <= 0
  ) {
    throw new DrawDocumentError("Canvas viewport must contain finite x/y coordinates and positive zoom.");
  }

  if (canvas.previewBounds !== undefined) {
    const bounds = canvas.previewBounds;
    if (
      !isRecord(bounds) ||
      !finite(bounds.x) ||
      !finite(bounds.y) ||
      !finite(bounds.width) ||
      !finite(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      throw new DrawDocumentError("Canvas previewBounds must contain finite coordinates and positive dimensions.");
    }
  }

  if (!Array.isArray(document.elements)) {
    throw new DrawDocumentError("Document elements must be an array.");
  }
  const ids = new Set<string>();
  document.elements.forEach((element, index) => {
    if (!isRecord(element) || typeof element.id !== "string" || !element.id) {
      throw new DrawDocumentError(`Element at index ${index} must have a non-empty element id.`);
    }
    if (typeof element.type !== "string" || !element.type) {
      throw new DrawDocumentError(`Element ${element.id} must have a non-empty type.`);
    }
    if (ids.has(element.id)) {
      throw new DrawDocumentError(`Document contains duplicate element id "${element.id}".`);
    }
    ids.add(element.id);
  });

  if (!isRecord(document.appState)) {
    throw new DrawDocumentError("Document appState must be an object.");
  }
  if (!isRecord(document.assets)) {
    throw new DrawDocumentError("Document assets must be an object map.");
  }
  for (const [assetKey, asset] of Object.entries(document.assets)) {
    if (!isRecord(asset) || asset.id !== assetKey) {
      throw new DrawDocumentError(`Asset "${assetKey}" must be an object whose id matches its key.`);
    }
    if (asset.dataURL !== undefined && (typeof asset.dataURL !== "string" || !asset.dataURL.startsWith("data:"))) {
      throw new DrawDocumentError(`Asset "${assetKey}" must contain an embedded data URL.`);
    }
    if (asset.dataURL === undefined && asset.kind !== "procedural-background") {
      throw new DrawDocumentError(
        `Asset "${assetKey}" is not self-contained; embedded assets need a dataURL.`,
      );
    }
  }

  assertJsonSafe(value);
}

function looksLikeLegacyPrimitiveDocument(raw: Record<string, unknown>): boolean {
  if (!isRecord(raw.document) || !Array.isArray(raw.document.elements)) return false;
  return raw.document.elements.some(
    (element) => isRecord(element) && isRecord(element.style),
  );
}

export function parseDrawFile(input: string | unknown): DrawDocument {
  let raw: unknown = input;
  if (typeof input === "string") {
    const byteLength = new TextEncoder().encode(input).byteLength;
    if (byteLength > MAX_DRAW_FILE_BYTES) {
      throw new DrawDocumentError(
        `Draw file exceeds the ${Math.round(MAX_DRAW_FILE_BYTES / 1024 / 1024)} MiB size limit.`,
        "FILE_TOO_LARGE",
      );
    }
    try {
      raw = JSON.parse(input);
    } catch (cause) {
      throw new DrawDocumentError("Draw file is not valid JSON.", "INVALID_DOCUMENT", { cause });
    }
  }
  if (!isRecord(raw)) throw new DrawDocumentError("Draw file must contain a JSON object.");
  if (raw.format !== "draw") throw new DrawDocumentError('Expected a Draw document with format "draw".');
  if (raw.formatVersion !== FORMAT_VERSION) {
    throw new DrawDocumentError(
      `Unsupported Draw format version ${String(raw.formatVersion)}.`,
      "UNSUPPORTED_VERSION",
    );
  }

  const normalized = looksLikeLegacyPrimitiveDocument(raw)
    ? normalizeLegacyDraw(raw)
    : normalizeVersionOneDocument(raw);
  validateDrawDocument(normalized);
  return normalized;
}

export function serializeDrawFile(value: DrawDocument): string {
  validateDrawDocument(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function fromExcalidrawScene(
  scene: ExcalidrawSceneInput,
  metadata: DrawDocumentMetadata = {},
): DrawDocument {
  const background = metadata.background ?? { ...DEFAULT_BACKGROUND };
  const appState = scene.appState ? copyJsonValue(scene.appState) : defaultAppState(background, metadata.viewport ?? { x: 0, y: 0, zoom: 1 });
  // Collaborators are runtime-only (and Maps serialize as `{}`), which breaks
  // Excalidraw when that placeholder is passed back as initial app state.
  delete (appState as Record<string, unknown>).collaborators;
  const viewport = metadata.viewport ?? viewportFromAppState(appState);
  const doc: DrawDocument = {
    format: "draw",
    formatVersion: FORMAT_VERSION,
    document: {
      id: metadata.id ?? makeId(),
      title: metadata.title ?? "Untitled drawing",
      canvas: {
        infinite: true,
        background: { ...background },
        viewport,
      },
      elements: copyJsonValue([...scene.elements]) as DrawElement[],
      appState,
      assets: normalizeSceneFiles(scene.files ?? {}),
    },
  };
  validateDrawDocument(doc);
  return doc;
}

export function toExcalidrawScene(doc: DrawDocument): {
  elements: DrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, DrawAsset>;
} {
  validateDrawDocument(doc);
  const backgroundColor =
    doc.document.canvas.background.color ??
    (doc.document.canvas.background.preset === "white" ? DEFAULT_WHITE_COLOR : DEFAULT_BLACKBOARD_COLOR);
  const appState = {
    ...copyJsonValue(doc.document.appState),
    viewBackgroundColor: backgroundColor,
    scrollX: doc.document.canvas.viewport.x,
    scrollY: doc.document.canvas.viewport.y,
    zoom: { value: doc.document.canvas.viewport.zoom },
  };
  // Older files and pre-fix autosaves may contain the serialized `{}` value.
  delete (appState as Record<string, unknown>).collaborators;
  return {
    elements: copyJsonValue(doc.document.elements),
    appState,
    files: copyJsonValue(doc.document.assets),
  };
}

export function normalizeLegacyDraw(raw: unknown): DrawDocument {
  if (!isRecord(raw) || !isRecord(raw.document)) {
    throw new DrawDocumentError("Legacy Draw document is missing its document data.");
  }
  const legacy = raw.document;
  if (!Array.isArray(legacy.elements)) {
    throw new DrawDocumentError("Legacy Draw document elements must be an array.");
  }
  const canvas = isRecord(legacy.canvas) ? legacy.canvas : {};
  const backgroundSource = isRecord(canvas.background) ? canvas.background : {};
  const preset: DrawBackgroundPreset = backgroundSource.preset === "white" ? "white" : "blackboard";
  const background: DrawBackground = {
    preset,
    styleVersion:
      Number.isInteger(backgroundSource.styleVersion) && Number(backgroundSource.styleVersion) > 0
        ? Number(backgroundSource.styleVersion)
        : 1,
    color:
      typeof backgroundSource.color === "string"
        ? backgroundSource.color
        : preset === "white"
          ? DEFAULT_WHITE_COLOR
          : DEFAULT_BLACKBOARD_COLOR,
    ...(typeof backgroundSource.texture === "string" ? { texture: backgroundSource.texture } : {}),
  };
  const viewport = normalizeViewport(canvas.viewport);
  const elements = legacy.elements.map((element, index) => convertLegacyElement(element, index));
  const assets = normalizeLegacyAssets(legacy.assets);
  const doc: DrawDocument = {
    format: "draw",
    formatVersion: FORMAT_VERSION,
    document: {
      id: typeof legacy.id === "string" && legacy.id ? legacy.id : makeId(),
      title: typeof legacy.title === "string" ? legacy.title : "Untitled drawing",
      canvas: {
        infinite: true,
        background,
        viewport,
        ...(isRecord(canvas.previewBounds) ? { previewBounds: canvas.previewBounds as DrawDocument["document"]["canvas"]["previewBounds"] } : {}),
      },
      elements,
      appState: defaultAppState(background, viewport),
      assets,
    },
  };
  validateDrawDocument(doc);
  return doc;
}

function normalizeVersionOneDocument(raw: Record<string, unknown>): DrawDocument {
  if (!isRecord(raw.document)) throw new DrawDocumentError("Draw document is missing its document data.");
  const source = raw.document;
  if (typeof source.id !== "string" || source.id.length === 0) {
    throw new DrawDocumentError("Document id must be a non-empty string.");
  }
  if (typeof source.title !== "string") {
    throw new DrawDocumentError("Document title must be a string.");
  }
  if (!isRecord(source.canvas) || source.canvas.infinite !== true) {
    throw new DrawDocumentError("Canvas must be an infinite Draw canvas.");
  }
  const canvas = source.canvas;
  if (!isRecord(canvas.background)) {
    throw new DrawDocumentError("Canvas background must be an object.");
  }
  if (!isRecord(canvas.viewport)) {
    throw new DrawDocumentError("Canvas viewport must be an object.");
  }
  if (
    !finite(canvas.viewport.x) ||
    !finite(canvas.viewport.y) ||
    !finite(canvas.viewport.zoom) ||
    canvas.viewport.zoom <= 0
  ) {
    throw new DrawDocumentError("Canvas viewport must contain finite x/y coordinates and positive zoom.");
  }
  if (!Array.isArray(source.elements)) {
    throw new DrawDocumentError("Document elements must be an array.");
  }
  if (!isRecord(source.appState)) {
    throw new DrawDocumentError("Document appState must be an object.");
  }
  if (!isRecord(source.assets)) {
    throw new DrawDocumentError("Document assets must be an object map.");
  }
  const background = { ...canvas.background } as unknown as DrawBackground;
  const viewport = { ...canvas.viewport } as unknown as DrawViewport;
  const assets = copyJsonValue(source.assets) as Record<string, DrawAsset>;
  const sceneElements = source.elements;
  const appState = copyJsonValue(source.appState);

  return {
    format: "draw",
    formatVersion: FORMAT_VERSION,
    document: {
      id: source.id,
      title: source.title,
      canvas: {
        infinite: true,
        background,
        viewport,
        ...(canvas.previewBounds !== undefined
          ? { previewBounds: canvas.previewBounds as DrawDocument["document"]["canvas"]["previewBounds"] }
          : {}),
      },
      elements: copyJsonValue(sceneElements) as DrawElement[],
      appState,
      assets,
    },
  };
}

function normalizeSceneFiles(files: Record<string, unknown>): Record<string, DrawAsset> {
  const assets: Record<string, DrawAsset> = {};
  for (const [key, rawAsset] of Object.entries(files)) {
    if (!isRecord(rawAsset)) {
      throw new DrawDocumentError(`Scene file "${key}" must be an object with embedded data.`);
    }
    assets[key] = { ...copyJsonValue(rawAsset), id: key } as DrawAsset;
  }
  return assets;
}

function normalizeLegacyAssets(value: unknown): Record<string, DrawAsset> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new DrawDocumentError("Document assets must be an object map.");
  const assets: Record<string, DrawAsset> = {};
  for (const [key, rawAsset] of Object.entries(value)) {
    if (!isRecord(rawAsset)) {
      throw new DrawDocumentError(`Asset "${key}" must be an object.`);
    }
    assets[key] = { ...copyJsonValue(rawAsset), id: key } as DrawAsset;
  }
  return assets;
}

function normalizeViewport(value: unknown): DrawViewport {
  if (!isRecord(value)) return { x: 0, y: 0, zoom: 1 };
  const zoom = finite(value.zoom) && value.zoom > 0 ? value.zoom : 1;
  return {
    x: finite(value.x) ? value.x : 0,
    y: finite(value.y) ? value.y : 0,
    zoom,
  };
}

function viewportFromAppState(appState: Record<string, unknown>): DrawViewport {
  const zoomState = isRecord(appState.zoom) ? appState.zoom.value : undefined;
  return {
    x: finite(appState.scrollX) ? appState.scrollX : 0,
    y: finite(appState.scrollY) ? appState.scrollY : 0,
    zoom: finite(zoomState) && zoomState > 0 ? zoomState : 1,
  };
}

function convertLegacyElement(value: unknown, index: number): DrawElement {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
    throw new DrawDocumentError(`Legacy element at index ${index} is malformed.`);
  }
  const style = isRecord(value.style) ? value.style : {};
  const strokeColor = typeof style.stroke === "string"
    ? style.stroke
    : value.type === "text" && typeof style.color === "string"
      ? style.color
      : "#f6f2e9";
  const backgroundColor = typeof style.fill === "string" ? style.fill : "transparent";
  const strokeWidth = finite(style.strokeWidth) ? style.strokeWidth : 2;
  const roughness = finite(style.roughness) ? Math.max(0, Math.min(2, Math.round(style.roughness))) : 1;
  const seed = stableHash(value.id);
  const common: Record<string, unknown> = {
    id: value.id,
    x: finite(value.x) ? value.x : 0,
    y: finite(value.y) ? value.y : 0,
    width: finite(value.width) ? value.width : 0,
    height: finite(value.height) ? value.height : 0,
    angle: 0,
    strokeColor,
    backgroundColor,
    fillStyle: "solid",
    strokeWidth,
    strokeStyle: style.strokeStyle === "dashed" ? "dashed" : "solid",
    roughness,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${index.toString(36).padStart(4, "0")}`,
    roundness: { type: 3 },
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
  };

  if (value.type === "text") {
    const font = style.font;
    const fontFamily = font === "chalk-hand" ? 1 : font === "monospace" ? 3 : 2;
    return {
      ...common,
      id: value.id,
      type: "text",
      text: typeof value.text === "string" ? value.text : "",
      originalText: typeof value.text === "string" ? value.text : "",
      fontSize: finite(style.fontSize) ? style.fontSize : 20,
      fontFamily,
      textAlign: style.align === "center" || style.align === "right" ? style.align : "left",
      verticalAlign: "top",
      containerId: null,
      lineHeight: 1.25,
      autoResize: false,
      baseline: finite(value.height) ? value.height : 20,
    };
  }

  if (value.type === "line" || value.type === "arrow") {
    const points = Array.isArray(value.points) ? value.points : [];
    const numericPoints = points.filter(
      (point): point is [number, number] =>
        Array.isArray(point) && point.length >= 2 && finite(point[0]) && finite(point[1]),
    );
    const pointX = numericPoints.map(([x]) => x);
    const pointY = numericPoints.map(([, y]) => y);
    const x = pointX.length ? Math.min(...pointX) : Number(common.x);
    const y = pointY.length ? Math.min(...pointY) : Number(common.y);
    const normalizedPoints = numericPoints.map(([pointXValue, pointYValue]) => [pointXValue - x, pointYValue - y]);
    const maxX = pointX.length ? Math.max(...pointX) : x;
    const maxY = pointY.length ? Math.max(...pointY) : y;
    return {
      ...common,
      id: value.id,
      x,
      y,
      width: maxX - x,
      height: maxY - y,
      type: value.type,
      points: normalizedPoints,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead:
        value.type === "arrow"
          ? style.endArrowhead === "triangle"
            ? "triangle"
            : style.endArrowhead === "dot"
              ? "dot"
              : "arrow"
          : null,
      elbowed: false,
    };
  }

  if (value.type === "rectangle" || value.type === "ellipse" || value.type === "diamond") {
    return { ...common, id: value.id, type: value.type };
  }

  throw new DrawDocumentError(`Legacy element "${value.id}" has unsupported type "${value.type}".`);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function assertJsonSafe(value: unknown, path = "document", ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DrawDocumentError(`Value at ${path} is not JSON-safe.`);
    return;
  }
  if (typeof value !== "object") {
    throw new DrawDocumentError(`Value at ${path} is not JSON-safe.`);
  }
  if (ancestors.has(value)) {
    throw new DrawDocumentError(`Circular value at ${path} is not JSON-safe.`);
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DrawDocumentError(`Value at ${path} is not a plain JSON object.`);
    }
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, String(index))) {
        throw new DrawDocumentError(`Sparse array at ${path} is not JSON-safe.`);
      }
      assertJsonSafe(value[index], `${path}[${index}]`, ancestors);
    }
    const extraKeys = Object.keys(value).filter((key) => !/^(0|[1-9]\d*)$/.test(key));
    if (extraKeys.length > 0) {
      throw new DrawDocumentError(`Array properties at ${path} are not JSON-safe.`);
    }
  } else {
    for (const [key, nested] of Object.entries(value)) {
      assertJsonSafe(nested, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}
