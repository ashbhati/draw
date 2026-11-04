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
      description: "Read a compact summary of the currently open Draw document, including stable element IDs for targeted edits.",
      inputSchema: z.object({}),
    },
    async () => textResult(summarizeCurrentCanvas(await bridgeRequest("/__draw/api/document"))),
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
      return textResult(result.result ?? result);
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
      return textResult(result.result ?? result);
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
