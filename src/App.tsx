import { CaptureUpdateAction, Excalidraw, FONT_FAMILY, convertToExcalidrawElements, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEmptyDocument,
  fromExcalidrawScene,
  parseDrawFile,
  serializeDrawFile,
  toExcalidrawScene,
  type DrawBackgroundPreset,
  type DrawDocument,
} from "./document/document";
import { composeBackgroundSvg, renderExportBlob, selectExportElements } from "./export/background";
import { recolorDefaultElements } from "./export/background-recolor";
import { saveCurrentDocument, loadCurrentDocument } from "./ui/storage";
import { applyElementUpdates, type EditableSceneElement } from "./integrations/scene-updates";
import { acquireWriterLock, type WriterLock } from "./ui/writer-lock";
import { createDebouncedSaver } from "./ui/autosave";
import { buildDiagramSkeletons } from "./integrations/diagram-builder";
import { persistAppliedDocument } from "./integrations/command-persistence";
import { createBridgeSynchronizer } from "./integrations/bridge-sync";

type Status = "loading" | "ready" | "saving" | "saved" | "error";
type BridgeCommand = { id: string; clientId: string; operation: "create_diagram" | "update_elements"; input: any };
const DEFAULT_COLOR: Record<DrawBackgroundPreset, string> = { blackboard: "#18191a", white: "#ffffff" };
const EDITOR_UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, changeViewBackgroundColor: false },
} as const;
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

export default function App() {
  const [doc, setDoc] = useState<DrawDocument | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");
  const [autosaveBlocked, setAutosaveBlocked] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const docRef = useRef<DrawDocument | null>(null);
  const clientId = useRef(randomId());
  const bridgeSync = useMemo(() => createBridgeSynchronizer(clientId.current), []);
  const writerOwned = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const onEditorReady = useCallback((api: ExcalidrawImperativeAPI) => { apiRef.current = api; }, []);

  const setDocument = useCallback((next: DrawDocument) => {
    docRef.current = next;
    setDoc(next);
  }, []);

  const autosave = useMemo(() => createDebouncedSaver<DrawDocument>(async (value) => {
    if (!writerOwned.current) return;
    await saveCurrentDocument(value);
    setStatus("saved");
  }, 350, (error) => {
    setStatus("error");
    setMessage(`Autosave failed: ${error instanceof Error ? error.message : String(error)}`);
  }), []);

  const syncBridgeDocument = useCallback(async (value: DrawDocument) => {
    if (!import.meta.env.DEV) return;
    if (!writerOwned.current) throw new Error("This tab does not own the active Draw canvas.");
    await bridgeSync(value);
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
          const stored = await loadCurrentDocument();
          if (!live) return;
          setDocument(stored ?? createEmptyDocument());
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
    const background = current.document.canvas.background;
    const next = fromExcalidrawScene({ elements, appState, files }, {
      id: current.document.id,
      title: current.document.title,
      background,
      viewport: {
        x: typeof state.scrollX === "number" ? state.scrollX : current.document.canvas.viewport.x,
        y: typeof state.scrollY === "number" ? state.scrollY : current.document.canvas.viewport.y,
        zoom: typeof state.zoom?.value === "number" ? state.zoom.value : current.document.canvas.viewport.zoom,
      },
    });
    setDocument(next);
    if (autosaveBlocked) {
      setStatus("error");
      return;
    }
    setStatus("saving");
    autosave.schedule(next);
    bridgeAutosave.schedule(next);
  }, [autosave, autosaveBlocked, bridgeAutosave, setDocument]);

  useEffect(() => {
    if (!doc || !canWrite || !import.meta.env.DEV) return;
    bridgeAutosave.schedule(doc);
  }, [bridgeAutosave, canWrite, doc?.document.id, doc ? editorKey : -1]);

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

  const loadDocument = useCallback(async (next: DrawDocument) => {
    if (!writerOwned.current) {
      setMessage("This tab is read-only because another Draw tab owns autosave.");
      return;
    }
    if (autosave.isBusy()) await autosave.flush();
    if (bridgeAutosave.isBusy()) await bridgeAutosave.flush();
    setDocument(next);
    setStatus("ready"); setMessage(""); setEditorKey((key) => key + 1);
    setAutosaveBlocked(false);
    try {
      await saveCurrentDocument(next);
      setStatus("saved");
      await syncBridgeDocument(next);
    } catch (error) {
      setAutosaveBlocked(true);
      setStatus("error");
      setMessage(`The file opened, but local autosave failed: ${error instanceof Error ? error.message : String(error)}. Use Save .draw to preserve it.`);
    }
  }, [autosave, bridgeAutosave, setDocument, syncBridgeDocument]);

  const openFile = async (file?: File) => {
    if (!file) return;
    if (docRef.current?.document.elements.some((element) => !element.isDeleted) &&
      !window.confirm("Open this file and replace the current canvas? Save an editable .draw copy first if you need to keep both.")) {
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    try { await loadDocument(await parseDrawFile(await file.text())); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not open this Draw file."); }
    finally { if (fileInput.current) fileInput.current.value = ""; }
  };

  const saveFile = () => {
    if (!doc) return;
    download(new Blob([serializeDrawFile(doc)], { type: "application/vnd.draw+json;charset=utf-8" }), filename(doc.document.title, "draw"));
    setMessage("Editable Draw file saved.");
  };

  const exportImage = async (mime: "image/png" | "image/jpeg") => {
    if (!apiRef.current || !doc) return;
    try {
      const allElements = apiRef.current.getSceneElements();
      const appState = apiRef.current.getAppState();
      const elements = selectExportElements(allElements, appState.selectedElementIds as Record<string, boolean> | undefined);
      const files = apiRef.current.getFiles();
      const svg = await exportToSvg({ elements, appState: { ...appState, exportBackground: false }, files, exportPadding: 32 });
      const composed = composeBackgroundSvg(new XMLSerializer().serializeToString(svg), doc.document.canvas.background.preset);
      const blob = await renderExportBlob(composed, mime);
      download(blob, filename(doc.document.title, mime === "image/png" ? "png" : "jpg"));
      setMessage(`Exported flattened ${mime === "image/png" ? "PNG" : "JPEG"} image.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Image export failed."); }
  };

  const selectBackground = (preset: DrawBackgroundPreset) => {
    if (!writerOwned.current) return;
    const current = docRef.current;
    if (!current) return;
    const color = DEFAULT_COLOR[preset];
    const elements = recolorDefaultElements(
      current.document.elements,
      current.document.canvas.background.preset,
      preset,
    );
    const next: DrawDocument = {
      ...current,
      document: {
        ...current.document,
        elements,
        canvas: { ...current.document.canvas, background: { preset, styleVersion: 1, color, ...(preset === "blackboard" ? { texture: "chalk-smudge-v1" } : {}) } },
        appState: { ...current.document.appState, viewBackgroundColor: color, currentItemStrokeColor: preset === "blackboard" ? "#f6f2e9" : "#1e1e1e" },
      },
    };
    setDocument(next);
    apiRef.current?.updateScene({
      elements: elements as any,
      appState: { viewBackgroundColor: color, currentItemStrokeColor: preset === "blackboard" ? "#f6f2e9" : "#1e1e1e" },
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
  };

  const handleMcpCommand = useCallback(async (event: BridgeCommand) => {
    const api = apiRef.current;
    const current = docRef.current;
    if (!api || !current || event.clientId !== clientId.current) return;
    let applied: { document: DrawDocument; result: Record<string, unknown> } | null = null;
    try {
      if (!writerOwned.current) throw new Error("This Draw tab is read-only because another tab owns the autosave lock.");
      if (autosaveBlocked) throw new Error("Local autosave is unavailable; open a saved .draw file before using MCP edits.");
      let elements = [...api.getSceneElementsIncludingDeleted()] as any[];
      let result: Record<string, unknown>;
      if (event.operation === "create_diagram") {
        const built = buildDiagramSkeletons(event.input, current.document.canvas.background.preset, randomId);
        // Keep the IDs minted by Draw so the MCP result can reliably map the
        // caller's node and edge IDs back to editable scene elements.
        const created = convertToExcalidrawElements(built.skeletons as any[], { regenerateIds: false });
        const labelIds = new Map<string, string>();
        for (const element of created as any[]) {
          if (element.type === "text" && element.containerId) labelIds.set(element.containerId, element.id);
        }
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
        elements = [...elements, ...created as any[]];
        result = {
          addedElementIds: created.map((element: any) => element.id),
          nodes, nodeLabels, edges,
          ...(titleElement ? { titleElementId: titleElement.id } : {}),
        };
      } else {
        const update = applyElementUpdates(elements, event.input.updates, measureTextWithExcalidraw);
        elements = update.elements;
        result = { updatedElementIds: update.updatedIds };
      }
      const state = api.getAppState() as any;
      const next = fromExcalidrawScene({ elements, appState: state, files: api.getFiles() }, {
        id: current.document.id, title: current.document.title,
        background: current.document.canvas.background,
        viewport: current.document.canvas.viewport,
      });
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      setDocument(next);
      applied = { document: next, result };
      const warning = await persistAppliedDocument(
        next,
        saveCurrentDocument,
        syncBridgeDocument,
      );
      if (warning) {
        setStatus("error");
        setMessage(warning);
      } else setStatus("saved");
      const acknowledgement = await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: event.id, clientId: clientId.current, document: next, result, ...(warning ? { warning } : {}) }),
      });
      if (!acknowledgement.ok) throw new Error(`Draw MCP bridge rejected the command acknowledgement (HTTP ${acknowledgement.status}).`);
    } catch (error) {
      if (applied) {
        const warning = `The edit was applied but the MCP acknowledgement failed: ${error instanceof Error ? error.message : String(error)}. Call get_current_canvas before retrying.`;
        setStatus("error");
        setMessage(warning);
        await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: event.id, clientId: clientId.current, document: applied.document, result: applied.result, warning }),
        }).catch(() => undefined);
        return;
      }
      await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: event.id, clientId: clientId.current, error: error instanceof Error ? error.message : String(error) }),
      }).catch(() => undefined);
    }
  }, [autosaveBlocked, setDocument, syncBridgeDocument]);

  useEffect(() => {
    if (!import.meta.hot) return;
    import.meta.hot.on("draw:mcp-command", handleMcpCommand);
    return () => import.meta.hot?.off("draw:mcp-command", handleMcpCommand);
  }, [handleMcpCommand]);

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
  const statusText = !canWrite ? "Read-only in this tab" : status === "saving" ? "Saving locally…" : status === "saved" ? "Saved on this device" : status === "error" ? "Save issue" : "All changes saved";

  return <main className={`draw-app bg-${background}`}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">D</span><span className="brand-name">draw</span><span className="brand-divider"/><span className="doc-title"><input ref={titleInput} aria-label="Drawing title" disabled={!canWrite} value={doc.document.title} onChange={(event) => {
        const next = { ...doc, document: { ...doc.document, title: event.target.value } };
        setDocument(next);
        if (autosaveBlocked) { setStatus("error"); return; }
        setStatus("saving");
        autosave.schedule(next);
        bridgeAutosave.schedule(next);
      }} /></span></div>
      <div className="toolbar-actions">
        <span className={`save-indicator ${status}`}><i />{statusText}</span>
        <button className="button button-quiet" disabled={!canWrite} onClick={() => fileInput.current?.click()} title={canWrite ? "Open editable .draw file" : "Close the other Draw tab to open files here"}>Open</button>
        <input ref={fileInput} className="visually-hidden" type="file" accept=".draw,application/vnd.draw+json,application/json" onChange={(event) => void openFile(event.target.files?.[0])} />
        <button className="button button-primary" onClick={saveFile} title="Save the complete editable Draw file"><span className="button-icon">↓</span>Save .draw</button>
        <div className="export-group"><button className="button button-quiet export-main" onClick={() => void exportImage("image/png")}>Export</button><select aria-label="Image export format" value="image/png" onChange={(event) => void exportImage(event.target.value as "image/png" | "image/jpeg")}><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option></select></div>
      </div>
    </header>
    <div className="workspace">
      <aside className="side-rail">
        <div className="rail-label">CANVAS</div>
        <div className="background-picker" role="group" aria-label="Canvas background">
          <button disabled={!canWrite} className={`background-option ${background === "blackboard" ? "active" : ""}`} onClick={() => selectBackground("blackboard")} aria-pressed={background === "blackboard"}><span className="swatch swatch-chalk"><b>✳</b></span><span>Blackboard</span></button>
          <button disabled={!canWrite} className={`background-option ${background === "white" ? "active" : ""}`} onClick={() => selectBackground("white")} aria-pressed={background === "white"}><span className="swatch swatch-paper"><b>◌</b></span><span>White</span></button>
        </div>
        <div className="rail-separator" />
        <div className="rail-label">QUICK START</div>
        <p className="rail-copy">Sketch freely on the infinite canvas. Pick a tool, draw, and connect ideas.</p>
        <div className="shortcut"><kbd>V</kbd><span>Select</span></div><div className="shortcut"><kbd>R</kbd><span>Rectangle</span></div><div className="shortcut"><kbd>A</kbd><span>Arrow</span></div><div className="shortcut"><kbd>P</kbd><span>Draw</span></div>
        <div className="rail-bottom"><span className="local-icon">⌂</span><span>Stored locally<br/><small>Your work stays on this device</small></span></div>
      </aside>
      <section className="canvas-area" aria-label="Drawing canvas">
        <div className="canvas-label"><span className="canvas-live"/>Infinite canvas <span className="dot-separator">·</span> {background === "blackboard" ? "Chalkboard" : "White"}</div>
    <div className="editor-shell"><Excalidraw key={editorKey} initialData={initialData} excalidrawAPI={onEditorReady} onChange={onChange} viewModeEnabled={!canWrite} theme="light" name={doc.document.title} UIOptions={EDITOR_UI_OPTIONS} /></div>
      </section>
    </div>
    {message && <div className="toast" role="status"><span>{message}</span><button onClick={() => setMessage("")} aria-label="Dismiss message">×</button></div>}
    <footer className="footer"><span>DRAW V1</span><span className="footer-dot"/>LOCAL FIRST<span className="footer-spacer"/>A canvas for thoughts, drawn by hand.</footer>
  </main>;
}
