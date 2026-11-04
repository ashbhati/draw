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
  | { operation: "update_elements"; input: UpdateElementsInput };

export class McpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpValidationError";
  }
}

const MAX_NODES = 100;
const MAX_EDGES = 200;
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
  if (name === "update_elements") {
    return { operation: "update_elements", input: parseUpdateElements(input) };
  }
  throw new McpValidationError(`Unknown Draw MCP tool "${name}".`);
}

/** Compact summary that excludes soft-deleted scene objects and keeps recent IDs visible. */
export function summarizeCurrentCanvas(document: DrawDocument, limit = 250) {
  const elements = document.document.elements.filter((element) => element.isDeleted !== true);
  const visible = elements.slice(-limit);
  return {
    id: document.document.id,
    title: document.document.title,
    background: document.document.canvas.background.preset,
    viewport: document.document.canvas.viewport,
    elementCount: elements.length,
    elements: visible.map((element: any) => ({
      id: element.id,
      type: element.type,
      text: typeof element.text === "string" ? element.text.slice(0, 160) : undefined,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    })),
    assetsCount: Object.keys(document.document.assets).length,
    truncated: elements.length > visible.length,
  };
}
