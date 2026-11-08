import { CaptureUpdateAction, Excalidraw, FONT_FAMILY, MainMenu, convertToExcalidrawElements, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createEmptyDocument,
  fromExcalidrawScene,
  parseDrawFile,
  serializeDrawFile,
  toExcalidrawScene,
  type DrawBackgroundPreset,
  type DrawDocument,
} from "./document/document";
import { isSafeHttpsUrl } from "./document/attribution";
import { composeBackgroundSvg, hasSelectedExportElements, renderExportBlob, selectExportElements } from "./export/background";
import { recolorForBackgroundPreset } from "./export/background-recolor";
import { saveCurrentDocument, loadCurrentDocument, commitMcpOperation, restoreMcpCommandSnapshot, loadMcpOperation, loadLatestMcpUndoOperation, loadLatestMcpRedoOperation, createWorkspace, createCanvas, duplicateCanvas, deleteCanvas, deleteWorkspace, listCanvases, listWorkspaces, loadCanvasDocument, renameCanvas, renameWorkspace, setActiveCanvas, type DrawCanvas, type DrawWorkspace } from "./ui/storage";
import { applyElementUpdates, routeBoundArrows, type EditableSceneElement } from "./integrations/scene-updates";
import { acquireWriterLock, type WriterLock } from "./ui/writer-lock";
import { createDebouncedSaver } from "./ui/autosave";
import { buildDiagramSkeletons } from "./integrations/diagram-builder";
import { buildPrimitiveSkeletons } from "./integrations/primitive-builder";
import { wrapTextToWidth } from "./integrations/scene-updates";
import { persistAppliedDocument } from "./integrations/command-persistence";
import { createBridgeSynchronizer } from "./integrations/bridge-sync";
import { applySceneEdit } from "./integrations/scene-operations";
import { hasSceneContentChanged, sceneElementsChanged } from "./integrations/scene-revision";
import { rebaseOpenedDocument, shouldRequireOpenConfirmation } from "./document/open-safety";
import { canRestoreCancelledMcpCommand } from "./integrations/mcp-cancellation";
import { canRedoMcpOperation, canUndoMcpOperation, hashMcpOperation, resolveOperationReplay, type DurableMcpOperation } from "./integrations/operation-ledger";
import { fetchOpenverseImage, imageAttributionFromOpenverseResult, searchOpenverseImages, validateEmbeddedImage, type OpenverseAttribution, type OpenverseImageResult } from "./integrations/openverse";

type Status = "loading" | "ready" | "saving" | "saved" | "error";
type BridgeCommand = { id: string; clientId: string; clientIdentity: string; operation: string; input: any; document?: DrawDocument };
type BridgeFlush = { id: string; clientId: string; clientIdentity: string };
type BridgeConfirmation = { token: string; clientId: string; clientIdentity: string; action: "open_document"; filename: string; expiresAt: number };
type McpPairingRequest = { requestId: string; clientId: string; name: string; fingerprint: string; expiresAt: number; replacesName?: string };
type McpClientRevokedEvent = { clientIdentity: string };
type McpCommandRevokedEvent = { id: string; clientId: string; clientIdentity: string };
type McpPairedClient = { clientIdentity: string; name: string; fingerprint: string; createdAt: number; expiresAt: number; revokedAt: number | null };
const DEFAULT_COLOR: Record<DrawBackgroundPreset, string> = { blackboard: "#18191a", white: "#ffffff" };
const EDITOR_UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, changeViewBackgroundColor: false },
} as const;
const DRAW_MENU = (
  <MainMenu>
    <MainMenu.DefaultItems.SearchMenu />
  </MainMenu>
);
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `el-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function measureTextWithExcalidraw(text: string, fontSize: number, element: EditableSceneElement) {
  const skeleton: Record<string, unknown> = {
    id: "draw-text-measurement",
    type: "text",
    text,
    fontSize,
    fontFamily: element.fontFamily ?? FONT_FAMILY.Virgil,
  };
  if (typeof element.lineHeight === "number") skeleton.lineHeight = element.lineHeight;
  const [measured] = convertToExcalidrawElements([skeleton] as any[], { regenerateIds: false }) as any[];
  return { width: measured.width as number, height: measured.height as number };
}

function renderedTextWidth(text: string, fontSize: number): number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return 0;
  context.font = `${fontSize}px Excalifont`;
  return Math.max(...text.split("\n").map((line) => context.measureText(line).width));
}

async function materializeMcpElements(skeletons: Record<string, unknown>[]) {
  const textSkeletons = skeletons.flatMap((skeleton) => {
    const nestedLabel = skeleton.label && typeof skeleton.label === "object" ? [skeleton.label as Record<string, unknown>] : [];
    return [skeleton, ...nestedLabel].filter((candidate) => typeof candidate.text === "string");
  });
  await Promise.all(textSkeletons.map((skeleton) => {
    const fontSize = typeof skeleton.fontSize === "number" ? skeleton.fontSize : 20;
    return document.fonts.load(`${fontSize}px Excalifont`, skeleton.text as string);
  }));
  await document.fonts.ready;
  const measuredSkeletons = skeletons.map((skeleton) => {
    const measured = { ...skeleton };
    if (measured.type === "text") measured.fontFamily = FONT_FAMILY.Excalifont;
    if (measured.label && typeof measured.label === "object") {
      measured.label = { ...(measured.label as Record<string, unknown>), fontFamily: FONT_FAMILY.Excalifont };
    }
    if (measured.type === "text" && typeof measured.maxWidth === "number" && typeof measured.text === "string") {
      const maxWidth = measured.maxWidth;
      const originalText = measured.text;
      measured.text = wrapTextToWidth(originalText, maxWidth, (line) => renderedTextWidth(line, typeof measured.fontSize === "number" ? measured.fontSize : 20));
      measured.originalText = originalText;
      delete measured.maxWidth;
    }
    return measured;
  });
  const created = convertToExcalidrawElements(measuredSkeletons as any[], { regenerateIds: false }) as any[];
  for (const element of created) {
    if (element.type !== "text" || element.containerId || typeof element.text !== "string") continue;
    const size = typeof element.fontSize === "number" ? element.fontSize : 20;
    element.width = Math.max(element.width ?? 0, Math.ceil(renderedTextWidth(element.text, size)) + 2);
    const source = skeletons.find((skeleton) => skeleton.id === element.id);
    if (typeof source?.text === "string") element.originalText = source.text;
  }
  return created;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function filename(title: string, extension: string) {
  const safe = title.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "Untitled-drawing";
  return `${safe}.${extension}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

export default function App() {
  const [doc, setDoc] = useState<DrawDocument | null>(null);
  const [workspaces, setWorkspaces] = useState<DrawWorkspace[]>([]);
  const [canvases, setCanvases] = useState<DrawCanvas[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [activeCanvasId, setActiveCanvasId] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<BridgeConfirmation | null>(null);
  const [editorConnected, setEditorConnected] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [launchCodeInput, setLaunchCodeInput] = useState("");
  const [connectError, setConnectError] = useState("");
  const [mcpManagementOpen, setMcpManagementOpen] = useState(false);
  const [mcpPairingSecret, setMcpPairingSecret] = useState("");
  const [mcpClients, setMcpClients] = useState<McpPairedClient[]>([]);
  const [mcpPairingRequest, setMcpPairingRequest] = useState<McpPairingRequest | null>(null);
  const [mcpPairingError, setMcpPairingError] = useState("");
  const [autosaveBlocked, setAutosaveBlocked] = useState(false);
  const autosaveBlockedRef = useRef(autosaveBlocked);
  autosaveBlockedRef.current = autosaveBlocked;
  const [canWrite, setCanWrite] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [exportScope, setExportScope] = useState<"canvas" | "selection">("canvas");
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [imageQuery, setImageQuery] = useState("");
  const [imageLicense, setImageLicense] = useState("");
  const [imageCategory, setImageCategory] = useState<"illustration" | "photograph" | "digitized_artwork" | "all">("illustration");
  const [imageResults, setImageResults] = useState<OpenverseImageResult[]>([]);
  const [imagePage, setImagePage] = useState(1);
  const [imageSearchError, setImageSearchError] = useState("");
  const [imageSearchBusy, setImageSearchBusy] = useState(false);
  const [imageInsertBusy, setImageInsertBusy] = useState<string | null>(null);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const docRef = useRef<DrawDocument | null>(null);
  const activeDocumentIdRef = useRef<string | null>(null);
  const clientId = useRef(randomId());
  const revokedMcpCommandIds = useRef(new Set<string>());
  const completedMcpCommandIds = useRef(new Set<string>());
  const editorSecret = useRef<string | null>(null);
  const bridgeSync = useMemo(() => createBridgeSynchronizer(clientId.current, () => editorSecret.current), []);
  const writerOwned = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastMcpOperation = useRef<{ id: string; revision: number } | null>(null);
  const lastUndoneOperation = useRef<{ id: string; revision: number } | null>(null);
  const viewRevisionTimer = useRef<number | null>(null);
  const onEditorReady = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    const viewport = docRef.current?.document.canvas.viewport;
    if (viewport) {
      api.updateScene({
        appState: { scrollX: viewport.x, scrollY: viewport.y, zoom: { value: viewport.zoom as any } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, []);

  useEffect(() => {
    const invalidateMcpHistoryOnHumanAction = (event: Event) => {
      if (!event.isTrusted) return;
      lastMcpOperation.current = null;
      lastUndoneOperation.current = null;
    };
    window.addEventListener("pointerdown", invalidateMcpHistoryOnHumanAction, true);
    window.addEventListener("keydown", invalidateMcpHistoryOnHumanAction, true);
    return () => {
      window.removeEventListener("pointerdown", invalidateMcpHistoryOnHumanAction, true);
      window.removeEventListener("keydown", invalidateMcpHistoryOnHumanAction, true);
    };
  }, []);

  const revokeEditorLease = useCallback((detail: { clientId?: string }) => {
    if (detail?.clientId !== clientId.current) return;
    editorSecret.current = null;
    setEditorConnected(false);
    setConfirmation(null);
    setConnectError("This editor session was replaced. Reconnect using the launch code in the trusted terminal.");
  }, []);

  useEffect(() => () => {
    if (viewRevisionTimer.current !== null) window.clearTimeout(viewRevisionTimer.current);
  }, []);

  useEffect(() => {
    const blockExcalidrawDialogs = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      const opensHelp = event.key === "?";
      const opensImageExporter = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "e";
      if (!opensHelp && !opensImageExporter) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", blockExcalidrawDialogs, true);
    return () => window.removeEventListener("keydown", blockExcalidrawDialogs, true);
  }, []);

  const setDocument = useCallback((next: DrawDocument) => {
    docRef.current = next;
    activeDocumentIdRef.current = next.document.id;
    setDoc(next);
  }, []);

  useEffect(() => {
    if (!doc || !activeCanvasId) return;
    setCanvases((current) => current.map((canvas) => canvas.id === activeCanvasId && canvas.name !== doc.document.title
      ? { ...canvas, name: doc.document.title }
      : canvas));
  }, [activeCanvasId, doc?.document.id, doc?.document.title]);

  const autosave = useMemo(() => createDebouncedSaver<DrawDocument>(async (value) => {
    if (!writerOwned.current) return;
    const outcome = await saveCurrentDocument(value);
    if (outcome.saved) setStatus("saved");
    else if (activeDocumentIdRef.current === value.document.id) {
      // A rejected write is actionable only while the submitted document is
      // still active. A switched or deleted canvas is expected to be stale.
      setStatus("error");
      setMessage("A newer saved scene or app state was kept; reload the page to continue from it.");
    }
  }, 350, (error) => {
    setStatus("error");
    setMessage(`Autosave failed: ${error instanceof Error ? error.message : String(error)}`);
  }), []);

  const syncBridgeDocument = useCallback(async (value: DrawDocument) => {
    if (!editorSecret.current) return;
    if (!writerOwned.current) throw new Error("This tab does not own the active Draw canvas.");
    try {
      await bridgeSync(value);
    } catch (error) {
      if (error instanceof Error && /authentication expired|401/i.test(error.message)) {
        editorSecret.current = null;
        setEditorConnected(false);
      }
      throw error;
    }
  }, [bridgeSync]);

  const bridgeAutosave = useMemo(() => createDebouncedSaver<DrawDocument>(syncBridgeDocument, 350, (error) => {
    setStatus("error");
    setMessage(`MCP bridge sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }), [syncBridgeDocument]);

  useEffect(() => {
    let live = true;
    let lock: WriterLock | null = null;
    const initialize = async () => {
      try {
        lock = await acquireWriterLock();
        if (!live) { lock.release(); return; }
        writerOwned.current = lock.acquired;
        setCanWrite(lock.acquired);
        if (!lock.acquired) {
          setAutosaveBlocked(true);
          setMessage(lock.supported
            ? "Draw is already open in another tab. Close that tab, then reload this tab to edit."
            : "This browser cannot coordinate Draw tabs safely. This tab is read-only to protect your autosave.");
        }
        try {
          let stored = await loadCurrentDocument();
          if (!live) return;
          let workspaceItems = await listWorkspaces();
          if (!workspaceItems.length) {
            if (lock.acquired) {
              const workspace = await createWorkspace("My workspace");
              const canvas = await createCanvas(workspace.id, stored?.document.title ?? "Untitled drawing", stored ?? undefined);
              await setActiveCanvas(canvas.id);
              stored = await loadCanvasDocument(canvas.id);
              workspaceItems = [workspace];
            }
          }
          let workspaceId = "";
          let canvasItems: DrawCanvas[] = [];
          if (stored) {
            for (const workspace of workspaceItems) {
              const items = await listCanvases(workspace.id);
              const active = items.find((item) => item.documentId === stored!.document.id);
              if (active) { workspaceId = workspace.id; canvasItems = items; break; }
            }
          }
          if (!workspaceId) {
            const workspace = workspaceItems[0];
            if (workspace) {
              workspaceId = workspace.id;
              canvasItems = await listCanvases(workspaceId);
              if (!canvasItems.length && lock.acquired) {
                const canvas = await createCanvas(workspaceId, "Untitled drawing");
                canvasItems = [canvas];
              }
              if (canvasItems.length) {
                if (lock.acquired) await setActiveCanvas(canvasItems[0].id);
                stored = await loadCanvasDocument(canvasItems[0].id);
              }
            }
          }
          if (!stored && lock.acquired) throw new Error("The active canvas document is unavailable.");
          setWorkspaces(workspaceItems);
          setCanvases(canvasItems);
          setActiveWorkspaceId(workspaceId);
          setActiveCanvasId(stored ? canvasItems.find((item) => item.documentId === stored!.document.id)?.id ?? "" : "");
          setDocument(stored ?? createEmptyDocument());
          if (stored) {
            try {
              const latestUndo = await loadLatestMcpUndoOperation(stored.document.id);
              if (!live) return;
              if (latestUndo && canUndoMcpOperation(latestUndo, latestUndo.clientIdentity, { id: stored.document.id, documentRevision: stored.document.documentRevision })) {
                lastMcpOperation.current = { id: latestUndo.operationId, revision: latestUndo.resultingRevision };
              }
            } catch (historyError) {
              if (!live) return;
              setMessage(`The drawing loaded, but stored MCP undo history is damaged. That undo is unavailable; the next successful edit will clear the damaged history. ${historyError instanceof Error ? historyError.message : String(historyError)}`);
            }
          }
          setStatus(lock.acquired ? "ready" : "error");
        } catch (error) {
          if (!live) return;
          setAutosaveBlocked(true);
          setDocument(createEmptyDocument());
          setStatus("error");
          setMessage(`Local autosave could not be loaded, so Draw will not overwrite it. Save a portable .draw file to keep new edits. ${error instanceof Error ? error.message : String(error)}`);
        }
      } catch (error) {
        if (!live) return;
        setAutosaveBlocked(true);
        setCanWrite(false);
        setDocument(createEmptyDocument());
        setStatus("error");
        setMessage(`Could not secure the single-tab editing lock; this tab is read-only. ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // React Strict Mode replays effects in development. Defer lock acquisition
    // one task so the discarded setup can cancel before it claims the tab lock.
    const initializeTimer = window.setTimeout(() => { void initialize(); }, 0);
    return () => {
      live = false;
      window.clearTimeout(initializeTimer);
      const release = () => {
        writerOwned.current = false;
        lock?.release();
      };
      if (autosave.isBusy() || bridgeAutosave.isBusy()) {
        void Promise.all([autosave.flush(), bridgeAutosave.flush()])
          .catch((error: unknown) => console.error("Could not flush Draw before closing:", error))
          .finally(release);
      } else release();
    };
  }, [autosave, bridgeAutosave, setDocument]);

  const onChange = useCallback((elements: readonly any[], appState: any, files: any) => {
    if (!writerOwned.current) return;
    const current = docRef.current;
    if (!current) return;
    const state = appState as Record<string, unknown> & { scrollX?: number; scrollY?: number; zoom?: { value?: number } };
    const backgroundPreset = state.viewBackgroundColor === "transparent"
      ? "blackboard"
      : state.viewBackgroundColor === DEFAULT_COLOR.white
        ? "white"
        : current.document.canvas.background.preset;
    const background = backgroundPreset === "blackboard"
      ? { preset: "blackboard" as const, styleVersion: 1, color: DEFAULT_COLOR.blackboard, texture: "chalk-smudge-v1" }
      : { preset: "white" as const, styleVersion: 1, color: DEFAULT_COLOR.white };
    const sceneChanged = hasSceneContentChanged(current, elements, files, background.preset);
    if (sceneChanged) {
      // A human scene edit makes a delayed MCP undo/redo ineligible. The live
      // editor history is shared, so an agent must never consume newer work.
      lastMcpOperation.current = null;
      lastUndoneOperation.current = null;
    }
    const viewport = {
      x: typeof state.scrollX === "number" ? state.scrollX : current.document.canvas.viewport.x,
      y: typeof state.scrollY === "number" ? state.scrollY : current.document.canvas.viewport.y,
      zoom: typeof state.zoom?.value === "number" ? state.zoom.value : current.document.canvas.viewport.zoom,
    };
    const viewChanged = JSON.stringify(current.document.canvas.viewport) !== JSON.stringify(viewport);
    const next = fromExcalidrawScene({ elements, appState, files }, {
      id: current.document.id,
      title: current.document.title,
      documentRevision: current.document.documentRevision + (sceneChanged ? 1 : 0),
      viewRevision: current.document.viewRevision,
      background,
      viewport,
    });
    setDocument(next);
    if (viewChanged) {
      if (viewRevisionTimer.current !== null) window.clearTimeout(viewRevisionTimer.current);
      viewRevisionTimer.current = window.setTimeout(() => {
        const latest = docRef.current;
        if (!latest) return;
        const settled = { ...latest, document: { ...latest.document, viewRevision: latest.document.viewRevision + 1 } };
        setDocument(settled);
        if (!autosaveBlockedRef.current) {
          autosave.schedule(settled);
          bridgeAutosave.schedule(settled);
        }
      }, 250);
    }
    if (autosaveBlocked) {
      setStatus("error");
      return;
    }
    setStatus("saving");
    autosave.schedule(next);
    bridgeAutosave.schedule(next);
  }, [autosave, autosaveBlocked, bridgeAutosave, setDocument]);

  useEffect(() => {
    if (!doc || !canWrite || !editorConnected) return;
    bridgeAutosave.schedule(doc);
  }, [bridgeAutosave, canWrite, editorConnected, doc?.document.id, doc ? editorKey : -1]);

  useEffect(() => {
    const flushPending = () => {
      if (!writerOwned.current || (!autosave.isBusy() && !bridgeAutosave.isBusy())) return;
      void Promise.all([autosave.flush(), bridgeAutosave.flush()]).catch((error: unknown) => {
        setStatus("error");
        setMessage(`Could not flush the last local save: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    const flushWhenHidden = () => { if (document.visibilityState === "hidden") flushPending(); };
    window.addEventListener("pagehide", flushPending);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushPending);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [autosave, bridgeAutosave]);

  const loadDocument = useCallback(async (next: DrawDocument): Promise<DrawDocument | null> => {
    if (!writerOwned.current) {
      setMessage("This tab is read-only because another Draw tab owns autosave.");
      return null;
    }
    if (autosave.isBusy()) await autosave.flush();
    if (bridgeAutosave.isBusy()) await bridgeAutosave.flush();
    if (viewRevisionTimer.current !== null) {
      window.clearTimeout(viewRevisionTimer.current);
      viewRevisionTimer.current = null;
    }
    const opened = rebaseOpenedDocument(docRef.current ?? next, next);
    lastMcpOperation.current = null;
    lastUndoneOperation.current = null;
    setStatus("ready"); setMessage("");
    setAutosaveBlocked(false);
    try {
      const replacement = await saveCurrentDocument(opened, { replaceDocument: true });
      if (!replacement.saved || !replacement.document) throw new Error("The active canvas did not accept the replacement document.");
      setDocument(replacement.document);
      setEditorKey((key) => key + 1);
      setStatus("saved");
      await syncBridgeDocument(replacement.document);
      return replacement.document;
    } catch (error) {
      setDocument(opened);
      setEditorKey((key) => key + 1);
      setAutosaveBlocked(true);
      setStatus("error");
      setMessage(`The file opened, but local autosave failed: ${error instanceof Error ? error.message : String(error)}. Use Save .draw to preserve it.`);
      return null;
    }
  }, [autosave, bridgeAutosave, setDocument, syncBridgeDocument]);

  const connectEditorToMcp = useCallback(async () => {
    if (!canWrite) return;
    setConnectError("");
    try {
      const response = await fetch("/__draw/api/editor/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ clientId: clientId.current, launchCode: launchCodeInput.trim().toUpperCase() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.editorSecret !== "string") {
        throw new Error(typeof result.error === "string" ? result.error : "Could not authenticate this Draw editor session.");
      }
      editorSecret.current = result.editorSecret;
      setEditorConnected(true);
      setConnectOpen(false);
      setLaunchCodeInput("");
      const current = docRef.current;
      if (current) await bridgeSync(current);
    } catch (error) {
      editorSecret.current = null;
      setEditorConnected(false);
      setConnectError(error instanceof Error ? error.message : "Could not authenticate this Draw editor session.");
    }
  }, [bridgeSync, canWrite, launchCodeInput]);

  const openMcpManagement = useCallback(async () => {
    setMcpPairingError("");
    if (!editorSecret.current || !canWrite) {
      setMcpPairingError("Connect this Draw tab to the local bridge before pairing MCP clients.");
      setMcpManagementOpen(true);
      return;
    }
    try {
      const headers = { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current };
      const clientsResponse = await fetch("/__draw/api/mcp/clients", { headers: { "x-draw-editor-secret": editorSecret.current }, cache: "no-store" });
      const clientsResult = await clientsResponse.json();
      if (!clientsResponse.ok) throw new Error(clientsResult.error ?? "Could not list paired MCP clients.");
      setMcpClients(clientsResult.clients ?? []);
      const secretResponse = await fetch("/__draw/api/mcp/pairing-secret", { method: "POST", headers, body: JSON.stringify({}), cache: "no-store" });
      const secretResult = await secretResponse.json();
      if (!secretResponse.ok) {
        setMcpPairingSecret("");
        setMcpPairingError(secretResult.error ?? "Could not create an MCP pairing secret.");
      } else setMcpPairingSecret(secretResult.pairingSecret);
      setMcpManagementOpen(true);
    } catch (error) {
      setMcpPairingError(error instanceof Error ? error.message : "Could not prepare MCP pairing.");
      setMcpManagementOpen(true);
    }
  }, [canWrite]);

  const respondToMcpPairing = useCallback(async (approved: boolean) => {
    const pending = mcpPairingRequest;
    if (!pending) return;
    try {
      const response = await fetch(`/__draw/api/mcp/pairings/${encodeURIComponent(pending.requestId)}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
        body: JSON.stringify({ clientId: clientId.current, approved }),
      });
      if (!response.ok) throw new Error("This MCP pairing request expired or the active Draw tab changed.");
      setMcpPairingRequest(null);
      setMcpPairingSecret("");
      if (approved) setMessage(`Paired MCP client “${pending.name}”.`);
      else setMessage("MCP pairing was denied.");
      if (approved && editorSecret.current) {
        const clients = await fetch("/__draw/api/mcp/clients", { headers: { "x-draw-editor-secret": editorSecret.current }, cache: "no-store" });
        if (clients.ok) setMcpClients((await clients.json()).clients ?? []);
      }
    } catch (error) {
      setMcpPairingRequest(null);
      setMessage(error instanceof Error ? error.message : "Could not answer the MCP pairing request.");
    }
  }, [mcpPairingRequest]);

  const revokeMcpClient = useCallback(async (identity: string) => {
    try {
      const response = await fetch(`/__draw/api/mcp/clients/${encodeURIComponent(identity)}`, {
        method: "DELETE", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
      });
      if (!response.ok) throw new Error("Could not revoke this MCP client.");
      setMcpClients((clients) => clients.map((client) => client.clientIdentity === identity ? { ...client, revokedAt: Date.now() } : client));
    } catch (error) {
      setMcpPairingError(error instanceof Error ? error.message : "Could not revoke this MCP client.");
    }
  }, []);

  const requestFreshEditorCode = useCallback(async () => {
    setConnectError("");
    try {
      const response = await fetch("/__draw/api/editor/reissue-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(typeof result.error === "string" ? result.error : "Could not request a fresh code.");
      }
      setConnectError("A fresh code was printed in the trusted terminal. Enter it here.");
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Could not request a fresh code.");
    }
  }, []);

  const openFile = async (file?: File) => {
    if (!file) return;
    try {
      const imported = await parseDrawFile(await file.text());
      await switchToNewCanvas(activeWorkspaceId, imported.document.title, imported);
      setMessage("Imported as a new editable canvas.");
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not open this Draw file."); }
    finally { if (fileInput.current) fileInput.current.value = ""; }
  };

  const refreshWorkspaceList = async (selectWorkspaceId = activeWorkspaceId, selectCanvasId = activeCanvasId) => {
    const nextWorkspaces = await listWorkspaces();
    const nextCanvases = selectWorkspaceId ? await listCanvases(selectWorkspaceId) : [];
    setWorkspaces(nextWorkspaces);
    setCanvases(nextCanvases);
    setActiveWorkspaceId(selectWorkspaceId);
    setActiveCanvasId(selectCanvasId);
  };

  const settleEditorBeforeSwitch = async () => {
    if (viewRevisionTimer.current !== null) { window.clearTimeout(viewRevisionTimer.current); viewRevisionTimer.current = null; }
    await Promise.all([autosave.flush(), bridgeAutosave.flush()]);
  };

  const switchToCanvas = async (canvasId: string, workspaceId = activeWorkspaceId) => {
    if (!canvasId || canvasId === activeCanvasId || !writerOwned.current) return;
    try {
      await settleEditorBeforeSwitch();
      autosave.cancelPending(); bridgeAutosave.cancelPending();
      const next = await loadCanvasDocument(canvasId);
      if (!next) throw new Error("The selected canvas has no saved document.");
      await setActiveCanvas(canvasId);
      lastMcpOperation.current = null; lastUndoneOperation.current = null;
      setDocument(next); setEditorKey((key) => key + 1); setStatus("saved"); setMessage("");
      await refreshWorkspaceList(workspaceId, canvasId);
    } catch (error) { setMessage(`Could not open canvas: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const switchToNewCanvas = async (workspaceId: string, name: string, source?: DrawDocument) => {
    await settleEditorBeforeSwitch();
    autosave.cancelPending(); bridgeAutosave.cancelPending();
    const created = await createCanvas(workspaceId, name, source);
    const next = await loadCanvasDocument(created.id);
    if (!next) throw new Error("The new canvas could not be loaded.");
    await setActiveCanvas(created.id);
    setDocument(next); setEditorKey((key) => key + 1); setStatus("saved");
    await refreshWorkspaceList(workspaceId, created.id);
  };

  const createNewWorkspace = async () => {
    try {
      await settleEditorBeforeSwitch();
      const workspace = await createWorkspace("New workspace");
      await switchToNewCanvas(workspace.id, "Untitled drawing");
    } catch (error) { setMessage(`Could not create workspace: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const selectWorkspace = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) return;
    try {
      const items = await listCanvases(workspaceId);
      if (!items.length) { await switchToNewCanvas(workspaceId, "Untitled drawing"); return; }
      await switchToCanvas(items[0].id, workspaceId);
    } catch (error) { setMessage(`Could not open workspace: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const createNewCanvas = async () => {
    try { await switchToNewCanvas(activeWorkspaceId, "Untitled drawing"); }
    catch (error) { setMessage(`Could not create canvas: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const duplicateActiveCanvas = async () => {
    try {
      await settleEditorBeforeSwitch();
      autosave.cancelPending(); bridgeAutosave.cancelPending();
      const duplicate = await duplicateCanvas(activeCanvasId);
      const next = await loadCanvasDocument(duplicate.id);
      if (!next) throw new Error("The copy could not be loaded.");
      await setActiveCanvas(duplicate.id); setDocument(next); setEditorKey((key) => key + 1);
      await refreshWorkspaceList(activeWorkspaceId, duplicate.id);
    } catch (error) { setMessage(`Could not duplicate canvas: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const renameActiveCanvas = async () => {
    const name = window.prompt("Canvas name", canvases.find((item) => item.id === activeCanvasId)?.name ?? "Untitled drawing");
    if (name === null) return;
    try {
      await settleEditorBeforeSwitch();
      const renamed = await renameCanvas(activeCanvasId, name);
      const next = await loadCanvasDocument(activeCanvasId);
      if (next) setDocument(next);
      await refreshWorkspaceList(activeWorkspaceId, activeCanvasId);
      setMessage(`Canvas renamed to ${renamed.name}.`);
    } catch (error) { setMessage(`Could not rename canvas: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const renameActiveWorkspace = async () => {
    const current = workspaces.find((item) => item.id === activeWorkspaceId);
    const name = window.prompt("Workspace name", current?.name ?? "My workspace");
    if (name === null) return;
    try { await renameWorkspace(activeWorkspaceId, name); await refreshWorkspaceList(); }
    catch (error) { setMessage(`Could not rename workspace: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const removeActiveCanvas = async () => {
    const target = canvases.find((item) => item.id === activeCanvasId);
    if (!target || !window.confirm(`Delete canvas “${target.name}”? Its saved editable drawing and history will be removed from this device.`)) return;
    try {
      await settleEditorBeforeSwitch();
      autosave.cancelPending(); bridgeAutosave.cancelPending();
      await deleteCanvas(target.id);
      activeDocumentIdRef.current = null;
      const next = await loadCurrentDocument();
      let updated = await listCanvases(activeWorkspaceId);
      if (!updated.length) { const fresh = await createCanvas(activeWorkspaceId, "Untitled drawing"); updated = [fresh]; await setActiveCanvas(fresh.id); }
      const active = updated.find((item) => item.documentId === next?.document.id) ?? updated[0];
      const activeDocument = next?.document.id === active.documentId ? next : await loadCanvasDocument(active.id);
      if (activeDocument) { await setActiveCanvas(active.id); setDocument(activeDocument); setEditorKey((key) => key + 1); }
      await refreshWorkspaceList(activeWorkspaceId, active.id);
      setStatus("saved"); setMessage("");
    } catch (error) { setMessage(`Could not delete canvas: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const removeActiveWorkspace = async () => {
    const workspace = workspaces.find((item) => item.id === activeWorkspaceId);
    if (!workspace || !window.confirm(`Delete workspace “${workspace.name}” and all ${canvases.length} saved canvas${canvases.length === 1 ? "" : "es"}? This permanently removes those editable drawings and their history from this device.`)) return;
    try {
      await settleEditorBeforeSwitch();
      autosave.cancelPending(); bridgeAutosave.cancelPending();
      await deleteWorkspace(workspace.id);
      activeDocumentIdRef.current = null;
      let remaining = await listWorkspaces();
      if (!remaining.length) remaining = [await createWorkspace("My workspace")];
      const nextWorkspace = remaining[0];
      let nextCanvases = await listCanvases(nextWorkspace.id);
      if (!nextCanvases.length) nextCanvases = [await createCanvas(nextWorkspace.id, "Untitled drawing")];
      const nextCanvas = nextCanvases[0];
      await setActiveCanvas(nextCanvas.id);
      const next = await loadCanvasDocument(nextCanvas.id);
      if (!next) throw new Error("The replacement canvas could not be loaded.");
      setDocument(next); setEditorKey((key) => key + 1);
      await refreshWorkspaceList(nextWorkspace.id, nextCanvas.id);
      setStatus("saved"); setMessage("");
    } catch (error) { setMessage(`Could not delete workspace: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const saveFile = () => {
    if (!doc) return;
    download(new Blob([serializeDrawFile(doc)], { type: "application/vnd.draw+json;charset=utf-8" }), filename(doc.document.title, "draw"));
    setMessage("Editable Draw file saved.");
  };

  const searchImages = async (event?: FormEvent, page = 1, append = false) => {
    event?.preventDefault();
    setImageSearchBusy(true);
    setImageSearchError("");
    try {
      const results = await searchOpenverseImages(imageQuery, { page, ...(imageCategory !== "all" ? { category: imageCategory } : {}), ...(imageLicense ? { license: imageLicense } : {}) });
      setImageResults((current) => append ? [...current, ...results] : results);
      setImagePage(page);
    } catch (error) {
      setImageSearchError(error instanceof Error ? error.message : "Could not search Openverse.");
    } finally { setImageSearchBusy(false); }
  };

  const addEmbeddedImage = async (image: { dataURL: string; mimeType: "image/png" | "image/jpeg"; width: number; height: number; attribution: OpenverseAttribution }, position?: { x: number; y: number }, requestedSize?: { width?: number; height?: number }) => {
    const api = apiRef.current;
    if (!api || !canWrite) throw new Error("The canvas is read-only in this tab.");
    const id = randomId();
    const scale = Math.min(1, 500 / Math.max(image.width, image.height));
    const defaultWidth = Math.max(24, Math.round(image.width * scale));
    const defaultHeight = Math.max(24, Math.round(image.height * scale));
    const width = requestedSize?.width ?? (requestedSize?.height ? Math.max(24, Math.round(requestedSize.height * image.width / image.height)) : defaultWidth);
    const height = requestedSize?.height ?? (requestedSize?.width ? Math.max(24, Math.round(requestedSize.width * image.height / image.width)) : defaultHeight);
    api.addFiles([{ id, dataURL: image.dataURL, mimeType: image.mimeType, created: Date.now(), lastRetrieved: Date.now(), attribution: image.attribution } as any]);
    const skeleton = {
      type: "image", id: randomId(), fileId: id,
      x: position?.x ?? 100, y: position?.y ?? 100, width, height,
      customData: { drawAttribution: image.attribution },
    };
    const [element] = convertToExcalidrawElements([skeleton] as any[], { regenerateIds: false }) as any[];
    if (!element) throw new Error("Could not create the image element.");
    return element;
  };

  const insertOpenverseImage = async (result: OpenverseImageResult) => {
    setImageInsertBusy(result.id);
    setImageSearchError("");
    try {
      const image = await fetchOpenverseImage(result.id, imageAttributionFromOpenverseResult(result));
      const element = await addEmbeddedImage(image);
      const api = apiRef.current;
      if (!api) throw new Error("The Draw canvas is not ready.");
      api.updateScene({ elements: [...api.getSceneElements(), element], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      setImagePickerOpen(false);
      setMessage(`Added “${result.title}” with Openverse attribution saved in the drawing.`);
    } catch (error) {
      setImageSearchError(error instanceof Error ? error.message : "Could not add this image.");
    } finally { setImageInsertBusy(null); }
  };

  const imageCredits = useMemo(() => {
    const elements = doc?.document.elements ?? [];
    const assets = doc?.document.assets ?? {};
    const elementCredits = elements.flatMap((element: any) => {
      const attribution = element.customData?.drawAttribution;
      return element.type === "image" && attribution?.provider === "Openverse" ? [{ id: element.id, attribution: attribution as OpenverseAttribution }] : [];
    });
    return elementCredits.length ? elementCredits : Object.values(assets).flatMap((asset: any) => asset.attribution?.provider === "Openverse" ? [{ id: asset.id, attribution: asset.attribution as OpenverseAttribution }] : []);
  }, [doc]);

  const exportImage = async (mime: "image/png" | "image/jpeg") => {
    if (!apiRef.current || !doc) return;
    try {
      const allElements = apiRef.current.getSceneElements();
      const appState = apiRef.current.getAppState();
      const selectedElementIds = exportScope === "selection"
        ? appState.selectedElementIds as Record<string, boolean> | undefined
        : undefined;
      if (exportScope === "selection" && !hasSelectedExportElements(allElements, selectedElementIds)) {
        setMessage("Select one or more objects to export a selection.");
        return;
      }
      const elements = selectExportElements(allElements, selectedElementIds);
      const files = apiRef.current.getFiles();
      const svg = await exportToSvg({ elements, appState: { ...appState, exportBackground: false }, files, exportPadding: 32 });
      const composed = composeBackgroundSvg(new XMLSerializer().serializeToString(svg), doc.document.canvas.background.preset);
      const blob = await renderExportBlob(composed, mime);
      download(blob, filename(doc.document.title, mime === "image/png" ? "png" : "jpg"));
      setMessage(`Exported flattened ${mime === "image/png" ? "PNG" : "JPEG"} image.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Image export failed."); }
  };

  const selectBackground = useCallback((preset: DrawBackgroundPreset) => {
    if (!writerOwned.current) return;
    const current = docRef.current;
    if (!current) return;
    const color = DEFAULT_COLOR[preset];
    const viewBackgroundColor = preset === "blackboard" ? "transparent" : color;
    const elements = recolorForBackgroundPreset(
      current.document.elements,
      current.document.canvas.background.preset,
      preset,
    );
    const next: DrawDocument = {
      ...current,
      document: {
        ...current.document,
        documentRevision: current.document.documentRevision + (preset === current.document.canvas.background.preset ? 0 : 1),
        elements,
        canvas: { ...current.document.canvas, background: { preset, styleVersion: 1, color, ...(preset === "blackboard" ? { texture: "chalk-smudge-v1" } : {}) } },
        appState: { ...current.document.appState, viewBackgroundColor, currentItemStrokeColor: preset === "blackboard" ? "#f6f2e9" : "#1e1e1e" },
      },
    };
    setDocument(next);
    apiRef.current?.updateScene({
      elements: elements as any,
      appState: { viewBackgroundColor, currentItemStrokeColor: preset === "blackboard" ? "#f6f2e9" : "#1e1e1e" },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    if (autosaveBlocked) {
      setStatus("error");
      setMessage("Local autosave is unavailable. Save a portable .draw file to keep this change.");
      return;
    }
    setStatus("saving");
    autosave.schedule(next);
    bridgeAutosave.schedule(next);
  }, [autosaveBlocked, autosave, bridgeAutosave, setDocument]);

  const renderCanvasToolbar = useCallback(() => {
    const selected = docRef.current?.document.canvas.background.preset ?? "blackboard";
    return <div className="draw-canvas-picker" role="group" aria-label="Canvas">
      <span className="draw-canvas-label">Canvas:</span>
      <button className={`draw-canvas-option ${selected === "blackboard" ? "active" : ""}`} disabled={!canWrite} aria-label="Blackboard" aria-pressed={selected === "blackboard"} onClick={() => selectBackground("blackboard")}>Blackboard</button>
      <button className={`draw-canvas-option ${selected === "white" ? "active" : ""}`} disabled={!canWrite} aria-label="Whiteboard" aria-pressed={selected === "white"} onClick={() => selectBackground("white")}>Whiteboard</button>
      <select className="draw-canvas-mobile" aria-label="Canvas background" disabled={!canWrite} value={selected} onChange={(event) => selectBackground(event.target.value as DrawBackgroundPreset)}>
        <option value="blackboard">Blackboard</option>
        <option value="white">Whiteboard</option>
      </select>
    </div>;
  }, [canWrite, selectBackground]);

  const handleMcpCommand = useCallback(async (event: BridgeCommand) => {
    if (completedMcpCommandIds.current.has(event.id)) return;
    if (revokedMcpCommandIds.current.has(event.id)) {
      revokedMcpCommandIds.current.delete(event.id);
      completedMcpCommandIds.current.add(event.id);
      while (completedMcpCommandIds.current.size > 256) completedMcpCommandIds.current.delete(completedMcpCommandIds.current.values().next().value!);
      return;
    }
    const api = apiRef.current;
    let current = docRef.current;
    if (!api || !current || !editorSecret.current || event.clientId !== clientId.current) return;
    const durableMutation = ["create_diagram", "create_elements", "insert_image", "update_elements", "delete_elements", "duplicate_elements", "group_elements", "ungroup_elements", "arrange_elements", "set_canvas_settings", "set_viewport", "undo_operation", "redo_operation"].includes(event.operation);
    let operationHash: string | null = null;
    try {
      if (durableMutation) {
        await Promise.all([autosave.flush(), bridgeAutosave.flush()]);
        current = docRef.current;
        if (!current) throw new Error("The active Draw document changed before the MCP operation could commit.");
        if (typeof event.input.idempotencyKey !== "string" || !event.input.idempotencyKey) throw new Error("A stable idempotencyKey is required for this mutation; reuse it only when retrying the same request.");
        operationHash = await hashMcpOperation(event.operation, event.input);
        const existing = await loadMcpOperation(current.document.id, event.clientIdentity, event.input.idempotencyKey);
        const replay = resolveOperationReplay(existing, {
          clientIdentity: event.clientIdentity,
          idempotencyKey: event.input.idempotencyKey,
          payloadHash: operationHash,
          now: Date.now(),
        });
        if (replay.kind === "conflict") throw new Error("IDEMPOTENCY_KEY_REUSE: This key was already used with a different operation payload.");
        if (replay.kind === "unknown") throw new Error("OUTCOME_UNKNOWN: This operation result expired. Read the current canvas and reconcile before creating a new request.");
        if (replay.kind === "replay") {
          const acknowledgement = await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
            method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current },
            body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, document: current, result: replay.result }),
          });
          if (!acknowledgement.ok) throw new Error(`Draw MCP bridge rejected the replay acknowledgement (HTTP ${acknowledgement.status}).`);
          return;
        }
        if (event.operation === "set_viewport" && event.input.expectedViewRevision !== current.document.viewRevision) {
          throw new Error(`CONFLICT: Current view revision is ${current.document.viewRevision}, expected ${event.input.expectedViewRevision}.`);
        }
      }
    } catch (error) {
      await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
        method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current },
        body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, error: error instanceof Error ? error.message : String(error) }),
      }).catch(() => undefined);
      return;
    }
    const commandStartElements = structuredClone([...api.getSceneElementsIncludingDeleted()]) as any[];
    const commandStartAppState = api.getAppState() as any;
    const commandStartSelection = structuredClone(commandStartAppState.selectedElementIds ?? {});
    let commandAppState: Record<string, unknown> = { selectedElementIds: commandStartSelection };
    let filesToRestore: any[] | null = null;
    let committedOperationId: string | null = null;
    const restoreCommandStartViewport = () => {
      api.updateScene({
        appState: {
          scrollX: commandStartAppState.scrollX,
          scrollY: commandStartAppState.scrollY,
          zoom: commandStartAppState.zoom,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    const restoreRevokedCommand = async (commandResult: DrawDocument | null) => {
      const liveState = api.getAppState() as any;
      const liveViewport = {
        x: typeof liveState.scrollX === "number" ? liveState.scrollX : current.document.canvas.viewport.x,
        y: typeof liveState.scrollY === "number" ? liveState.scrollY : current.document.canvas.viewport.y,
        zoom: typeof liveState.zoom?.value === "number" ? liveState.zoom.value : current.document.canvas.viewport.zoom,
      };
      const liveSelection = (liveState.selectedElementIds ?? {}) as Record<string, boolean>;
      const guardAllowsRestore = Boolean(commandResult && canRestoreCancelledMcpCommand(current, commandResult, docRef.current, liveViewport, liveSelection));
      if (!guardAllowsRestore || !commandResult || !committedOperationId) return false;
      const restoredStorage = await restoreMcpCommandSnapshot(current, commandResult, {
        clientIdentity: event.clientIdentity,
        idempotencyKey: event.input.idempotencyKey,
        operationId: committedOperationId,
      }, { preserveHistory: event.operation === "set_viewport" });
      if (!restoredStorage) return false;
      // Update the mounted scene in place. Remounting Excalidraw resets its
      // history and selection; CaptureUpdateAction.NEVER keeps rollback out
      // of the user's undo stack. The MCP edit's own history entry can make
      // the first Undo a no-op after rollback, but older human history remains.
      api.updateScene({
        elements: commandStartElements,
        appState: {
          selectedElementIds: commandStartSelection,
          scrollX: commandStartAppState.scrollX,
          scrollY: commandStartAppState.scrollY,
          zoom: commandStartAppState.zoom,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setDocument(current);
      lastMcpOperation.current = null;
      lastUndoneOperation.current = null;
      autosave.schedule(current);
      bridgeAutosave.schedule(current);
      await Promise.all([autosave.flush(), bridgeAutosave.flush()]).catch(() => undefined);
      await syncBridgeDocument(current).catch(() => undefined);
      setMessage("The revoked MCP command was rolled back; your selection and undo history were preserved.");
      return true;
    };
    let applied: { document: DrawDocument; result: Record<string, unknown> } | null = null;
    let commandResult: DrawDocument | null = null;
    let editorLockedForCommit = false;
    const unlockEditorAfterCommit = async () => {
      if (!editorLockedForCommit) return;
      api.updateScene({ appState: { viewModeEnabled: false }, captureUpdate: CaptureUpdateAction.NEVER });
      editorLockedForCommit = false;
      if (Object.values(commandStartSelection).some(Boolean)) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const activeSelection = (api.getAppState() as any).selectedElementIds ?? {};
        if (!Object.values(activeSelection).some(Boolean)) {
          api.updateScene({ appState: { selectedElementIds: commandStartSelection }, captureUpdate: CaptureUpdateAction.NEVER });
        }
      }
    };
    try {
      if (!writerOwned.current) throw new Error("This Draw tab is read-only because another tab owns the autosave lock.");
      if (autosaveBlocked) throw new Error("Local autosave is unavailable; open a saved .draw file before using MCP edits.");
      let elements = [...api.getSceneElementsIncludingDeleted()] as any[];
      const liveState = api.getAppState() as any;
      const liveBackground = liveState.viewBackgroundColor === "transparent" ? "blackboard" : liveState.viewBackgroundColor === DEFAULT_COLOR.white ? "white" : current.document.canvas.background.preset;
      if (hasSceneContentChanged(current, elements, api.getFiles(), liveBackground)) {
        lastMcpOperation.current = null;
        lastUndoneOperation.current = null;
        throw new Error("CONFLICT: The live editor has unsynchronized changes. Read the current canvas and retry with its latest revision.");
      }
      if (typeof event.input.expectedDocumentRevision === "number" && event.input.expectedDocumentRevision !== current.document.documentRevision) {
        throw new Error("CONFLICT: The expected document revision is stale. Read the current canvas and retry.");
      }
      let result: Record<string, unknown>;
      let nextDocument: DrawDocument | null = null;
      let captureUpdate: any = CaptureUpdateAction.IMMEDIATELY;
      if (event.operation === "set_selection") {
        lastMcpOperation.current = null;
        lastUndoneOperation.current = null;
        const selected = Object.fromEntries(event.input.ids.map((id: string) => [id, true]));
        api.updateScene({ appState: { selectedElementIds: selected }, captureUpdate: CaptureUpdateAction.NEVER });
        result = { selectedElementIds: event.input.ids };
        await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
          method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current },
          body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, document: current, result }),
        });
        return;
      }
      if (event.operation === "create_diagram") {
        const built = buildDiagramSkeletons(event.input, current.document.canvas.background.preset, randomId);
        // Keep the IDs minted by Draw so the MCP result can reliably map the
        // caller's node and edge IDs back to editable scene elements.
        const created = await materializeMcpElements(built.skeletons);
        const labelIds = new Map<string, string>();
        for (const element of created as any[]) {
          if (element.type === "text" && element.containerId) labelIds.set(element.containerId, element.id);
        }
        const routedCreated = routeBoundArrows(created as any[]);
        const nodes = Object.fromEntries(Object.entries(built.nodeElementIds).map(([inputId, elementId]) => [inputId, elementId]));
        const nodeLabels = Object.fromEntries(Object.entries(built.nodeElementIds).flatMap(([inputId, elementId]) => {
          const labelId = labelIds.get(elementId);
          return labelId ? [[inputId, labelId]] : [];
        }));
        const edges = built.edgeElementIds.map((elementId, index) => ({
          elementId,
          ...(labelIds.has(elementId) ? { labelElementId: labelIds.get(elementId) } : {}),
          inputIndex: index,
        }));
        const titleElement = event.input.title && (created as any[]).find((element) => element.type === "text" && !element.containerId && element.text === event.input.title);
        elements = [...elements, ...routedCreated as any[]];
        result = {
          addedElementIds: created.map((element: any) => element.id),
          nodes, nodeLabels, edges,
          ...(titleElement ? { titleElementId: titleElement.id } : {}),
        };
      } else if (event.operation === "create_elements") {
        const built = buildPrimitiveSkeletons(event.input, current.document.canvas.background.preset, randomId);
        const created = routeBoundArrows(await materializeMcpElements(built.skeletons) as any[]);
        const labelElementIds = Object.fromEntries(Object.entries(built.elementIds).flatMap(([inputId, elementId]) => {
          const label = created.find((element: any) => element.type === "text" && element.containerId === elementId);
          return label ? [[inputId, label.id]] : [];
        }));
        const relationships = Object.entries(built.elementIds).map(([inputId, elementId]) => {
          const element = created.find((candidate: any) => candidate.id === elementId) as any;
          return {
            id: inputId,
            elementId,
            ...(labelElementIds[inputId] ? { labelElementId: labelElementIds[inputId] } : {}),
            ...(element?.startBinding?.elementId ? { startElementId: element.startBinding.elementId } : {}),
            ...(element?.endBinding?.elementId ? { endElementId: element.endBinding.elementId } : {}),
          };
        });
        elements = [...elements, ...created];
        result = {
          addedElementIds: created.map((element: any) => element.id),
          elementIds: built.elementIds,
          labelElementIds,
          elements: relationships,
        };
      } else if (event.operation === "insert_image") {
        const input = event.input as { dataURL: string; mimeType: "image/png" | "image/jpeg"; attribution: OpenverseAttribution; x: number; y: number; width?: number; height?: number };
        const encoded = input.dataURL.split(",", 2)[1];
        if (!encoded) throw new Error("Image data is malformed.");
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const validated = await validateEmbeddedImage(bytes, input.mimeType);
        const fileId = randomId();
        const file = { id: fileId, dataURL: validated.dataURL, mimeType: validated.mimeType, created: Date.now(), lastRetrieved: Date.now() };
        const scale = Math.min(1, 500 / Math.max(validated.width, validated.height));
        const defaultWidth = Math.max(24, Math.round(validated.width * scale));
        const defaultHeight = Math.max(24, Math.round(validated.height * scale));
        const width = input.width ?? (input.height ? Math.max(24, Math.round(input.height * validated.width / validated.height)) : defaultWidth);
        const height = input.height ?? (input.width ? Math.max(24, Math.round(input.width * validated.height / validated.width)) : defaultHeight);
        const [imageElement] = convertToExcalidrawElements([{
          id: randomId(), type: "image", fileId, x: input.x, y: input.y, width, height,
          customData: { drawAttribution: input.attribution },
        }] as any[], { regenerateIds: false }) as any[];
        if (!imageElement) throw new Error("Could not create the image element.");
        filesToRestore = [file];
        elements = [...elements, imageElement];
        nextDocument = fromExcalidrawScene({ elements, appState: api.getAppState() as any, files: { ...api.getFiles(), [fileId]: file } }, {
          id: current.document.id, title: current.document.title,
          documentRevision: current.document.documentRevision + 1, viewRevision: current.document.viewRevision,
          background: current.document.canvas.background, viewport: current.document.canvas.viewport,
        });
        result = { addedElementIds: [imageElement.id], assetId: fileId, attribution: input.attribution };
      } else if (event.operation === "update_elements") {
        const update = applyElementUpdates(elements, event.input.updates, measureTextWithExcalidraw);
        elements = update.elements;
        result = { updatedElementIds: update.updatedIds };
      } else if (["delete_elements", "duplicate_elements", "group_elements", "ungroup_elements", "arrange_elements"].includes(event.operation)) {
        const action = event.operation === "delete_elements" ? "delete"
          : event.operation === "duplicate_elements" ? "duplicate"
            : event.operation === "group_elements" ? "group"
              : event.operation === "ungroup_elements" ? "ungroup"
                : event.input.action;
        const changed = applySceneEdit(elements, { action, ids: event.input.ids, offsetX: event.input.offsetX, offsetY: event.input.offsetY, alignment: event.input.alignment, axis: event.input.axis }, randomId);
        elements = changed.elements;
        result = { affectedElementIds: changed.affectedIds, addedElementIds: changed.createdIds, failures: changed.failed };
      } else if (event.operation === "set_canvas_settings") {
        lastMcpOperation.current = null;
        lastUndoneOperation.current = null;
        captureUpdate = CaptureUpdateAction.NEVER;
        const preset = event.input.background ?? current.document.canvas.background.preset;
        elements = event.input.background
          ? recolorForBackgroundPreset(elements as any, current.document.canvas.background.preset, preset) as any[]
          : elements;
        const color = DEFAULT_COLOR[preset as DrawBackgroundPreset];
        const background = preset === "blackboard"
          ? { preset: "blackboard" as const, styleVersion: 1, color, texture: "chalk-smudge-v1" }
          : { preset: "white" as const, styleVersion: 1, color };
        const appState = { ...(api.getAppState() as any), viewBackgroundColor: preset === "blackboard" ? "transparent" : color, currentItemStrokeColor: preset === "blackboard" ? "#f6f2e9" : "#1e1e1e" };
        nextDocument = fromExcalidrawScene({ elements, appState, files: api.getFiles() }, {
          id: current.document.id,
          title: event.input.title ?? current.document.title,
          documentRevision: current.document.documentRevision + 1,
          viewRevision: current.document.viewRevision,
          background,
          viewport: current.document.canvas.viewport,
        });
        result = { title: nextDocument.document.title, background: nextDocument.document.canvas.background.preset };
      } else if (event.operation === "set_viewport") {
        api.updateScene({ appState: { viewModeEnabled: true }, captureUpdate: CaptureUpdateAction.NEVER });
        editorLockedForCommit = true;
        if (event.input.action === "fit_content") {
          const visible = api.getSceneElements();
          if (!visible.length) throw new Error("Cannot fit the viewport because the canvas has no elements.");
          api.scrollToContent(visible as any, { fitToViewport: true, animate: false });
          await new Promise((resolve) => setTimeout(resolve, 40));
        } else {
          api.updateScene({ appState: { scrollX: event.input.x, scrollY: event.input.y, zoom: { value: event.input.zoom } }, captureUpdate: CaptureUpdateAction.NEVER });
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        const state = api.getAppState() as any;
        const viewport = {
          x: typeof state.scrollX === "number" ? state.scrollX : current.document.canvas.viewport.x,
          y: typeof state.scrollY === "number" ? state.scrollY : current.document.canvas.viewport.y,
          zoom: typeof state.zoom?.value === "number" ? state.zoom.value : current.document.canvas.viewport.zoom,
        };
        nextDocument = { ...current, document: { ...current.document, canvas: { ...current.document.canvas, viewport }, viewRevision: current.document.viewRevision + (JSON.stringify(viewport) === JSON.stringify(current.document.canvas.viewport) ? 0 : 1) } };
        result = { viewport: nextDocument.document.canvas.viewport };
        captureUpdate = CaptureUpdateAction.NEVER;
      } else if (event.operation === "undo_operation" || event.operation === "redo_operation") {
        if (event.operation === "redo_operation") {
          const redoState = await loadLatestMcpRedoOperation(current.document.id);
          if (!redoState || redoState.operation.operationId !== event.input.operationId || !canRedoMcpOperation(redoState, event.clientIdentity, { id: current.document.id, documentRevision: current.document.documentRevision })) {
            throw new Error("CONFLICT: This MCP identity cannot redo that operation after a later scene change or another actor's operation.");
          }
          const afterScene = toExcalidrawScene(redoState.operation.afterDocument);
          const liveAppState = api.getAppState() as any;
          elements = afterScene.elements as any[];
          filesToRestore = Object.values(afterScene.files);
          commandAppState = {
            ...afterScene.appState,
            selectedElementIds: commandStartSelection,
            scrollX: liveAppState.scrollX,
            scrollY: liveAppState.scrollY,
            zoom: liveAppState.zoom,
          };
          nextDocument = fromExcalidrawScene({ elements, appState: commandAppState, files: afterScene.files }, {
            id: current.document.id,
            title: redoState.operation.afterDocument.document.title,
            documentRevision: current.document.documentRevision + 1,
            viewRevision: current.document.viewRevision,
            background: redoState.operation.afterDocument.document.canvas.background,
            viewport: current.document.canvas.viewport,
          });
          result = { operationId: redoState.operation.operationId, redone: true, documentRevision: nextDocument.document.documentRevision };
          lastMcpOperation.current = { id: redoState.operation.operationId, revision: nextDocument.document.documentRevision };
          lastUndoneOperation.current = null;
        } else {
        const target = await loadLatestMcpUndoOperation(current.document.id);
        if (!target || target.operationId !== event.input.operationId || !canUndoMcpOperation(target, event.clientIdentity, { id: current.document.id, documentRevision: current.document.documentRevision })) {
          throw new Error("CONFLICT: This MCP identity cannot undo that operation because it is no longer the latest eligible change.");
        }
        const beforeScene = toExcalidrawScene(target.beforeDocument);
        const liveAppState = api.getAppState() as any;
        elements = beforeScene.elements as any[];
        filesToRestore = Object.values(beforeScene.files);
        commandAppState = {
          ...beforeScene.appState,
          selectedElementIds: commandStartSelection,
          scrollX: liveAppState.scrollX,
          scrollY: liveAppState.scrollY,
          zoom: liveAppState.zoom,
        };
        nextDocument = fromExcalidrawScene({ elements, appState: commandAppState, files: beforeScene.files }, {
          id: current.document.id,
          title: current.document.title,
          documentRevision: current.document.documentRevision + 1,
          viewRevision: current.document.viewRevision,
          background: current.document.canvas.background,
          viewport: current.document.canvas.viewport,
        });
        result = { operationId: target.operationId, undone: true, documentRevision: nextDocument.document.documentRevision };
        lastUndoneOperation.current = { id: target.operationId, revision: nextDocument.document.documentRevision };
        lastMcpOperation.current = null;
        }
      } else if (event.operation === "open_document") {
        if (!event.document) throw new Error("Open document command is missing its validated Draw file.");
        const opened = await loadDocument(event.document);
        if (!opened) throw new Error("The Draw document could not be opened into the active canvas.");
        result = { opened: true, documentId: opened.document.id, title: opened.document.title, documentRevision: opened.document.documentRevision };
        nextDocument = opened;
      } else if (event.operation === "export_image") {
        const allElements = api.getSceneElements();
        const state = api.getAppState() as any;
        const selected = event.input.scope === "selection" ? state.selectedElementIds as Record<string, boolean> | undefined : undefined;
        if (event.input.scope === "selection" && !hasSelectedExportElements(allElements, selected)) throw new Error("Select one or more elements before exporting a selection.");
        const exportElements = selectExportElements(allElements, selected);
        const svg = await exportToSvg({ elements: exportElements, appState: { ...state, exportBackground: false }, files: api.getFiles(), exportPadding: 32 });
        const serialized = new XMLSerializer().serializeToString(svg);
        const requestedBackground = event.input.background ?? current.document.canvas.background.preset;
        const composed = requestedBackground === "transparent" ? serialized : composeBackgroundSvg(serialized, requestedBackground);
        const blob = await renderExportBlob(composed, event.input.format === "png" ? "image/png" : "image/jpeg");
        if (blob.size > 20 * 1024 * 1024) throw new Error("Image export exceeds the 20 MiB artifact limit.");
        const imageData = await blobToBase64(blob);
        result = { imageData, format: event.input.format, scope: event.input.scope, documentRevision: current.document.documentRevision };
        nextDocument = current;
        captureUpdate = CaptureUpdateAction.NEVER;
      } else {
        throw new Error(`Unsupported Draw MCP operation “${event.operation}”.`);
      }
      const mutationWithoutDocument = event.operation === "export_image";
      if (!nextDocument && !mutationWithoutDocument) {
        const sceneMutation = event.operation !== "set_viewport";
        const viewMutation = event.operation === "set_viewport";
        nextDocument = fromExcalidrawScene({ elements, appState: api.getAppState() as any, files: api.getFiles() }, {
          id: current.document.id,
          title: current.document.title,
          documentRevision: current.document.documentRevision + (sceneMutation ? 1 : 0),
          viewRevision: current.document.viewRevision + (viewMutation && JSON.stringify(current.document.canvas.viewport) !== JSON.stringify({ x: (api.getAppState() as any).scrollX, y: (api.getAppState() as any).scrollY, zoom: (api.getAppState() as any).zoom?.value }) ? 1 : 0),
          background: current.document.canvas.background,
          viewport: current.document.canvas.viewport,
        });
      }
      if (!nextDocument) nextDocument = current;
      commandResult = nextDocument;
      if (revokedMcpCommandIds.current.has(event.id)) {
        if (event.operation === "set_viewport") restoreCommandStartViewport();
        if (!await restoreRevokedCommand(commandResult)) setMessage("MCP client revoked after a newer canvas edit; that edit was preserved.");
        return;
      }
      const isTransient = event.operation === "export_image";
      const durableOperationId = durableMutation ? randomId() : event.id;
      result = {
        ...result,
        ...(event.operation === "undo_operation" ? {} : { operationId: durableOperationId }),
        documentRevision: nextDocument.document.documentRevision,
        viewRevision: nextDocument.document.viewRevision,
      };
      const undoEligible = ["create_diagram", "create_elements", "insert_image", "update_elements", "delete_elements", "duplicate_elements", "group_elements", "ungroup_elements", "arrange_elements", "redo_operation"].includes(event.operation);
      let persistenceWarning: string | undefined;
      if (durableMutation) {
        const record: DurableMcpOperation = {
          documentId: nextDocument.document.id,
          clientIdentity: event.clientIdentity,
          idempotencyKey: event.input.idempotencyKey,
          payloadHash: operationHash!,
          operationId: durableOperationId,
          actor: event.clientIdentity,
          baseRevision: current.document.documentRevision,
          resultingRevision: nextDocument.document.documentRevision,
          baseViewRevision: current.document.viewRevision,
          resultingViewRevision: nextDocument.document.viewRevision,
          result: { ...result, persisted: true },
          beforeDocument: current,
          afterDocument: nextDocument,
          undoEligible,
          completedAt: Date.now(),
        };
        // Temporarily make the mounted editor read-only while the atomic local
        // commit is pending, so a human edit cannot race the revision snapshot.
        api.updateScene({ appState: { viewModeEnabled: true }, captureUpdate: CaptureUpdateAction.NEVER });
        editorLockedForCommit = true;
        await commitMcpOperation(nextDocument, record, event.operation === "undo_operation"
          ? { undoTarget: { operationId: event.input.operationId, clientIdentity: event.clientIdentity } }
          : event.operation === "redo_operation"
            ? { redoTarget: { operationId: event.input.operationId, clientIdentity: event.clientIdentity } }
            : { invalidateUndo: !undoEligible && event.operation !== "set_viewport" });
        committedOperationId = durableOperationId;
        if (undoEligible) lastMcpOperation.current = { id: durableOperationId, revision: nextDocument.document.documentRevision };
        else if (event.operation === "set_canvas_settings" || event.operation === "undo_operation") lastMcpOperation.current = null;
        if (event.operation !== "undo_operation") lastUndoneOperation.current = null;
      }
      setDocument(nextDocument);
      if (event.operation !== "open_document") {
        if (filesToRestore) api.addFiles(filesToRestore as any);
        api.updateScene({
          elements,
          appState: {
            ...commandAppState,
            viewModeEnabled: false,
          selectedElementIds: commandStartSelection,
            ...(event.operation === "set_canvas_settings" ? {
              viewBackgroundColor: nextDocument.document.appState.viewBackgroundColor,
              currentItemStrokeColor: nextDocument.document.appState.currentItemStrokeColor,
            } : {}),
          } as any,
          captureUpdate,
        });
      }
      if (!durableMutation) {
        applied = { document: nextDocument, result };
        persistenceWarning = await persistAppliedDocument(nextDocument, saveCurrentDocument, syncBridgeDocument);
      } else applied = { document: nextDocument, result };
      // The IndexedDB transaction is the durable commit point. Once that
      // scene is installed, let the human keep editing while bridge sync and
      // acknowledgement are in flight; revocation rollback uses semantic
      // scene and selection guards to preserve any newer human state.
      if (editorLockedForCommit) {
        await unlockEditorAfterCommit();
      }
      if (durableMutation) {
        try {
          await syncBridgeDocument(nextDocument);
        } catch (error) {
          persistenceWarning = `MCP bridge sync failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (revokedMcpCommandIds.current.has(event.id)) {
        await unlockEditorAfterCommit();
        if (!await restoreRevokedCommand(commandResult)) setMessage("MCP client revoked after a newer canvas edit; that edit was preserved.");
        return;
      }
      editorLockedForCommit = false;
      if (persistenceWarning) {
        setStatus("error");
        setMessage(persistenceWarning);
      } else setStatus("saved");
      const acknowledgement = await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
        method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
        body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, document: nextDocument, result: { ...result, persisted: durableMutation || !persistenceWarning }, ...(persistenceWarning ? { warning: persistenceWarning } : {}) }),
      });
      const acknowledgementBody = await acknowledgement.json().catch(() => ({})) as { revoked?: boolean };
      if (revokedMcpCommandIds.current.has(event.id) || acknowledgement.status === 410 && acknowledgementBody.revoked === true) {
        revokedMcpCommandIds.current.add(event.id);
        const restored = await restoreRevokedCommand(commandResult);
        if (!restored) setMessage("MCP client revoked after a newer canvas edit; that edit was preserved.");
        return;
      }
      if (!acknowledgement.ok) throw new Error(`Draw MCP bridge rejected the command acknowledgement (HTTP ${acknowledgement.status}).`);
    } catch (error) {
      await unlockEditorAfterCommit();
      if (event.operation === "set_viewport" && !committedOperationId) restoreCommandStartViewport();
      if (revokedMcpCommandIds.current.has(event.id)) {
        if (!await restoreRevokedCommand(commandResult)) setMessage("MCP client revoked after a newer canvas edit; that edit was preserved.");
        return;
      }
      if (error instanceof Error && error.message.startsWith("IDEMPOTENCY_REPLAY:") && durableMutation) {
        const [savedOperation, savedDocument] = await Promise.all([
          loadMcpOperation(current.document.id, event.clientIdentity, event.input.idempotencyKey),
          loadCurrentDocument(),
        ]);
        if (savedOperation && !("tombstone" in savedOperation) && savedDocument) {
          const acknowledgement = await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
            method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
            body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, document: savedDocument, result: savedOperation.result }),
          });
          if (acknowledgement.ok) return;
        }
      }
      if (applied) {
        const warning = `The edit was applied but the MCP acknowledgement failed: ${error instanceof Error ? error.message : String(error)}. Call get_current_canvas before retrying.`;
        setStatus("error");
        setMessage(warning);
        await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
          method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
          body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, document: applied.document, result: applied.result, warning }),
        }).catch(() => undefined);
        return;
      }
      await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
        method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
        body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, error: error instanceof Error ? error.message : String(error) }),
      }).catch(() => undefined);
    } finally {
      revokedMcpCommandIds.current.delete(event.id);
      completedMcpCommandIds.current.add(event.id);
      while (completedMcpCommandIds.current.size > 256) completedMcpCommandIds.current.delete(completedMcpCommandIds.current.values().next().value!);
    }
  }, [autosave, autosaveBlocked, bridgeAutosave, setDocument]);

  const handleBridgeFlush = useCallback(async (event: BridgeFlush) => {
    const api = apiRef.current;
    const current = docRef.current;
    if (!api || !current || !editorSecret.current || event.clientId !== clientId.current || !writerOwned.current) return;
    try {
      const state = api.getAppState() as any;
      const elements = api.getSceneElementsIncludingDeleted() as any[];
      const files = api.getFiles();
      const viewport = {
        x: typeof state.scrollX === "number" ? state.scrollX : current.document.canvas.viewport.x,
        y: typeof state.scrollY === "number" ? state.scrollY : current.document.canvas.viewport.y,
        zoom: typeof state.zoom?.value === "number" ? state.zoom.value : current.document.canvas.viewport.zoom,
      };
      const candidate = fromExcalidrawScene({ elements, appState: state, files }, {
        id: current.document.id,
        title: current.document.title,
        documentRevision: current.document.documentRevision,
        viewRevision: current.document.viewRevision,
        background: current.document.canvas.background,
        viewport,
      });
      const sceneChanged = JSON.stringify(current.document.elements) !== JSON.stringify(candidate.document.elements)
        || JSON.stringify(current.document.assets) !== JSON.stringify(candidate.document.assets);
      if (sceneChanged) {
        lastMcpOperation.current = null;
        lastUndoneOperation.current = null;
      }
      const viewChanged = JSON.stringify(current.document.canvas.viewport) !== JSON.stringify(viewport);
      const next = {
        ...candidate,
        document: {
          ...candidate.document,
          documentRevision: current.document.documentRevision + (sceneChanged ? 1 : 0),
          viewRevision: current.document.viewRevision + (viewChanged ? 1 : 0),
        },
      };
      setDocument(next);
      if (!autosaveBlocked) {
        autosave.schedule(next);
        bridgeAutosave.schedule(next);
        await Promise.all([autosave.flush(), bridgeAutosave.flush()]);
      } else await syncBridgeDocument(next);
      await fetch(`/__draw/api/document/flush/${encodeURIComponent(event.id)}`, {
        method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
        body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, document: next }),
      });
    } catch (error) {
      await fetch(`/__draw/api/document/flush/${encodeURIComponent(event.id)}`, {
        method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
        body: JSON.stringify({ id: event.id, clientId: clientId.current, clientIdentity: event.clientIdentity, error: error instanceof Error ? error.message : String(error) }),
      }).catch(() => undefined);
    }
  }, [autosave, autosaveBlocked, bridgeAutosave, setDocument, syncBridgeDocument]);

  const handleBridgeConfirmation = useCallback((event: BridgeConfirmation) => {
    if (event.clientId !== clientId.current || !writerOwned.current || !editorSecret.current) return;
    setConfirmation(event);
  }, []);

  const handleMcpPairingRequest = useCallback((event: McpPairingRequest) => {
    if (event.clientId !== clientId.current || !writerOwned.current || !editorSecret.current) return;
    setMcpPairingRequest(event);
  }, []);

  const handleMcpClientRevoked = useCallback((event: McpClientRevokedEvent) => {
    setConfirmation((current) => current?.clientIdentity === event.clientIdentity ? null : current);
    setMessage("An MCP client was revoked. Its pending requests were canceled.");
  }, []);

  const handleMcpCommandRevoked = useCallback((event: McpCommandRevokedEvent) => {
    if (event.clientId !== clientId.current) return;
    if (completedMcpCommandIds.current.has(event.id)) return;
    revokedMcpCommandIds.current.add(event.id);
  }, []);

  const handleMcpConfirmationRevoked = useCallback((event: { token: string; clientId: string }) => {
    if (event.clientId === clientId.current) {
      setConfirmation((current) => current?.token === event.token ? null : current);
    }
  }, []);

  const respondToConfirmation = useCallback(async (approved: boolean) => {
    const pending = confirmation;
    if (!pending) return;
    try {
      const response = await fetch(`/__draw/api/confirmations/${encodeURIComponent(pending.token)}/respond`, {
        method: "POST", headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current ?? "" },
        body: JSON.stringify({ clientId: clientId.current, approved }),
      });
      if (!response.ok) throw new Error("This confirmation request expired or the active Draw tab changed.");
      setConfirmation(null);
      if (!approved) setMessage("Document open was denied. The active canvas was left unchanged.");
    } catch (error) {
      setConfirmation(null);
      setMessage(error instanceof Error ? error.message : "Could not answer the confirmation request.");
    }
  }, [confirmation]);

  useEffect(() => {
    const handlers: Record<string, (detail: any) => void> = {
      "draw:editor-lease-revoked": revokeEditorLease,
      "draw:mcp-command": handleMcpCommand,
      "draw:flush-document": handleBridgeFlush,
      "draw:confirmation-required": handleBridgeConfirmation,
      "draw:mcp-pairing-required": handleMcpPairingRequest,
      "draw:mcp-client-revoked": handleMcpClientRevoked,
      "draw:confirmation-revoked": handleMcpConfirmationRevoked,
      "draw:mcp-command-revoked": handleMcpCommandRevoked,
    };
    if (import.meta.hot) {
      const hot = import.meta.hot;
      for (const [event, handler] of Object.entries(handlers)) hot.on(event, handler);
      return () => { for (const [event, handler] of Object.entries(handlers)) import.meta.hot?.off(event, handler); };
    }
    if (!editorConnected || !editorSecret.current) return;
    let cancelled = false;
    let source: EventSource | null = null;
    const controller = new AbortController();
    void (async () => {
      try {
        const ticketResponse = await fetch("/__draw/api/events/ticket", {
          method: "POST",
          headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret.current! },
          body: "{}",
          signal: controller.signal,
          cache: "no-store",
        });
        const ticketResult = await ticketResponse.json().catch(() => ({}));
        if (!ticketResponse.ok || typeof ticketResult.ticket !== "string") throw new Error("Could not authenticate the Draw event stream.");
        if (cancelled) return;
        source = new EventSource(`/__draw/api/events?ticket=${encodeURIComponent(ticketResult.ticket)}`);
        for (const [event, handler] of Object.entries(handlers)) {
          source.addEventListener(event, ((message: MessageEvent<string>) => {
            try { handler(JSON.parse(message.data)); } catch { setMessage("Draw received an invalid MCP bridge event."); }
          }) as EventListener);
        }
        source.onerror = () => setMessage("The Draw MCP event stream disconnected. Reconnect this editor before using MCP.");
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not connect to the Draw MCP event stream.");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      source?.close();
    };
  }, [editorConnected, handleBridgeConfirmation, handleBridgeFlush, handleMcpCommand, handleMcpPairingRequest, handleMcpClientRevoked, handleMcpConfirmationRevoked, handleMcpCommandRevoked, revokeEditorLease]);

  const initialData = useMemo(() => {
    if (!doc) return undefined;
    const sceneData = toExcalidrawScene(doc);
    // Excalidraw treats collaborators as a runtime Map. Keep it out of the
    // portable JSON document, then restore the empty Map only at the editor edge.
    return {
      ...sceneData,
      appState: { ...sceneData.appState, collaborators: new Map() },
    } as unknown as ExcalidrawInitialDataState;
  }, [doc?.document.id, editorKey]);
  if (!doc || status === "loading") return <main className="loading-screen"><div className="brand-mark">D</div><p>Preparing your canvas…</p></main>;
  const background = doc.document.canvas.background.preset;
  const savedSelection = doc.document.appState.selectedElementIds as Record<string, boolean> | undefined;
  const selectionAvailable = hasSelectedExportElements(doc.document.elements, savedSelection);
  const statusText = !canWrite ? "Read-only in this tab" : status === "saving" ? "Saving locally…" : status === "saved" ? "Saved on this device" : status === "error" ? "Save issue" : "All changes saved";

  return <main className={`draw-app bg-${background}`}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">D</span><span className="brand-name">draw</span><span className="brand-divider"/><span className="doc-title"><input ref={titleInput} aria-label="Drawing title" disabled={!canWrite} value={doc.document.title} onChange={(event) => {
        const next = { ...doc, document: { ...doc.document, title: event.target.value, documentRevision: doc.document.documentRevision + 1 } };
        setDocument(next);
        setCanvases((current) => current.map((canvas) => canvas.id === activeCanvasId ? { ...canvas, name: event.target.value } : canvas));
        if (autosaveBlocked) { setStatus("error"); return; }
        setStatus("saving");
        autosave.schedule(next);
        bridgeAutosave.schedule(next);
      }} /></span></div>
      <div className="toolbar-actions">
        <span className={`save-indicator ${status}`}><i />{statusText}</span>
        <button className="button button-quiet" disabled={!canWrite} onClick={() => { setImageSearchError(""); setImagePickerOpen(true); }} title="Search openly licensed illustrations">Images</button>
        <button className="button button-quiet" disabled={!imageCredits.length} onClick={() => setCreditsOpen(true)} title="Inspect saved image attribution">Image credits</button>
        {import.meta.env.DEV && <button className="button button-quiet" disabled={!canWrite} onClick={() => { setConnectError(""); setConnectOpen(true); }} title="Pair this editor with the local MCP bridge">{editorConnected ? "MCP connected" : "Connect MCP"}</button>}
        {import.meta.env.DEV && <button className="button button-quiet" disabled={!canWrite} onClick={() => void openMcpManagement()} title="Pair or revoke local MCP clients">MCP clients</button>}
        <button className="button button-quiet" disabled={!canWrite} onClick={() => fileInput.current?.click()} title={canWrite ? "Open an editable Draw document" : "Close the other Draw tab to open files here"}>Open .draw</button>
        <input ref={fileInput} className="visually-hidden" type="file" accept=".draw,application/vnd.draw+json,application/json" onChange={(event) => void openFile(event.target.files?.[0])} />
        <button className="button button-primary" onClick={saveFile} title="Save the complete editable Draw file"><span className="button-icon">↓</span>Save .draw</button>
        <div className="export-group"><button className="button button-quiet export-main" disabled={exportScope === "selection" && !selectionAvailable} title={exportScope === "selection" && !selectionAvailable ? "Select one or more objects to export a selection" : undefined} onClick={() => void exportImage("image/png")}>Export</button><select aria-label="Export scope" value={exportScope} onChange={(event) => setExportScope(event.target.value as "canvas" | "selection")}><option value="canvas">Whole drawing</option><option value="selection">Selection only</option></select><select aria-label="Image export format" value="image/png" onChange={(event) => void exportImage(event.target.value as "image/png" | "image/jpeg")}><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option></select></div>
      </div>
    </header>
    <nav className="project-toolbar" aria-label="Workspace and canvas management">
      <label>Workspace <select aria-label="Workspace" value={activeWorkspaceId} disabled={!canWrite} onChange={(event) => void selectWorkspace(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
      <button className="button" disabled={!canWrite} onClick={() => void createNewWorkspace()}>New workspace</button>
      <button className="button" disabled={!canWrite} onClick={() => void renameActiveWorkspace()}>Rename workspace</button>
      <button className="button button-danger-quiet" disabled={!canWrite || workspaces.length < 1} onClick={() => void removeActiveWorkspace()}>Delete workspace</button>
      <span className="project-divider" />
      <label>Canvas <select aria-label="Canvas" value={activeCanvasId} disabled={!canWrite} onChange={(event) => void switchToCanvas(event.target.value)}>{canvases.map((canvas) => <option key={canvas.id} value={canvas.id}>{canvas.name}</option>)}</select></label>
      <button className="button" disabled={!canWrite} onClick={() => void createNewCanvas()}>New canvas</button>
      <button className="button" disabled={!canWrite || !activeCanvasId} onClick={() => void duplicateActiveCanvas()}>Duplicate canvas</button>
      <button className="button" disabled={!canWrite || !activeCanvasId} onClick={() => void renameActiveCanvas()}>Rename canvas</button>
      <button className="button button-danger-quiet" disabled={!canWrite || !activeCanvasId} onClick={() => void removeActiveCanvas()}>Delete canvas</button>
    </nav>
    {imagePickerOpen && <div className="draw-confirmation-backdrop" role="presentation">
      <section className="draw-image-picker" role="dialog" aria-modal="true" aria-labelledby="draw-image-picker-title">
        <div className="draw-dialog-heading"><div><h2 id="draw-image-picker-title">Find an illustration</h2><p>Search Openverse for openly licensed images. Check each item's source and license before reuse.</p></div><button className="button button-quiet" onClick={() => setImagePickerOpen(false)} aria-label="Close image search">×</button></div>
        <form className="draw-image-search" onSubmit={(event) => void searchImages(event)}>
          <label htmlFor="draw-image-query">Search images</label>
          <input id="draw-image-query" value={imageQuery} onChange={(event) => setImageQuery(event.target.value)} maxLength={200} placeholder="e.g. chalk robot illustration" />
          <label htmlFor="draw-image-license">License filter</label>
          <select id="draw-image-license" value={imageLicense} onChange={(event) => setImageLicense(event.target.value)}>
            <option value="">All supported licenses</option><option value="cc0">CC0</option><option value="pdm">Public domain</option><option value="by">CC BY</option><option value="by-sa">CC BY-SA</option><option value="by-nd">CC BY-ND</option><option value="by-nc">CC BY-NC</option><option value="by-nc-sa">CC BY-NC-SA</option><option value="by-nc-nd">CC BY-NC-ND</option>
          </select>
          <label htmlFor="draw-image-category">Image type</label>
          <select id="draw-image-category" value={imageCategory} onChange={(event) => setImageCategory(event.target.value as typeof imageCategory)}>
            <option value="illustration">Illustrations</option><option value="digitized_artwork">Digitized artwork</option><option value="photograph">Photographs</option><option value="all">All image types</option>
          </select>
          <button className="button button-primary" disabled={imageSearchBusy || !imageQuery.trim()} type="submit">{imageSearchBusy ? "Searching…" : "Search"}</button>
        </form>
        {imageSearchError && <p role="alert" className="draw-image-error">{imageSearchError}</p>}
        <div className="draw-image-results" aria-live="polite">
          {imageResults.map((result) => <article className="draw-image-card" key={result.id}>
            <img src={result.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
            <div className="draw-image-card-copy"><strong>{result.title}</strong>
              <span>{result.creator ?? "Creator not listed"}</span>
              <span>License: {result.license ? `${result.license.toUpperCase()}${result.licenseVersion ? ` ${result.licenseVersion}` : ""}` : "Not listed; verify before reuse"}</span>
              <div className="draw-image-links">{result.sourceUrl && <a href={result.sourceUrl} target="_blank" rel="noreferrer">Source</a>}{result.creatorUrl && <a href={result.creatorUrl} target="_blank" rel="noreferrer">Creator</a>}{result.licenseUrl && <a href={result.licenseUrl} target="_blank" rel="noreferrer">License</a>}</div>
              <button className="button button-quiet" disabled={imageInsertBusy !== null || !result.license} title={!result.license ? "This result has no license metadata and cannot be inserted by default." : "Embed this image and its attribution in the drawing"} onClick={() => void insertOpenverseImage(result)}>{imageInsertBusy === result.id ? "Adding…" : "Add to drawing"}</button>
            </div>
          </article>)}
          {!imageSearchBusy && imageQuery && !imageResults.length && !imageSearchError && <p>No matching images found. Try a broader search.</p>}
        </div>
        {imageResults.length >= 12 && imagePage < 20 && <button className="button button-quiet" disabled={imageSearchBusy} onClick={() => void searchImages(undefined, imagePage + 1, true)}>{imageSearchBusy ? "Loading…" : "Load more"}</button>}
        <p className="draw-image-disclaimer">Search provided by <a href="https://openverse.org/" target="_blank" rel="noreferrer">Openverse</a>; Draw is not endorsed or certified by Openverse. Images are embedded for offline editing. Openverse indexes third-party license claims; verify each item's rights and attribution requirements before reuse. See <a href="https://docs.openverse.org/terms_of_service/" target="_blank" rel="noreferrer">Openverse's terms</a>.</p>
      </section>
    </div>}
    {creditsOpen && <div className="draw-confirmation-backdrop" role="presentation">
      <section className="draw-confirmation" role="dialog" aria-modal="true" aria-labelledby="draw-image-credits-title">
        <h2 id="draw-image-credits-title">Image credits</h2>
        {!imageCredits.length && <p>No Openverse images are in this drawing.</p>}
        <div className="draw-image-credit-list">{imageCredits.map(({ id, attribution }) => <article key={id}>
          <strong>{attribution.title}</strong><span>{attribution.creator ?? "Creator not listed"}</span>
          <span>{attribution.license ? `${attribution.license.toUpperCase()}${attribution.licenseVersion ? ` ${attribution.licenseVersion}` : ""}` : "License not listed"}</span>
          <small>{attribution.verification === "unverified" ? "File supplied claim (unverified). Verify it with a trusted source." : "Openverse listing metadata; licensing claims are not independently verified."}</small>
          <div className="draw-image-links">{isSafeHttpsUrl(attribution.sourceUrl) && <a href={attribution.sourceUrl} target="_blank" rel="noreferrer">Source</a>}{isSafeHttpsUrl(attribution.creatorUrl) && <a href={attribution.creatorUrl} target="_blank" rel="noreferrer">Creator</a>}{isSafeHttpsUrl(attribution.licenseUrl) && <a href={attribution.licenseUrl} target="_blank" rel="noreferrer">License</a>}</div>
        </article>)}</div>
        {imageCredits.length > 0 && <button className="button button-quiet" onClick={() => {
          const report = imageCredits.map(({ attribution }) => `${attribution.title}\nAttribution status: ${attribution.verification === "unverified" ? "File supplied claim (unverified)" : "Openverse listing metadata; not independently verified"}\nCreator: ${attribution.creator ?? "Not listed"}${isSafeHttpsUrl(attribution.creatorUrl) ? ` (${attribution.creatorUrl})` : ""}\nSource: ${isSafeHttpsUrl(attribution.sourceUrl) ? attribution.sourceUrl : "Not listed"}\nLicense: ${attribution.license ? `${attribution.license.toUpperCase()} ${attribution.licenseVersion ?? ""}`.trim() : "Not listed"}${isSafeHttpsUrl(attribution.licenseUrl) ? ` (${attribution.licenseUrl})` : ""}\n${attribution.attribution ?? ""}`).join("\n\n");
          download(new Blob([report], { type: "text/plain;charset=utf-8" }), filename(doc.document.title, "credits.txt"));
        }}>Download credits report</button>}
        <p className="draw-confirmation-expiry">Verify each item's license and any requirements for sharing adaptations or commercial use.</p>
        <div className="draw-confirmation-actions"><button className="button button-quiet" onClick={() => setCreditsOpen(false)}>Close</button></div>
      </section>
    </div>}
    <div className="workspace">
      <section className="canvas-area" aria-label="Drawing canvas">
    <div className="editor-shell"><Excalidraw key={editorKey} initialData={initialData} excalidrawAPI={onEditorReady} onChange={onChange} viewModeEnabled={!canWrite} theme="light" name={doc.document.title} UIOptions={EDITOR_UI_OPTIONS}
      renderTopRightUI={renderCanvasToolbar}>{DRAW_MENU}</Excalidraw></div>
      </section>
    </div>
    {confirmation && <div className="draw-confirmation-backdrop" role="presentation">
      <section className="draw-confirmation" role="dialog" aria-modal="true" aria-labelledby="draw-confirmation-title" aria-describedby="draw-confirmation-copy">
        <h2 id="draw-confirmation-title">Open a Draw document?</h2>
        <p id="draw-confirmation-copy">An agent wants to open <strong>{confirmation.filename}</strong> and replace the current canvas. Save the current drawing first if you need to keep it.</p>
        <p className="draw-confirmation-expiry">This one-time approval expires in two minutes.</p>
        <div className="draw-confirmation-actions">
          <button className="button button-quiet" onClick={() => void respondToConfirmation(false)}>Keep current canvas</button>
          <button className="button button-primary" onClick={() => void respondToConfirmation(true)}>Approve opening</button>
        </div>
      </section>
    </div>}
    {connectOpen && <div className="draw-confirmation-backdrop" role="presentation">
      <section className="draw-confirmation" role="dialog" aria-modal="true" aria-labelledby="draw-connect-title">
        <h2 id="draw-connect-title">Connect to MCP</h2>
        <p>Enter the one-time code printed in the trusted terminal running Draw. This must be the Draw tab you intend to connect; the code expires after one minute.</p>
        <label htmlFor="draw-launch-code">Launch code</label>
        <input id="draw-launch-code" autoComplete="off" spellCheck={false} value={launchCodeInput} onChange={(event) => setLaunchCodeInput(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === "Enter") void connectEditorToMcp(); }} />
        {connectError && <p role="alert">{connectError}</p>}
        <div className="draw-confirmation-actions">
          <button className="button button-quiet" onClick={() => void requestFreshEditorCode()}>Request fresh code</button>
          <button className="button button-quiet" onClick={() => setConnectOpen(false)}>Cancel</button>
          <button className="button button-primary" disabled={launchCodeInput.trim().length < 12} onClick={() => void connectEditorToMcp()}>Connect</button>
        </div>
      </section>
    </div>}
    {mcpManagementOpen && <div className="draw-confirmation-backdrop" role="presentation">
      <section className="draw-confirmation" role="dialog" aria-modal="true" aria-labelledby="draw-mcp-clients-title">
        <h2 id="draw-mcp-clients-title">MCP clients</h2>
        <p>Copy this one-time pairing secret into the MCP host’s protected configuration as <code>DRAW_MCP_PAIRING_SECRET</code>. It expires in five minutes and can be used once. Then call its Draw pairing tool. Draw will ask you to approve the host name and fingerprint.</p>
        {mcpPairingSecret && <div className="mcp-pairing-secret"><code>{mcpPairingSecret}</code><button className="button button-quiet" onClick={() => void navigator.clipboard.writeText(mcpPairingSecret)}>Copy secret</button></div>}
        {mcpPairingError && <p role="alert">{mcpPairingError}</p>}
        <h3>Paired hosts</h3>
        {mcpClients.length === 0 && <p>No MCP clients have been paired.</p>}
        {mcpClients.map((client) => <div className="mcp-client-row" key={client.clientIdentity}>
          <span><strong>{client.name}</strong><small>{client.clientIdentity} · {client.revokedAt ? "revoked" : new Date(client.expiresAt).toLocaleDateString()}</small></span>
          {!client.revokedAt && <button className="button button-quiet" onClick={() => void revokeMcpClient(client.clientIdentity)}>Revoke</button>}
        </div>)}
        <div className="draw-confirmation-actions"><button className="button button-quiet" onClick={() => { setMcpManagementOpen(false); setMcpPairingSecret(""); }}>Close</button></div>
      </section>
    </div>}
    {mcpPairingRequest && <div className="draw-confirmation-backdrop" role="presentation">
      <section className="draw-confirmation" role="dialog" aria-modal="true" aria-labelledby="draw-mcp-pairing-title">
        <h2 id="draw-mcp-pairing-title">Approve MCP client?</h2>
        <p><strong>{mcpPairingRequest.name}</strong> is requesting access to this Draw instance.</p>
        <p>Client fingerprint: <code>{mcpPairingRequest.fingerprint}</code></p>
        {mcpPairingRequest.replacesName && <p role="alert">Approving this host will revoke the existing paired client “{mcpPairingRequest.replacesName}” with the same fingerprint.</p>}
        <p className="draw-confirmation-expiry">Approve only if this matches the host you are pairing. The request expires in two minutes.</p>
        <div className="draw-confirmation-actions">
          <button className="button button-quiet" onClick={() => void respondToMcpPairing(false)}>Deny</button>
          <button className="button button-primary" onClick={() => void respondToMcpPairing(true)}>Approve client</button>
        </div>
      </section>
    </div>}
    {message && <div className="toast" role="status"><span>{message}</span><button onClick={() => setMessage("")} aria-label="Dismiss message">×</button></div>}
    <footer className="footer"><span>DRAW V1</span><span className="footer-dot"/>LOCAL FIRST<span className="footer-spacer"/>A canvas for thoughts, drawn by hand.</footer>
  </main>;
}
