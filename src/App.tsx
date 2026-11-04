import { Excalidraw, convertToExcalidrawElements, exportToSvg } from "@excalidraw/excalidraw";
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
import { saveCurrentDocument, loadCurrentDocument } from "./ui/storage";
import { applyElementUpdates } from "./integrations/scene-updates";

type Status = "loading" | "ready" | "saving" | "saved" | "error";
type BridgeCommand = { id: string; clientId: string; operation: "create_diagram" | "update_elements"; input: any };
const DEFAULT_COLOR: Record<DrawBackgroundPreset, string> = { blackboard: "#18191a", white: "#ffffff" };
const EDITOR_UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, changeViewBackgroundColor: false },
} as const;
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `el-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
  const [editorKey, setEditorKey] = useState(0);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const docRef = useRef<DrawDocument | null>(null);
  const clientId = useRef(randomId());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const onEditorReady = useCallback((api: ExcalidrawImperativeAPI) => { apiRef.current = api; }, []);

  const setDocument = useCallback((next: DrawDocument) => {
    docRef.current = next;
    setDoc(next);
  }, []);

  useEffect(() => {
    let live = true;
    loadCurrentDocument().then((stored) => {
      if (!live) return;
      setDocument(stored ?? createEmptyDocument());
      setStatus("ready");
    }).catch((error: unknown) => {
      if (!live) return;
      setAutosaveBlocked(true);
      setDocument(createEmptyDocument());
      setStatus("error");
      setMessage(`Local autosave could not be loaded, so Draw will not overwrite it. Save a portable .draw file to keep new edits. ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { live = false; };
  }, [setDocument]);

  const syncBridgeDocument = useCallback(async (value: DrawDocument) => {
    if (!import.meta.env.DEV) return;
    const response = await fetch("/__draw/api/document", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error(`Draw bridge rejected document sync (HTTP ${response.status}).`);
  }, []);

  const onChange = useCallback((elements: readonly any[], appState: any, files: any) => {
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
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveCurrentDocument(next).then(() => setStatus("saved")).catch((error: unknown) => {
        setStatus("error"); setMessage(`Autosave failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      void syncBridgeDocument(next).catch((error: unknown) => {
        setStatus("error"); setMessage(error instanceof Error ? error.message : "Could not sync Draw with MCP.");
      });
    }, 350);
  }, [autosaveBlocked, setDocument, syncBridgeDocument]);

  useEffect(() => {
    if (!doc || !import.meta.env.DEV) return;
    const id = clientId.current;
    void fetch("/__draw/api/client", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: id }) }).catch(() => undefined);
    void syncBridgeDocument(doc).catch(() => undefined);
  }, [doc?.document.id, doc ? editorKey : -1, syncBridgeDocument]);

  const loadDocument = useCallback((next: DrawDocument) => {
    setAutosaveBlocked(false);
    setDocument(next);
    setStatus("ready"); setMessage(""); setEditorKey((key) => key + 1);
    void saveCurrentDocument(next).then(() => setStatus("saved")).catch(() => setStatus("error"));
    void syncBridgeDocument(next).catch(() => undefined);
  }, [setDocument, syncBridgeDocument]);

  const openFile = async (file?: File) => {
    if (!file) return;
    if (docRef.current?.document.elements.some((element) => !element.isDeleted) &&
      !window.confirm("Open this file and replace the current canvas? Save an editable .draw copy first if you need to keep both.")) {
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    try { loadDocument(await parseDrawFile(await file.text())); }
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
    const current = docRef.current;
    if (!current) return;
    const color = DEFAULT_COLOR[preset];
    const next: DrawDocument = {
      ...current,
      document: {
        ...current.document,
        canvas: { ...current.document.canvas, background: { preset, styleVersion: 1, color, ...(preset === "blackboard" ? { texture: "chalk-smudge-v1" } : {}) } },
        appState: { ...current.document.appState, viewBackgroundColor: color, currentItemStrokeColor: preset === "blackboard" ? "#f6f2e9" : "#1e1e1e" },
      },
    };
    setDocument(next);
    apiRef.current?.updateScene({ appState: { viewBackgroundColor: color, currentItemStrokeColor: preset === "blackboard" ? "#f6f2e9" : "#1e1e1e" } });
    if (autosaveBlocked) {
      setStatus("error");
      setMessage("Local autosave is unavailable. Save a portable .draw file to keep this change.");
      return;
    }
    void saveCurrentDocument(next).then(() => setStatus("saved")).catch(() => setStatus("error"));
    void syncBridgeDocument(next).catch(() => undefined);
  };

  const handleMcpCommand = useCallback(async (event: BridgeCommand) => {
    const api = apiRef.current;
    const current = docRef.current;
    if (!api || !current || event.clientId !== clientId.current) return;
    try {
      if (autosaveBlocked) throw new Error("Local autosave is unavailable; open a saved .draw file before using MCP edits.");
      let elements = [...api.getSceneElementsIncludingDeleted()] as any[];
      let affected: string[] = [];
      if (event.operation === "create_diagram") {
        const { nodes, edges } = event.input;
        const onBlackboard = current.document.canvas.background.preset === "blackboard";
        const defaultStroke = onBlackboard ? "#f2d27a" : "#546271";
        const ids = new Map<string, string>();
        const skeletons: any[] = nodes.map((node: any) => {
          const id = randomId(); ids.set(node.id, id);
          return { id, type: node.shape === "ellipse" ? "ellipse" : node.shape === "diamond" ? "diamond" : "rectangle", x: node.x, y: node.y, width: node.width ?? 180, height: node.height ?? 72, strokeColor: node.color ?? defaultStroke, backgroundColor: onBlackboard ? "#18191a" : "#ffffff", fillStyle: "solid", strokeWidth: 2, roughness: 1, label: { text: node.label, fontSize: 20, strokeColor: node.color ?? defaultStroke } };
        });
        if (event.input.title) skeletons.unshift({ type: "text", x: Math.min(...nodes.map((node: any) => node.x)), y: Math.min(...nodes.map((node: any) => node.y)) - 56, text: event.input.title, fontSize: 28, strokeColor: onBlackboard ? "#f6f2e9" : "#1e1e1e", roughness: 1 });
        for (const edge of edges) {
          const from = nodes.find((node: any) => node.id === edge.from), to = nodes.find((node: any) => node.id === edge.to);
          if (!from || !to) continue;
          const sx = from.x + (from.width ?? 180) / 2, sy = from.y + (from.height ?? 72) / 2;
          const ex = to.x + (to.width ?? 180) / 2, ey = to.y + (to.height ?? 72) / 2;
          skeletons.push({ type: "arrow", x: sx, y: sy, points: [[0, 0], [ex - sx, ey - sy]], start: { id: ids.get(edge.from) }, end: { id: ids.get(edge.to) }, endArrowhead: "arrow", strokeColor: edge.color ?? defaultStroke, label: edge.label ? { text: edge.label, fontSize: 16, strokeColor: edge.color ?? defaultStroke } : undefined });
        }
        const created = convertToExcalidrawElements(skeletons);
        affected = created.map((element: any) => element.id);
        elements = [...elements, ...created as any[]];
      } else {
        const result = applyElementUpdates(elements, event.input.updates);
        elements = result.elements;
        affected = result.updatedIds;
      }
      api.updateScene({ elements });
      const state = api.getAppState() as any;
      const next = fromExcalidrawScene({ elements, appState: state, files: api.getFiles() }, {
        id: current.document.id, title: current.document.title,
        background: current.document.canvas.background,
        viewport: current.document.canvas.viewport,
      });
      setDocument(next);
      await saveCurrentDocument(next);
      await syncBridgeDocument(next);
      const acknowledgement = await fetch(`/__draw/api/commands/${encodeURIComponent(event.id)}/ack`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: event.id, clientId: clientId.current, result: event.operation === "create_diagram" ? { addedElementIds: affected } : { updatedElementIds: affected } }),
      });
      if (!acknowledgement.ok) throw new Error(`Draw MCP bridge rejected the command acknowledgement (HTTP ${acknowledgement.status}).`);
    } catch (error) {
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
  const statusText = status === "saving" ? "Saving locally…" : status === "saved" ? "Saved on this device" : status === "error" ? "Save issue" : "All changes saved";

  return <main className={`draw-app bg-${background}`}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">D</span><span className="brand-name">draw</span><span className="brand-divider"/><span className="doc-title"><input ref={titleInput} aria-label="Drawing title" value={doc.document.title} onChange={(event) => {
        const next = { ...doc, document: { ...doc.document, title: event.target.value } };
        setDocument(next); void syncBridgeDocument(next).catch(() => undefined);
      }} onBlur={() => { if (!autosaveBlocked && docRef.current) void saveCurrentDocument(docRef.current); }} /></span></div>
      <div className="toolbar-actions">
        <span className={`save-indicator ${status}`}><i />{statusText}</span>
        <button className="button button-quiet" onClick={() => fileInput.current?.click()} title="Open editable .draw file">Open</button>
        <input ref={fileInput} className="visually-hidden" type="file" accept=".draw,application/vnd.draw+json,application/json" onChange={(event) => void openFile(event.target.files?.[0])} />
        <button className="button button-primary" onClick={saveFile} title="Save the complete editable Draw file"><span className="button-icon">↓</span>Save .draw</button>
        <div className="export-group"><button className="button button-quiet export-main" onClick={() => void exportImage("image/png")}>Export</button><select aria-label="Image export format" value="image/png" onChange={(event) => void exportImage(event.target.value as "image/png" | "image/jpeg")}><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option></select></div>
      </div>
    </header>
    <div className="workspace">
      <aside className="side-rail">
        <div className="rail-label">CANVAS</div>
        <div className="background-picker" role="group" aria-label="Canvas background">
          <button className={`background-option ${background === "blackboard" ? "active" : ""}`} onClick={() => selectBackground("blackboard")} aria-pressed={background === "blackboard"}><span className="swatch swatch-chalk"><b>✳</b></span><span>Blackboard</span></button>
          <button className={`background-option ${background === "white" ? "active" : ""}`} onClick={() => selectBackground("white")} aria-pressed={background === "white"}><span className="swatch swatch-paper"><b>◌</b></span><span>White</span></button>
        </div>
        <div className="rail-separator" />
        <div className="rail-label">QUICK START</div>
        <p className="rail-copy">Sketch freely on the infinite canvas. Pick a tool, draw, and connect ideas.</p>
        <div className="shortcut"><kbd>V</kbd><span>Select</span></div><div className="shortcut"><kbd>R</kbd><span>Rectangle</span></div><div className="shortcut"><kbd>A</kbd><span>Arrow</span></div><div className="shortcut"><kbd>P</kbd><span>Draw</span></div>
        <div className="rail-bottom"><span className="local-icon">⌂</span><span>Stored locally<br/><small>Your work stays on this device</small></span></div>
      </aside>
      <section className="canvas-area" aria-label="Drawing canvas">
        <div className="canvas-label"><span className="canvas-live"/>Infinite canvas <span className="dot-separator">·</span> {background === "blackboard" ? "Chalkboard" : "White"}</div>
    <div className="editor-shell"><Excalidraw key={editorKey} initialData={initialData} excalidrawAPI={onEditorReady} onChange={onChange} theme="light" name={doc.document.title} UIOptions={EDITOR_UI_OPTIONS} /></div>
      </section>
    </div>
    {message && <div className="toast" role="status"><span>{message}</span><button onClick={() => setMessage("")} aria-label="Dismiss message">×</button></div>}
    <footer className="footer"><span>DRAW V1</span><span className="footer-dot"/>LOCAL FIRST<span className="footer-spacer"/>A canvas for thoughts, drawn by hand.</footer>
  </main>;
}
