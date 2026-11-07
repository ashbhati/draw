import type { DrawDocument } from "../document/document";

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
export type CreateElementsInput = { elements: DrawPrimitiveInput[] };

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

export type UpdateElementsInput = { updates: ElementUpdateInput[] };

export type McpCommand =
  | { operation: "create_diagram"; input: CreateDiagramInput }
  | { operation: "create_elements"; input: CreateElementsInput }
  | { operation: "update_elements"; input: UpdateElementsInput };

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
  return { elements };
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

  return { ...(title !== undefined ? { title } : {}), nodes, edges };
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
  return { updates };
}

export function parseMcpToolInput(
  name: string,
  input: unknown,
): McpCommand {
  if (name === "create_diagram") {
    return { operation: "create_diagram", input: parseCreateDiagram(input) };
  }
  if (name === "create_elements") {
    return { operation: "create_elements", input: parseCreateElements(input) };
  }
  if (name === "update_elements") {
    return { operation: "update_elements", input: parseUpdateElements(input) };
  }
  throw new McpValidationError(`Unknown Draw MCP tool "${name}".`);
}

export interface CanvasPageOptions {
  /** Zero-based index among active (non-deleted) scene elements. */
  offset?: number;
  /** Maximum number of elements in this page. */
  limit?: number;
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

  const visible = elements.slice(offset, offset + limit);
  const nextOffset = offset + visible.length;
  const hasMore = nextOffset < elements.length;
  return {
    id: document.document.id,
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
    })),
    assetsCount: Object.keys(document.document.assets).length,
    truncated: hasMore || offset > 0,
  };
}
