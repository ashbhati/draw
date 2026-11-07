import { validateDrawDocument, type DrawDocument } from "../document/document";
import { compactOperationLedger, operationLedgerKey, OPERATION_TOMBSTONE_RETENTION_MS, sameSceneSnapshot, type DurableMcpOperation, type DurableMcpOperationResult, type DurableMcpRedo, type DurableMcpTombstone, type OperationLedgerEntry } from "../integrations/operation-ledger";

const DATABASE_NAME = "draw-local";
const DATABASE_VERSION = 3;
const DOCUMENTS_STORE = "documents";
const MCP_OPERATIONS_STORE = "mcpOperations";
const MCP_UNDO_STORE = "mcpUndo";
const MCP_REDO_STORE = "mcpRedo";
const CURRENT_DOCUMENT_KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Local autosave requires IndexedDB in this browser."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
        database.createObjectStore(DOCUMENTS_STORE);
      }
      if (!database.objectStoreNames.contains(MCP_OPERATIONS_STORE)) {
        database.createObjectStore(MCP_OPERATIONS_STORE);
      }
      if (!database.objectStoreNames.contains(MCP_UNDO_STORE)) {
        database.createObjectStore(MCP_UNDO_STORE);
      }
      if (!database.objectStoreNames.contains(MCP_REDO_STORE)) {
        database.createObjectStore(MCP_REDO_STORE);
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
export async function saveCurrentDocument(document: DrawDocument, options: { replaceDocument?: boolean } = {}): Promise<void> {
  validateDrawDocument(document);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
    const store = transaction.objectStore(DOCUMENTS_STORE);
    const currentRequest = store.get(CURRENT_DOCUMENT_KEY);
    currentRequest.onsuccess = () => {
      const current = currentRequest.result as DrawDocument | undefined;
      if (current && current.document.id !== document.document.id && !options.replaceDocument) return;
      if (current && (
        (current.document.documentRevision ?? 0) > (document.document.documentRevision ?? 0)
        || (current.document.documentRevision ?? 0) === (document.document.documentRevision ?? 0)
          && (current.document.viewRevision ?? 0) > (document.document.viewRevision ?? 0)
      )) return;
      if (current
        && (current.document.documentRevision ?? 0) === (document.document.documentRevision ?? 0)
        && (current.document.viewRevision ?? 0) === (document.document.viewRevision ?? 0)
        && JSON.stringify(current) !== JSON.stringify(document)
        && !options.replaceDocument) return;
      store.put(document, CURRENT_DOCUMENT_KEY);
    };
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

/** Load the most recently autosaved editable scene, or null on first run. */
export async function loadCurrentDocument(): Promise<DrawDocument | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DOCUMENTS_STORE, "readonly");
    const request = transaction.objectStore(DOCUMENTS_STORE).get(CURRENT_DOCUMENT_KEY);
    const [value] = await Promise.all([
      new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not read the autosaved Draw document."));
      }),
      waitForTransaction(transaction),
    ]);
    if (value === undefined) return null;
    validateDrawDocument(value);
    return value;
  } finally {
    database.close();
  }
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
    const transaction = database.transaction([DOCUMENTS_STORE, MCP_OPERATIONS_STORE, MCP_UNDO_STORE, MCP_REDO_STORE], "readwrite");
    const documents = transaction.objectStore(DOCUMENTS_STORE);
    const operations = transaction.objectStore(MCP_OPERATIONS_STORE);
    const undo = transaction.objectStore(MCP_UNDO_STORE);
    const redo = transaction.objectStore(MCP_REDO_STORE);
    let commitError: Error | null = null;
    const operationKey = operationLedgerKey(operation.documentId, operation.clientIdentity, operation.idempotencyKey);
    const currentRequest = documents.get(CURRENT_DOCUMENT_KEY);
    const existingRequest = operations.get(operationKey);
    const undoRequest = undo.get(operation.documentId);
    const redoRequest = redo.get(operation.documentId);
    const operationKeysRequest = operations.getAllKeys();
    const operationEntriesRequest = operations.getAll();
    let readsRemaining = 6;
    const tryCommit = () => {
      readsRemaining -= 1;
      if (readsRemaining > 0) return;
      try {
      const current = currentRequest.result as DrawDocument | undefined;
      const existingRaw = existingRequest.result as unknown;
      const latestUndoRaw = undoRequest.result as unknown;
      const latestRedoRaw = redoRequest.result as unknown;
      if (existingRaw !== undefined) assertOperationResult(existingRaw);
      if (latestUndoRaw !== undefined) assertDurableMcpOperation(latestUndoRaw);
      const existing = existingRaw as DurableMcpOperationResult | DurableMcpTombstone | undefined;
      const latestUndo = latestUndoRaw as DurableMcpOperation | undefined;
      const latestRedo = latestRedoRaw as DurableMcpRedo | undefined;
      const ledgerKeys = operationKeysRequest.result as IDBValidKey[];
      const ledgerValues = operationEntriesRequest.result as OperationLedgerEntry[];
      if (latestRedoRaw !== undefined) {
        if (typeof latestRedo !== "object" || !latestRedo || !Number.isSafeInteger(latestRedo.undoneRevision)) throw new Error("The durable MCP redo ledger is malformed; refusing to redo it.");
        assertDurableMcpOperation(latestRedo.operation);
      }
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
      documents.put(document, CURRENT_DOCUMENT_KEY);
      try {
        const compacted = compactOperationLedger(ledgerKeys.map((key, index) => {
          assertOperationResult(ledgerValues[index]);
          return [key, ledgerValues[index]];
        }), Date.now());
        const compactedByKey = new Map(compacted.map(([key, value]) => [String(key), value]));
        ledgerKeys.forEach((key, index) => {
          const next = compactedByKey.get(String(key));
          if (!next) operations.delete(key);
          else if (next !== ledgerValues[index]) operations.put(next, key);
        });
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
    currentRequest.onsuccess = tryCommit;
    existingRequest.onsuccess = tryCommit;
    undoRequest.onsuccess = tryCommit;
    redoRequest.onsuccess = tryCommit;
    operationKeysRequest.onsuccess = tryCommit;
    operationEntriesRequest.onsuccess = tryCommit;
    currentRequest.onerror = () => { commitError = currentRequest.error ?? new Error("Could not inspect the current Draw revision."); transaction.abort(); };
    existingRequest.onerror = () => { commitError = existingRequest.error ?? new Error("Could not inspect the MCP operation ledger."); transaction.abort(); };
    undoRequest.onerror = () => { commitError = undoRequest.error ?? new Error("Could not inspect the MCP undo ledger."); transaction.abort(); };
    redoRequest.onerror = () => { commitError = redoRequest.error ?? new Error("Could not inspect the MCP redo ledger."); transaction.abort(); };
    operationKeysRequest.onerror = () => { commitError = operationKeysRequest.error ?? new Error("Could not inspect MCP ledger retention state."); transaction.abort(); };
    operationEntriesRequest.onerror = () => { commitError = operationEntriesRequest.error ?? new Error("Could not inspect MCP ledger retention state."); transaction.abort(); };
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
    const currentRequest = documents.get(CURRENT_DOCUMENT_KEY);
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
