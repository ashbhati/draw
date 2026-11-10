import { createEmptyDocument, normalizeStoredDrawDocument, validateDrawDocument, type DrawDocument } from "../document/document";
import { normalizeDrawImageAttributions } from "../document/attribution";
import { compactOperationLedger, operationLedgerKey, OPERATION_SNAPSHOT_RETENTION_MS, OPERATION_TOMBSTONE_RETENTION_MS, sameSceneSnapshot, type DurableMcpOperation, type DurableMcpOperationResult, type DurableMcpRedo, type DurableMcpTombstone, type OperationLedgerEntry } from "../integrations/operation-ledger";

const DATABASE_NAME = "draw-local";
const DATABASE_VERSION = 11;
const DOCUMENTS_STORE = "documents";
const MCP_OPERATIONS_STORE = "mcpOperations";
const MCP_WORKSPACE_OPERATIONS_STORE = "mcpWorkspaceOperations";
const MCP_UNDO_STORE = "mcpUndo";
const MCP_REDO_STORE = "mcpRedo";
const MCP_META_STORE = "mcpMeta";
const WORKSPACES_STORE = "workspaces";
const CANVASES_STORE = "canvases";
const WORKSPACE_META_STORE = "workspaceMeta";
const WORKSPACE_CATALOG_REVISION_KEY = "workspace-catalog-revision";
const WORKSPACE_LIBRARY_STORE = "workspaceLibrary";
const MIGRATION_MARKER_KEY = "migration-v6-complete";
const LEGACY_RECOVERY_KEY = "legacy-recovery";
const LEGACY_RECOVERY_INFO_KEY = "legacy-recovery-info";
const LEGACY_RECOVERY_FORMAT = "draw-legacy-recovery-v1";
const CURRENT_DOCUMENT_KEY = "current";
const CURRENT_WRITE_ORDER_KEY = "current-write-order";
const ACTIVE_POINTER_KEY = "active";
const INITIALIZED_KEY = "has-canvas-history";
const AUTOSAVE_SESSION_ID = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
let autosaveSequence = 0;
const MCP_COMPACTION_INTERVAL = 32;
const MAX_DOCUMENT_SNAPSHOTS = 100;
export const MCP_WORKSPACE_RECEIPT_LIMIT = 1_000;
const MCP_WORKSPACE_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_LIBRARY_OPERATION_RECEIPTS = 256;
const LIBRARY_OPERATION_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

type AutosaveOrder = { sessionId: string; sequence: number };

export interface DrawWorkspace { id: string; name: string; createdAt: number; updatedAt: number }
export interface DrawCanvas { id: string; workspaceId: string; name: string; documentId: string; createdAt: number; updatedAt: number }
export interface LegacyDocumentRecovery {
  source: string;
  raw: unknown;
  reason?: string;
  canvasId?: string;
  quarantinedAt?: number;
  recovered: boolean;
}
export interface DrawLibraryItem {
  id: string;
  status?: "published" | "unpublished";
  created: number;
  name?: string;
  elements: DrawDocument["document"]["elements"];
  assets: Record<string, DrawDocument["document"]["assets"][string]>;
}
export interface WorkspaceLibraryState { items: DrawLibraryItem[]; revision: number }
export interface WorkspaceLibraryMutationContext {
  clientIdentity: string;
  idempotencyKey: string;
  payloadHash: string;
  expectedRevision: number;
}
export interface WorkspaceLibraryMutationResult<T = Record<string, unknown>> extends WorkspaceLibraryState {
  result: T;
  replayed: boolean;
}
interface WorkspaceLibraryReceipt { clientIdentity: string; idempotencyKey: string; payloadHash: string; result: Record<string, unknown>; revision: number; completedAt: number }
interface StoredWorkspaceLibrary extends WorkspaceLibraryState { receipts: Record<string, WorkspaceLibraryReceipt> }
interface ActiveCanvasPointer { workspaceId: string; canvasId: string }

export type McpWorkspaceAction =
  | { type: "create_workspace"; name: string }
  | { type: "rename_workspace"; workspaceId: string; name: string }
  | { type: "select_workspace"; workspaceId: string }
  | { type: "create_canvas"; workspaceId: string; name: string }
  | { type: "rename_canvas"; canvasId: string; name: string }
  | { type: "duplicate_canvas"; canvasId: string; name?: string }
  | { type: "select_canvas"; workspaceId: string; canvasId: string }
  | { type: "delete_canvas"; canvasId: string }
  | { type: "delete_workspace"; workspaceId: string }
  | { type: "import_draw_file_as_canvas"; workspaceId: string; name?: string; document: DrawDocument };

export interface McpWorkspaceOperationRequest {
  clientIdentity: string;
  idempotencyKey: string;
  payloadHash: string;
  expectedCatalogRevision: number;
  action: McpWorkspaceAction;
}

export interface McpWorkspaceOperationResult {
  catalogRevision: number;
  activeWorkspaceId: string;
  activeCanvasId: string;
  activeDocument: DrawDocument;
  workspace?: DrawWorkspace;
  canvas?: DrawCanvas;
  workspaces: DrawWorkspace[];
  canvases: DrawCanvas[];
  operation?: { type: string; workspaceId?: string; canvasId?: string; committedCatalogRevision?: number };
}

interface McpWorkspaceOperationReceipt {
  clientIdentity: string;
  idempotencyKey: string;
  payloadHash: string;
  completedAt: number;
  operation: { type: string; workspaceId?: string; canvasId?: string; committedCatalogRevision: number };
  workspaceIds: string[];
  canvasIds: string[];
}

export interface McpWorkspaceCatalog extends McpWorkspaceOperationResult {}

export class DrawStorageRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = "DrawStorageRecoveryError"; }
}

export class WorkspaceLibraryConflictError extends Error {
  constructor(message: string, readonly code: "LIBRARY_REVISION_CONFLICT" | "IDEMPOTENCY_KEY_REUSE") {
    super(message);
    this.name = "WorkspaceLibraryConflictError";
  }
}

function documentKey(id: string): IDBValidKey { return ["draw-document", id]; }
function writeOrderKey(id: string): IDBValidKey { return ["draw-write-order", id]; }

function recoveryRecord(raw: unknown, metadata?: unknown, reason?: string): LegacyDocumentRecovery {
  let original = raw;
  let info = metadata;
  // Schema 9 wrote v5 recovery metadata and the raw value in one object. Split
  // that known envelope during upgrade; all newer records keep raw separate.
  if (info === undefined && raw && typeof raw === "object" && !Array.isArray(raw)
    && (raw as Record<string, unknown>).source === "v5-canvas"
    && typeof (raw as Record<string, unknown>).canvasId === "string"
    && Object.prototype.hasOwnProperty.call(raw, "raw")) {
    info = raw;
    original = (raw as Record<string, unknown>).raw;
  }
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const record = info as Partial<LegacyDocumentRecovery> & { format?: string };
    if (typeof record.source === "string") {
      return {
        source: record.source,
        raw: original,
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        ...(typeof record.canvasId === "string" ? { canvasId: record.canvasId } : {}),
        ...(Number.isFinite(record.quarantinedAt) ? { quarantinedAt: record.quarantinedAt } : {}),
        recovered: record.recovered === true,
      };
    }
  }
  return { source: "legacy-current", raw: original, ...(reason ? { reason } : {}), quarantinedAt: Date.now(), recovered: false };
}

function storedRecoveryRecord(record: LegacyDocumentRecovery): Omit<LegacyDocumentRecovery, "raw"> & { format: typeof LEGACY_RECOVERY_FORMAT } {
  const { raw: _raw, ...metadata } = record;
  return { ...metadata, format: LEGACY_RECOVERY_FORMAT };
}

function recoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function autosaveSceneAndMetadata(document: DrawDocument): string {
  const { appState: _appState, ...metadata } = document.document;
  const { viewport: _viewport, ...canvas } = metadata.canvas;
  return JSON.stringify({ ...document, document: { ...metadata, canvas } });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Local autosave requires IndexedDB in this browser."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
        database.createObjectStore(DOCUMENTS_STORE);
      }
      if (!database.objectStoreNames.contains(MCP_OPERATIONS_STORE)) {
        database.createObjectStore(MCP_OPERATIONS_STORE);
      }
      if (!database.objectStoreNames.contains(MCP_WORKSPACE_OPERATIONS_STORE)) {
        database.createObjectStore(MCP_WORKSPACE_OPERATIONS_STORE);
      }
      if (!database.objectStoreNames.contains(MCP_UNDO_STORE)) {
        const undo = database.createObjectStore(MCP_UNDO_STORE);
        undo.createIndex("byCompletedAt", "completedAt", { unique: false });
      }
      if (!database.objectStoreNames.contains(MCP_REDO_STORE)) {
        const redo = database.createObjectStore(MCP_REDO_STORE);
        redo.createIndex("byCompletedAt", "operation.completedAt", { unique: false });
      }
      if (database.objectStoreNames.contains(MCP_UNDO_STORE) && !request.transaction!.objectStore(MCP_UNDO_STORE).indexNames.contains("byCompletedAt")) request.transaction!.objectStore(MCP_UNDO_STORE).createIndex("byCompletedAt", "completedAt", { unique: false });
      if (database.objectStoreNames.contains(MCP_REDO_STORE) && !request.transaction!.objectStore(MCP_REDO_STORE).indexNames.contains("byCompletedAt")) request.transaction!.objectStore(MCP_REDO_STORE).createIndex("byCompletedAt", "operation.completedAt", { unique: false });
      if (!database.objectStoreNames.contains(MCP_META_STORE)) database.createObjectStore(MCP_META_STORE);
      const workspaces = database.objectStoreNames.contains(WORKSPACES_STORE)
        ? request.transaction!.objectStore(WORKSPACES_STORE) : database.createObjectStore(WORKSPACES_STORE);
      const canvases = database.objectStoreNames.contains(CANVASES_STORE)
        ? request.transaction!.objectStore(CANVASES_STORE) : database.createObjectStore(CANVASES_STORE);
      if (!canvases.indexNames.contains("byWorkspaceId")) canvases.createIndex("byWorkspaceId", "workspaceId", { unique: false });
      if (!canvases.indexNames.contains("byDocumentId")) canvases.createIndex("byDocumentId", "documentId", { unique: true });
      if (!database.objectStoreNames.contains(WORKSPACE_META_STORE)) database.createObjectStore(WORKSPACE_META_STORE);
      if (!database.objectStoreNames.contains(WORKSPACE_LIBRARY_STORE)) database.createObjectStore(WORKSPACE_LIBRARY_STORE);
      const meta = request.transaction!.objectStore(WORKSPACE_META_STORE);
      const documents = request.transaction!.objectStore(DOCUMENTS_STORE);
      if (event.oldVersion < 5) {
        // V1 used literal keys. Migrate valid content, but quarantine malformed
        // content without throwing in onupgradeneeded (which would brick opens).
        const legacyRequest = documents.get(CURRENT_DOCUMENT_KEY);
        legacyRequest.onsuccess = () => {
          const legacy = legacyRequest.result as unknown;
          if (legacy !== undefined) {
            try {
              const doc = normalizeStoredDrawDocument(legacy);
              const workspaceId = `workspace-${doc.document.id}`;
              const canvasId = `canvas-${doc.document.id}`;
              const now = Date.now();
              documents.put(doc, documentKey(doc.document.id));
              documents.put(doc, CURRENT_DOCUMENT_KEY);
              workspaces.put({ id: workspaceId, name: "My workspace", createdAt: now, updatedAt: now } satisfies DrawWorkspace, workspaceId);
              canvases.put({ id: canvasId, workspaceId, name: doc.document.title, documentId: doc.document.id, createdAt: now, updatedAt: now } satisfies DrawCanvas, canvasId);
              meta.put({ workspaceId, canvasId } satisfies ActiveCanvasPointer, ACTIVE_POINTER_KEY);
              meta.put(true, INITIALIZED_KEY);
              const oldOrder = documents.get(CURRENT_WRITE_ORDER_KEY);
              oldOrder.onsuccess = () => {
                if (oldOrder.result !== undefined) documents.put(oldOrder.result, writeOrderKey(doc.document.id));
                documents.delete(CURRENT_WRITE_ORDER_KEY);
              };
            } catch (error) {
              const record = recoveryRecord(structuredClone(legacy), undefined, recoveryErrorMessage(error));
              meta.put(record.raw, LEGACY_RECOVERY_KEY);
              meta.put(storedRecoveryRecord(record), LEGACY_RECOVERY_INFO_KEY);
            }
          }
          meta.put(true, MIGRATION_MARKER_KEY);
        };
      } else if (event.oldVersion === 5) {
        // PR #47's first v5 draft keyed documents by raw IDs. Re-key every
        // referenced row before accepting arbitrary IDs from portable files.
        const canvasRequest = canvases.getAll();
        canvasRequest.onsuccess = () => {
          const entries = canvasRequest.result as DrawCanvas[];
          const documentIds = new Set(entries.map((canvas) => canvas.documentId));
          let remaining = entries.length;
          const finish = () => { if (remaining === 0) { meta.put(true, MIGRATION_MARKER_KEY); if (entries.length) meta.put(true, INITIALIZED_KEY); } };
          if (!remaining) { finish(); return; }
          for (const canvas of entries) {
            const oldDocumentRequest = documents.get(canvas.documentId);
            oldDocumentRequest.onsuccess = () => {
              const raw = oldDocumentRequest.result as unknown;
              try {
                const normalized = normalizeStoredDrawDocument(raw);
                if (normalized.document.id !== canvas.documentId) throw new Error("The legacy canvas document id does not match its canvas row.");
                documents.put(normalized, documentKey(canvas.documentId));
                const aliasRequest = documents.get(CURRENT_DOCUMENT_KEY);
                aliasRequest.onsuccess = () => {
                  try { if (normalizeStoredDrawDocument(aliasRequest.result).document.id === canvas.documentId) documents.put(normalized, CURRENT_DOCUMENT_KEY); } catch { /* another canvas owns the alias or it is quarantined */ }
                };
                if (canvas.documentId !== CURRENT_DOCUMENT_KEY && canvas.documentId !== CURRENT_WRITE_ORDER_KEY) documents.delete(canvas.documentId);
                const oldOrderKey = `${canvas.documentId}-write-order`;
                const orderRequest = documents.get(oldOrderKey);
                orderRequest.onsuccess = () => {
                  const order = orderRequest.result as Partial<AutosaveOrder> | undefined;
                  if (typeof order?.sessionId === "string" && Number.isSafeInteger(order.sequence)) documents.put(order, writeOrderKey(canvas.documentId));
                  // An arbitrary legacy document ID may equal another row's
                  // old write-order key; never delete a key that is a document.
                  if (!documentIds.has(oldOrderKey)) documents.delete(oldOrderKey);
                  remaining -= 1;
                  finish();
                };
              } catch (error) {
                const record = recoveryRecord(structuredClone(raw ?? null), { source: "v5-canvas", canvasId: canvas.id, reason: recoveryErrorMessage(error), quarantinedAt: Date.now(), recovered: false });
                meta.put(record.raw, LEGACY_RECOVERY_KEY);
                meta.put(storedRecoveryRecord(record), LEGACY_RECOVERY_INFO_KEY);
                remaining -= 1;
                finish();
              }
            };
          }
        };
      }
      if (event.oldVersion < 8) {
        const receipts = request.transaction!.objectStore(MCP_WORKSPACE_OPERATIONS_STORE);
        const keys = receipts.getAllKeys();
        const values = receipts.getAll();
        let pending = 2;
        const compactLegacyReceipts = () => {
          pending -= 1;
          if (pending) return;
          const rows = (values.result as Array<any>).map((row, index) => {
            if (!row || typeof row !== "object" || typeof row.clientIdentity !== "string" || typeof row.idempotencyKey !== "string" || typeof row.payloadHash !== "string") return null;
            const oldResult = row?.result;
            const operation = oldResult?.operation;
            const workspaceId = operation?.workspaceId ?? oldResult?.workspace?.id ?? oldResult?.activeWorkspaceId;
            const canvasId = operation?.canvasId ?? oldResult?.canvas?.id ?? oldResult?.activeCanvasId;
            const compact: McpWorkspaceOperationReceipt = {
              clientIdentity: row.clientIdentity,
              idempotencyKey: row.idempotencyKey,
              payloadHash: row.payloadHash,
              completedAt: Number.isFinite(row.completedAt) ? row.completedAt : Date.now(),
              operation: {
                type: typeof operation?.type === "string" ? operation.type : "legacy_workspace_operation",
                ...(typeof workspaceId === "string" ? { workspaceId } : {}),
                ...(typeof canvasId === "string" ? { canvasId } : {}),
                committedCatalogRevision: Number.isSafeInteger(oldResult?.catalogRevision) ? oldResult.catalogRevision : 0,
              },
              workspaceIds: typeof workspaceId === "string" ? [workspaceId] : [],
              canvasIds: typeof canvasId === "string" ? [canvasId] : [],
            };
            return { key: (keys.result as IDBValidKey[])[index], compact };
          }).filter((entry): entry is { key: IDBValidKey; compact: McpWorkspaceOperationReceipt } => !!entry && entry.compact.completedAt >= Date.now() - MCP_WORKSPACE_RECEIPT_RETENTION_MS)
            .sort((a, b) => b.compact.completedAt - a.compact.completedAt).slice(0, MCP_WORKSPACE_RECEIPT_LIMIT);
          const retained = new Set(rows.map((entry) => JSON.stringify(entry.key)));
          (keys.result as IDBValidKey[]).forEach((key) => { if (!retained.has(JSON.stringify(key))) receipts.delete(key); });
          rows.forEach(({ key, compact }) => receipts.put(compact, key));
        };
        keys.onsuccess = values.onsuccess = compactLegacyReceipts;
      }
      if (event.oldVersion < 10) {
        // Earlier upgrades quarantined malformed-looking V1 rows as-is. Some
        // were valid Draw v1 documents that only lacked revision counters, so
        // retry the normalizer now while retaining the original value.
        const recoveryRequest = meta.get(LEGACY_RECOVERY_KEY);
        const recoveryInfoRequest = meta.get(LEGACY_RECOVERY_INFO_KEY);
        const canvasesRequest = canvases.getAll();
        const pointerRequest = meta.get(ACTIVE_POINTER_KEY);
        let pending = 4;
        let recovery: unknown;
        let recoveryInfo: unknown;
        let existingCanvases: DrawCanvas[] = [];
        let activePointer: ActiveCanvasPointer | undefined;
        const attemptRecovery = () => {
          pending -= 1;
          if (pending) return;
          if (recovery === undefined) return;
          const record = recoveryRecord(recovery, recoveryInfo);
          try {
            const document = normalizeStoredDrawDocument(record.raw);
            if (record.source === "v5-canvas" && record.canvasId) {
              const canvas = existingCanvases.find((item) => item.id === record.canvasId);
              if (!canvas || canvas.documentId !== document.document.id) throw new Error("The quarantined v5 document does not match its canvas row.");
              documents.put(document, documentKey(canvas.documentId));
              if (activePointer?.canvasId === canvas.id) documents.put(document, CURRENT_DOCUMENT_KEY);
            } else {
              const existing = existingCanvases.find((item) => item.documentId === document.document.id);
              if (existing) {
                documents.put(document, documentKey(existing.documentId));
                if (activePointer?.canvasId === existing.id) documents.put(document, CURRENT_DOCUMENT_KEY);
              } else {
                const now = Date.now();
                const workspace = { id: `workspace-${crypto.randomUUID()}`, name: "Recovered workspace", createdAt: now, updatedAt: now } satisfies DrawWorkspace;
                const canvas = { id: `canvas-${crypto.randomUUID()}`, workspaceId: workspace.id, name: document.document.title, documentId: document.document.id, createdAt: now, updatedAt: now } satisfies DrawCanvas;
                workspaces.put(workspace, workspace.id);
                canvases.put(canvas, canvas.id);
                documents.put(document, documentKey(document.document.id));
                if (!activePointer) {
                  meta.put({ workspaceId: workspace.id, canvasId: canvas.id } satisfies ActiveCanvasPointer, ACTIVE_POINTER_KEY);
                  documents.put(document, CURRENT_DOCUMENT_KEY);
                }
                meta.put(true, INITIALIZED_KEY);
                incrementWorkspaceCatalogRevision(meta);
              }
            }
            meta.put(record.raw, LEGACY_RECOVERY_KEY);
            meta.put(storedRecoveryRecord({ ...record, recovered: true }), LEGACY_RECOVERY_INFO_KEY);
          } catch (error) {
            meta.put(record.raw, LEGACY_RECOVERY_KEY);
            meta.put(storedRecoveryRecord({ ...record, reason: recoveryErrorMessage(error), recovered: false }), LEGACY_RECOVERY_INFO_KEY);
          }
        };
        recoveryRequest.onsuccess = () => { recovery = recoveryRequest.result; attemptRecovery(); };
        recoveryInfoRequest.onsuccess = () => { recoveryInfo = recoveryInfoRequest.result; attemptRecovery(); };
        canvasesRequest.onsuccess = () => { existingCanvases = canvasesRequest.result as DrawCanvas[]; attemptRecovery(); };
        pointerRequest.onsuccess = () => { activePointer = pointerRequest.result as ActiveCanvasPointer | undefined; attemptRecovery(); };
        recoveryRequest.onerror = recoveryInfoRequest.onerror = canvasesRequest.onerror = pointerRequest.onerror = () => { request.transaction!.abort(); };
      }
      if (event.oldVersion < 11) {
        // V2 treats a workspace as a single project board. Keep the oldest
        // canvas in its current workspace and move each additional canvas to
        // its own workspace without changing canvas/document identities.
        const libraryStore = request.transaction!.objectStore(WORKSPACE_LIBRARY_STORE);
        const workspaceReceipts = request.transaction!.objectStore(MCP_WORKSPACE_OPERATIONS_STORE);
        const workspaceRequest = workspaces.getAll();
        const canvasRequest = canvases.getAll();
        const libraryKeysRequest = libraryStore.getAllKeys();
        const libraryValuesRequest = libraryStore.getAll();
        const pointerRequest = meta.get(ACTIVE_POINTER_KEY);
        const revisionRequest = meta.get(WORKSPACE_CATALOG_REVISION_KEY);
        let pending = 6;
        let workspaceRows: DrawWorkspace[] = [];
        let canvasRows: DrawCanvas[] = [];
        let libraryKeys: IDBValidKey[] = [];
        let libraryRows: unknown[] = [];
        let pointer: ActiveCanvasPointer | undefined;
        let catalogRevision = 0;
        const migrateOneBoardWorkspaces = () => {
          pending -= 1;
          if (pending) return;
          try {
            const grouped = new Map<string, DrawCanvas[]>();
            for (const canvas of canvasRows) grouped.set(canvas.workspaceId, [...(grouped.get(canvas.workspaceId) ?? []), canvas]);
            let changed = false;
            for (const workspace of workspaceRows) {
              const owned = (grouped.get(workspace.id) ?? []).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
              if (!owned.length) {
                const now = Date.now();
                const document = createEmptyDocument("Untitled drawing");
                const canvas: DrawCanvas = { id: crypto.randomUUID(), workspaceId: workspace.id, name: "Untitled drawing", documentId: document.document.id, createdAt: now, updatedAt: now };
                documents.put(document, documentKey(document.document.id));
                canvases.put(canvas, canvas.id);
                changed = true;
                if (!pointer) {
                  pointer = { workspaceId: workspace.id, canvasId: canvas.id };
                  meta.put(pointer, ACTIVE_POINTER_KEY);
                  documents.put(document, CURRENT_DOCUMENT_KEY);
                }
                continue;
              }
              for (const canvas of owned.slice(1)) {
                const newWorkspace: DrawWorkspace = {
                  id: crypto.randomUUID(),
                  name: `${workspace.name} — ${canvas.name}`,
                  createdAt: canvas.createdAt,
                  updatedAt: canvas.updatedAt,
                };
                const reassignedCanvas = { ...canvas, workspaceId: newWorkspace.id };
                workspaces.put(newWorkspace, newWorkspace.id);
                canvases.put(reassignedCanvas, reassignedCanvas.id);
                if (pointer?.canvasId === canvas.id) {
                  pointer = { workspaceId: newWorkspace.id, canvasId: canvas.id };
                  meta.put(pointer, ACTIVE_POINTER_KEY);
                }
                const sourceLibraryIndex = libraryKeys.findIndex((key) => key === workspace.id);
                if (sourceLibraryIndex >= 0 && libraryRows[sourceLibraryIndex] !== undefined) {
                  const sourceLibrary = readStoredWorkspaceLibrary(libraryRows[sourceLibraryIndex]);
                  libraryStore.put({ items: sourceLibrary.items, revision: sourceLibrary.revision, receipts: {} } satisfies StoredWorkspaceLibrary, newWorkspace.id);
                }
                changed = true;
              }
            }
            if (changed) {
              meta.put(catalogRevision + 1, WORKSPACE_CATALOG_REVISION_KEY);
              meta.put(true, INITIALIZED_KEY);
              // Old operation receipts encode the old workspace/canvas relation.
              // Clearing all catalog receipts also makes stale retries fail their
              // expected revision check instead of replaying an obsolete result.
              workspaceReceipts.clear();
            }
          } catch {
            // A versionchange transaction is atomic. Do not let an unreadable
            // library or malformed row commit only part of the board split.
            request.transaction!.abort();
          }
        };
        workspaceRequest.onsuccess = () => { workspaceRows = workspaceRequest.result as DrawWorkspace[]; migrateOneBoardWorkspaces(); };
        canvasRequest.onsuccess = () => { canvasRows = canvasRequest.result as DrawCanvas[]; migrateOneBoardWorkspaces(); };
        libraryKeysRequest.onsuccess = () => { libraryKeys = libraryKeysRequest.result as IDBValidKey[]; migrateOneBoardWorkspaces(); };
        libraryValuesRequest.onsuccess = () => { libraryRows = libraryValuesRequest.result as unknown[]; migrateOneBoardWorkspaces(); };
        pointerRequest.onsuccess = () => { pointer = pointerRequest.result as ActiveCanvasPointer | undefined; migrateOneBoardWorkspaces(); };
        revisionRequest.onsuccess = () => { catalogRevision = Number.isSafeInteger(revisionRequest.result) ? Number(revisionRequest.result) : 0; migrateOneBoardWorkspaces(); };
        for (const item of [workspaceRequest, canvasRequest, libraryKeysRequest, libraryValuesRequest, pointerRequest, revisionRequest]) item.onerror = () => { request.transaction!.abort(); };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the Draw autosave database."));
    request.onblocked = () => reject(new Error("The Draw autosave database is blocked by another tab."));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the Draw document."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving the Draw document was cancelled."));
  });
}

function assertOperationResult(value: unknown): asserts value is DurableMcpOperationResult | DurableMcpTombstone {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The durable MCP operation ledger is malformed; refusing to replay or undo it.");
  const entry = value as Partial<DurableMcpOperation & DurableMcpTombstone>;
  if (typeof entry.documentId !== "string" || typeof entry.clientIdentity !== "string" || typeof entry.idempotencyKey !== "string"
    || typeof entry.payloadHash !== "string" || typeof entry.operationId !== "string" || !Number.isFinite(entry.completedAt)) {
    throw new Error("The durable MCP operation ledger is incomplete; refusing to replay or undo it.");
  }
  if (entry.tombstone === true) {
    if (!Number.isFinite(entry.expiredAt)) throw new Error("The MCP idempotency tombstone is malformed; refusing to replay it.");
    return;
  }
  if (entry.actor !== entry.clientIdentity || !Number.isSafeInteger(entry.baseRevision) || !Number.isSafeInteger(entry.resultingRevision)
    || entry.baseViewRevision !== undefined && !Number.isSafeInteger(entry.baseViewRevision)
    || entry.resultingViewRevision !== undefined && !Number.isSafeInteger(entry.resultingViewRevision)
    || typeof entry.result !== "object" || entry.result === null) {
    throw new Error("The durable MCP operation ledger is incomplete; refusing to replay or undo it.");
  }
}

function assertDurableMcpOperation(value: unknown): asserts value is DurableMcpOperation {
  assertOperationResult(value);
  const entry = value as DurableMcpOperation;
  if ("tombstone" in (value as object) || typeof entry.undoEligible !== "boolean" || !entry.beforeDocument || !entry.afterDocument) {
    throw new Error("The durable MCP history snapshot is incomplete; refusing to replay or undo it.");
  }
  validateDrawDocument(entry.beforeDocument);
  validateDrawDocument(entry.afterDocument);
  if (entry.beforeDocument.document.id !== entry.documentId || entry.afterDocument.document.id !== entry.documentId
    || entry.afterDocument.document.documentRevision !== entry.resultingRevision) {
    throw new Error("The durable MCP operation ledger does not match its document snapshots; refusing to replay or undo it.");
  }
}

/** Save the current editable scene locally; this is separate from image export. */
export async function saveCurrentDocument(document: DrawDocument, options: { replaceDocument?: boolean; writeToken?: AutosaveOrder } = {}): Promise<{ saved: boolean; document?: DrawDocument }> {
  validateDrawDocument(document);
  const writeOrder = options.writeToken ?? { sessionId: AUTOSAVE_SESSION_ID, sequence: ++autosaveSequence };
  const database = await openDatabase();
  try {
    const resolvedCanvas = await resolveActiveCanvas(database);
    if (!resolvedCanvas) {
      const metaTx = database.transaction(WORKSPACE_META_STORE, "readonly");
      const hasCanvasHistory = await requestValue<boolean | undefined>(metaTx.objectStore(WORKSPACE_META_STORE).get(INITIALIZED_KEY));
      await waitForTransaction(metaTx);
      if (hasCanvasHistory) throw new DrawStorageRecoveryError("There is no active canvas. Create a canvas before saving; the deleted document will not be recreated automatically.");
      const now = Date.now();
      const workspaceId = `workspace-${crypto.randomUUID()}`;
      const canvasId = `canvas-${crypto.randomUUID()}`;
      const tx = database.transaction([DOCUMENTS_STORE, WORKSPACES_STORE, CANVASES_STORE, WORKSPACE_META_STORE], "readwrite");
      tx.objectStore(DOCUMENTS_STORE).put(document, documentKey(document.document.id));
      tx.objectStore(WORKSPACES_STORE).put({ id: workspaceId, name: "My workspace", createdAt: now, updatedAt: now } satisfies DrawWorkspace, workspaceId);
      const initialCanvas = { id: canvasId, workspaceId, name: document.document.title, documentId: document.document.id, createdAt: now, updatedAt: now } satisfies DrawCanvas;
      tx.objectStore(CANVASES_STORE).put(initialCanvas, canvasId);
      tx.objectStore(WORKSPACE_META_STORE).put({ workspaceId, canvasId } satisfies ActiveCanvasPointer, ACTIVE_POINTER_KEY);
      tx.objectStore(WORKSPACE_META_STORE).put(true, INITIALIZED_KEY);
      tx.objectStore(DOCUMENTS_STORE).put(document, CURRENT_DOCUMENT_KEY);
      await waitForTransaction(tx);
      return { saved: true, document };
    }

    const transaction = database.transaction([DOCUMENTS_STORE, CANVASES_STORE, WORKSPACE_META_STORE, MCP_OPERATIONS_STORE, MCP_UNDO_STORE, MCP_REDO_STORE], "readwrite");
    const documents = transaction.objectStore(DOCUMENTS_STORE);
    const canvases = transaction.objectStore(CANVASES_STORE);
    const meta = transaction.objectStore(WORKSPACE_META_STORE);
    const operations = transaction.objectStore(MCP_OPERATIONS_STORE);
    const undo = transaction.objectStore(MCP_UNDO_STORE);
    const redo = transaction.objectStore(MCP_REDO_STORE);
    const activePointerRequest = meta.get(ACTIVE_POINTER_KEY);
    let activeCanvas: DrawCanvas | undefined;
    let current: DrawDocument | undefined;
    let previousOrder: AutosaveOrder | undefined;
    let readsRemaining = 0;
    let savedDocument: DrawDocument | undefined;
    let saveError: Error | undefined;
    const finishSave = () => {
      const pointer = activePointerRequest.result as ActiveCanvasPointer | undefined;
      const canvas = activeCanvas;
      // A switch or replacement between the preflight recovery and this
      // transaction is an ordinary stale autosave. The pointer, canvas, doc,
      // and write all belong to this transaction, so it cannot cross canvases.
      if (!pointer || !canvas || pointer.canvasId !== canvas.id) return;
      if (!current) {
        saveError = new DrawStorageRecoveryError("The active Draw canvas is damaged: its editable document is missing.");
        transaction.abort();
        return;
      }
      if (!options.replaceDocument && document.document.id !== canvas.documentId) return;
      if (!options.replaceDocument && current && (
        (current.document.documentRevision ?? 0) > (document.document.documentRevision ?? 0)
        || (current.document.documentRevision ?? 0) === (document.document.documentRevision ?? 0)
          && (current.document.viewRevision ?? 0) > (document.document.viewRevision ?? 0)
      )) return;
      if (!options.replaceDocument && current
        && (current.document.documentRevision ?? 0) === (document.document.documentRevision ?? 0)
        && (current.document.viewRevision ?? 0) === (document.document.viewRevision ?? 0)
        && JSON.stringify(current) !== JSON.stringify(document)
        && (autosaveSceneAndMetadata(current) !== autosaveSceneAndMetadata(document)
          || previousOrder?.sessionId === writeOrder.sessionId && previousOrder.sequence > writeOrder.sequence)) return;

      const next = structuredClone(document);
      if (options.replaceDocument) {
        next.document.id = crypto.randomUUID();
        next.document.documentRevision = Math.max(document.document.documentRevision, current.document.documentRevision + 1);
        next.document.viewRevision = Math.max(document.document.viewRevision, current.document.viewRevision + 1);
      }
      const oldDocumentId = canvas.documentId;
      const previousCanvasName = canvas.name;
      const nextCanvas = { ...canvas, documentId: next.document.id, name: next.document.title, updatedAt: Date.now() };
      if (options.replaceDocument) {
        documents.delete(documentKey(oldDocumentId));
        documents.delete(writeOrderKey(oldDocumentId));
        undo.delete(oldDocumentId);
        redo.delete(oldDocumentId);
        const keysRequest = operations.getAllKeys();
        const valuesRequest = operations.getAll();
        let ledgerReads = 2;
        const clearOldLedger = () => {
          ledgerReads -= 1;
          if (ledgerReads) return;
          (valuesRequest.result as Array<{ documentId?: string }>).forEach((value, index) => {
            if (value?.documentId === oldDocumentId) operations.delete((keysRequest.result as IDBValidKey[])[index]);
          });
          writeReplacement();
        };
        keysRequest.onsuccess = clearOldLedger;
        valuesRequest.onsuccess = clearOldLedger;
        keysRequest.onerror = valuesRequest.onerror = () => { saveError = new Error("Could not clean replaced document history."); transaction.abort(); };
      } else writeReplacement();

      function writeReplacement() {
        documents.put(next, documentKey(next.document.id));
        documents.put(writeOrder, writeOrderKey(next.document.id));
        documents.put(next, CURRENT_DOCUMENT_KEY);
        canvases.put(nextCanvas, nextCanvas.id);
        if (nextCanvas.name !== previousCanvasName) incrementWorkspaceCatalogRevision(meta);
        meta.put(true, INITIALIZED_KEY);
        savedDocument = next;
      }
    };
    activePointerRequest.onsuccess = () => {
      const pointer = activePointerRequest.result as ActiveCanvasPointer | undefined;
      if (!pointer) return;
      const activeCanvasRequest = canvases.get(pointer.canvasId);
      activeCanvasRequest.onsuccess = () => {
        activeCanvas = activeCanvasRequest.result as DrawCanvas | undefined;
        if (!activeCanvas) {
          saveError = new DrawStorageRecoveryError("The active Draw canvas pointer is damaged; no canvas row exists for it.");
          transaction.abort();
          return;
        }
        const currentRequest = documents.get(documentKey(activeCanvas.documentId));
        const orderRequest = documents.get(writeOrderKey(activeCanvas.documentId));
        readsRemaining = 2;
        const maybeFinish = () => { readsRemaining -= 1; if (readsRemaining === 0) finishSave(); };
        currentRequest.onsuccess = () => { current = currentRequest.result as DrawDocument | undefined; maybeFinish(); };
        orderRequest.onsuccess = () => { previousOrder = orderRequest.result as AutosaveOrder | undefined; maybeFinish(); };
        currentRequest.onerror = orderRequest.onerror = () => { saveError = new Error("Could not inspect the active Draw document before saving."); transaction.abort(); };
      };
      activeCanvasRequest.onerror = () => { saveError = activeCanvasRequest.error ?? new Error("Could not inspect the active Draw canvas."); transaction.abort(); };
    };
    activePointerRequest.onerror = () => { saveError = activePointerRequest.error ?? new Error("Could not inspect the active Draw canvas selection."); transaction.abort(); };
    try { await waitForTransaction(transaction); } catch (error) { throw saveError ?? error; }
    if (saveError) throw saveError;
    return savedDocument ? { saved: true, document: savedDocument } : { saved: false };
  } finally {
    database.close();
  }
}

/** Load the most recently autosaved editable scene, or null on first run. */
export async function loadCurrentDocument(): Promise<DrawDocument | null> {
  const database = await openDatabase();
  try {
    const active = await resolveActiveCanvas(database);
    if (!active) return null;
    const transaction = database.transaction(DOCUMENTS_STORE, "readonly");
    const value = await requestValue<unknown>(transaction.objectStore(DOCUMENTS_STORE).get(documentKey(active.documentId)));
    await waitForTransaction(transaction);
    if (value === undefined) throw new DrawStorageRecoveryError(`Canvas ${active.id} is damaged: its document disappeared during loading.`);
    validateDrawDocument(value);
    normalizeDrawImageAttributions(value, "trusted-storage");
    return value;
  } finally {
    database.close();
  }
}

/** Read the original quarantined value without replacing or consuming it. */
export async function loadLegacyDocumentRecovery(): Promise<LegacyDocumentRecovery | null> {
  const database = await openDatabase();
  try {
    const tx = database.transaction(WORKSPACE_META_STORE, "readonly");
    const meta = tx.objectStore(WORKSPACE_META_STORE);
    const [raw, info] = await Promise.all([
      requestValue<unknown>(meta.get(LEGACY_RECOVERY_KEY)),
      requestValue<unknown>(meta.get(LEGACY_RECOVERY_INFO_KEY)),
    ]);
    await waitForTransaction(tx);
    return raw === undefined ? null : recoveryRecord(raw, info);
  } finally { database.close(); }
}

/** Serialize the untouched quarantined value for a user-owned backup download. */
export async function exportLegacyDocumentRecovery(): Promise<string | null> {
  const recovery = await loadLegacyDocumentRecovery();
  if (!recovery) return null;
  try {
    const json = JSON.stringify(recovery.raw, null, 2);
    if (typeof json !== "string") throw new Error("Quarantined data is not representable as JSON.");
    return `${json}\n`;
  } catch (error) {
    throw new DrawStorageRecoveryError(`The quarantined data is still preserved, but could not be exported as JSON: ${recoveryErrorMessage(error)}`);
  }
}

/** Atomically establish a writable workspace while leaving the quarantine untouched. */
export async function createFreshWorkspaceFromRecovery(
  name: string,
  source?: DrawDocument,
): Promise<{ workspace: DrawWorkspace; canvas: DrawCanvas; document: DrawDocument }> {
  const workspaceName = name.trim() || "Recovered workspace";
  const now = Date.now();
  const workspace = { id: `workspace-${crypto.randomUUID()}`, name: workspaceName, createdAt: now, updatedAt: now } satisfies DrawWorkspace;
  const document = source ? structuredClone(source) : createEmptyDocument(workspaceName);
  document.document.id = crypto.randomUUID();
  document.document.title = document.document.title.trim() || workspaceName;
  document.document.documentRevision = 0;
  document.document.viewRevision = 0;
  validateDrawDocument(document);
  normalizeDrawImageAttributions(document, "trusted-storage");
  const canvas = { id: `canvas-${crypto.randomUUID()}`, workspaceId: workspace.id, name: document.document.title, documentId: document.document.id, createdAt: now, updatedAt: now } satisfies DrawCanvas;
  const database = await openDatabase();
  try {
    const tx = database.transaction([DOCUMENTS_STORE, WORKSPACES_STORE, CANVASES_STORE, WORKSPACE_META_STORE], "readwrite");
    const documents = tx.objectStore(DOCUMENTS_STORE);
    const workspaces = tx.objectStore(WORKSPACES_STORE);
    const canvases = tx.objectStore(CANVASES_STORE);
    const meta = tx.objectStore(WORKSPACE_META_STORE);
    workspaces.put(workspace, workspace.id);
    canvases.put(canvas, canvas.id);
    documents.put(document, documentKey(document.document.id));
    documents.put(document, CURRENT_DOCUMENT_KEY);
    documents.put({ sessionId: AUTOSAVE_SESSION_ID, sequence: ++autosaveSequence } satisfies AutosaveOrder, writeOrderKey(document.document.id));
    meta.put({ workspaceId: workspace.id, canvasId: canvas.id } satisfies ActiveCanvasPointer, ACTIVE_POINTER_KEY);
    meta.put(true, INITIALIZED_KEY);
    incrementWorkspaceCatalogRevision(meta);
    await waitForTransaction(tx);
    return { workspace, canvas, document };
  } finally { database.close(); }
}

/** List workspaces in creation order. Storage API intended for the V2 shell. */
export async function listWorkspaces(): Promise<DrawWorkspace[]> {
  return readAll<DrawWorkspace>(WORKSPACES_STORE);
}

export async function listCanvases(workspaceId: string): Promise<DrawCanvas[]> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(CANVASES_STORE, "readonly");
    const req = tx.objectStore(CANVASES_STORE).index("byWorkspaceId").getAll(workspaceId);
    const [items] = await Promise.all([requestValue<DrawCanvas[]>(req), waitForTransaction(tx)]);
    return items.sort((a, b) => a.createdAt - b.createdAt);
  } finally { db.close(); }
}

/** Return the active project catalog and its monotonic revision for MCP optimistic concurrency. */
export async function getMcpWorkspaceCatalog(): Promise<McpWorkspaceCatalog> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES_STORE, CANVASES_STORE, DOCUMENTS_STORE, WORKSPACE_META_STORE], "readonly");
    const workspacesRequest = tx.objectStore(WORKSPACES_STORE).getAll();
    const canvasesRequest = tx.objectStore(CANVASES_STORE).getAll();
    const pointerRequest = tx.objectStore(WORKSPACE_META_STORE).get(ACTIVE_POINTER_KEY);
    const revisionRequest = tx.objectStore(WORKSPACE_META_STORE).get(WORKSPACE_CATALOG_REVISION_KEY);
    const documentRequest = tx.objectStore(DOCUMENTS_STORE).get(CURRENT_DOCUMENT_KEY);
    const [workspaces, canvases, pointer, revision, activeDocument] = await Promise.all([
      requestValue<DrawWorkspace[]>(workspacesRequest), requestValue<DrawCanvas[]>(canvasesRequest),
      requestValue<ActiveCanvasPointer | undefined>(pointerRequest), requestValue<number | undefined>(revisionRequest),
      requestValue<DrawDocument | undefined>(documentRequest), waitForTransaction(tx),
    ]).then(([a, b, c, d, e]) => [a, b, c, d, e] as const);
    if (!pointer || !activeDocument) throw new DrawStorageRecoveryError("There is no active Draw canvas for MCP workspace operations.");
    validateDrawDocument(activeDocument);
    return {
      catalogRevision: Number.isSafeInteger(revision) ? revision! : 0,
      activeWorkspaceId: pointer.workspaceId,
      activeCanvasId: pointer.canvasId,
      activeDocument,
      workspaces: workspaces.sort((a, b) => a.createdAt - b.createdAt),
      canvases: canvases.sort((a, b) => a.createdAt - b.createdAt),
    };
  } finally { db.close(); }
}

export async function loadMcpWorkspaceOperationReceipt(
  clientIdentity: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<McpWorkspaceOperationResult | null> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([MCP_WORKSPACE_OPERATIONS_STORE, WORKSPACES_STORE, CANVASES_STORE, WORKSPACE_META_STORE, DOCUMENTS_STORE], "readonly");
    const key = JSON.stringify([clientIdentity, idempotencyKey]);
    const receiptRequest = tx.objectStore(MCP_WORKSPACE_OPERATIONS_STORE).get(key);
    const workspaceRequest = tx.objectStore(WORKSPACES_STORE).getAll();
    const canvasRequest = tx.objectStore(CANVASES_STORE).getAll();
    const pointerRequest = tx.objectStore(WORKSPACE_META_STORE).get(ACTIVE_POINTER_KEY);
    const revisionRequest = tx.objectStore(WORKSPACE_META_STORE).get(WORKSPACE_CATALOG_REVISION_KEY);
    const documentRequest = tx.objectStore(DOCUMENTS_STORE).get(CURRENT_DOCUMENT_KEY);
    const [receipt, workspaces, canvases, pointer, revision, activeDocument] = await Promise.all([
      requestValue<McpWorkspaceOperationReceipt | undefined>(receiptRequest), requestValue<DrawWorkspace[]>(workspaceRequest),
      requestValue<DrawCanvas[]>(canvasRequest), requestValue<ActiveCanvasPointer | undefined>(pointerRequest),
      requestValue<number | undefined>(revisionRequest), requestValue<DrawDocument | undefined>(documentRequest), waitForTransaction(tx),
    ]).then(([a, b, c, d, e, f]) => [a, b, c, d, e, f] as const);
    if (!receipt) return null;
    if (!Number.isFinite(receipt.completedAt) || receipt.completedAt < Date.now() - MCP_WORKSPACE_RECEIPT_RETENTION_MS) return null;
    if (receipt.payloadHash !== payloadHash) throw new Error("IDEMPOTENCY_KEY_REUSE: This key was already used with a different workspace payload.");
    if (!receipt.operation || !pointer || !activeDocument) throw new Error("The workspace MCP receipt or active catalog is malformed; refusing to replay it.");
    validateDrawDocument(activeDocument);
    const sortedWorkspaces = workspaces.sort((a, b) => a.createdAt - b.createdAt);
    const sortedCanvases = canvases.sort((a, b) => a.createdAt - b.createdAt);
    return {
      catalogRevision: Number.isSafeInteger(revision) ? revision! : 0,
      activeWorkspaceId: pointer.workspaceId,
      activeCanvasId: pointer.canvasId,
      activeDocument,
      workspaces: sortedWorkspaces,
      canvases: sortedCanvases,
      ...(receipt.operation.workspaceId ? { workspace: sortedWorkspaces.find((item) => item.id === receipt.operation.workspaceId) } : {}),
      ...(receipt.operation.canvasId ? { canvas: sortedCanvases.find((item) => item.id === receipt.operation.canvasId) } : {}),
      operation: { ...receipt.operation },
    };
  } finally { db.close(); }
}

/**
 * Apply a workspace/canvas MCP mutation and its durable replay receipt in one
 * IndexedDB transaction. A retry with the same caller/key returns the saved
 * result before checking the now-stale catalog revision.
 */
export async function commitMcpWorkspaceOperation(request: McpWorkspaceOperationRequest): Promise<McpWorkspaceOperationResult> {
  if (!request.clientIdentity || !request.idempotencyKey || !request.payloadHash) throw new Error("Workspace MCP operations require caller identity, idempotency key, and payload hash.");
  if (!Number.isSafeInteger(request.expectedCatalogRevision) || request.expectedCatalogRevision < 0) throw new Error("expectedCatalogRevision must be a non-negative integer.");
  if (request.action.type === "import_draw_file_as_canvas") validateDrawDocument(request.action.document);
  const db = await openDatabase();
  const receiptKey = JSON.stringify([request.clientIdentity, request.idempotencyKey]);
  return new Promise<McpWorkspaceOperationResult>((resolve, reject) => {
    const stores = [WORKSPACES_STORE, CANVASES_STORE, DOCUMENTS_STORE, WORKSPACE_META_STORE, WORKSPACE_LIBRARY_STORE, MCP_OPERATIONS_STORE, MCP_UNDO_STORE, MCP_REDO_STORE, MCP_WORKSPACE_OPERATIONS_STORE];
    const tx = db.transaction(stores, "readwrite");
    const workspaceStore = tx.objectStore(WORKSPACES_STORE);
    const canvasStore = tx.objectStore(CANVASES_STORE);
    const documents = tx.objectStore(DOCUMENTS_STORE);
    const libraryStore = tx.objectStore(WORKSPACE_LIBRARY_STORE);
    const meta = tx.objectStore(WORKSPACE_META_STORE);
    const receipts = tx.objectStore(MCP_WORKSPACE_OPERATIONS_STORE);
    let failure: Error | undefined;
    let result: McpWorkspaceOperationResult | undefined;
    let activeDocument: DrawDocument | undefined;
    let activePointer: ActiveCanvasPointer | undefined;
    let workspaces: DrawWorkspace[] = [];
    let canvases: DrawCanvas[] = [];
    let originalCanvases: DrawCanvas[] = [];
    let currentRevision = 0;
    let processing = false;
    const abort = (error: unknown) => {
      if (failure) return;
      failure = error instanceof Error ? error : new Error(String(error));
      try { tx.abort(); } catch { /* the transaction may already be closing */ }
    };
    const now = () => Date.now();
    const makeCanvas = (workspaceId: string, name: string, source?: DrawDocument): { canvas: DrawCanvas; document: DrawDocument } => {
      const title = name.trim() || "Untitled canvas";
      const doc = source ? structuredClone(source) : createEmptyDocument(title);
      validateDrawDocument(doc);
      const canvas: DrawCanvas = { id: crypto.randomUUID(), workspaceId, name: title, documentId: crypto.randomUUID(), createdAt: now(), updatedAt: now() };
      doc.document.id = canvas.documentId;
      doc.document.title = title;
      doc.document.documentRevision = 0;
      doc.document.viewRevision = 0;
      documents.put(doc, documentKey(doc.document.id));
      canvasStore.put(canvas, canvas.id);
      canvases.push(canvas);
      return { canvas, document: doc };
    };
    const setActive = (canvas: DrawCanvas, doc: DrawDocument) => {
      activePointer = { workspaceId: canvas.workspaceId, canvasId: canvas.id };
      activeDocument = doc;
      meta.put(activePointer, ACTIVE_POINTER_KEY);
      documents.put(doc, CURRENT_DOCUMENT_KEY);
      documents.delete(CURRENT_WRITE_ORDER_KEY);
    };
    const readCanvasDocument = (canvas: DrawCanvas, callback: (doc: DrawDocument) => void) => {
      const docRequest = documents.get(documentKey(canvas.documentId));
      docRequest.onerror = () => abort(docRequest.error ?? new Error("Could not read the canvas document."));
      docRequest.onsuccess = () => {
        try {
          const doc = docRequest.result as DrawDocument | undefined;
          if (!doc) throw new DrawStorageRecoveryError(`Canvas ${canvas.id} is damaged: its editable document is missing.`);
          validateDrawDocument(doc);
          callback(doc);
        } catch (error) { abort(error); }
      };
    };
    const finalize = (workspace?: DrawWorkspace, canvas?: DrawCanvas) => {
      if (failure || !activePointer || !activeDocument) { if (!failure) abort(new DrawStorageRecoveryError("Workspace operation left Draw without an active canvas.")); return; }
      const nextRevision = currentRevision + 1;
      meta.put(nextRevision, WORKSPACE_CATALOG_REVISION_KEY);
      workspaces.sort((a, b) => a.createdAt - b.createdAt);
      canvases.sort((a, b) => a.createdAt - b.createdAt);
      result = {
        catalogRevision: nextRevision,
        activeWorkspaceId: activePointer.workspaceId,
        activeCanvasId: activePointer.canvasId,
        activeDocument,
        ...(workspace ? { workspace } : {}),
        ...(canvas ? { canvas } : {}),
        workspaces: structuredClone(workspaces),
        canvases: structuredClone(canvases),
        operation: {
          type: request.action.type,
          ...(request.action.type !== "delete_workspace" && request.action.type !== "delete_canvas" && workspace ? { workspaceId: workspace.id } : {}),
          ...(request.action.type !== "delete_workspace" && request.action.type !== "delete_canvas" && canvas ? { canvasId: canvas.id } : {}),
          committedCatalogRevision: nextRevision,
        },
      };
      const receipt: McpWorkspaceOperationReceipt = {
        clientIdentity: request.clientIdentity,
        idempotencyKey: request.idempotencyKey,
        payloadHash: request.payloadHash,
        completedAt: now(),
        operation: { ...result.operation!, committedCatalogRevision: nextRevision },
        workspaceIds: result.operation?.workspaceId ? [result.operation.workspaceId] : [],
        canvasIds: result.operation?.canvasId ? [result.operation.canvasId] : [],
      };
      receipts.put(receipt, receiptKey);
      const keysRequest = receipts.getAllKeys();
      const valuesRequest = receipts.getAll();
      let pendingPruneReads = 2;
      const pruneReceipts = () => {
        pendingPruneReads -= 1;
        if (pendingPruneReads) return;
        const keys = keysRequest.result as IDBValidKey[];
        const rows = valuesRequest.result as McpWorkspaceOperationReceipt[];
        const cutoff = now() - MCP_WORKSPACE_RECEIPT_RETENTION_MS;
        const keep = rows.map((row, index) => ({ row, key: keys[index] }))
          .filter(({ row }) => row?.completedAt >= cutoff)
          .sort((a, b) => (b.row.operation?.committedCatalogRevision ?? 0) - (a.row.operation?.committedCatalogRevision ?? 0))
          .slice(0, MCP_WORKSPACE_RECEIPT_LIMIT);
        const kept = new Set(keep.map(({ key }) => JSON.stringify(key)));
        keys.forEach((key) => { if (!kept.has(JSON.stringify(key))) receipts.delete(key); });
      };
      keysRequest.onsuccess = valuesRequest.onsuccess = pruneReceipts;
    };
    const selectFirstCanvas = (workspace: DrawWorkspace, callback: (canvas: DrawCanvas, doc: DrawDocument) => void) => {
      const candidate = canvases.filter((item) => item.workspaceId === workspace.id).sort((a, b) => a.createdAt - b.createdAt)[0]
        ?? makeCanvas(workspace.id, "Untitled drawing").canvas;
      readCanvasDocument(candidate, (doc) => callback(candidate, doc));
    };
    const createWorkspaceBoard = (sourceWorkspace: DrawWorkspace, workspaceName: string, canvasName: string, source?: DrawDocument) => {
      const libraryRequest = libraryStore.get(sourceWorkspace.id);
      libraryRequest.onerror = () => abort(libraryRequest.error ?? new Error("Could not copy the workspace library."));
      libraryRequest.onsuccess = () => {
        try {
          const timestamp = now();
          const createdWorkspace: DrawWorkspace = { id: crypto.randomUUID(), name: workspaceName.trim() || "Untitled workspace", createdAt: timestamp, updatedAt: timestamp };
          workspaceStore.put(createdWorkspace, createdWorkspace.id);
          workspaces.push(createdWorkspace);
          if (libraryRequest.result !== undefined) {
            libraryStore.put(copyWorkspaceLibraryForNewWorkspace(libraryRequest.result), createdWorkspace.id);
          }
          const created = makeCanvas(createdWorkspace.id, canvasName, source);
          setActive(created.canvas, created.document);
          finalize(createdWorkspace, created.canvas);
        } catch (error) { abort(error); }
      };
    };
    const apply = () => {
      if (processing || failure) return;
      processing = true;
      try {
        const receipt = tx.objectStore(MCP_WORKSPACE_OPERATIONS_STORE).get(receiptKey);
        // The initial receipt check is asynchronous; this is a continuation so
        // the mutation and receipt remain in this same transaction.
        receipt.onerror = () => abort(receipt.error ?? new Error("Could not read workspace MCP operation receipt."));
        receipt.onsuccess = () => {
          const findWorkspace = (id: string) => workspaces.find((item) => item.id === id);
          const findCanvas = (id: string) => canvases.find((item) => item.id === id);
          const stored = receipt.result as McpWorkspaceOperationReceipt | undefined;
          if (stored) {
            if (!Number.isFinite(stored.completedAt) || stored.completedAt < now() - MCP_WORKSPACE_RECEIPT_RETENTION_MS) {
              receipts.delete(receiptKey);
            } else {
            if (stored.payloadHash !== request.payloadHash) { abort(new Error("IDEMPOTENCY_KEY_REUSE: This key was already used with a different workspace payload.")); return; }
            if (!stored.operation || !activePointer || !activeDocument) { abort(new Error("The workspace MCP receipt or active catalog is malformed; refusing to replay it.")); return; }
            const operationWorkspace = stored.operation.workspaceId ? findWorkspace(stored.operation.workspaceId) : undefined;
            const operationCanvas = stored.operation.canvasId ? findCanvas(stored.operation.canvasId) : undefined;
            result = {
              catalogRevision: currentRevision,
              activeWorkspaceId: activePointer.workspaceId,
              activeCanvasId: activePointer.canvasId,
              activeDocument: structuredClone(activeDocument),
              workspaces: structuredClone(workspaces),
              canvases: structuredClone(canvases),
              ...(operationWorkspace ? { workspace: structuredClone(operationWorkspace) } : {}),
              ...(operationCanvas ? { canvas: structuredClone(operationCanvas) } : {}),
              operation: { ...stored.operation },
            };
            return;
            }
          }
          if (currentRevision !== request.expectedCatalogRevision) {
            abort(new Error(`CONFLICT: Workspace catalog revision is ${currentRevision}, expected ${request.expectedCatalogRevision}. Read the workspace list and retry.`));
            return;
          }
          const action = request.action;
          switch (action.type) {
            case "create_workspace": {
              const timestamp = now();
              const created: DrawWorkspace = { id: crypto.randomUUID(), name: action.name.trim() || "Untitled workspace", createdAt: timestamp, updatedAt: timestamp };
              workspaceStore.put(created, created.id); workspaces.push(created);
              const createdDoc = makeCanvas(created.id, "Untitled drawing");
              setActive(createdDoc.canvas, createdDoc.document); finalize(created, createdDoc.canvas); break;
            }
            case "rename_workspace": {
              const target = findWorkspace(action.workspaceId);
              if (!target) { abort(new Error("Workspace does not exist.")); break; }
              const renamed = { ...target, name: action.name.trim() || "Untitled workspace", updatedAt: now() };
              workspaceStore.put(renamed, renamed.id); workspaces = workspaces.map((item) => item.id === renamed.id ? renamed : item);
              finalize(renamed); break;
            }
            case "select_workspace": {
              const target = findWorkspace(action.workspaceId);
              if (!target) { abort(new Error("Workspace does not exist.")); break; }
              selectFirstCanvas(target, (canvas, doc) => { setActive(canvas, doc); finalize(target, canvas); }); break;
            }
            case "create_canvas": {
              const target = findWorkspace(action.workspaceId);
              if (!target) { abort(new Error("Workspace does not exist.")); break; }
              const name = action.name.trim() || "Untitled drawing";
              createWorkspaceBoard(target, name, name); break;
            }
            case "rename_canvas": {
              const target = findCanvas(action.canvasId);
              if (!target) { abort(new Error("Canvas does not exist.")); break; }
              readCanvasDocument(target, (doc) => {
                const nextName = action.name.trim() || "Untitled canvas";
                doc.document.title = nextName; doc.document.documentRevision += 1;
                const renamed = { ...target, name: nextName, updatedAt: now() };
                documents.put(doc, documentKey(doc.document.id)); canvasStore.put(renamed, renamed.id);
                canvases = canvases.map((item) => item.id === renamed.id ? renamed : item);
                const owner = findWorkspace(target.workspaceId);
                if (activePointer?.canvasId === target.id) setActive(renamed, doc);
                finalize(owner, renamed);
              }); break;
            }
            case "duplicate_canvas": {
              const target = findCanvas(action.canvasId);
              if (!target) { abort(new Error("Canvas does not exist.")); break; }
              readCanvasDocument(target, (doc) => {
                const name = action.name?.trim() || `${target.name} copy`;
                const sourceWorkspace = findWorkspace(target.workspaceId);
                if (!sourceWorkspace) { abort(new Error("The canvas workspace does not exist.")); return; }
                createWorkspaceBoard(sourceWorkspace, name, name, doc);
              }); break;
            }
            case "select_canvas": {
              const target = findCanvas(action.canvasId);
              if (!target || target.workspaceId !== action.workspaceId) { abort(new Error("Canvas does not exist in the requested workspace.")); break; }
              readCanvasDocument(target, (doc) => { setActive(target, doc); finalize(findWorkspace(target.workspaceId), target); }); break;
            }
            case "import_draw_file_as_canvas": {
              const target = findWorkspace(action.workspaceId);
              if (!target) { abort(new Error("Workspace does not exist.")); break; }
              const name = action.name?.trim() || action.document.document.title;
              createWorkspaceBoard(target, name, name, action.document); break;
            }
            case "delete_canvas": {
              if (!findCanvas(action.canvasId)) { abort(new Error("Canvas does not exist.")); break; }
              abort(new Error("A workspace contains one board. To remove this drawing, approve and use delete_workspace so its library and history are included."));
              break;
            }
            case "delete_workspace": {
              const target = findWorkspace(action.workspaceId);
              if (!target) { abort(new Error("Workspace does not exist.")); break; }
              const deleted = canvases.filter((item) => item.workspaceId === target.id);
              workspaces = workspaces.filter((item) => item.id !== target.id); workspaceStore.delete(target.id);
              tx.objectStore(WORKSPACE_LIBRARY_STORE).delete(target.id);
              canvases = canvases.filter((item) => item.workspaceId !== target.id);
              for (const canvas of deleted) {
                canvasStore.delete(canvas.id); documents.delete(documentKey(canvas.documentId)); documents.delete(writeOrderKey(canvas.documentId));
                tx.objectStore(MCP_UNDO_STORE).delete(canvas.documentId); tx.objectStore(MCP_REDO_STORE).delete(canvas.documentId);
              }
              if (activePointer?.workspaceId !== target.id) { finalize(); break; }
              let nextWorkspace = workspaces.sort((a, b) => a.createdAt - b.createdAt)[0];
              if (!nextWorkspace) {
                const timestamp = now(); nextWorkspace = { id: crypto.randomUUID(), name: "My workspace", createdAt: timestamp, updatedAt: timestamp };
                workspaces.push(nextWorkspace); workspaceStore.put(nextWorkspace, nextWorkspace.id);
              }
              selectFirstCanvas(nextWorkspace, (canvas, doc) => { setActive(canvas, doc); finalize(nextWorkspace, canvas); }); break;
            }
          }
        };
      } catch (error) { abort(error); }
    };
    const [revisionRequest, pointerRequest, workspacesRequest, canvasesRequest, aliasRequest] = [
      meta.get(WORKSPACE_CATALOG_REVISION_KEY), meta.get(ACTIVE_POINTER_KEY),
      workspaceStore.getAll(), canvasStore.getAll(), documents.get(CURRENT_DOCUMENT_KEY),
    ];
    let remaining = 5;
    const ready = () => { remaining -= 1; if (remaining !== 0) return; };
    for (const requestItem of [revisionRequest, pointerRequest, workspacesRequest, canvasesRequest, aliasRequest]) requestItem.onerror = () => abort(requestItem.error ?? new Error("Could not inspect workspace catalog."));
    revisionRequest.onsuccess = () => { currentRevision = Number.isSafeInteger(revisionRequest.result) ? revisionRequest.result as number : 0; ready(); };
    pointerRequest.onsuccess = () => { activePointer = pointerRequest.result as ActiveCanvasPointer | undefined; ready(); };
    workspacesRequest.onsuccess = () => { workspaces = workspacesRequest.result as DrawWorkspace[]; ready(); };
    canvasesRequest.onsuccess = () => { canvases = canvasesRequest.result as DrawCanvas[]; originalCanvases = [...canvases]; ready(); };
    aliasRequest.onsuccess = () => { activeDocument = aliasRequest.result as DrawDocument | undefined; ready(); };
    tx.oncomplete = () => { db.close(); if (failure) reject(failure); else if (result) resolve(result); else reject(new Error("Workspace operation completed without a result.")); };
    tx.onerror = tx.onabort = () => { db.close(); reject(failure ?? tx.error ?? new Error("Workspace MCP operation was cancelled.")); };
    // Define an atomic ledger cleanup helper after initial catalog reads, then
    // apply. (The helper body is assigned in the continuation below.)
    const kick = () => {
      if (remaining !== 0 || processing) return;
      const action = request.action;
      if (action.type === "delete_canvas" || action.type === "delete_workspace") {
        const keysRequest = tx.objectStore(MCP_OPERATIONS_STORE).getAllKeys();
        const valuesRequest = tx.objectStore(MCP_OPERATIONS_STORE).getAll();
        let left = 2;
        const prune = () => {
          left -= 1; if (left) return;
          const deletedCanvases = action.type === "delete_canvas"
            ? originalCanvases.filter((item) => item.id === action.canvasId)
            : originalCanvases.filter((item) => item.workspaceId === action.workspaceId);
          const ids = new Set(deletedCanvases.map((item) => item.documentId));
          (valuesRequest.result as Array<{ documentId?: string }>).forEach((item, index) => {
            if (item?.documentId && ids.has(item.documentId)) tx.objectStore(MCP_OPERATIONS_STORE).delete((keysRequest.result as IDBValidKey[])[index]);
          });
            const workspaceReceiptStore = tx.objectStore(MCP_WORKSPACE_OPERATIONS_STORE);
            const receiptKeys = workspaceReceiptStore.getAllKeys();
            const receiptValues = workspaceReceiptStore.getAll();
            let receiptReads = 2;
            const pruneWorkspaceReceipts = () => {
              receiptReads -= 1; if (receiptReads) return;
              const removedCanvasIds = new Set(deletedCanvases.map((item) => item.id));
              const removedWorkspaceIds = action.type === "delete_workspace" ? new Set([action.workspaceId]) : new Set<string>();
              (receiptValues.result as Array<Partial<McpWorkspaceOperationReceipt>>).forEach((receipt, index) => {
                const refersToRemovedWorkspace = (receipt.workspaceIds ?? []).some((id) => removedWorkspaceIds.has(id));
                const refersToRemovedCanvas = (receipt.canvasIds ?? []).some((id) => removedCanvasIds.has(id));
                if (refersToRemovedWorkspace || refersToRemovedCanvas) workspaceReceiptStore.delete((receiptKeys.result as IDBValidKey[])[index]);
              });
              apply();
            };
            receiptKeys.onsuccess = receiptValues.onsuccess = pruneWorkspaceReceipts;
            receiptKeys.onerror = receiptValues.onerror = () => abort(new Error("Could not inspect workspace MCP receipts before deletion."));
        };
        keysRequest.onsuccess = valuesRequest.onsuccess = prune;
        keysRequest.onerror = valuesRequest.onerror = () => abort(new Error("Could not inspect document history before deletion."));
      } else apply();
    };
    // Use request completion ordering to defer mutations until every initial
    // row is available; transaction remains live because all events are IDB callbacks.
    for (const item of [revisionRequest, pointerRequest, workspacesRequest, canvasesRequest, aliasRequest]) {
      const original = item.onsuccess;
      item.onsuccess = (event) => { original?.call(item, event); kick(); };
    }
  });
}

function libraryReceiptKey(clientIdentity: string, idempotencyKey: string): string {
  return JSON.stringify([clientIdentity, idempotencyKey]);
}

function compactLibraryReceiptResult(result: Record<string, unknown>): Record<string, unknown> {
  const item = result.item && typeof result.item === "object" ? result.item as Partial<DrawLibraryItem> : undefined;
  return {
    ...(item?.id || typeof result.itemId === "string" ? { itemId: item?.id ?? result.itemId as string } : {}),
    ...(item?.name || typeof result.itemName === "string" ? { itemName: item?.name ?? result.itemName as string } : {}),
    ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "item" && key !== "itemId")),
  };
}

function readStoredWorkspaceLibrary(value: unknown): StoredWorkspaceLibrary {
  if (Array.isArray(value)) return { items: structuredClone(value as DrawLibraryItem[]), revision: 0, receipts: {} };
  if (!value || typeof value !== "object") return { items: [], revision: 0, receipts: {} };
  const record = value as Partial<StoredWorkspaceLibrary>;
  if (!Array.isArray(record.items) || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
    throw new DrawStorageRecoveryError("The workspace library record is damaged.");
  }
  return {
    items: structuredClone(record.items),
    revision: record.revision as number,
    receipts: record.receipts && typeof record.receipts === "object" ? structuredClone(record.receipts) : {},
  };
}

function copyWorkspaceLibraryForNewWorkspace(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return { items: structuredClone(value), revision: 0, receipts: {} } satisfies StoredWorkspaceLibrary;
  if (!value || typeof value !== "object") return structuredClone(value);
  const record = structuredClone(value) as Record<string, unknown>;
  delete record.receipts;
  if (Array.isArray(record.items)) {
    return { ...record, revision: Number.isSafeInteger(record.revision) && Number(record.revision) >= 0 ? record.revision : 0, receipts: {} };
  }
  return record;
}

function normalizeLibraryItems(items: readonly DrawLibraryItem[]): DrawLibraryItem[] {
  const normalized = items.map((item) => {
    if (!item || typeof item.id !== "string" || !item.id || !Array.isArray(item.elements) || !Number.isFinite(item.created)) {
      throw new Error("The Draw library item is invalid.");
    }
    return structuredClone({ ...item, assets: item.assets ?? {} });
  });
  const ids = new Set<string>();
  for (const item of normalized) {
    if (ids.has(item.id)) throw new Error("Draw library item IDs must be unique within a workspace.");
    ids.add(item.id);
  }
  return normalized;
}

/** Load the reusable element library and compare-and-swap revision for a workspace. */
export async function loadWorkspaceLibraryState(workspaceId: string): Promise<WorkspaceLibraryState> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES_STORE, WORKSPACE_LIBRARY_STORE], "readonly");
    const workspaceRequest = tx.objectStore(WORKSPACES_STORE).get(workspaceId);
    const libraryRequest = tx.objectStore(WORKSPACE_LIBRARY_STORE).get(workspaceId);
    const [workspace, value] = await Promise.all([
      requestValue<DrawWorkspace | undefined>(workspaceRequest),
      requestValue<unknown>(libraryRequest),
      waitForTransaction(tx),
    ]);
    if (!workspace) throw new Error("Workspace does not exist.");
    const state = readStoredWorkspaceLibrary(value);
    return { items: state.items, revision: state.revision };
  } finally { db.close(); }
}

export async function loadWorkspaceLibrary(workspaceId: string): Promise<DrawLibraryItem[]> {
  return (await loadWorkspaceLibraryState(workspaceId)).items;
}

/** Replace a legacy/editor library snapshot only if its caller holds the current revision. */
export async function saveWorkspaceLibrary(workspaceId: string, items: readonly DrawLibraryItem[], expectedRevision: number): Promise<WorkspaceLibraryState> {
  const normalized = normalizeLibraryItems(items);
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES_STORE, WORKSPACE_LIBRARY_STORE], "readwrite");
    const workspaceRequest = tx.objectStore(WORKSPACES_STORE).get(workspaceId);
    const libraryRequest = tx.objectStore(WORKSPACE_LIBRARY_STORE).get(workspaceId);
    let failure: Error | undefined;
    let reads = 2;
    let workspaceExists = false;
    let current: StoredWorkspaceLibrary = { items: [], revision: 0, receipts: {} };
    let result: WorkspaceLibraryState | undefined;
    const finish = () => {
      reads -= 1;
      if (reads) return;
      if (!workspaceExists) { failure = new Error("Workspace does not exist."); tx.abort(); return; }
      try {
        if (current.revision !== expectedRevision) throw new WorkspaceLibraryConflictError("The workspace library changed. Reload it and retry.", "LIBRARY_REVISION_CONFLICT");
        if (JSON.stringify(current.items) !== JSON.stringify(normalized)) {
          current = { ...current, items: normalized, revision: current.revision + 1 };
          tx.objectStore(WORKSPACE_LIBRARY_STORE).put(current, workspaceId);
        }
        result = { items: current.items, revision: current.revision };
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
    };
    workspaceRequest.onsuccess = () => { workspaceExists = Boolean(workspaceRequest.result); finish(); };
    libraryRequest.onsuccess = () => { current = readStoredWorkspaceLibrary(libraryRequest.result); finish(); };
    workspaceRequest.onerror = libraryRequest.onerror = () => { failure = new Error("Could not read the workspace library."); tx.abort(); };
    try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
    if (!result) throw new Error("Could not save the workspace library.");
    return result;
  } finally { db.close(); }
}

export async function addWorkspaceLibraryItem(workspaceId: string, item: DrawLibraryItem | (() => DrawLibraryItem), context: WorkspaceLibraryMutationContext): Promise<WorkspaceLibraryMutationResult> {
  return mutateWorkspaceLibrary(workspaceId, context, (items) => {
    const normalized = normalizeLibraryItems([typeof item === "function" ? item() : item])[0];
    const existing = items.find((saved) => saved.id === normalized.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) throw new WorkspaceLibraryConflictError("A library item with this ID already exists.", "LIBRARY_REVISION_CONFLICT");
    return { items: existing ? items : [normalized, ...items], result: { item: existing ?? normalized, alreadyAdded: Boolean(existing) }, changed: !existing };
  });
}

export async function renameWorkspaceLibraryItem(workspaceId: string, itemId: string, name: string, context: WorkspaceLibraryMutationContext): Promise<WorkspaceLibraryMutationResult> {
  return mutateWorkspaceLibrary(workspaceId, context, (items) => {
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new Error("Library item does not exist.");
    const previousName = items[index].name;
    const normalizedName = name.trim() || "Untitled library item";
    const renamed = { ...items[index], name: normalizedName };
    items[index] = renamed;
    return { items, result: { item: renamed, renamed: true }, changed: previousName !== normalizedName };
  });
}

export async function deleteWorkspaceLibraryItem(workspaceId: string, itemId: string, context: WorkspaceLibraryMutationContext): Promise<WorkspaceLibraryMutationResult> {
  return mutateWorkspaceLibrary(workspaceId, context, (items) => {
    const remaining = items.filter((item) => item.id !== itemId);
    return { items: remaining, result: { itemId, deleted: remaining.length !== items.length }, changed: remaining.length !== items.length };
  });
}

async function mutateWorkspaceLibrary(
  workspaceId: string,
  context: WorkspaceLibraryMutationContext,
  mutate: (items: DrawLibraryItem[]) => { items: DrawLibraryItem[]; result: Record<string, unknown>; changed: boolean },
): Promise<WorkspaceLibraryMutationResult> {
  if (!context.clientIdentity || !context.idempotencyKey || !context.payloadHash || !Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0) {
    throw new Error("Workspace library mutation context is invalid.");
  }
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES_STORE, WORKSPACE_LIBRARY_STORE], "readwrite");
    const workspaceRequest = tx.objectStore(WORKSPACES_STORE).get(workspaceId);
    const libraryRequest = tx.objectStore(WORKSPACE_LIBRARY_STORE).get(workspaceId);
    let reads = 2;
    let failure: Error | undefined;
    let workspaceExists = false;
    let current: StoredWorkspaceLibrary = { items: [], revision: 0, receipts: {} };
    let result: WorkspaceLibraryMutationResult | undefined;
    const finish = () => {
      reads -= 1;
      if (reads) return;
      if (!workspaceExists) { failure = new Error("Workspace does not exist."); tx.abort(); return; }
      try {
        const key = libraryReceiptKey(context.clientIdentity, context.idempotencyKey);
        const receipt = current.receipts[key];
        if (receipt) {
          if (receipt.payloadHash !== context.payloadHash) throw new WorkspaceLibraryConflictError("This idempotency key was already used with a different library operation.", "IDEMPOTENCY_KEY_REUSE");
          result = { items: current.items, revision: current.revision, result: structuredClone(receipt.result), replayed: true };
          return;
        }
        if (current.revision !== context.expectedRevision) throw new WorkspaceLibraryConflictError("The workspace library changed. Read its latest revision and retry.", "LIBRARY_REVISION_CONFLICT");
        const mutation = mutate(structuredClone(current.items));
        const nextRevision = mutation.changed ? current.revision + 1 : current.revision;
        const nextResult = structuredClone(compactLibraryReceiptResult({ ...mutation.result, libraryRevision: nextRevision }));
        const completedAt = Date.now();
        const receipts = {
          ...Object.fromEntries(Object.entries(current.receipts)
            .filter(([, receipt]) => Number.isFinite(receipt?.completedAt) && receipt.completedAt >= completedAt - LIBRARY_OPERATION_RECEIPT_RETENTION_MS)
            .map(([receiptKey, receipt]) => [receiptKey, { ...receipt, result: compactLibraryReceiptResult(receipt.result ?? {}) }])),
          [key]: { clientIdentity: context.clientIdentity, idempotencyKey: context.idempotencyKey, payloadHash: context.payloadHash, result: nextResult, revision: nextRevision, completedAt },
        };
        const boundedReceipts = Object.fromEntries(Object.entries(receipts)
          .sort(([, left], [, right]) => left.completedAt - right.completedAt)
          .slice(-MAX_LIBRARY_OPERATION_RECEIPTS));
        current = { items: normalizeLibraryItems(mutation.items), revision: nextRevision, receipts: boundedReceipts };
        tx.objectStore(WORKSPACE_LIBRARY_STORE).put(current, workspaceId);
        result = { items: current.items, revision: nextRevision, result: nextResult, replayed: false };
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
    };
    workspaceRequest.onsuccess = () => { workspaceExists = Boolean(workspaceRequest.result); finish(); };
    libraryRequest.onsuccess = () => { current = readStoredWorkspaceLibrary(libraryRequest.result); finish(); };
    workspaceRequest.onerror = libraryRequest.onerror = () => { failure = new Error("Could not read the workspace library."); tx.abort(); };
    try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
    if (!result) throw new Error("Could not commit the workspace library mutation.");
    return result;
  } finally { db.close(); }
}

async function readAll<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  try { const tx = db.transaction(storeName, "readonly"); const req = tx.objectStore(storeName).getAll(); const [items] = await Promise.all([requestValue<T[]>(req), waitForTransaction(tx)]); return items.sort((a: any, b: any) => a.createdAt - b.createdAt); }
  finally { db.close(); }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed.")); }); }

function incrementWorkspaceCatalogRevision(meta: IDBObjectStore): void {
  const request = meta.get(WORKSPACE_CATALOG_REVISION_KEY);
  request.onsuccess = () => meta.put((Number.isSafeInteger(request.result) ? Number(request.result) : 0) + 1, WORKSPACE_CATALOG_REVISION_KEY);
}

/** Repair a missing/dangling active pointer by selecting the first intact canvas. */
async function resolveActiveCanvas(database: IDBDatabase): Promise<DrawCanvas | null> {
  const tx = database.transaction([CANVASES_STORE, DOCUMENTS_STORE, WORKSPACE_META_STORE], "readwrite");
  const canvasesStore = tx.objectStore(CANVASES_STORE);
  const documents = tx.objectStore(DOCUMENTS_STORE);
  const meta = tx.objectStore(WORKSPACE_META_STORE);
  const pointerRequest = meta.get(ACTIVE_POINTER_KEY);
  const canvasesRequest = canvasesStore.getAll();
  const recoveryRequest = meta.get(LEGACY_RECOVERY_KEY);
  let reads = 3;
  let pointer: ActiveCanvasPointer | undefined;
  let canvases: DrawCanvas[] = [];
  let recovery: unknown;
  let result: DrawCanvas | null = null;
  let failure: Error | undefined;
  const inspect = () => {
    reads -= 1;
    if (reads) return;
    const candidates = canvases.sort((a, b) => a.createdAt - b.createdAt);
    if (pointer) {
      const active = candidates.find((canvas) => canvas.id === pointer!.canvasId && canvas.workspaceId === pointer!.workspaceId);
      if (active) candidates.splice(candidates.indexOf(active), 1), candidates.unshift(active);
    }
    let index = 0;
    const checkNext = () => {
      const candidate = candidates[index++];
      if (!candidate) {
        if (canvases.length) failure = new DrawStorageRecoveryError("Draw storage is damaged: canvases exist, but none has a valid editable document. The stored data was left untouched for recovery.");
        else if (recovery !== undefined) failure = new DrawStorageRecoveryError("The previous Draw document is damaged and was quarantined. The database is available, but the document needs recovery before editing.");
        return;
      }
      const docRequest = documents.get(documentKey(candidate.documentId));
      docRequest.onsuccess = () => {
        try {
          if (!docRequest.result) throw new Error("missing");
          validateDrawDocument(docRequest.result);
          result = candidate;
          const nextPointer = { workspaceId: candidate.workspaceId, canvasId: candidate.id } satisfies ActiveCanvasPointer;
          if (pointer?.canvasId !== candidate.id || pointer.workspaceId !== candidate.workspaceId) meta.put(nextPointer, ACTIVE_POINTER_KEY);
        } catch { checkNext(); }
      };
      docRequest.onerror = () => { failure = docRequest.error ?? new DrawStorageRecoveryError("Could not inspect a stored Draw canvas."); tx.abort(); };
    };
    checkNext();
  };
  pointerRequest.onsuccess = () => { pointer = pointerRequest.result as ActiveCanvasPointer | undefined; inspect(); };
  canvasesRequest.onsuccess = () => { canvases = canvasesRequest.result as DrawCanvas[]; inspect(); };
  recoveryRequest.onsuccess = () => { recovery = recoveryRequest.result; inspect(); };
  for (const request of [pointerRequest, canvasesRequest, recoveryRequest]) request.onerror = () => { failure = request.error ?? new Error("Could not inspect Draw workspace storage."); tx.abort(); };
  try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
  if (failure) throw failure;
  return result;
}

export async function loadCanvasDocument(canvasId: string): Promise<DrawDocument | null> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([CANVASES_STORE, DOCUMENTS_STORE], "readonly");
    const canvasReq = tx.objectStore(CANVASES_STORE).get(canvasId);
    const result = new Promise<DrawDocument | null>((resolve, reject) => {
      canvasReq.onsuccess = () => { const canvas = canvasReq.result as DrawCanvas | undefined; if (!canvas) { resolve(null); return; } const docReq = tx.objectStore(DOCUMENTS_STORE).get(documentKey(canvas.documentId)); docReq.onsuccess = () => { if (!docReq.result) { reject(new DrawStorageRecoveryError(`Canvas ${canvas.id} is damaged: its document is missing.`)); return; } resolve(docReq.result); }; docReq.onerror = () => reject(docReq.error); };
      canvasReq.onerror = () => reject(canvasReq.error);
    });
    const [value] = await Promise.all([result, waitForTransaction(tx)]);
    if (value) { validateDrawDocument(value); normalizeDrawImageAttributions(value, "trusted-storage"); }
    return value;
  } finally { db.close(); }
}

export async function createWorkspace(name: string): Promise<DrawWorkspace> {
  return (await createWorkspaceWithCanvas(name, "Untitled drawing")).workspace;
}

/** Create a project and its only board in one transaction. */
export async function createWorkspaceWithCanvas(
  name: string,
  canvasName: string,
  source?: DrawDocument,
  hooks: { afterDocumentWrite?: () => void } = {},
): Promise<{ workspace: DrawWorkspace; canvas: DrawCanvas; document: DrawDocument }> {
  const timestamp = Date.now();
  const workspace: DrawWorkspace = { id: crypto.randomUUID(), name: name.trim() || "Untitled workspace", createdAt: timestamp, updatedAt: timestamp };
  const boardName = canvasName.trim() || "Untitled drawing";
  const document = source ? structuredClone(source) : createEmptyDocument(boardName);
  validateDrawDocument(document);
  document.document.id = crypto.randomUUID();
  document.document.title = boardName;
  document.document.documentRevision = 0;
  document.document.viewRevision = 0;
  normalizeDrawImageAttributions(document, "trusted-storage");
  const canvas: DrawCanvas = { id: crypto.randomUUID(), workspaceId: workspace.id, name: boardName, documentId: document.document.id, createdAt: timestamp, updatedAt: timestamp };
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES_STORE, CANVASES_STORE, DOCUMENTS_STORE, WORKSPACE_META_STORE], "readwrite");
    tx.objectStore(WORKSPACES_STORE).put(workspace, workspace.id);
    tx.objectStore(CANVASES_STORE).put(canvas, canvas.id);
    tx.objectStore(DOCUMENTS_STORE).put(document, documentKey(document.document.id));
    try { hooks.afterDocumentWrite?.(); } catch (error) { tx.abort(); throw error; }
    tx.objectStore(WORKSPACE_META_STORE).put(true, INITIALIZED_KEY);
    incrementWorkspaceCatalogRevision(tx.objectStore(WORKSPACE_META_STORE));
    await waitForTransaction(tx);
    return { workspace, canvas, document };
  }
  finally { db.close(); }
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<DrawWorkspace> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES_STORE, WORKSPACE_META_STORE], "readwrite");
    const store = tx.objectStore(WORKSPACES_STORE);
    const request = store.get(workspaceId);
    let renamed: DrawWorkspace | undefined;
    let failure: Error | undefined;
    request.onsuccess = () => {
      if (!request.result) { failure = new Error("Workspace does not exist."); tx.abort(); return; }
      renamed = { ...(request.result as DrawWorkspace), name: name.trim() || "Untitled workspace", updatedAt: Date.now() };
      store.put(renamed, workspaceId);
      incrementWorkspaceCatalogRevision(tx.objectStore(WORKSPACE_META_STORE));
    };
    try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
    return renamed!;
  } finally { db.close(); }
}

export async function renameCanvas(canvasId: string, name: string): Promise<DrawCanvas> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([CANVASES_STORE, DOCUMENTS_STORE, WORKSPACE_META_STORE], "readwrite");
    const canvases = tx.objectStore(CANVASES_STORE);
    const request = canvases.get(canvasId);
    let renamed: DrawCanvas | undefined;
    let failure: Error | undefined;
    request.onsuccess = () => {
      const canvas = request.result as DrawCanvas | undefined;
      if (!canvas) { failure = new Error("Canvas does not exist."); tx.abort(); return; }
      const docRequest = tx.objectStore(DOCUMENTS_STORE).get(documentKey(canvas.documentId));
      docRequest.onsuccess = () => {
        try {
          if (!docRequest.result) throw new DrawStorageRecoveryError(`Canvas ${canvasId} is damaged: its editable document is missing.`);
          const document = docRequest.result as DrawDocument;
          validateDrawDocument(document);
          const nextName = name.trim() || "Untitled canvas";
          document.document.title = nextName;
          document.document.documentRevision += 1;
          renamed = { ...canvas, name: nextName, updatedAt: Date.now() };
          tx.objectStore(DOCUMENTS_STORE).put(document, documentKey(canvas.documentId));
          canvases.put(renamed, canvasId);
          incrementWorkspaceCatalogRevision(tx.objectStore(WORKSPACE_META_STORE));
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
      };
      docRequest.onerror = () => { failure = docRequest.error ?? new Error("Could not read the canvas document."); tx.abort(); };
    };
    try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
    return renamed!;
  } finally { db.close(); }
}

export async function duplicateCanvas(canvasId: string, name?: string): Promise<DrawCanvas> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([CANVASES_STORE, DOCUMENTS_STORE, WORKSPACES_STORE, WORKSPACE_META_STORE, WORKSPACE_LIBRARY_STORE], "readwrite");
    const sourceRequest = tx.objectStore(CANVASES_STORE).get(canvasId);
    let duplicate: DrawCanvas | undefined;
    let failure: Error | undefined;
    sourceRequest.onsuccess = () => {
      const source = sourceRequest.result as DrawCanvas | undefined;
      if (!source) { failure = new Error("Canvas does not exist."); tx.abort(); return; }
      const documentRequest = tx.objectStore(DOCUMENTS_STORE).get(documentKey(source.documentId));
      documentRequest.onsuccess = () => {
        try {
          if (!documentRequest.result) throw new DrawStorageRecoveryError(`Canvas ${canvasId} is damaged: its editable document is missing.`);
          const sourceDocument = structuredClone(documentRequest.result as DrawDocument);
          validateDrawDocument(sourceDocument);
          const nextName = name?.trim() || `${source.name} copy`;
          sourceDocument.document.title = nextName;
          sourceDocument.document.documentRevision = 0;
          sourceDocument.document.viewRevision = 0;
          const timestamp = Date.now();
          const newWorkspace: DrawWorkspace = { id: crypto.randomUUID(), name: nextName, createdAt: timestamp, updatedAt: timestamp };
          const libraryRequest = tx.objectStore(WORKSPACE_LIBRARY_STORE).get(source.workspaceId);
          libraryRequest.onerror = () => { failure = libraryRequest.error ?? new Error("Could not copy the workspace library."); tx.abort(); };
          libraryRequest.onsuccess = () => {
            try {
              tx.objectStore(WORKSPACES_STORE).put(newWorkspace, newWorkspace.id);
              if (libraryRequest.result !== undefined) {
                tx.objectStore(WORKSPACE_LIBRARY_STORE).put(copyWorkspaceLibraryForNewWorkspace(libraryRequest.result), newWorkspace.id);
              }
              duplicate = { id: crypto.randomUUID(), workspaceId: newWorkspace.id, name: nextName, documentId: crypto.randomUUID(), createdAt: timestamp, updatedAt: timestamp };
              sourceDocument.document.id = duplicate.documentId;
              tx.objectStore(DOCUMENTS_STORE).put(sourceDocument, documentKey(duplicate.documentId));
              tx.objectStore(CANVASES_STORE).put(duplicate, duplicate.id);
              tx.objectStore(WORKSPACE_META_STORE).put(true, INITIALIZED_KEY);
              incrementWorkspaceCatalogRevision(tx.objectStore(WORKSPACE_META_STORE));
            } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
          };
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
      };
      documentRequest.onerror = () => { failure = documentRequest.error ?? new Error("Could not read the canvas document."); tx.abort(); };
    };
    try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
    return duplicate!;
  } finally { db.close(); }
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES_STORE, CANVASES_STORE, DOCUMENTS_STORE, WORKSPACE_META_STORE, WORKSPACE_LIBRARY_STORE, MCP_OPERATIONS_STORE, MCP_UNDO_STORE, MCP_REDO_STORE, MCP_WORKSPACE_OPERATIONS_STORE], "readwrite");
    const workspaces = tx.objectStore(WORKSPACES_STORE);
    const canvases = tx.objectStore(CANVASES_STORE);
    const documents = tx.objectStore(DOCUMENTS_STORE);
    const meta = tx.objectStore(WORKSPACE_META_STORE);
    const requests = [
      workspaces.get(workspaceId),
      canvases.index("byWorkspaceId").getAll(workspaceId),
      canvases.getAll(),
      meta.get(ACTIVE_POINTER_KEY),
      documents.get(CURRENT_DOCUMENT_KEY),
      tx.objectStore(MCP_OPERATIONS_STORE).getAllKeys(),
      tx.objectStore(MCP_OPERATIONS_STORE).getAll(),
      tx.objectStore(MCP_WORKSPACE_OPERATIONS_STORE).getAllKeys(),
      tx.objectStore(MCP_WORKSPACE_OPERATIONS_STORE).getAll(),
    ];
    let pending = requests.length;
    let failure: Error | undefined;
    const abort = (error: unknown) => { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); };
    const finish = () => {
      pending -= 1;
      if (pending) return;
      if (!requests[0].result) return;
      const removed = requests[1].result as DrawCanvas[];
      const allCanvases = requests[2].result as DrawCanvas[];
      const active = requests[3].result as ActiveCanvasPointer | undefined;
      const alias = requests[4].result as DrawDocument | undefined;
      const operationKeys = requests[5].result as IDBValidKey[];
      const operations = requests[6].result as Array<{ documentId?: string }>;
      const workspaceReceiptKeys = requests[7].result as IDBValidKey[];
      const workspaceReceipts = requests[8].result as Array<Partial<McpWorkspaceOperationReceipt>>;
      const removedIds = new Set(removed.map((canvas) => canvas.documentId));
      const removedCanvasIds = new Set(removed.map((canvas) => canvas.id));
      workspaces.delete(workspaceId);
      incrementWorkspaceCatalogRevision(meta);
      tx.objectStore(WORKSPACE_LIBRARY_STORE).delete(workspaceId);
      for (const canvas of removed) {
        canvases.delete(canvas.id);
        documents.delete(documentKey(canvas.documentId));
        documents.delete(writeOrderKey(canvas.documentId));
        tx.objectStore(MCP_UNDO_STORE).delete(canvas.documentId);
        tx.objectStore(MCP_REDO_STORE).delete(canvas.documentId);
      }
      operations.forEach((operation, index) => { if (operation?.documentId && removedIds.has(operation.documentId)) tx.objectStore(MCP_OPERATIONS_STORE).delete(operationKeys[index]); });
      workspaceReceipts.forEach((receipt, index) => {
        if ((receipt.workspaceIds ?? []).includes(workspaceId) || (receipt.canvasIds ?? []).some((id) => removedCanvasIds.has(id))) {
          tx.objectStore(MCP_WORKSPACE_OPERATIONS_STORE).delete(workspaceReceiptKeys[index]);
        }
      });
      if (!active || !removed.some((canvas) => canvas.id === active.canvasId)) return;
      const candidates = allCanvases.filter((canvas) => canvas.workspaceId !== workspaceId).sort((a, b) => a.createdAt - b.createdAt);
      let index = 0;
      const pickSibling = () => {
        const candidate = candidates[index++];
        if (!candidate) {
          meta.delete(ACTIVE_POINTER_KEY);
          documents.delete(CURRENT_DOCUMENT_KEY);
          documents.delete(CURRENT_WRITE_ORDER_KEY);
          return;
        }
        const request = documents.get(documentKey(candidate.documentId));
        request.onsuccess = () => {
          try {
            if (!request.result) throw new Error("missing sibling document");
            validateDrawDocument(request.result);
            meta.put({ workspaceId: candidate.workspaceId, canvasId: candidate.id } satisfies ActiveCanvasPointer, ACTIVE_POINTER_KEY);
            documents.put(request.result, CURRENT_DOCUMENT_KEY);
          } catch { pickSibling(); }
        };
        request.onerror = () => abort(request.error ?? new Error("Could not recover a canvas after deleting its workspace."));
      };
      // A legacy alias can only be removed when it references deleted data.
      if (alias && removedIds.has(alias.document.id)) documents.delete(CURRENT_DOCUMENT_KEY);
      pickSibling();
    };
    requests.forEach((request) => {
      request.onsuccess = finish;
      request.onerror = () => abort(request.error ?? new Error("Could not inspect workspace storage before deletion."));
    });
    try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
  } finally { db.close(); }
}

export async function createCanvas(workspaceId: string, name: string, source?: DrawDocument, hooks: { afterDocumentWrite?: () => void } = {}): Promise<DrawCanvas> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES_STORE, CANVASES_STORE, DOCUMENTS_STORE, WORKSPACE_META_STORE], "readwrite");
    const workspaces = tx.objectStore(WORKSPACES_STORE); const workspaceReq = workspaces.get(workspaceId);
    const ownedRequest = tx.objectStore(CANVASES_STORE).index("byWorkspaceId").getAll(workspaceId);
    const canvas = { id: crypto.randomUUID(), workspaceId, name: name.trim() || "Untitled canvas", documentId: "", createdAt: Date.now(), updatedAt: Date.now() } satisfies DrawCanvas;
    let failure: Error | undefined;
    let ready = 0;
    const create = () => {
      ready += 1;
      if (ready !== 2) return;
      if (!workspaceReq.result) { failure = new Error("Workspace does not exist."); tx.abort(); return; }
      if ((ownedRequest.result as DrawCanvas[]).length > 0) { failure = new Error("This workspace already has a board. Create a new workspace to start another drawing."); tx.abort(); return; }
      const doc = source ? structuredClone(source) : createEmptyDocument(canvas.name);
      validateDrawDocument(doc);
      doc.document.id = crypto.randomUUID(); doc.document.title = canvas.name; doc.document.documentRevision = 0; doc.document.viewRevision = 0;
      canvas.documentId = doc.document.id;
      tx.objectStore(DOCUMENTS_STORE).put(doc, documentKey(doc.document.id));
      try { hooks.afterDocumentWrite?.(); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); return; }
      tx.objectStore(CANVASES_STORE).put(canvas, canvas.id);
      tx.objectStore(WORKSPACE_META_STORE).put(true, INITIALIZED_KEY);
      incrementWorkspaceCatalogRevision(tx.objectStore(WORKSPACE_META_STORE));
    };
    workspaceReq.onsuccess = ownedRequest.onsuccess = create;
    workspaceReq.onerror = ownedRequest.onerror = () => { failure = new Error("Could not inspect the target workspace."); tx.abort(); };
    try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
    return canvas;
  } finally { db.close(); }
}

export async function setActiveCanvas(canvasId: string): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction([CANVASES_STORE, DOCUMENTS_STORE, WORKSPACE_META_STORE], "readwrite"); const canvases = tx.objectStore(CANVASES_STORE); const req = canvases.get(canvasId); let failure: Error | undefined;
    req.onsuccess = () => { const canvas = req.result as DrawCanvas | undefined; if (!canvas) { failure = new Error("Canvas does not exist."); tx.abort(); return; } const docRequest = tx.objectStore(DOCUMENTS_STORE).get(documentKey(canvas.documentId)); docRequest.onsuccess = () => { try { if (!docRequest.result) throw new Error("missing"); validateDrawDocument(docRequest.result); const meta = tx.objectStore(WORKSPACE_META_STORE); const oldPointer = meta.get(ACTIVE_POINTER_KEY); oldPointer.onsuccess = () => { if (oldPointer.result?.canvasId !== canvasId) incrementWorkspaceCatalogRevision(meta); }; meta.put({ workspaceId: canvas.workspaceId, canvasId } satisfies ActiveCanvasPointer, ACTIVE_POINTER_KEY); tx.objectStore(DOCUMENTS_STORE).put(docRequest.result, CURRENT_DOCUMENT_KEY); } catch { failure = new DrawStorageRecoveryError(`Canvas ${canvas.id} is damaged: its editable document is missing or invalid.`); tx.abort(); } }; docRequest.onerror = () => { failure = docRequest.error ?? new Error("Could not inspect the canvas document."); tx.abort(); }; };
    try { await waitForTransaction(tx); } catch (error) { throw failure ?? error; }
  } finally { db.close(); }
}

export async function deleteCanvas(canvasId: string): Promise<void> {
  const canvas = (await readAll<DrawCanvas>(CANVASES_STORE)).find((item) => item.id === canvasId);
  if (!canvas) throw new Error("Canvas does not exist.");
  throw new Error("A workspace contains one board. To remove this drawing, confirm and delete its workspace so the workspace library and document history are included.");
}

/** Atomically commit an MCP-authored scene revision and the replay/undo record. */
export async function commitMcpOperation(
  document: DrawDocument,
  operation: DurableMcpOperation,
  hooks: {
    afterDocumentWrite?: () => void;
    undoTarget?: { operationId: string; clientIdentity: string };
    redoTarget?: { operationId: string; clientIdentity: string };
    invalidateUndo?: boolean;
  } = {},
): Promise<void> {
  validateDrawDocument(document);
  if (operation.documentId !== document.document.id || operation.resultingRevision !== document.document.documentRevision) {
    throw new Error("MCP operation ledger does not match the document revision being committed.");
  }
  if (operation.resultingViewRevision !== undefined && operation.resultingViewRevision !== document.document.viewRevision) {
    throw new Error("MCP operation ledger does not match the view revision being committed.");
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction([DOCUMENTS_STORE, MCP_OPERATIONS_STORE, MCP_UNDO_STORE, MCP_REDO_STORE, MCP_META_STORE], "readwrite");
    const documents = transaction.objectStore(DOCUMENTS_STORE);
    const operations = transaction.objectStore(MCP_OPERATIONS_STORE);
    const undo = transaction.objectStore(MCP_UNDO_STORE);
    const redo = transaction.objectStore(MCP_REDO_STORE);
    const meta = transaction.objectStore(MCP_META_STORE);
    let commitError: Error | null = null;
    const operationKey = operationLedgerKey(operation.documentId, operation.clientIdentity, operation.idempotencyKey);
    const currentRequest = documents.get(documentKey(operation.documentId));
    const existingRequest = operations.get(operationKey);
    const undoRequest = undo.get(operation.documentId);
    const redoRequest = redo.get(operation.documentId);
    const metaRequest = meta.get("commit-count");
    let readsRemaining = 5;
    let prepared = false;
    const tryCommit = () => {
      if (prepared) return;
      readsRemaining -= 1;
      if (readsRemaining > 0) return;
      prepared = true;
      const count = Number(metaRequest.result ?? 0) + 1;
      meta.put(count, "commit-count");
      const finalizeCommit = (ledgerKeys: IDBValidKey[] = [], ledgerValues: unknown[] = []) => {
      try {
      const current = currentRequest.result as DrawDocument | undefined;
      const existingRaw = existingRequest.result as unknown;
      const latestUndoRaw = undoRequest.result as unknown;
      const latestRedoRaw = redoRequest.result as unknown;
      if (existingRaw !== undefined) assertOperationResult(existingRaw);
      const existing = existingRaw as DurableMcpOperationResult | DurableMcpTombstone | undefined;
      let latestUndo: DurableMcpOperation | undefined;
      let latestRedo: DurableMcpRedo | undefined;
      try { if (latestUndoRaw !== undefined) assertDurableMcpOperation(latestUndoRaw); latestUndo = latestUndoRaw as DurableMcpOperation | undefined; } catch { /* quarantine the unusable pointer on the successful write below */ }
      try {
        if (latestRedoRaw !== undefined) {
          const candidate = latestRedoRaw as DurableMcpRedo;
          if (typeof candidate !== "object" || !candidate || !Number.isSafeInteger(candidate.undoneRevision)) throw new Error("Malformed redo pointer");
          assertDurableMcpOperation(candidate.operation);
          latestRedo = candidate;
        }
      } catch { /* quarantine the unusable pointer on the successful write below */ }
      if (existing) {
        commitError = existing.payloadHash !== operation.payloadHash
          ? new Error("IDEMPOTENCY_KEY_REUSE: This key was already used with a different operation payload.")
          : "tombstone" in existing || Date.now() - existing.completedAt >= 7 * 24 * 60 * 60 * 1_000
            ? new Error("OUTCOME_UNKNOWN: The durable result for this idempotency key has expired.")
            : new Error("IDEMPOTENCY_REPLAY: Another identical operation already committed. Retry with the same key to retrieve its result.");
        transaction.abort();
        return;
      }
      const currentRevision = current?.document?.documentRevision ?? 0;
      const currentViewRevision = current?.document?.viewRevision ?? 0;
      if (current && current.document.id !== operation.documentId || currentRevision !== operation.baseRevision
        || operation.baseViewRevision !== undefined && currentViewRevision !== operation.baseViewRevision) {
        commitError = new Error(`CONFLICT: Durable document/view revision is ${currentRevision}/${currentViewRevision}, expected ${operation.baseRevision}/${operation.baseViewRevision ?? currentViewRevision}.`);
        transaction.abort();
        return;
      }
      if (hooks.undoTarget && (!latestUndo
        || latestUndo.operationId !== hooks.undoTarget.operationId
        || latestUndo.clientIdentity !== hooks.undoTarget.clientIdentity
        || latestUndo.actor !== operation.clientIdentity
        || !latestUndo.undoEligible
        || latestUndo.resultingRevision !== operation.baseRevision
        || !sameSceneSnapshot(current, latestUndo.afterDocument))) {
        commitError = new Error("CONFLICT: The durable MCP undo target is no longer the latest eligible scene change.");
        transaction.abort();
        return;
      }
      if (hooks.redoTarget && (!latestRedo
        || latestRedo.operation.operationId !== hooks.redoTarget.operationId
        || latestRedo.operation.clientIdentity !== hooks.redoTarget.clientIdentity
        || latestRedo.operation.actor !== operation.clientIdentity
        || latestRedo.undoneRevision !== operation.baseRevision
        || !sameSceneSnapshot(current, latestRedo.operation.beforeDocument))) {
        commitError = new Error("CONFLICT: The durable MCP redo target is no longer eligible.");
        transaction.abort();
        return;
      }
      documents.put(document, documentKey(operation.documentId));
      documents.put(document, CURRENT_DOCUMENT_KEY);
      try {
        if (ledgerKeys.length) {
          const validEntries: Array<[IDBValidKey, OperationLedgerEntry]> = [];
          const validKeys = new Set<string>();
          ledgerKeys.forEach((key, index) => {
            try {
              assertOperationResult(ledgerValues[index]);
              validEntries.push([key, ledgerValues[index] as OperationLedgerEntry]);
              validKeys.add(String(key));
            } catch { operations.delete(key); }
          });
          const compacted = compactOperationLedger(validEntries, Date.now());
        const compactedByKey = new Map(compacted.map(([key, value]) => [String(key), value]));
        ledgerKeys.forEach((key, index) => {
          if (!validKeys.has(String(key))) return;
          const next = compactedByKey.get(String(key));
          if (!next) operations.delete(key);
          else if (next !== ledgerValues[index]) operations.put(next, key);
        });
        }
        if (latestUndoRaw !== undefined && !latestUndo) undo.delete(operation.documentId);
        if (latestRedoRaw !== undefined && !latestRedo) redo.delete(operation.documentId);
        hooks.afterDocumentWrite?.();
        const { beforeDocument: _before, afterDocument: _after, undoEligible: _undoEligible, ...durableResult } = operation;
        operations.put(durableResult, operationKey);
        if (hooks.undoTarget && latestUndo) {
          undo.delete(operation.documentId);
          redo.put({ operation: latestUndo, undoneRevision: document.document.documentRevision }, operation.documentId);
        } else if (hooks.redoTarget || operation.undoEligible) {
          undo.put(operation, operation.documentId);
          redo.delete(operation.documentId);
        } else if (hooks.invalidateUndo) {
          undo.delete(operation.documentId);
          redo.delete(operation.documentId);
        }
      } catch (error) {
        commitError = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
      }
      } catch (error) {
        commitError = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
      }
      };
      if (count % MCP_COMPACTION_INTERVAL === 0) {
        const keysRequest = operations.getAllKeys();
        const entriesRequest = operations.getAll();
        let compactionReads = 4;
        const pruneSnapshotStore = (store: IDBObjectStore, completedAt: (value: any) => number) => {
          const countRequest = store.count();
          countRequest.onsuccess = () => {
            let remaining = countRequest.result;
            const request = store.index("byCompletedAt").openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { finishCompaction(); return; }
              const expired = completedAt(cursor.value) <= Date.now() - OPERATION_SNAPSHOT_RETENTION_MS;
              if (expired || remaining > MAX_DOCUMENT_SNAPSHOTS) {
                cursor.delete();
                remaining -= 1;
              }
              cursor.continue();
            };
            request.onerror = () => { commitError = request.error ?? new Error("Could not prune old MCP snapshots."); transaction.abort(); };
          };
          countRequest.onerror = () => { commitError = countRequest.error ?? new Error("Could not count MCP snapshots."); transaction.abort(); };
        };
        const finishCompaction = () => {
          compactionReads -= 1;
          if (compactionReads === 0) finalizeCommit(keysRequest.result as IDBValidKey[], entriesRequest.result as unknown[]);
        };
        keysRequest.onsuccess = finishCompaction;
        entriesRequest.onsuccess = finishCompaction;
        pruneSnapshotStore(undo, (value) => value.completedAt);
        pruneSnapshotStore(redo, (value) => value.operation.completedAt);
        keysRequest.onerror = () => { commitError = keysRequest.error ?? new Error("Could not compact the MCP operation ledger."); transaction.abort(); };
        entriesRequest.onerror = () => { commitError = entriesRequest.error ?? new Error("Could not compact the MCP operation ledger."); transaction.abort(); };
      } else finalizeCommit();
    };
    currentRequest.onsuccess = tryCommit;
    existingRequest.onsuccess = tryCommit;
    undoRequest.onsuccess = tryCommit;
    redoRequest.onsuccess = tryCommit;
    metaRequest.onsuccess = tryCommit;
    currentRequest.onerror = () => { commitError = currentRequest.error ?? new Error("Could not inspect the current Draw revision."); transaction.abort(); };
    existingRequest.onerror = () => { commitError = existingRequest.error ?? new Error("Could not inspect the MCP operation ledger."); transaction.abort(); };
    undoRequest.onerror = () => { commitError = undoRequest.error ?? new Error("Could not inspect the MCP undo ledger."); transaction.abort(); };
    redoRequest.onerror = () => { commitError = redoRequest.error ?? new Error("Could not inspect the MCP redo ledger."); transaction.abort(); };
    metaRequest.onerror = () => { commitError = metaRequest.error ?? new Error("Could not inspect MCP ledger maintenance state."); transaction.abort(); };
    try {
      await waitForTransaction(transaction);
    } catch (error) {
      throw commitError ?? error;
    }
  } finally {
    database.close();
  }
}

/** Compensate an unacknowledged MCP scene only while its committed result is still current. */
export async function restoreMcpCommandSnapshot(
  before: DrawDocument,
  expectedAfter: DrawDocument,
  identity: { clientIdentity: string; idempotencyKey: string; operationId: string },
  hooks: { afterDocumentWrite?: () => void; preserveHistory?: boolean } = {},
): Promise<boolean> {
  validateDrawDocument(before);
  validateDrawDocument(expectedAfter);
  if (before.document.id !== expectedAfter.document.id
    || expectedAfter.document.documentRevision <= before.document.documentRevision) return false;
  const database = await openDatabase();
  try {
    const transaction = database.transaction([DOCUMENTS_STORE, MCP_OPERATIONS_STORE, MCP_UNDO_STORE, MCP_REDO_STORE], "readwrite");
    const documents = transaction.objectStore(DOCUMENTS_STORE);
    const operations = transaction.objectStore(MCP_OPERATIONS_STORE);
    const undo = transaction.objectStore(MCP_UNDO_STORE);
    const redo = transaction.objectStore(MCP_REDO_STORE);
    const key = operationLedgerKey(before.document.id, identity.clientIdentity, identity.idempotencyKey);
    const currentRequest = documents.get(documentKey(before.document.id));
    const operationRequest = operations.get(key);
    const undoRequest = undo.get(before.document.id);
    const redoRequest = redo.get(before.document.id);
    let restored = false;
    let restoreError: Error | null = null;
    let operation: DurableMcpOperationResult | DurableMcpTombstone | undefined;
    let readsRemaining = 4;
    const tryRestore = () => {
      readsRemaining -= 1;
      if (readsRemaining > 0) return;
      try {
      const current = currentRequest.result as DrawDocument | undefined;
      const entry = operationRequest.result as unknown;
      const undoValue = undoRequest.result as unknown;
      const redoValue = redoRequest.result as unknown;
      if (entry !== undefined) assertOperationResult(entry);
      if (undoValue !== undefined) assertDurableMcpOperation(undoValue);
      if (redoValue !== undefined) {
        const redoEntry = redoValue as DurableMcpRedo;
        if (typeof redoEntry !== "object" || !redoEntry || !Number.isSafeInteger(redoEntry.undoneRevision)) throw new Error("The durable MCP redo ledger is malformed; refusing cancellation compensation.");
        assertDurableMcpOperation(redoEntry.operation);
      }
      operation = entry as DurableMcpOperationResult | DurableMcpTombstone | undefined;
      if (current?.document.id !== expectedAfter.document.id
        || current.document.documentRevision < expectedAfter.document.documentRevision
        || current.document.viewRevision < expectedAfter.document.viewRevision
        || JSON.stringify(current.document.canvas.viewport) !== JSON.stringify(expectedAfter.document.canvas.viewport)
        || !sameSceneSnapshot(current, expectedAfter)
        || !operation || "tombstone" in operation
        || operation.clientIdentity !== identity.clientIdentity
        || operation.idempotencyKey !== identity.idempotencyKey
        || operation.operationId !== identity.operationId
        || operation.documentId !== before.document.id
        || operation.resultingRevision !== expectedAfter.document.documentRevision) return;
      if (operation.resultingViewRevision !== undefined && operation.resultingViewRevision !== expectedAfter.document.viewRevision) return;
      } catch (error) {
        restoreError = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
        return;
      }
      try {
        documents.put(before, documentKey(before.document.id));
        documents.put(before, CURRENT_DOCUMENT_KEY);
        operations.put({
          documentId: operation.documentId,
          clientIdentity: operation.clientIdentity,
          idempotencyKey: operation.idempotencyKey,
          payloadHash: operation.payloadHash,
          operationId: operation.operationId,
          completedAt: operation.completedAt,
          expiredAt: Date.now() + OPERATION_TOMBSTONE_RETENTION_MS,
          tombstone: true,
        } satisfies DurableMcpTombstone, key);
        if (!hooks.preserveHistory) {
          undo.delete(before.document.id);
          redo.delete(before.document.id);
        }
        hooks.afterDocumentWrite?.();
        restored = true;
      } catch (error) {
        restoreError = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
      }
    };
    currentRequest.onsuccess = tryRestore;
    operationRequest.onsuccess = tryRestore;
    undoRequest.onsuccess = tryRestore;
    redoRequest.onsuccess = tryRestore;
    for (const request of [currentRequest, operationRequest, undoRequest, redoRequest]) request.onerror = () => transaction.abort();
    try {
      await waitForTransaction(transaction);
    } catch (error) {
      throw restoreError ?? error;
    }
    return restored;
  } finally {
    database.close();
  }
}

export async function loadLatestMcpRedoOperation(documentId: string): Promise<DurableMcpRedo | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(MCP_REDO_STORE, "readonly");
    const request = transaction.objectStore(MCP_REDO_STORE).get(documentId);
    const [value] = await Promise.all([
      new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not read the MCP redo ledger."));
      }),
      waitForTransaction(transaction),
    ]);
    if (value === undefined) return null;
    const redo = value as DurableMcpRedo;
    if (typeof redo !== "object" || !redo || !Number.isSafeInteger(redo.undoneRevision)) throw new Error("The durable MCP redo ledger is malformed; refusing to redo it.");
    assertDurableMcpOperation(redo.operation);
    if (Date.now() - redo.operation.completedAt >= OPERATION_SNAPSHOT_RETENTION_MS) {
      const cleanup = database.transaction(MCP_REDO_STORE, "readwrite");
      cleanup.objectStore(MCP_REDO_STORE).delete(documentId);
      await waitForTransaction(cleanup);
      return null;
    }
    return redo;
  } finally {
    database.close();
  }
}

export async function loadLatestMcpUndoOperation(documentId: string): Promise<DurableMcpOperation | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(MCP_UNDO_STORE, "readonly");
    const request = transaction.objectStore(MCP_UNDO_STORE).get(documentId);
    const [value] = await Promise.all([
      new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not read the MCP undo ledger."));
      }),
      waitForTransaction(transaction),
    ]);
    if (value === undefined) return null;
    assertDurableMcpOperation(value);
    if ("tombstone" in value) throw new Error("The MCP undo pointer is malformed; refusing to undo an expired operation.");
    if (Date.now() - value.completedAt >= OPERATION_SNAPSHOT_RETENTION_MS) {
      const cleanup = database.transaction(MCP_UNDO_STORE, "readwrite");
      cleanup.objectStore(MCP_UNDO_STORE).delete(documentId);
      await waitForTransaction(cleanup);
      return null;
    }
    return value;
  } finally {
    database.close();
  }
}

export async function loadMcpOperation(
  documentId: string,
  clientIdentity: string,
  idempotencyKey: string,
): Promise<OperationLedgerEntry | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(MCP_OPERATIONS_STORE, "readonly");
    const request = transaction.objectStore(MCP_OPERATIONS_STORE).get(operationLedgerKey(documentId, clientIdentity, idempotencyKey));
    const [value] = await Promise.all([
      new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not read the MCP operation ledger."));
      }),
      waitForTransaction(transaction),
    ]);
    if (value === undefined) return null;
    assertOperationResult(value);
    return value;
  } finally {
    database.close();
  }
}
