import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { parseMcpToolInput, summarizeCurrentCanvas } from "./mcp-contract";

const defaultBaseUrl = "http://127.0.0.1:5173";
const requestTimeoutMs = 25_000;
const colorSchema = z.string().regex(/^#[\da-f]{6}$/i, "Use a six-digit hex color such as #f3c94c.");

const createDiagramSchema = z.object({
  title: z.string().max(200).optional(),
  nodes: z.array(z.object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(500),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().min(24).max(5000).optional(),
    height: z.number().finite().min(24).max(5000).optional(),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
    color: colorSchema.optional(),
  })).min(1).max(100),
  edges: z.array(z.object({
    from: z.string().min(1).max(100),
    to: z.string().min(1).max(100),
    label: z.string().min(1).max(500).optional(),
    color: colorSchema.optional(),
  })).max(200),
});

const pointSchema = z.array(z.number().finite()).min(2).max(3);
const primitiveBaseSchema = {
  id: z.string().min(1).max(100),
  x: z.number().finite(),
  y: z.number().finite(),
  strokeColor: colorSchema.optional(),
};
const primitiveStrokeSchema = {
  ...primitiveBaseSchema,
  strokeWidth: z.number().finite().min(1).max(8).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
};
const createPrimitiveSchema = z.discriminatedUnion("type", [
  z.object({
    ...primitiveStrokeSchema, type: z.enum(["rectangle", "ellipse", "diamond"]),
    width: z.number().finite().min(24).max(5000).optional(), height: z.number().finite().min(24).max(5000).optional(),
    backgroundColor: z.union([colorSchema, z.literal("transparent")]).optional(),
    fillStyle: z.enum(["solid", "hachure", "cross-hatch", "zigzag", "dots"]).optional(),
  }).strict(),
  z.object({ ...primitiveBaseSchema, type: z.literal("text"), text: z.string().min(1).max(500), fontSize: z.number().finite().min(8).max(128).optional() }).strict(),
  z.object({ ...primitiveStrokeSchema, type: z.literal("line"), points: z.array(pointSchema).min(2).max(2000) }).strict(),
  z.object({
    ...primitiveStrokeSchema, type: z.literal("arrow"), points: z.array(pointSchema).min(2).max(2000),
    endArrowhead: z.enum(["arrow", "bar", "dot", "triangle"]).nullable().optional(),
  }).strict(),
  z.object({ ...primitiveStrokeSchema, type: z.literal("freedraw"), points: z.array(pointSchema).min(2).max(2000) }).strict(),
]);
const createElementsSchema = z.object({ elements: z.array(createPrimitiveSchema).min(1).max(100) }).strict();

const updateElementsSchema = z.object({
  updates: z.array(z.object({
    id: z.string().min(1).max(100),
    patch: z.object({
      text: z.string().min(1).max(500).optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      width: z.number().finite().min(24).max(5000).optional(),
      height: z.number().finite().min(24).max(5000).optional(),
      strokeColor: colorSchema.optional(),
      backgroundColor: colorSchema.optional(),
    }).strict(),
  })).min(1).max(100),
});

function resolveLoopbackBaseUrl(): URL {
  const base = new URL(process.env.DRAW_MCP_BASE_URL ?? defaultBaseUrl);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password
  ) {
    throw new Error("DRAW_MCP_BASE_URL must point to a loopback HTTP address such as http://127.0.0.1:5173.");
  }
  return base;
}

const baseUrl = resolveLoopbackBaseUrl();

async function bridgeRequest(path: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body?.error === "string" ? body.error : `Draw bridge returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out waiting for the Draw canvas. Keep the local Draw app open and try again.");
    }
    if (error instanceof TypeError) {
      throw new Error(`Cannot reach Draw at ${baseUrl.origin}. Start the local Draw app, then retry.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function createServer() {
  const server = new McpServer({ name: "draw", version: "0.1.0" });

  server.registerTool(
    "get_current_canvas",
    {
      description: "Flush and read the latest active Draw document, then return a paginated summary including stable element IDs, container relationships, and colors for targeted edits. Use nextOffset to request more elements.",
      inputSchema: z.object({ offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(250).optional() }),
    },
    async (input) => textResult(summarizeCurrentCanvas(await bridgeRequest("/__draw/api/document?flush=1"), input)),
  );

  server.registerTool(
    "create_diagram",
    {
      description: "Create editable diagram nodes and arrows on the open Draw canvas. Coordinates are canvas units; every node and edge is added as native Draw/Excalidraw scene elements, not an image.",
      inputSchema: createDiagramSchema,
    },
    async (input) => {
      const command = parseMcpToolInput("create_diagram", input);
      const result = await bridgeRequest("/__draw/api/commands", {
        method: "POST",
        body: JSON.stringify(command),
      });
      return textResult(result.warning ? { ...result.result, warning: result.warning } : result.result ?? result);
    },
  );

  server.registerTool(
    "create_elements",
    {
      description: "Create editable native Draw shapes, text, lines, arrows, and freehand strokes on the open canvas. Use local canvas coordinates; line and freedraw points are offsets from each element's x/y. Returns input IDs mapped to Draw element IDs.",
      inputSchema: createElementsSchema,
    },
    async (input) => {
      const command = parseMcpToolInput("create_elements", input);
      const result = await bridgeRequest("/__draw/api/commands", {
        method: "POST",
        body: JSON.stringify(command),
      });
      return textResult(result.warning ? { ...result.result, warning: result.warning } : result.result ?? result);
    },
  );

  server.registerTool(
    "update_elements",
    {
      description: "Move, resize, recolor, or change text on editable elements in the open Draw canvas. Use get_current_canvas to find element IDs.",
      inputSchema: updateElementsSchema,
    },
    async (input) => {
      const command = parseMcpToolInput("update_elements", input);
      const result = await bridgeRequest("/__draw/api/commands", {
        method: "POST",
        body: JSON.stringify(command),
      });
      return textResult(result.warning ? { ...result.result, warning: result.warning } : result.result ?? result);
    },
  );

  return server;
}

try {
  serveStdio(createServer);
} catch (error) {
  console.error("Draw MCP server failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
