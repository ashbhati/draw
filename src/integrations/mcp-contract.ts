import type { DrawDocument } from "../document/document";
import { normalizeImageAttribution } from "../document/attribution";

export type DiagramNodeInput = {
  id: string;
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  shape?: "rectangle" | "ellipse" | "diamond";
  color?: string;
};

export type DiagramEdgeInput = {
  from: string;
  to: string;
  label?: string;
  color?: string;
};

export type CreateDiagramInput = {
  title?: string;
  documentId?: string;
  expectedDocumentRevision?: number;
  idempotencyKey: string;
  nodes: DiagramNodeInput[];
  edges: DiagramEdgeInput[];
};

export type DrawPrimitiveType = "rectangle" | "ellipse" | "diamond" | "text" | "line" | "arrow" | "freedraw";
export type PrimitivePoint = [number, number] | [number, number, number];
export type DrawPrimitiveInput = {
  id: string;
  type: DrawPrimitiveType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  maxWidth?: number;
  label?: string;
  start?: string;
  end?: string;
  points?: PrimitivePoint[];
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  fillStyle?: "solid" | "hachure" | "cross-hatch" | "zigzag" | "dots";
  roughness?: 0 | 1 | 2;
  endArrowhead?: "arrow" | "bar" | "dot" | "triangle" | null;
};
export type CreateElementsInput = { elements: DrawPrimitiveInput[]; documentId?: string; expectedDocumentRevision?: number; idempotencyKey: string };

export type ElementUpdateInput = {
  id: string;
  patch: {
    text?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    strokeColor?: string;
    backgroundColor?: string;
  };
};

export type UpdateElementsInput = { updates: ElementUpdateInput[]; documentId?: string; expectedDocumentRevision?: number; idempotencyKey: string };

export type SceneIdsInput = { documentId: string; expectedDocumentRevision: number; idempotencyKey: string; ids: string[] };
export type ArrangeElementsInput = SceneIdsInput & {
  action: "bring_to_front" | "send_to_back" | "align" | "distribute";
  alignment?: "left" | "right" | "top" | "bottom" | "center_x" | "center_y";
  axis?: "horizontal" | "vertical";
};
export type CanvasSettingsInput = {
  documentId: string; expectedDocumentRevision: number; idempotencyKey: string; title?: string; background?: "blackboard" | "white";
};
export type ViewportInput = {
  documentId: string; expectedViewRevision: number; idempotencyKey: string;
  action: "fit_content" | "set"; x?: number; y?: number; zoom?: number;
};
export type OpenDocumentInput = { path: string; documentId: string; expectedDocumentRevision: number; confirmationToken?: string };
export type SaveDocumentInput = { path?: string; documentId: string; expectedDocumentRevision: number };
export type ExportImageInput = {
  path?: string; documentId: string; format: "png" | "jpeg"; scope: "canvas" | "selection";
  background?: "blackboard" | "white" | "transparent";
};
export type InsertImageInput = {
  documentId: string;
  expectedDocumentRevision: number;
  idempotencyKey: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  mimeType: "image/png" | "image/jpeg";
  dataURL: string;
  attribution: {
    provider: "Openverse";
    providerId: string;
    title: string;
    creator?: string;
    creatorUrl?: string;
    sourceUrl?: string;
    license?: string;
    licenseVersion?: string;
    licenseUrl?: string;
    attribution?: string;
    source?: string;
    capturedAt: string;
  };
  idempotencyPayload?: { imageId: string; x: number; y: number; width?: number; height?: number };
};

export type McpWorkspaceAction =
  | { action: "list_workspaces" }
  | { action: "list_canvases"; workspaceId: string }
  | ({ action: "create_workspace"; name: string } & WorkspaceMutationContext)
  | ({ action: "rename_workspace"; workspaceId: string; name: string } & WorkspaceMutationContext)
  | ({ action: "select_workspace"; workspaceId: string } & WorkspaceMutationContext)
  | ({ action: "create_canvas"; workspaceId: string; name: string } & WorkspaceMutationContext)
  | ({ action: "rename_canvas"; canvasId: string; name: string } & WorkspaceMutationContext)
  | ({ action: "duplicate_canvas"; canvasId: string; name?: string } & WorkspaceMutationContext)
  | ({ action: "select_canvas"; workspaceId: string; canvasId: string } & WorkspaceMutationContext)
  | ({ action: "delete_canvas"; canvasId: string; confirmationToken?: string } & WorkspaceMutationContext)
  | ({ action: "delete_workspace"; workspaceId: string; confirmationToken?: string } & WorkspaceMutationContext)
  | ({ action: "import_draw_file_as_canvas"; workspaceId: string; path: string; name?: string } & WorkspaceMutationContext);

export type WorkspaceMutationContext = { expectedCatalogRevision: number; idempotencyKey: string };
export type WorkspaceLibraryContext = { documentId: string };
export type WorkspaceLibraryMutation = WorkspaceLibraryContext & { expectedDocumentRevision: number; expectedLibraryRevision: number; idempotencyKey: string };

export type McpCommand =
  | { operation: "create_diagram"; input: CreateDiagramInput }
  | { operation: "create_elements"; input: CreateElementsInput }
  | { operation: "update_elements"; input: UpdateElementsInput }
  | { operation: "delete_elements"; input: SceneIdsInput }
  | { operation: "duplicate_elements"; input: SceneIdsInput & { offsetX?: number; offsetY?: number } }
  | { operation: "set_selection"; input: { documentId: string; ids: string[] } }
  | { operation: "group_elements"; input: SceneIdsInput }
  | { operation: "ungroup_elements"; input: SceneIdsInput }
  | { operation: "arrange_elements"; input: ArrangeElementsInput }
  | { operation: "undo_operation" | "redo_operation"; input: { documentId: string; operationId: string; expectedDocumentRevision: number; idempotencyKey: string } }
  | { operation: "set_canvas_settings"; input: CanvasSettingsInput }
  | { operation: "set_viewport"; input: ViewportInput }
  | { operation: "open_document"; input: OpenDocumentInput; document?: DrawDocument }
  | { operation: "save_document"; input: SaveDocumentInput }
  | { operation: "export_image"; input: ExportImageInput }
  | { operation: "insert_image"; input: InsertImageInput }
  | WorkspaceActionCommand
  | { operation: "list_workspace_library" | "read_workspace_library_item"; input: WorkspaceLibraryContext & { itemId?: string } }
  | { operation: "add_selection_to_workspace_library"; input: WorkspaceLibraryMutation & { itemId: string; elementIds?: string[]; name?: string } }
  | { operation: "rename_workspace_library_item"; input: WorkspaceLibraryMutation & { itemId: string; name: string } }
  | { operation: "delete_workspace_library_item"; input: WorkspaceLibraryMutation & { itemId: string; confirmationToken?: string } }
  | { operation: "insert_workspace_library_item"; input: WorkspaceLibraryContext & { expectedDocumentRevision: number; idempotencyKey: string; itemId: string } };

// Workspace operations are delivered to the active authenticated editor, which owns local IndexedDB.
export type WorkspaceActionCommand = { operation: "workspace_action"; input: McpWorkspaceAction; document?: DrawDocument };

export class McpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpValidationError";
  }
}

const MAX_NODES = 100;
const MAX_EDGES = 200;
const MAX_PRIMITIVES = 100;
const MAX_POINTS = 2_000;
const MAX_TEXT_LENGTH = 500;
const MAX_COORDINATE = 100_000;
const COLOR_PATTERN = /^#[\da-f]{6}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new McpValidationError(`${label} must be an object.`);
  return value;
}

function requireString(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new McpValidationError(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) throw new McpValidationError(`${label} exceeds ${maxLength} characters.`);
  return value;
}

function requireIdempotencyKey(input: Record<string, unknown>, label: string): string {
  return requireString(input.idempotencyKey, `${label}.idempotencyKey`, 200);
}

function requireFiniteCoordinate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new McpValidationError(`${label} must be a finite number.`);
  }
  if (Math.abs(value) > MAX_COORDINATE) {
    throw new McpValidationError(`${label} must be between -${MAX_COORDINATE} and ${MAX_COORDINATE}.`);
  }
  return value;
}

function optionalDimension(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 24 || value > 5_000) {
    throw new McpValidationError(`${label} must be a finite number between 24 and 5000.`);
  }
  return value;
}

function optionalColor(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    throw new McpValidationError(`${label} must be a six-digit hex color such as #f3c94c.`);
  }
  return value;
}

function optionalBackgroundColor(value: unknown, label: string): string | undefined {
  if (value === undefined || value === "transparent") return value;
  return optionalColor(value, label);
}

function optionalRevisionContext(input: Record<string, unknown>, label: string) {
  if (input.documentId === undefined && input.expectedDocumentRevision === undefined) return {};
  const documentId = requireString(input.documentId, `${label}.documentId`, 200);
  if (!Number.isSafeInteger(input.expectedDocumentRevision) || (input.expectedDocumentRevision as number) < 0) {
    throw new McpValidationError(`${label}.expectedDocumentRevision must be a non-negative integer.`);
  }
  return { documentId, expectedDocumentRevision: input.expectedDocumentRevision as number };
}

function parsePrimitivePoints(value: unknown, label: string, allowPressure: boolean): PrimitivePoint[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_POINTS) {
    throw new McpValidationError(`${label} must contain between 2 and ${MAX_POINTS} points.`);
  }
  const points = value.map((rawPoint, index): PrimitivePoint => {
    if (!Array.isArray(rawPoint) || (rawPoint.length !== 2 && rawPoint.length !== 3)) {
      throw new McpValidationError(`${label}[${index}] must contain x, y, and optional pressure values.`);
    }
    if (rawPoint.length === 3 && !allowPressure) {
      throw new McpValidationError(`${label}[${index}] pressure is only supported for freedraw elements.`);
    }
    const x = requireFiniteCoordinate(rawPoint[0], `${label}[${index}].x`);
    const y = requireFiniteCoordinate(rawPoint[1], `${label}[${index}].y`);
    if (rawPoint.length === 3) {
      if (typeof rawPoint[2] !== "number" || !Number.isFinite(rawPoint[2]) || rawPoint[2] < 0 || rawPoint[2] > 1) {
        throw new McpValidationError(`${label}[${index}].pressure must be a finite number between 0 and 1.`);
      }
      return [x, y, rawPoint[2]];
    }
    return [x, y];
  });
  if (new Set(points.map(([x, y]) => `${x},${y}`)).size < 2) {
    throw new McpValidationError(`${label} must describe a non-zero-length path.`);
  }
  return points;
}

function parseCreateElements(value: unknown): CreateElementsInput {
  const input = requireRecord(value, "create_elements input");
  if (!Array.isArray(input.elements) || input.elements.length < 1 || input.elements.length > MAX_PRIMITIVES) {
    throw new McpValidationError(`elements must contain at least one element and no more than ${MAX_PRIMITIVES} items.`);
  }
  const ids = new Set<string>();
  const elements = input.elements.map((rawElement, index): DrawPrimitiveInput => {
    const element = requireRecord(rawElement, `elements[${index}]`);
    const id = requireString(element.id, `elements[${index}].id`, 100);
    if (ids.has(id)) throw new McpValidationError(`duplicate element id "${id}".`);
    ids.add(id);
    const type = element.type;
    const supportedTypes: DrawPrimitiveType[] = ["rectangle", "ellipse", "diamond", "text", "line", "arrow", "freedraw"];
    if (typeof type !== "string" || !supportedTypes.includes(type as DrawPrimitiveType)) {
      throw new McpValidationError(`elements[${index}].type is unsupported. Use rectangle, ellipse, diamond, text, line, arrow, or freedraw.`);
    }
    const baseFields = ["id", "type", "x", "y", "strokeColor"];
    const shapeFields = ["width", "height", "strokeWidth", "strokeStyle", "roughness", "backgroundColor", "fillStyle", "label"];
    const pathFields = ["points", "strokeWidth", "strokeStyle", "roughness"];
    const allowedFields = new Set([
      ...baseFields,
      ...(type === "rectangle" || type === "ellipse" || type === "diamond" ? shapeFields : []),
      ...(type === "text" ? ["text", "fontSize", "maxWidth"] : []),
      ...(type === "line" || type === "freedraw" ? pathFields : []),
      ...(type === "arrow" ? [...pathFields, "endArrowhead", "start", "end", "label"] : []),
    ]);
    for (const field of Object.keys(element)) {
      if (!allowedFields.has(field)) throw new McpValidationError(`elements[${index}] has unsupported field "${field}" for ${type}.`);
    }
    const parsed: DrawPrimitiveInput = {
      id,
      type: type as DrawPrimitiveType,
      x: requireFiniteCoordinate(element.x, `elements[${index}].x`),
      y: requireFiniteCoordinate(element.y, `elements[${index}].y`),
    };
    if (element.width !== undefined) parsed.width = optionalDimension(element.width, `elements[${index}].width`);
    if (element.height !== undefined) parsed.height = optionalDimension(element.height, `elements[${index}].height`);
    if (element.strokeColor !== undefined) parsed.strokeColor = optionalColor(element.strokeColor, `elements[${index}].strokeColor`);
    if (element.backgroundColor !== undefined) parsed.backgroundColor = optionalBackgroundColor(element.backgroundColor, `elements[${index}].backgroundColor`);
    if (element.strokeWidth !== undefined) {
      if (typeof element.strokeWidth !== "number" || !Number.isFinite(element.strokeWidth) || element.strokeWidth < 1 || element.strokeWidth > 8) {
        throw new McpValidationError(`elements[${index}].strokeWidth must be between 1 and 8.`);
      }
      parsed.strokeWidth = element.strokeWidth;
    }
    if (element.strokeStyle !== undefined) {
      if (element.strokeStyle !== "solid" && element.strokeStyle !== "dashed" && element.strokeStyle !== "dotted") {
        throw new McpValidationError(`elements[${index}].strokeStyle must be solid, dashed, or dotted.`);
      }
      parsed.strokeStyle = element.strokeStyle;
    }
    if (element.fillStyle !== undefined) {
      if (!["solid", "hachure", "cross-hatch", "zigzag", "dots"].includes(element.fillStyle as string)) {
        throw new McpValidationError(`elements[${index}].fillStyle is unsupported.`);
      }
      parsed.fillStyle = element.fillStyle as DrawPrimitiveInput["fillStyle"];
    }
    if (element.roughness !== undefined) {
      if (element.roughness !== 0 && element.roughness !== 1 && element.roughness !== 2) {
        throw new McpValidationError(`elements[${index}].roughness must be 0, 1, or 2.`);
      }
      parsed.roughness = element.roughness;
    }
    if (type === "text") {
      if (element.width !== undefined || element.height !== undefined || element.backgroundColor !== undefined || element.fillStyle !== undefined || element.points !== undefined || element.endArrowhead !== undefined || element.strokeWidth !== undefined || element.strokeStyle !== undefined || element.roughness !== undefined) {
        throw new McpValidationError(`elements[${index}] has fields that are not valid for text.`);
      }
      parsed.text = requireString(element.text, `elements[${index}].text`);
      if (element.fontSize !== undefined) {
        if (typeof element.fontSize !== "number" || !Number.isFinite(element.fontSize) || element.fontSize < 8 || element.fontSize > 128) {
          throw new McpValidationError(`elements[${index}].fontSize must be between 8 and 128.`);
        }
        parsed.fontSize = element.fontSize;
      }
      if (element.maxWidth !== undefined) parsed.maxWidth = optionalDimension(element.maxWidth, `elements[${index}].maxWidth`);
    } else if (type === "rectangle" || type === "ellipse" || type === "diamond") {
      if (element.label !== undefined) parsed.label = requireString(element.label, `elements[${index}].label`);
    } else if (type === "line" || type === "arrow" || type === "freedraw") {
      if (element.width !== undefined || element.height !== undefined || element.backgroundColor !== undefined || element.fillStyle !== undefined || element.text !== undefined || element.fontSize !== undefined) {
        throw new McpValidationError(`elements[${index}] has fields that are not valid for ${type}.`);
      }
      parsed.points = parsePrimitivePoints(element.points, `elements[${index}].points`, type === "freedraw");
      if (element.endArrowhead !== undefined) {
        if (type !== "arrow") throw new McpValidationError(`elements[${index}].endArrowhead is only valid for arrow elements.`);
        if (element.endArrowhead !== null && !["arrow", "bar", "dot", "triangle"].includes(element.endArrowhead as string)) {
          throw new McpValidationError(`elements[${index}].endArrowhead is unsupported.`);
        }
        parsed.endArrowhead = element.endArrowhead as DrawPrimitiveInput["endArrowhead"];
      }
      if (type === "arrow") {
        if ((element.start === undefined) !== (element.end === undefined)) {
          throw new McpValidationError(`elements[${index}] must supply both start and end when binding arrow endpoints.`);
        }
        if (element.start !== undefined) parsed.start = requireString(element.start, `elements[${index}].start`, 100);
        if (element.end !== undefined) parsed.end = requireString(element.end, `elements[${index}].end`, 100);
        if (element.label !== undefined) parsed.label = requireString(element.label, `elements[${index}].label`);
      }
    } else if (element.text !== undefined || element.points !== undefined || element.fontSize !== undefined || element.endArrowhead !== undefined) {
      throw new McpValidationError(`elements[${index}] has fields that are not valid for ${type}.`);
    }
    return parsed;
  });
  const typeById = new Map(elements.map(({ id, type }) => [id, type]));
  for (const element of elements) {
    if (element.type !== "arrow" || element.start === undefined || element.end === undefined) continue;
    const startType = typeById.get(element.start);
    const endType = typeById.get(element.end);
    const isShape = (candidate: DrawPrimitiveType | undefined) => candidate === "rectangle" || candidate === "ellipse" || candidate === "diamond";
    if (!isShape(startType) || !isShape(endType)) {
      throw new McpValidationError(`Arrow "${element.id}" endpoints must reference valid shapes from this create_elements call.`);
    }
  }
  return { ...optionalRevisionContext(input, "create_elements"), idempotencyKey: requireIdempotencyKey(input, "create_elements"), elements };
}

function parseCreateDiagram(value: unknown): CreateDiagramInput {
  const input = requireRecord(value, "create_diagram input");
  const title = input.title === undefined ? undefined : requireString(input.title, "title", 200);
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > MAX_NODES) {
    throw new McpValidationError(`nodes must contain at least one node and no more than ${MAX_NODES} items.`);
  }
  if (!Array.isArray(input.edges) || input.edges.length > MAX_EDGES) {
    throw new McpValidationError(`edges must contain no more than ${MAX_EDGES} items.`);
  }

  const ids = new Set<string>();
  const nodes = input.nodes.map((rawNode, index): DiagramNodeInput => {
    const node = requireRecord(rawNode, `nodes[${index}]`);
    const id = requireString(node.id, `nodes[${index}].id`, 100);
    if (ids.has(id)) throw new McpValidationError(`duplicate node id "${id}".`);
    ids.add(id);
    const shape = node.shape;
    if (shape !== undefined && shape !== "rectangle" && shape !== "ellipse" && shape !== "diamond") {
      throw new McpValidationError(`nodes[${index}].shape must be rectangle, ellipse, or diamond.`);
    }
    return {
      id,
      label: requireString(node.label, `nodes[${index}].label`),
      x: requireFiniteCoordinate(node.x, `nodes[${index}].x`),
      y: requireFiniteCoordinate(node.y, `nodes[${index}].y`),
      ...(node.width !== undefined ? { width: optionalDimension(node.width, `nodes[${index}].width`) } : {}),
      ...(node.height !== undefined ? { height: optionalDimension(node.height, `nodes[${index}].height`) } : {}),
      ...(shape !== undefined ? { shape } : {}),
      ...(node.color !== undefined ? { color: optionalColor(node.color, `nodes[${index}].color`) } : {}),
    };
  });

  const edges = input.edges.map((rawEdge, index): DiagramEdgeInput => {
    const edge = requireRecord(rawEdge, `edges[${index}]`);
    const from = requireString(edge.from, `edges[${index}].from`, 100);
    const to = requireString(edge.to, `edges[${index}].to`, 100);
    if (!ids.has(from) || !ids.has(to)) {
      throw new McpValidationError(`edges[${index}] refers to an unknown node.`);
    }
    return {
      from,
      to,
      ...(edge.label !== undefined ? { label: requireString(edge.label, `edges[${index}].label`) } : {}),
      ...(edge.color !== undefined ? { color: optionalColor(edge.color, `edges[${index}].color`) } : {}),
    };
  });

  return { ...optionalRevisionContext(input, "create_diagram"), idempotencyKey: requireIdempotencyKey(input, "create_diagram"), ...(title !== undefined ? { title } : {}), nodes, edges };
}

const UPDATE_FIELDS = new Set(["text", "x", "y", "width", "height", "strokeColor", "backgroundColor"]);

function parseUpdateElements(value: unknown): UpdateElementsInput {
  const input = requireRecord(value, "update_elements input");
  if (!Array.isArray(input.updates) || input.updates.length < 1 || input.updates.length > MAX_NODES) {
    throw new McpValidationError(`updates must contain between 1 and ${MAX_NODES} items.`);
  }
  const ids = new Set<string>();
  const updates = input.updates.map((rawUpdate, index): ElementUpdateInput => {
    const update = requireRecord(rawUpdate, `updates[${index}]`);
    const id = requireString(update.id, `updates[${index}].id`, 100);
    if (ids.has(id)) throw new McpValidationError(`duplicate update id "${id}".`);
    ids.add(id);
    const patch = requireRecord(update.patch, `updates[${index}].patch`);
    const fields = Object.keys(patch);
    if (fields.length === 0) throw new McpValidationError(`updates[${index}].patch cannot be empty.`);
    for (const field of fields) {
      if (!UPDATE_FIELDS.has(field)) throw new McpValidationError(`unsupported update field "${field}".`);
    }
    const normalized: ElementUpdateInput["patch"] = {};
    for (const [key, fieldValue] of Object.entries(patch)) {
      switch (key) {
        case "text":
          normalized.text = requireString(fieldValue, `updates[${index}].patch.text`);
          break;
        case "x":
        case "y":
          normalized[key] = requireFiniteCoordinate(fieldValue, `updates[${index}].patch.${key}`);
          break;
        case "width":
        case "height":
          normalized[key] = optionalDimension(fieldValue, `updates[${index}].patch.${key}`);
          break;
        case "strokeColor":
        case "backgroundColor":
          normalized[key] = optionalColor(fieldValue, `updates[${index}].patch.${key}`);
          break;
      }
    }
    return { id, patch: normalized };
  });
  return { ...optionalRevisionContext(input, "update_elements"), idempotencyKey: requireIdempotencyKey(input, "update_elements"), updates };
}

function parseSceneIds(value: unknown, label: string, allowEmpty = false): SceneIdsInput & { ids: string[] } {
  const input = requireRecord(value, `${label} input`);
  const documentId = requireString(input.documentId, `${label}.documentId`, 200);
  if (!Number.isSafeInteger(input.expectedDocumentRevision) || (input.expectedDocumentRevision as number) < 0) {
    throw new McpValidationError(`${label}.expectedDocumentRevision must be a non-negative integer.`);
  }
  if (!Array.isArray(input.ids) || input.ids.length > MAX_NODES || (!allowEmpty && input.ids.length < 1)) {
    throw new McpValidationError(`${label}.ids must contain ${allowEmpty ? "no more than" : "between 1 and"} ${MAX_NODES} element IDs.`);
  }
  const ids = input.ids.map((id, index) => requireString(id, `${label}.ids[${index}]`, 200));
  if (new Set(ids).size !== ids.length) throw new McpValidationError(`${label}.ids cannot contain duplicates.`);
  return { documentId, expectedDocumentRevision: input.expectedDocumentRevision as number, idempotencyKey: requireIdempotencyKey(input, label), ids };
}

function parseRelativeFileName(value: unknown, label: string, allowedExtensions: string[]): string {
  const name = requireString(value, label, 160);
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes(":") || name.startsWith("~")) {
    throw new McpValidationError(`${label} must be a plain filename inside the configured Draw folder.`);
  }
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (!allowedExtensions.includes(extension)) throw new McpValidationError(`${label} must end in ${allowedExtensions.join(" or ")}.`);
  return name;
}

function parseSceneTool(name: string, value: unknown): McpCommand | null {
  if (["delete_elements", "duplicate_elements", "group_elements", "ungroup_elements"].includes(name)) {
    const base = parseSceneIds(value, name);
    if (name === "duplicate_elements") {
      const input = requireRecord(value, `${name} input`);
      const offsetX = input.offsetX === undefined ? undefined : requireFiniteCoordinate(input.offsetX, `${name}.offsetX`);
      const offsetY = input.offsetY === undefined ? undefined : requireFiniteCoordinate(input.offsetY, `${name}.offsetY`);
      return { operation: name, input: { ...base, ...(offsetX !== undefined ? { offsetX } : {}), ...(offsetY !== undefined ? { offsetY } : {}) } } as McpCommand;
    }
    return { operation: name, input: base } as McpCommand;
  }
  if (name === "set_selection") {
    const input = parseSceneIds(value, name, true);
    return { operation: "set_selection", input: { documentId: input.documentId, ids: input.ids } };
  }
  if (name === "arrange_elements") {
    const base = parseSceneIds(value, name);
    const input = requireRecord(value, `${name} input`);
    const action = input.action;
    if (action !== "bring_to_front" && action !== "send_to_back" && action !== "align" && action !== "distribute") {
      throw new McpValidationError(`${name}.action must be bring_to_front, send_to_back, align, or distribute.`);
    }
    const alignment = input.alignment;
    const axis = input.axis;
    if (action === "align" && !["left", "right", "top", "bottom", "center_x", "center_y"].includes(alignment as string)) {
      throw new McpValidationError(`${name}.alignment must be left, right, top, bottom, center_x, or center_y.`);
    }
    if (action === "distribute" && axis !== "horizontal" && axis !== "vertical") {
      throw new McpValidationError(`${name}.axis must be horizontal or vertical.`);
    }
    if (action === "align" && base.ids.length < 2) throw new McpValidationError("align requires at least two elements.");
    if (action === "distribute" && base.ids.length < 3) throw new McpValidationError("distribute requires at least three elements.");
    return { operation: "arrange_elements", input: { ...base, action, ...(alignment ? { alignment: alignment as ArrangeElementsInput["alignment"] } : {}), ...(axis ? { axis: axis as ArrangeElementsInput["axis"] } : {}) } };
  }
  if (name === "undo_operation" || name === "redo_operation") {
    const input = requireRecord(value, `${name} input`);
    if (!Number.isSafeInteger(input.expectedDocumentRevision) || (input.expectedDocumentRevision as number) < 0) {
      throw new McpValidationError(`${name}.expectedDocumentRevision must be a non-negative integer.`);
    }
    return { operation: name, input: {
      documentId: requireString(input.documentId, `${name}.documentId`, 200),
      operationId: requireString(input.operationId, `${name}.operationId`, 200),
      expectedDocumentRevision: input.expectedDocumentRevision as number,
      idempotencyKey: requireIdempotencyKey(input, name),
    } };
  }
  if (name === "set_canvas_settings") {
    const input = requireRecord(value, `${name} input`);
    if (!Number.isSafeInteger(input.expectedDocumentRevision) || (input.expectedDocumentRevision as number) < 0) {
      throw new McpValidationError(`${name}.expectedDocumentRevision must be a non-negative integer.`);
    }
    if (input.title === undefined && input.background === undefined) throw new McpValidationError("set_canvas_settings requires title or background.");
    if (input.background !== undefined && input.background !== "blackboard" && input.background !== "white") {
      throw new McpValidationError("set_canvas_settings.background must be blackboard or white.");
    }
    return { operation: name, input: {
      documentId: requireString(input.documentId, `${name}.documentId`, 200),
      expectedDocumentRevision: input.expectedDocumentRevision as number,
      idempotencyKey: requireIdempotencyKey(input, name),
      ...(input.title !== undefined ? { title: requireString(input.title, `${name}.title`, 200) } : {}),
      ...(input.background !== undefined ? { background: input.background as CanvasSettingsInput["background"] } : {}),
    } };
  }
  if (name === "set_viewport") {
    const input = requireRecord(value, `${name} input`);
    if (!Number.isSafeInteger(input.expectedViewRevision) || (input.expectedViewRevision as number) < 0) {
      throw new McpValidationError(`${name}.expectedViewRevision must be a non-negative integer.`);
    }
    if (input.action !== "fit_content" && input.action !== "set") throw new McpValidationError("set_viewport.action must be fit_content or set.");
    if (input.action === "set") {
      requireFiniteCoordinate(input.x, `${name}.x`);
      requireFiniteCoordinate(input.y, `${name}.y`);
      if (typeof input.zoom !== "number" || !Number.isFinite(input.zoom) || input.zoom < 0.1 || input.zoom > 10) {
        throw new McpValidationError("set_viewport.zoom must be between 0.1 and 10.");
      }
    }
    return { operation: name, input: {
      documentId: requireString(input.documentId, `${name}.documentId`, 200),
      expectedViewRevision: input.expectedViewRevision as number,
      idempotencyKey: requireIdempotencyKey(input, name),
      action: input.action,
      ...(input.action === "set" ? { x: input.x as number, y: input.y as number, zoom: input.zoom as number } : {}),
    } };
  }
  if (name === "open_document") {
    const input = requireRecord(value, `${name} input`);
    if (!Number.isSafeInteger(input.expectedDocumentRevision) || (input.expectedDocumentRevision as number) < 0) {
      throw new McpValidationError(`${name}.expectedDocumentRevision must be a non-negative integer.`);
    }
    return { operation: name, input: {
      path: parseRelativeFileName(input.path, `${name}.path`, [".draw"]),
      documentId: requireString(input.documentId, `${name}.documentId`, 200),
      expectedDocumentRevision: input.expectedDocumentRevision as number,
      ...(input.confirmationToken !== undefined ? { confirmationToken: requireString(input.confirmationToken, `${name}.confirmationToken`, 200) } : {}),
    } };
  }
  if (name === "save_document") {
    const input = requireRecord(value, `${name} input`);
    if (!Number.isSafeInteger(input.expectedDocumentRevision) || (input.expectedDocumentRevision as number) < 0) {
      throw new McpValidationError(`${name}.expectedDocumentRevision must be a non-negative integer.`);
    }
    return { operation: name, input: {
      ...(input.path !== undefined ? { path: parseRelativeFileName(input.path, `${name}.path`, [".draw"]) } : {}),
      documentId: requireString(input.documentId, `${name}.documentId`, 200),
      expectedDocumentRevision: input.expectedDocumentRevision as number,
    } };
  }
  if (name === "export_image") {
    const input = requireRecord(value, `${name} input`);
    const format = input.format;
    if (format !== "png" && format !== "jpeg") throw new McpValidationError("export_image.format must be png or jpeg.");
    if (input.scope !== "canvas" && input.scope !== "selection") throw new McpValidationError("export_image.scope must be canvas or selection.");
    if (input.background !== undefined && !["blackboard", "white", "transparent"].includes(input.background as string)) {
      throw new McpValidationError("export_image.background must be blackboard, white, or transparent.");
    }
    if (input.path !== undefined) parseRelativeFileName(input.path, `${name}.path`, format === "png" ? [".png"] : [".jpg", ".jpeg"]);
    return { operation: name, input: {
      ...(input.path !== undefined ? { path: input.path as string } : {}),
      documentId: requireString(input.documentId, `${name}.documentId`, 200),
      format, scope: input.scope,
      ...(input.background !== undefined ? { background: input.background as ExportImageInput["background"] } : {}),
    } };
  }
  return null;
}

function parseEmbeddedImage(value: unknown): McpCommand {
  const input = requireRecord(value, "insert_image input");
  const allowedFields = new Set(["documentId", "expectedDocumentRevision", "idempotencyKey", "x", "y", "width", "height", "mimeType", "dataURL", "attribution", "idempotencyPayload"]);
  for (const field of Object.keys(input)) if (!allowedFields.has(field)) throw new McpValidationError(`insert_image has unsupported field "${field}"; remote image URLs are not accepted.`);
  if (!Number.isSafeInteger(input.expectedDocumentRevision) || (input.expectedDocumentRevision as number) < 0) {
    throw new McpValidationError("insert_image.expectedDocumentRevision must be a non-negative integer.");
  }
  const mimeType = input.mimeType;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new McpValidationError("insert_image.mimeType must be image/png or image/jpeg.");
  const dataURL = input.dataURL;
  const maximumLength = Math.ceil((2 * 1024 * 1024) * 4 / 3) + 64;
  if (typeof dataURL !== "string" || dataURL.length > maximumLength || !new RegExp(`^data:${mimeType.replace("/", "\\/")};base64,[A-Za-z0-9+/]+=*$`).test(dataURL)) {
    throw new McpValidationError("insert_image.dataURL must be a base64 PNG or JPEG no larger than 2 MiB.");
  }
  const raw = requireRecord(input.attribution, "insert_image.attribution");
  const attributionFields = new Set(["provider", "providerId", "title", "creator", "creatorUrl", "sourceUrl", "license", "licenseVersion", "licenseUrl", "attribution", "source", "capturedAt", "verification"]);
  for (const field of Object.keys(raw)) if (!attributionFields.has(field)) throw new McpValidationError(`insert_image.attribution has unsupported field "${field}".`);
  const normalizedAttribution = normalizeImageAttribution(raw, "unverified", true);
  if (!normalizedAttribution) throw new McpValidationError("insert_image.attribution must contain a valid Openverse ID, title, supported license, capture date, and safe optional metadata.");
  let idempotencyPayload: InsertImageInput["idempotencyPayload"];
  if (input.idempotencyPayload !== undefined) {
    const stable = requireRecord(input.idempotencyPayload, "insert_image.idempotencyPayload");
    for (const field of Object.keys(stable)) if (!["imageId", "x", "y", "width", "height"].includes(field)) throw new McpValidationError(`insert_image.idempotencyPayload has unsupported field "${field}".`);
    if (typeof stable.imageId !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(stable.imageId)) throw new McpValidationError("insert_image.idempotencyPayload.imageId must be a valid provider ID.");
    idempotencyPayload = {
      imageId: stable.imageId, x: requireFiniteCoordinate(stable.x, "insert_image.idempotencyPayload.x"), y: requireFiniteCoordinate(stable.y, "insert_image.idempotencyPayload.y"),
      ...(stable.width !== undefined ? { width: optionalDimension(stable.width, "insert_image.idempotencyPayload.width") } : {}),
      ...(stable.height !== undefined ? { height: optionalDimension(stable.height, "insert_image.idempotencyPayload.height") } : {}),
    };
  }
  return { operation: "insert_image", input: {
    documentId: requireString(input.documentId, "insert_image.documentId", 200),
    expectedDocumentRevision: input.expectedDocumentRevision as number,
    idempotencyKey: requireIdempotencyKey(input, "insert_image"),
    x: requireFiniteCoordinate(input.x, "insert_image.x"),
    y: requireFiniteCoordinate(input.y, "insert_image.y"),
    ...(input.width !== undefined ? { width: optionalDimension(input.width, "insert_image.width") } : {}),
    ...(input.height !== undefined ? { height: optionalDimension(input.height, "insert_image.height") } : {}),
    mimeType,
    dataURL,
    attribution: normalizedAttribution,
    ...(idempotencyPayload ? { idempotencyPayload } : {}),
  } };
}

export function parseMcpToolInput(
  name: string,
  value: unknown,
): McpCommand {
  if (["list_workspace_library", "read_workspace_library_item"].includes(name)) {
    const input = requireRecord(value, `${name} input`);
    return { operation: name as "list_workspace_library" | "read_workspace_library_item", input: {
      documentId: requireString(input.documentId, `${name}.documentId`, 200),
      ...(name === "read_workspace_library_item" ? { itemId: requireString(input.itemId, `${name}.itemId`, 200) } : {}),
    } };
  }
  if (["add_selection_to_workspace_library", "rename_workspace_library_item", "delete_workspace_library_item", "insert_workspace_library_item"].includes(name)) {
    const input = requireRecord(value, `${name} input`);
    if (!Number.isSafeInteger(input.expectedDocumentRevision) || (input.expectedDocumentRevision as number) < 0) throw new McpValidationError(`${name}.expectedDocumentRevision must be a non-negative integer.`);
    const common = { documentId: requireString(input.documentId, `${name}.documentId`, 200), expectedDocumentRevision: input.expectedDocumentRevision as number, idempotencyKey: requireIdempotencyKey(input, name), itemId: requireString(input.itemId, `${name}.itemId`, 200) };
    if (name === "insert_workspace_library_item") return { operation: name, input: common };
    if (!Number.isSafeInteger(input.expectedLibraryRevision) || (input.expectedLibraryRevision as number) < 0) throw new McpValidationError(`${name}.expectedLibraryRevision must be a non-negative integer.`);
    const mutation = { ...common, expectedLibraryRevision: input.expectedLibraryRevision as number };
    if (name === "add_selection_to_workspace_library") {
      if (input.elementIds !== undefined && (!Array.isArray(input.elementIds) || input.elementIds.length < 1 || input.elementIds.length > 100 || input.elementIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 200))) throw new McpValidationError(`${name}.elementIds must contain between 1 and 100 stable element IDs.`);
      return { operation: name, input: { ...mutation, ...(Array.isArray(input.elementIds) ? { elementIds: input.elementIds as string[] } : {}), ...(input.name !== undefined ? { name: requireString(input.name, `${name}.name`, 160) } : {}) } };
    }
    if (name === "rename_workspace_library_item") return { operation: name, input: { ...mutation, name: requireString(input.name, `${name}.name`, 160) } };
    return { operation: "delete_workspace_library_item", input: { ...mutation, ...(input.confirmationToken !== undefined ? { confirmationToken: requireString(input.confirmationToken, `${name}.confirmationToken`, 200) } : {}) } };
  }
  if (name === "create_diagram") {
    return { operation: "create_diagram", input: parseCreateDiagram(value) };
  }
  if (name === "create_elements") {
    return { operation: "create_elements", input: parseCreateElements(value) };
  }
  if (name === "insert_image" || name === "insert_openverse_image") return parseEmbeddedImage(value);
  if (name === "update_elements") {
    return { operation: "update_elements", input: parseUpdateElements(value) };
  }
  if (name === "workspace_action") {
    return parseWorkspaceAction(value);
  }
  const sceneTool = parseSceneTool(name, value);
  if (sceneTool) return sceneTool;
  throw new McpValidationError(`Unknown Draw MCP tool "${name}".`);
}

const WORKSPACE_ACTIONS = new Set([
  "list_workspaces", "list_canvases", "create_workspace", "rename_workspace", "select_workspace",
  "create_canvas", "rename_canvas", "duplicate_canvas", "select_canvas", "delete_canvas",
  "delete_workspace", "import_draw_file_as_canvas",
]);

function parseWorkspaceAction(value: unknown): WorkspaceActionCommand {
  const input = requireRecord(value, "workspace_action input");
  const action = input.action;
  if (typeof action !== "string" || !WORKSPACE_ACTIONS.has(action)) throw new McpValidationError("workspace_action.action must name a supported workspace or canvas action.");
  const mutation = action !== "list_workspaces" && action !== "list_canvases";
  const allowed = new Set(["action"]);
  const fieldsByAction: Record<string, string[]> = {
    list_workspaces: [], list_canvases: ["workspaceId"], create_workspace: ["name"],
    rename_workspace: ["workspaceId", "name"], select_workspace: ["workspaceId"],
    create_canvas: ["workspaceId", "name"], rename_canvas: ["canvasId", "name"],
    duplicate_canvas: ["canvasId", "name"], select_canvas: ["workspaceId", "canvasId"],
    delete_canvas: ["canvasId", "confirmationToken"], delete_workspace: ["workspaceId", "confirmationToken"],
    import_draw_file_as_canvas: ["workspaceId", "path", "name"],
  };
  for (const field of fieldsByAction[action] ?? []) allowed.add(field);
  if (mutation) { allowed.add("expectedCatalogRevision"); allowed.add("idempotencyKey"); }
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new McpValidationError(`workspace_action has unsupported field "${key}".`);
  const result: Record<string, unknown> = { action };
  const requiredStrings = new Set(["workspaceId", "canvasId", "name", "path"]);
  for (const field of fieldsByAction[action] ?? []) {
    const raw = input[field];
    if (field === "name" && action === "duplicate_canvas" && raw === undefined) continue;
    if (field === "confirmationToken" && raw === undefined) continue;
    if (field === "path") result.path = parseRelativeFileName(raw, "workspace_action.path", [".draw"]);
    else if (field === "name") result.name = requireString(raw, "workspace_action.name", 200);
    else if (field === "confirmationToken") result.confirmationToken = requireString(raw, "workspace_action.confirmationToken", 200);
    else if (requiredStrings.has(field)) result[field] = requireString(raw, `workspace_action.${field}`, 200);
  }
  if (mutation) {
    if (!Number.isSafeInteger(input.expectedCatalogRevision) || (input.expectedCatalogRevision as number) < 0) {
      throw new McpValidationError("workspace_action.expectedCatalogRevision must be a non-negative integer.");
    }
    result.expectedCatalogRevision = input.expectedCatalogRevision;
    result.idempotencyKey = requireIdempotencyKey(input, "workspace_action");
  }
  return { operation: "workspace_action", input: result as unknown as McpWorkspaceAction };
}

export interface CanvasPageOptions {
  /** Zero-based index among active (non-deleted) scene elements. */
  offset?: number;
  /** Maximum number of elements in this page. */
  limit?: number;
  expectedDocumentRevision?: number;
}

const MAX_CANVAS_PAGE_SIZE = 250;
const MAX_CANVAS_OFFSET = 1_000_000;

/** Compact, paginated summary that excludes soft-deleted scene objects. */
export function summarizeCurrentCanvas(document: DrawDocument, options: CanvasPageOptions | number = {}) {
  const elements = document.document.elements.filter((element) => element.isDeleted !== true);
  const legacyLimit = typeof options === "number";
  const limit = legacyLimit ? options : (options.limit ?? MAX_CANVAS_PAGE_SIZE);
  const offset = legacyLimit
    ? Math.max(0, elements.length - limit)
    : (options.offset ?? 0);

  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_CANVAS_OFFSET) {
    throw new McpValidationError(`offset must be an integer between 0 and ${MAX_CANVAS_OFFSET}.`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANVAS_PAGE_SIZE) {
    throw new McpValidationError(`limit must be an integer between 1 and ${MAX_CANVAS_PAGE_SIZE}.`);
  }
  if (typeof options !== "number" && options.expectedDocumentRevision !== undefined && options.expectedDocumentRevision !== document.document.documentRevision) {
    throw new McpValidationError(`Document revision conflict. Expected ${options.expectedDocumentRevision}; current revision is ${document.document.documentRevision}. Read the first page again.`);
  }

  const visible = elements.slice(offset, offset + limit);
  const nextOffset = offset + visible.length;
  const hasMore = nextOffset < elements.length;
  return {
    id: document.document.id,
    documentId: document.document.id,
    documentRevision: document.document.documentRevision ?? 0,
    viewRevision: document.document.viewRevision ?? 0,
    title: document.document.title,
    background: document.document.canvas.background.preset,
    viewport: document.document.canvas.viewport,
    elementCount: elements.length,
    offset,
    limit,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
    elements: visible.map((element: any) => ({
      id: element.id,
      type: element.type,
      text: typeof element.text === "string" ? element.text.slice(0, 160) : undefined,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      containerId: element.containerId,
      boundElements: Array.isArray(element.boundElements) ? element.boundElements : undefined,
      strokeColor: element.strokeColor,
      backgroundColor: element.backgroundColor,
      strokeWidth: element.strokeWidth,
      strokeStyle: element.strokeStyle,
      fillStyle: element.fillStyle,
      roughness: element.roughness,
      opacity: element.opacity,
      angle: element.angle,
      groupIds: Array.isArray(element.groupIds) ? element.groupIds : undefined,
      startBinding: element.startBinding,
      endBinding: element.endBinding,
      points: element.points,
      ...(element.originalText ? { originalText: element.originalText } : {}),
    })),
    assetsCount: Object.keys(document.document.assets).length,
    truncated: hasMore || offset > 0,
  };
}
