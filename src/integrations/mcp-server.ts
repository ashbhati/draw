import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHash } from "node:crypto";
import { readLocalMcpCredential, getLocalMcpIdentity, writeLocalMcpCredential } from "./mcp-client-credentials";
import * as z from "zod/v4";
import { parseMcpToolInput, summarizeCurrentCanvas } from "./mcp-contract";
import { loadDrawFileSnapshot, writeNewArtifact } from "./mcp-file-access";
import { assertInlineArtifactSize } from "./mcp-result-limits";
import { shouldRequireOpenConfirmation } from "../document/open-safety";
import { serializeDrawFile } from "../document/document";

const defaultBaseUrl = "http://127.0.0.1:5173";
const requestTimeoutMs = 25_000;
const pairingTimeoutMs = 125_000;
const colorSchema = z.string().regex(/^#[\da-f]{6}$/i, "Use a six-digit hex color such as #f3c94c.");

const createDiagramSchema = z.object({
  documentId: z.string().min(1).max(200),
  expectedDocumentRevision: z.number().int().nonnegative(),
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
const pathPointSchema = z.tuple([z.number().finite(), z.number().finite()]);
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
    label: z.string().min(1).max(500).optional(),
  }).strict(),
  z.object({ ...primitiveBaseSchema, type: z.literal("text"), text: z.string().min(1).max(500), fontSize: z.number().finite().min(8).max(128).optional(), maxWidth: z.number().finite().min(24).max(5000).optional() }).strict(),
  z.object({ ...primitiveStrokeSchema, type: z.literal("line"), points: z.array(pathPointSchema).min(2).max(2000) }).strict(),
  z.object({
    ...primitiveStrokeSchema, type: z.literal("arrow"), points: z.array(pathPointSchema).min(2).max(2000),
    endArrowhead: z.enum(["arrow", "bar", "dot", "triangle"]).nullable().optional(),
    start: z.string().min(1).max(100).optional(), end: z.string().min(1).max(100).optional(), label: z.string().min(1).max(500).optional(),
  }).strict(),
  z.object({ ...primitiveStrokeSchema, type: z.literal("freedraw"), points: z.array(pointSchema).min(2).max(2000) }).strict(),
]);
const createElementsSchema = z.object({
  documentId: z.string().min(1).max(200), expectedDocumentRevision: z.number().int().nonnegative(),
  elements: z.array(createPrimitiveSchema).min(1).max(100),
}).strict();

const updateElementsSchema = z.object({
  documentId: z.string().min(1).max(200),
  expectedDocumentRevision: z.number().int().nonnegative(),
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

const revisionContext = { documentId: z.string().min(1).max(200), expectedDocumentRevision: z.number().int().nonnegative() };
const idsSchema = z.object({ ...revisionContext, ids: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict();
const commandTool = (server: McpServer, name: string, description: string, inputSchema: any) => {
  server.registerTool(name, { description, inputSchema }, async (input: Record<string, unknown>) => {
    const command = parseMcpToolInput(name, input);
    const result = await bridgeRequest("/__draw/api/commands", { method: "POST", body: JSON.stringify(command) });
    return textResult(result.warning ? { ...result.result, warning: result.warning } : result.result ?? result);
  });
};
const fileRoot = () => {
  const root = process.env.DRAW_MCP_DOCUMENT_DIR;
  if (!root) throw new Error("Set DRAW_MCP_DOCUMENT_DIR to an absolute, user-approved folder for MCP open/save/export tools.");
  return root;
};

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

async function bridgeRequest(path: string, init?: RequestInit, options: { pairing?: boolean; timeoutMs?: number } = {}): Promise<any> {
  const pairing = options.pairing ?? false;
  const credential = pairing ? null : await readLocalMcpCredential();
  if (!pairing && (!credential?.clientIdentity || !credential.capability || (credential.expiresAt ?? 0) <= Date.now())) {
    throw new Error("This MCP host is not paired with Draw. In Draw, open MCP clients, copy the one-time pairing secret into protected host configuration, then call pair_mcp_client.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? requestTimeoutMs);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(!pairing && credential ? { "x-draw-client-identity": credential.clientIdentity!, authorization: `Bearer ${credential.capability!}` } : {}),
        ...(init?.headers ?? {}),
      },
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

  server.registerTool("pair_mcp_client", {
    description: "Pair this MCP host with Draw. First copy Draw's one-time MCP pairing secret into protected host configuration as DRAW_MCP_PAIRING_SECRET. The tool submits that secret, a stable host fingerprint, and a configured client name; Draw asks the human owner to approve. The capability is saved locally with restrictive permissions and is never returned to the model.",
    inputSchema: z.object({}).strict(),
  }, async () => {
    const pairingSecret = process.env.DRAW_MCP_PAIRING_SECRET;
    if (!pairingSecret || !/^[a-f\d]{64}$/i.test(pairingSecret)) {
      throw new Error("Set DRAW_MCP_PAIRING_SECRET in the MCP host's protected secret configuration using the secret displayed in Draw's MCP clients dialog.");
    }
    const local = await getLocalMcpIdentity();
    const fingerprint = createHash("sha256").update(local.installationId).digest("hex");
    const clientName = process.env.DRAW_MCP_CLIENT_NAME?.trim() || "Draw MCP client";
    const paired = await bridgeRequest("/__draw/api/mcp/pair", {
      method: "POST",
      body: JSON.stringify({ pairingSecret, clientName, fingerprint }),
    }, { pairing: true, timeoutMs: pairingTimeoutMs });
    if (typeof paired.clientIdentity !== "string" || typeof paired.capability !== "string" || typeof paired.expiresAt !== "number") {
      throw new Error("Draw returned an invalid MCP pairing result.");
    }
    await writeLocalMcpCredential({ ...local, clientIdentity: paired.clientIdentity, capability: paired.capability, expiresAt: paired.expiresAt });
    return textResult({ paired: true, clientIdentity: paired.clientIdentity, expiresAt: paired.expiresAt, fingerprint });
  });

  server.registerTool(
    "get_current_canvas",
    {
      description: "Flush and read the latest active Draw document, then return a paginated summary including stable element IDs, container relationships, and colors for targeted edits. Use nextOffset to request more elements.",
      inputSchema: z.object({ offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(250).optional(), expectedDocumentRevision: z.number().int().nonnegative().optional() }),
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
      description: "Create editable native Draw shapes, text, lines, arrows, and freehand strokes on the open canvas. Use canvas coordinates; path points are offsets from x/y. Freedraw supports optional per-point pressure. Arrows may bind both endpoints to shapes created in the call; bound arrows derive their path from the shapes and ignore supplied x/y/points. Returns input IDs mapped to Draw element IDs and relationships.",
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

  commandTool(server, "delete_elements", "Soft-delete editable elements by stable IDs. The entire batch validates against the active document revision before applying; returns per-element outcomes.", idsSchema);
  commandTool(server, "duplicate_elements", "Duplicate editable elements and their bound labels with new Draw IDs. Optionally set offsetX/offsetY (default 24).", {
    ...revisionContext, ids: z.array(z.string().min(1).max(200)).min(1).max(100), offsetX: z.number().finite().min(-100000).max(100000).optional(), offsetY: z.number().finite().min(-100000).max(100000).optional(),
  });
  commandTool(server, "set_selection", "Select or clear elements in the open Draw canvas by stable IDs. Selection is transient and is not saved.", { documentId: z.string().min(1).max(200), ids: z.array(z.string().min(1).max(200)).max(100) });
  commandTool(server, "group_elements", "Group two or more selected elements in the active Draw document.", idsSchema);
  commandTool(server, "ungroup_elements", "Remove the latest shared group from selected elements in the active Draw document.", idsSchema);
  commandTool(server, "arrange_elements", "Bring selected elements forward/back, align two or more, or distribute three or more. Bound labels travel with their shapes.", {
    ...revisionContext,
    ids: z.array(z.string().min(1).max(200)).min(1).max(100),
    action: z.enum(["bring_to_front", "send_to_back", "align", "distribute"]),
    alignment: z.enum(["left", "right", "top", "bottom", "center_x", "center_y"]).optional(),
    axis: z.enum(["horizontal", "vertical"]).optional(),
  });
  const historySchema = { documentId: z.string().min(1).max(200), operationId: z.string().min(1).max(200), expectedDocumentRevision: z.number().int().nonnegative() };
  commandTool(server, "undo_operation", "Undo the latest MCP operation only if no later scene edit has invalidated it. Provide the operationId returned by a successful mutation.", historySchema);
  commandTool(server, "redo_operation", "Redo the operation just undone, provided no newer scene edit has occurred.", historySchema);
  commandTool(server, "set_canvas_settings", "Set the active document title and/or its Blackboard/Whiteboard background.", {
    ...revisionContext, title: z.string().min(1).max(200).optional(), background: z.enum(["blackboard", "white"]).optional(),
  });
  commandTool(server, "set_viewport", "Set canvas pan/zoom or fit the current document contents into view. This changes the view revision, not element coordinates.", {
    documentId: z.string().min(1).max(200), expectedViewRevision: z.number().int().nonnegative(),
    action: z.enum(["fit_content", "set"]), x: z.number().finite().optional(), y: z.number().finite().optional(), zoom: z.number().finite().min(0.1).max(10).optional(),
  });

  server.registerTool("open_document", {
    description: "Open a native editable .draw file from DRAW_MCP_DOCUMENT_DIR. The MCP path is only a plain filename; this tool cannot read outside that configured directory. Replacing a non-empty canvas returns NEEDS_CONFIRMATION and a one-use token; approve it in the Draw app, then retry with that token.",
    inputSchema: z.object({ path: z.string().min(1).max(160), documentId: z.string().min(1).max(200), expectedDocumentRevision: z.number().int().nonnegative(), confirmationToken: z.string().min(1).max(200).optional() }).strict(),
  }, async (input) => {
    const command = parseMcpToolInput("open_document", input);
    if (command.operation !== "open_document") throw new Error("Invalid open_document command.");
    const current = await bridgeRequest("/__draw/api/document?flush=1");
    assertDocumentContext(current, command.input.documentId, command.input.expectedDocumentRevision);
    const { document, fingerprint } = await loadDrawFileSnapshot(fileRoot(), command.input.path);
    const needsConfirmation = shouldRequireOpenConfirmation(current);
    if (needsConfirmation && !command.input.confirmationToken) {
      const confirmation = await bridgeRequest("/__draw/api/confirmations", { method: "POST", body: JSON.stringify({
        action: "open_document", documentId: command.input.documentId,
        expectedDocumentRevision: command.input.expectedDocumentRevision,
        filename: command.input.path, fingerprint,
      }) });
      return textResult({ status: "NEEDS_CONFIRMATION", confirmationToken: confirmation.confirmationToken, expiresAt: confirmation.expiresAt, action: "open_document", filename: command.input.path });
    }
    if (command.input.confirmationToken) {
      const confirmation = await bridgeRequest(`/__draw/api/confirmations/${encodeURIComponent(command.input.confirmationToken)}/consume`, { method: "POST", body: JSON.stringify({
        action: "open_document", documentId: command.input.documentId,
        expectedDocumentRevision: command.input.expectedDocumentRevision,
        filename: command.input.path, fingerprint,
      }) });
      if (confirmation.status !== "APPROVED") return textResult({ status: confirmation.status, opened: false, documentId: current.document.id });
    }
    const result = await bridgeRequest("/__draw/api/commands", { method: "POST", body: JSON.stringify({ ...command, document }) });
    return textResult({ ...result.result, documentId: document.document.id, title: document.document.title, documentRevision: document.document.documentRevision });
  });

  server.registerTool("save_document", {
    description: "Save the current editable .draw document. Optional path writes a new file only inside DRAW_MCP_DOCUMENT_DIR; existing files are never overwritten. Without path, returns native .draw JSON as tool content.",
    inputSchema: z.object({ path: z.string().min(1).max(160).optional(), documentId: z.string().min(1).max(200), expectedDocumentRevision: z.number().int().nonnegative() }).strict(),
  }, async (input) => {
    const command = parseMcpToolInput("save_document", input);
    if (command.operation !== "save_document") throw new Error("Invalid save_document command.");
    const document = await bridgeRequest("/__draw/api/document?flush=1");
    assertDocumentContext(document, command.input.documentId, command.input.expectedDocumentRevision);
    const drawFile = serializeDrawFile(document);
    const fileName = command.input.path ?? `${document.document.title.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "Untitled-drawing"}.draw`;
    if (command.input.path) {
      await writeNewArtifact(fileRoot(), fileName, new TextEncoder().encode(drawFile), "draw");
      return textResult({ saved: true, fileName, documentId: document.document.id, documentRevision: document.document.documentRevision });
    }
    assertInlineArtifactSize(new TextEncoder().encode(drawFile).byteLength, "Draw file");
    return textResult({ saved: true, fileName, mimeType: "application/vnd.draw+json", documentId: document.document.id, documentRevision: document.document.documentRevision, drawFile });
  });

  server.registerTool("export_image", {
    description: "Export the active Draw canvas or selection to PNG/JPEG without replacing its editable .draw document. Optional paths create a new file inside DRAW_MCP_DOCUMENT_DIR.",
    inputSchema: z.object({ path: z.string().min(1).max(160).optional(), documentId: z.string().min(1).max(200), format: z.enum(["png", "jpeg"]), scope: z.enum(["canvas", "selection"]), background: z.enum(["blackboard", "white", "transparent"]).optional() }).strict(),
  }, async (input) => {
    const command = parseMcpToolInput("export_image", input);
    if (command.operation !== "export_image") throw new Error("Invalid export_image command.");
    const result = await bridgeRequest("/__draw/api/commands", { method: "POST", body: JSON.stringify(command) });
    const exported = result.result as Record<string, unknown> | null;
    if (typeof exported?.imageData !== "string") throw new Error("Draw did not return an image artifact.");
    const bytes = Buffer.from(exported.imageData, "base64");
    if (!command.input.path) assertInlineArtifactSize(bytes.byteLength, "Image export");
    const mimeType = command.input.format === "png" ? "image/png" : "image/jpeg";
    const name = command.input.path ?? `${Date.now()}-draw.${command.input.format === "png" ? "png" : "jpg"}`;
    if (command.input.path) await writeNewArtifact(fileRoot(), name, bytes, command.input.format);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ exported: true, fileName: name, mimeType, bytes: bytes.byteLength }, null, 2) },
        ...(!command.input.path ? [{ type: "image" as const, mimeType, data: bytes.toString("base64") }] : []),
      ],
    };
  });

  return server;
}

function assertDocumentContext(document: any, documentId: string, expectedRevision: number): void {
  if (document?.document?.id !== documentId) throw new Error("Document ID does not match the active Draw canvas.");
  if ((document?.document?.documentRevision ?? 0) !== expectedRevision) throw new Error("Document revision conflict. Read the latest canvas and retry with its current revision.");
}

try {
  serveStdio(createServer);
} catch (error) {
  console.error("Draw MCP server failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
