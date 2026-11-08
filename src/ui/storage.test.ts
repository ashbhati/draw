import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { createEmptyDocument } from "../document/document";
import { commitMcpOperation, createCanvas, createWorkspace, deleteCanvas, listCanvases, listWorkspaces, loadCanvasDocument, loadCurrentDocument, loadLatestMcpRedoOperation, loadLatestMcpUndoOperation, loadMcpOperation, restoreMcpCommandSnapshot, saveCurrentDocument, setActiveCanvas } from "./storage";
import { canRedoMcpOperation, canUndoMcpOperation, OPERATION_RESULT_RETENTION_MS, OPERATION_SNAPSHOT_RETENTION_MS, resolveOperationReplay, type DurableMcpOperation } from "../integrations/operation-ledger";

describe("local Draw autosave", () => {
  beforeEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("draw-local");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  });

  it("saves and restores an editable Draw document without flattening it", async () => {
    const doc = createEmptyDocument("Research map");
    doc.document.elements.push({
      id: "card-1",
      type: "rectangle",
      x: 20,
      y: 40,
      width: 260,
      height: 120,
      strokeColor: "#ffffff",
    });
    doc.document.canvas.background.preset = "white";
    doc.document.canvas.viewport = { x: -20, y: -40, zoom: 0.8 };

    await saveCurrentDocument(doc);
    const restored = await loadCurrentDocument();

    expect(restored).toEqual(doc);
    expect(restored?.document.elements[0]).toMatchObject({ id: "card-1", type: "rectangle" });
    expect(restored?.document.canvas.background.preset).toBe("white");
  });

  it("returns null before the first autosave", async () => {
    expect(await loadCurrentDocument()).toBeNull();
  });

  it("migrates the existing current document into a default workspace without changing its portable content", async () => {
    const legacy = createEmptyDocument("Existing V1 work");
    legacy.document.elements.push({ id: "legacy-shape", type: "rectangle", x: 10, y: 20, width: 70, height: 45, strokeColor: "#fff" });
    legacy.document.assets["asset-1"] = { id: "asset-1", dataURL: "data:image/png;base64,AA==" };
    legacy.document.canvas.viewport = { x: -31, y: 74, zoom: 0.8 };
    legacy.document.documentRevision = 12;
    legacy.document.viewRevision = 8;
    await seedLegacyCurrentDocument(legacy);

    expect(await loadCurrentDocument()).toEqual(legacy);
    const workspaces = await listWorkspaces();
    expect(workspaces).toHaveLength(1);
    const canvases = await listCanvases(workspaces[0].id);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ workspaceId: workspaces[0].id, documentId: legacy.document.id, name: "Existing V1 work" });
    expect(await loadCanvasDocument(canvases[0].id)).toEqual(legacy);
    expect(await readLegacyCurrentDocument()).toEqual(legacy);
  });

  it("isolates per-canvas autosaves and will not let a delayed inactive-canvas save switch or overwrite the active canvas", async () => {
    const first = createEmptyDocument("First canvas");
    await saveCurrentDocument(first);
    const workspace = (await listWorkspaces())[0];
    const secondCanvas = await createCanvas(workspace.id, "Second canvas");
    const second = await loadCanvasDocument(secondCanvas.id);
    expect(second).not.toBeNull();
    expect(second!.document.id).not.toBe(first.document.id);
    expect(second!.document.title).toBe("Second canvas");
    await setActiveCanvas(secondCanvas.id);

    const editedSecond = structuredClone(second!);
    editedSecond.document.documentRevision = 1;
    editedSecond.document.elements.push({ id: "second-shape", type: "ellipse", x: 2, y: 4, width: 20, height: 15 });
    expect(await saveCurrentDocument(editedSecond)).toEqual({ saved: true });

    const staleFirst = structuredClone(first);
    staleFirst.document.documentRevision = 1;
    staleFirst.document.elements.push({ id: "stale-shape", type: "rectangle", x: 0, y: 0, width: 10, height: 10 });
    expect(await saveCurrentDocument(staleFirst)).toEqual({ saved: false });
    expect((await loadCurrentDocument())?.document.id).toBe(second!.document.id);
    expect(await loadCanvasDocument(secondCanvas.id)).toEqual(editedSecond);
    expect(await loadCanvasDocument((await listCanvases(workspace.id))[0].id)).toEqual(first);
  });

  it("commits workspace/canvas creation atomically and keeps V1 .draw import as a new document", async () => {
    const imported = createEmptyDocument("Portable drawing");
    imported.document.elements.push({ id: "imported-shape", type: "diamond", x: 20, y: 30, width: 40, height: 50 });
    imported.document.assets.asset1 = { id: "asset1", dataURL: "data:image/png;base64,AA==" };
    const workspace = await createWorkspace("Research project");
    const canvas = await createCanvas(workspace.id, imported.document.title, imported);
    const stored = await loadCanvasDocument(canvas.id);

    expect(stored).toMatchObject({ format: "draw", formatVersion: 1 });
    expect(stored!.document.id).not.toBe(imported.document.id);
    expect(stored!.document.documentRevision).toBe(0);
    expect(stored!.document.elements).toEqual(imported.document.elements);
    expect(stored!.document.assets).toEqual(imported.document.assets);
    expect((await listCanvases(workspace.id))).toContainEqual(expect.objectContaining({ id: canvas.id, documentId: stored!.document.id }));
  });

  it("rolls back imported document and canvas together when canvas creation fails", async () => {
    const workspace = await createWorkspace("Atomic workspace");
    const imported = createEmptyDocument("Should not persist");
    await expect(createCanvas(workspace.id, imported.document.title, imported, { afterDocumentWrite: () => { throw new Error("injected failure"); } })).rejects.toThrow("injected failure");
    expect(await listCanvases(workspace.id)).toEqual([]);
    const database = await openDrawDatabaseForTest();
    const tx = database.transaction("documents", "readonly");
    const keys = await requestValue(tx.objectStore("documents").getAllKeys());
    await transactionDone(tx);
    database.close();
    expect(keys).not.toContain(imported.document.id);
  });

  it("deletes a canvas and its document without changing another workspace's active document", async () => {
    const first = createEmptyDocument("Kept canvas");
    await saveCurrentDocument(first);
    const defaultWorkspace = (await listWorkspaces())[0];
    const otherWorkspace = await createWorkspace("Other project");
    const otherCanvas = await createCanvas(otherWorkspace.id, "Other canvas");
    await setActiveCanvas(otherCanvas.id);
    const deletedDocument = await loadCanvasDocument(otherCanvas.id);

    await deleteCanvas(otherCanvas.id);
    expect(await saveCurrentDocument(deletedDocument!)).toEqual({ saved: false });

    expect(await loadCanvasDocument(otherCanvas.id)).toBeNull();
    expect(await loadCurrentDocument()).toBeNull();
    expect(await listCanvases(defaultWorkspace.id)).toHaveLength(1);
    expect(await listCanvases(otherWorkspace.id)).toHaveLength(0);
    expect(await listWorkspaces()).toHaveLength(2);
  });

  it("atomically stores the scene revision and MCP operation result", async () => {
    const before = createEmptyDocument("Atomic scene");
    await saveCurrentDocument(before);
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    after.document.elements.push({ id: "mcp-shape", type: "rectangle", x: 5, y: 7, width: 80, height: 40, strokeColor: "#ffffff" });
    const operation = {
      documentId: before.document.id,
      clientIdentity: "paired-client-a",
      idempotencyKey: "request-1",
      payloadHash: "sha256:payload",
      operationId: "operation-1",
      actor: "paired-client-a",
      baseRevision: 0,
      resultingRevision: 1,
      result: { addedElementIds: ["mcp-shape"] },
      beforeDocument: before,
      afterDocument: after,
      undoEligible: true,
      completedAt: Date.now(),
    } as const;

    await commitMcpOperation(after, operation);

    const { beforeDocument: _before, afterDocument: _after, undoEligible: _undoEligible, ...ledgerResult } = operation;
    expect(await loadCurrentDocument()).toEqual(after);
    expect(await loadMcpOperation(before.document.id, "paired-client-a", "request-1")).toEqual(ledgerResult);
    expect(await loadLatestMcpUndoOperation(before.document.id)).toEqual(operation);
  });

  it("rolls back both scene and ledger writes when a transaction fails mid-commit", async () => {
    const before = createEmptyDocument("Atomic failure");
    await saveCurrentDocument(before);
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    after.document.elements.push({ id: "uncommitted", type: "rectangle", x: 0, y: 0, width: 80, height: 40, strokeColor: "#ffffff" });
    const operation = {
      documentId: before.document.id,
      clientIdentity: "paired-client-a",
      idempotencyKey: "request-fail",
      payloadHash: "sha256:payload",
      operationId: "operation-fail",
      actor: "paired-client-a",
      baseRevision: 0,
      resultingRevision: 1,
      result: { addedElementIds: ["uncommitted"] },
      beforeDocument: before,
      afterDocument: after,
      undoEligible: true,
      completedAt: Date.now(),
    } as const;

    await expect(commitMcpOperation(after, operation, { afterDocumentWrite: () => { throw new Error("injected storage failure"); } })).rejects.toThrow("injected storage failure");

    expect(await loadCurrentDocument()).toEqual(before);
    expect(await loadMcpOperation(before.document.id, "paired-client-a", "request-fail")).toBeNull();
    expect(await loadLatestMcpUndoOperation(before.document.id)).toBeNull();
  });

  it("compensates a revoked unacknowledged MCP commit atomically only while its result is still current", async () => {
    const before = createEmptyDocument("Revocation rollback");
    await saveCurrentDocument(before);
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    after.document.elements.push({ id: "pending-mcp", type: "rectangle", x: 10, y: 10, width: 80, height: 40, strokeColor: "#fff" });
    const operation = {
      documentId: before.document.id, clientIdentity: "paired-client", idempotencyKey: "pending-key",
      payloadHash: "hash", operationId: "pending-operation", actor: "paired-client",
      baseRevision: 0, resultingRevision: 1, result: {}, beforeDocument: before, afterDocument: after,
      undoEligible: true, completedAt: Date.now(),
    } satisfies DurableMcpOperation;
    await commitMcpOperation(after, operation);
    const identity = { clientIdentity: "paired-client", idempotencyKey: "pending-key", operationId: "pending-operation" };

    await expect(restoreMcpCommandSnapshot(before, after, identity, { afterDocumentWrite: () => { throw new Error("injected compensation failure"); } })).rejects.toThrow("injected compensation failure");
    expect(await loadCurrentDocument()).toEqual(after);
    expect(await loadMcpOperation(before.document.id, "paired-client", "pending-key")).toMatchObject({ operationId: "pending-operation", result: {} });
    expect(await loadLatestMcpUndoOperation(before.document.id)).toEqual(operation);

    expect(await restoreMcpCommandSnapshot(before, after, identity)).toBe(true);
    expect(await loadCurrentDocument()).toEqual(before);
    const canceled = await loadMcpOperation(before.document.id, "paired-client", "pending-key");
    expect(canceled).toMatchObject({ operationId: "pending-operation", tombstone: true });
    expect(resolveOperationReplay(canceled, { clientIdentity: "paired-client", idempotencyKey: "pending-key", payloadHash: "hash", now: Date.now() }).kind).toBe("unknown");
    expect(await loadLatestMcpUndoOperation(before.document.id)).toBeNull();
    expect(await loadLatestMcpRedoOperation(before.document.id)).toBeNull();
  });

  it("does not compensate an MCP command after a newer human document is stored", async () => {
    const before = createEmptyDocument("Human edit wins");
    await saveCurrentDocument(before);
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    after.document.elements.push({ id: "pending-mcp", type: "rectangle", x: 10, y: 10, width: 80, height: 40, strokeColor: "#fff" });
    await saveCurrentDocument(after);
    const human = structuredClone(after);
    human.document.documentRevision = 2;
    human.document.elements.push({ id: "human-edit", type: "ellipse", x: 120, y: 10, width: 80, height: 40, strokeColor: "#fff" });
    await saveCurrentDocument(human);

    expect(await restoreMcpCommandSnapshot(before, after, { clientIdentity: "paired-client", idempotencyKey: "missing-operation", operationId: "missing" })).toBe(false);
    expect(await loadCurrentDocument()).toEqual(human);
  });

  it("does not let a delayed autosave overwrite a newer MCP revision", async () => {
    const newer = createEmptyDocument("Newer");
    newer.document.documentRevision = 3;
    await saveCurrentDocument(newer);
    const stale = createEmptyDocument("Stale");
    stale.document.documentRevision = 2;
    await saveCurrentDocument(stale);
    expect(await loadCurrentDocument()).toEqual(newer);
    const sameRevisionStale = structuredClone(newer);
    sameRevisionStale.document.title = "Stale same-revision title";
    await saveCurrentDocument(sameRevisionStale);
    expect(await loadCurrentDocument()).toEqual(newer);
  });

  it("keeps the newer app-state-only autosave when equal-revision writes finish out of order", async () => {
    const before = createEmptyDocument("Equal revision view");
    await saveCurrentDocument(before);
    const older = structuredClone(before);
    older.document.appState = { ...older.document.appState, scrollX: 10 };
    older.document.canvas.viewport = { x: 10, y: 0, zoom: 1 };
    const newer = structuredClone(before);
    newer.document.appState = { ...newer.document.appState, scrollX: 25 };
    newer.document.canvas.viewport = { x: 25, y: 0, zoom: 1 };
    await saveCurrentDocument(newer, { writeToken: { sessionId: "test-session", sequence: 2 } });
    expect(await saveCurrentDocument(older, { writeToken: { sessionId: "test-session", sequence: 1 } })).toEqual({ saved: false });
    expect((await loadCurrentDocument())?.document.appState.scrollX).toBe(25);
  });

  it("loads the document despite corrupt history and clears malformed undo/redo pointers on commit", async () => {
    const document = createEmptyDocument("Recover from history corruption");
    await saveCurrentDocument(document);
    const database = await openDrawDatabaseForTest();
    const seed = database.transaction(["mcpUndo", "mcpRedo", "mcpOperations", "mcpMeta"], "readwrite");
    seed.objectStore("mcpUndo").put({ broken: true }, document.document.id);
    seed.objectStore("mcpRedo").put({ broken: true }, document.document.id);
    seed.objectStore("mcpOperations").put({ broken: true }, JSON.stringify([document.document.id, "unrelated-client", "broken-key"]));
    seed.objectStore("mcpMeta").put(31, "commit-count");
    await transactionDone(seed);
    database.close();

    expect(await loadCurrentDocument()).toEqual(document);
    await expect(loadLatestMcpUndoOperation(document.document.id)).rejects.toThrow(/malformed|incomplete/i);

    const after = structuredClone(document);
    after.document.documentRevision = 1;
    after.document.elements.push({ id: "recovering-mcp", type: "rectangle", x: 1, y: 2, width: 30, height: 20, strokeColor: "#fff" });
    await commitMcpOperation(after, {
      documentId: document.document.id, clientIdentity: "healthy-client", idempotencyKey: "healthy-key", payloadHash: "healthy-hash",
      operationId: "healthy-operation", actor: "healthy-client", baseRevision: 0, resultingRevision: 1,
      result: { ok: true }, beforeDocument: document, afterDocument: after, undoEligible: true, completedAt: Date.now(),
    });
    expect(await loadCurrentDocument()).toEqual(after);
    expect(await loadLatestMcpUndoOperation(document.document.id)).toMatchObject({ operationId: "healthy-operation" });
    expect(await loadMcpOperation(document.document.id, "unrelated-client", "broken-key")).toBeNull();
  });

  it("expires and deletes undo snapshots after the retention window", async () => {
    const before = createEmptyDocument("Expired snapshot");
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    const operation: DurableMcpOperation = {
      documentId: before.document.id, clientIdentity: "paired-client-expired", idempotencyKey: "old-snapshot", payloadHash: "old",
      operationId: "old-snapshot-operation", actor: "paired-client-expired", baseRevision: 0, resultingRevision: 1,
      result: { operationId: "old-snapshot-operation" }, beforeDocument: before, afterDocument: after, undoEligible: true,
      completedAt: Date.now() - OPERATION_SNAPSHOT_RETENTION_MS - 1,
    };
    await commitMcpOperation(after, operation);
    expect(canUndoMcpOperation(operation, operation.clientIdentity, { id: before.document.id, documentRevision: 1 })).toBe(false);
    expect(await loadLatestMcpUndoOperation(before.document.id)).toBeNull();
  });

  it("bounds undo snapshots retained for older documents during periodic compaction", async () => {
    const current = createEmptyDocument("Current retention bound");
    await saveCurrentDocument(current);
    const database = await openDrawDatabaseForTest();
    const seed = database.transaction(["mcpUndo", "mcpMeta"], "readwrite");
    for (let index = 0; index < 101; index += 1) seed.objectStore("mcpUndo").put({ completedAt: Date.now() - 101 + index }, `old-document-${index}`);
    seed.objectStore("mcpMeta").put(31, "commit-count");
    await transactionDone(seed);
    database.close();

    const after = structuredClone(current);
    after.document.documentRevision = 1;
    const mutation: DurableMcpOperation = {
      documentId: current.document.id, clientIdentity: "retention-client", idempotencyKey: "retention-trigger", payloadHash: "retention",
      operationId: "retention-trigger", actor: "retention-client", baseRevision: 0, resultingRevision: 1,
      result: { operationId: "retention-trigger" }, beforeDocument: current, afterDocument: after, undoEligible: false, completedAt: Date.now(),
    };
    await commitMcpOperation(after, mutation);
    const verify = await openDrawDatabaseForTest();
    const transaction = verify.transaction("mcpUndo", "readonly");
    const count = await new Promise<number>((resolve, reject) => {
      const request = transaction.objectStore("mcpUndo").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(count).toBe(100);
    verify.close();
  });

  it("does not let a delayed autosave from a previous document replace the active document", async () => {
    const active = createEmptyDocument("Active document");
    await saveCurrentDocument(active);
    const staleOtherDocument = createEmptyDocument("Stale previous document");
    await saveCurrentDocument(staleOtherDocument);
    expect(await loadCurrentDocument()).toEqual(active);

    await saveCurrentDocument(staleOtherDocument, { replaceDocument: true });
    expect(await loadCurrentDocument()).toEqual(staleOtherDocument);
  });

  it("durably replays viewport mutations and CAS-checks their view revision", async () => {
    const before = createEmptyDocument("Durable viewport");
    await saveCurrentDocument(before);
    const after = structuredClone(before);
    after.document.canvas.viewport = { x: -120, y: 35, zoom: 1.25 };
    after.document.viewRevision = 1;
    const operation: DurableMcpOperation = {
      documentId: before.document.id, clientIdentity: "paired-client-view", idempotencyKey: "viewport-key",
      payloadHash: "viewport-hash", operationId: "viewport-operation", actor: "paired-client-view",
      baseRevision: 0, resultingRevision: 0, baseViewRevision: 0, resultingViewRevision: 1,
      result: { viewport: after.document.canvas.viewport, viewRevision: 1 },
      beforeDocument: before, afterDocument: after, undoEligible: false, completedAt: Date.now(),
    };
    await commitMcpOperation(after, operation);
    expect(await loadCurrentDocument()).toEqual(after);
    expect(await loadMcpOperation(before.document.id, operation.clientIdentity, operation.idempotencyKey)).toMatchObject({ operationId: operation.operationId, result: operation.result });
    await expect(commitMcpOperation(after, operation)).rejects.toThrow(/IDEMPOTENCY_REPLAY/i);

    const staleViewport = structuredClone(before);
    staleViewport.document.canvas.viewport = { x: 0, y: 200, zoom: 1.5 };
    staleViewport.document.viewRevision = 1;
    await expect(commitMcpOperation(staleViewport, {
      ...operation, idempotencyKey: "stale-viewport-key", operationId: "stale-viewport-op",
      payloadHash: "stale-hash", resultingViewRevision: 1,
      result: { viewport: staleViewport.document.canvas.viewport, viewRevision: 1 },
      afterDocument: staleViewport,
    })).rejects.toThrow(/view revision/i);
    expect(await loadCurrentDocument()).toEqual(after);
  });

  it("rejects a stale durable commit and a second concurrent same-key commit", async () => {
    const before = createEmptyDocument("CAS");
    await saveCurrentDocument(before);
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    const operation = {
      documentId: before.document.id, clientIdentity: "paired-client-a", idempotencyKey: "request-cas",
      payloadHash: "sha256:payload", operationId: "operation-cas", actor: "paired-client-a", baseRevision: 0,
      resultingRevision: 1, result: { changed: true }, beforeDocument: before, undoEligible: true, completedAt: Date.now(),
      afterDocument: after,
    } as const;
    await commitMcpOperation(after, operation);
    await expect(commitMcpOperation(after, operation)).rejects.toThrow(/IDEMPOTENCY_REPLAY/i);
    const staleAfter = structuredClone(after);
    staleAfter.document.documentRevision = 2;
    await expect(commitMcpOperation(staleAfter, { ...operation, idempotencyKey: "request-stale", operationId: "operation-stale", baseRevision: 0, resultingRevision: 2 })).rejects.toThrow(/CONFLICT/i);
    expect(await loadCurrentDocument()).toEqual(after);
    expect(await loadMcpOperation(before.document.id, "paired-client-a", "request-stale")).toBeNull();
  });

  it("restores actor-safe undo after reload and conflicts after a later human revision", async () => {
    const before = createEmptyDocument("Undo after reload");
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    after.document.elements.push({ id: "mcp-shape", type: "rectangle", x: 1, y: 2, width: 50, height: 40, strokeColor: "#ffffff" });
    const operation: DurableMcpOperation = {
      documentId: before.document.id, clientIdentity: "paired-client-a", idempotencyKey: "create-1", payloadHash: "hash",
      operationId: "mcp-operation-1", actor: "paired-client-a", baseRevision: 0, resultingRevision: 1,
      result: { operationId: "mcp-operation-1" }, beforeDocument: before, afterDocument: after, undoEligible: true, completedAt: Date.now(),
    };
    await commitMcpOperation(after, operation);
    const reloaded = await loadCurrentDocument();
    const latestUndo = await loadLatestMcpUndoOperation(before.document.id);
    expect(latestUndo?.operationId).toBe("mcp-operation-1");
    expect(canUndoMcpOperation(latestUndo, "paired-client-a", { id: before.document.id, documentRevision: reloaded!.document.documentRevision })).toBe(true);
    expect(canUndoMcpOperation(latestUndo, "paired-client-b", { id: before.document.id, documentRevision: 1 })).toBe(false);

    const humanEdit = structuredClone(reloaded!);
    humanEdit.document.documentRevision = 2;
    humanEdit.document.title = "Edited by human";
    await saveCurrentDocument(humanEdit);
    const afterHumanReload = await loadCurrentDocument();
    expect(canUndoMcpOperation(await loadLatestMcpUndoOperation(before.document.id), "paired-client-a", { id: before.document.id, documentRevision: afterHumanReload!.document.documentRevision })).toBe(false);
  });

  it("atomically records undo and redo snapshots so redo survives a reload", async () => {
    const before = createEmptyDocument("Undo redo");
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    after.document.elements.push({ id: "mcp-shape", type: "rectangle", x: 1, y: 2, width: 50, height: 40, strokeColor: "#ffffff" });
    const operation: DurableMcpOperation = {
      documentId: before.document.id, clientIdentity: "paired-client-a", idempotencyKey: "create-2", payloadHash: "hash",
      operationId: "mcp-operation-2", actor: "paired-client-a", baseRevision: 0, resultingRevision: 1,
      result: { operationId: "mcp-operation-2" }, beforeDocument: before, afterDocument: after, undoEligible: true, completedAt: Date.now(),
    };
    await commitMcpOperation(after, operation);
    const undone = structuredClone(before);
    undone.document.documentRevision = 2;
    const undoRequest: DurableMcpOperation = {
      ...operation, idempotencyKey: "undo-2", operationId: "undo-request-2", baseRevision: 1, resultingRevision: 2,
      result: { operationId: "mcp-operation-2", undone: true }, beforeDocument: after, afterDocument: undone, undoEligible: false,
    };
    await commitMcpOperation(undone, undoRequest, { undoTarget: { operationId: operation.operationId, clientIdentity: operation.clientIdentity } });
    const redo = await loadLatestMcpRedoOperation(before.document.id);
    expect(canRedoMcpOperation(redo, "paired-client-a", { id: before.document.id, documentRevision: 2 })).toBe(true);
    expect(canRedoMcpOperation(redo, "paired-client-b", { id: before.document.id, documentRevision: 2 })).toBe(false);

    const redone = structuredClone(after);
    redone.document.documentRevision = 3;
    const redoRequest: DurableMcpOperation = {
      ...operation, idempotencyKey: "redo-2", operationId: "redo-request-2", baseRevision: 2, resultingRevision: 3,
      result: { operationId: "redo-request-2", redone: true }, beforeDocument: undone, afterDocument: redone, undoEligible: true,
    };
    await commitMcpOperation(redone, redoRequest, { redoTarget: { operationId: operation.operationId, clientIdentity: operation.clientIdentity } });
    expect((await loadLatestMcpUndoOperation(before.document.id))?.operationId).toBe("redo-request-2");
    expect(await loadLatestMcpRedoOperation(before.document.id)).toBeNull();
  });

  it("compacts a seven-day-old operation result while retaining an OUTCOME_UNKNOWN tombstone", async () => {
    const before = createEmptyDocument("Retention");
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    after.document.elements.push({ id: "old-operation", type: "rectangle", x: 1, y: 1, width: 40, height: 30, strokeColor: "#ffffff" });
    const expired: DurableMcpOperation = {
      documentId: before.document.id, clientIdentity: "paired-client-a", idempotencyKey: "expired-key", payloadHash: "old-hash",
      operationId: "expired-operation", actor: "paired-client-a", baseRevision: 0, resultingRevision: 1,
      result: { operationId: "expired-operation" }, beforeDocument: before, afterDocument: after, undoEligible: true,
      completedAt: Date.now() - OPERATION_RESULT_RETENTION_MS - 1,
    };
    await commitMcpOperation(after, expired);
    const afterSecond = structuredClone(after);
    afterSecond.document.documentRevision = 2;
    afterSecond.document.title = "Second operation";
    const second: DurableMcpOperation = {
      ...expired, idempotencyKey: "second-key", payloadHash: "new-hash", operationId: "second-operation",
      baseRevision: 1, resultingRevision: 2, beforeDocument: after, afterDocument: afterSecond, undoEligible: false, completedAt: Date.now(),
      result: { operationId: "second-operation" },
    };
    const database = await openDrawDatabaseForTest();
    const maintenance = database.transaction("mcpMeta", "readwrite");
    maintenance.objectStore("mcpMeta").put(31, "commit-count");
    await transactionDone(maintenance);
    database.close();
    await commitMcpOperation(afterSecond, second, { invalidateUndo: true });

    const tombstone = await loadMcpOperation(before.document.id, "paired-client-a", "expired-key");
    expect(tombstone).toMatchObject({ tombstone: true, payloadHash: "old-hash" });
    expect(resolveOperationReplay(tombstone, { clientIdentity: "paired-client-a", idempotencyKey: "expired-key", payloadHash: "old-hash", now: Date.now() })).toEqual({ kind: "unknown", reason: "idempotency_expired" });
  });

  it("fails closed when a stored operation record is malformed", async () => {
    const document = createEmptyDocument("Malformed ledger");
    await saveCurrentDocument(document);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("mcpOperations", "readwrite");
    transaction.objectStore("mcpOperations").put({ documentId: document.document.id, clientIdentity: "paired-client-a", idempotencyKey: "bad" }, JSON.stringify([document.document.id, "paired-client-a", "bad"]));
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    database.close();

    await expect(loadMcpOperation(document.document.id, "paired-client-a", "bad")).rejects.toThrow(/malformed|incomplete/i);
  });
});

async function openDrawDatabaseForTest(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("draw-local");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedLegacyCurrentDocument(document: import("../document/document").DrawDocument): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("draw-local", 4);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("documents")) request.result.createObjectStore("documents"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction("documents", "readwrite");
  transaction.objectStore("documents").put(document, "current");
  await transactionDone(transaction);
  database.close();
}

async function readLegacyCurrentDocument(): Promise<unknown> {
  const database = await openDrawDatabaseForTest();
  const transaction = database.transaction("documents", "readonly");
  const value = await requestValue(transaction.objectStore("documents").get("current"));
  await transactionDone(transaction);
  database.close();
  return value;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
