import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { createEmptyDocument, parseDrawFile, serializeDrawFile } from "../document/document";
import { addWorkspaceLibraryItem, commitMcpOperation, commitMcpWorkspaceOperation, createCanvas, createWorkspace, deleteCanvas, deleteWorkspace, deleteWorkspaceLibraryItem, duplicateCanvas, DrawStorageRecoveryError, getMcpWorkspaceCatalog, listCanvases, listWorkspaces, loadCanvasDocument, loadCurrentDocument, loadLatestMcpRedoOperation, loadLatestMcpUndoOperation, loadMcpOperation, loadMcpWorkspaceOperationReceipt, loadWorkspaceLibrary, loadWorkspaceLibraryState, MCP_WORKSPACE_RECEIPT_LIMIT, renameCanvas, renameWorkspace, renameWorkspaceLibraryItem, restoreMcpCommandSnapshot, saveCurrentDocument, saveWorkspaceLibrary, setActiveCanvas, WorkspaceLibraryConflictError } from "./storage";
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

  async function getWorkspaceReceipts(): Promise<any[]> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = database.transaction("mcpWorkspaceOperations", "readonly");
      const request = tx.objectStore("mcpWorkspaceOperations").getAll();
      return await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result as any[]);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  }

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

  it("preserves trusted Openverse attribution in local storage but downgrades portable imports", async () => {
    const doc = createEmptyDocument("Openverse attribution");
    const attribution = {
      provider: "Openverse", providerId: "123e4567-e89b-12d3-a456-426614174000", title: "Chalk arrows",
      creator: "Artist", sourceUrl: "https://example.test/source", license: "by", licenseVersion: "4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/", capturedAt: "2026-01-01T00:00:00.000Z",
      verification: "openverse-index",
    };
    doc.document.elements.push({ id: "image-1", type: "image", x: 10, y: 20, width: 1, height: 1, fileId: "image-1", customData: { drawAttribution: attribution } });
    doc.document.assets["image-1"] = { id: "image-1", dataURL: "data:image/png;base64,AA==", attribution };

    await saveCurrentDocument(doc);
    expect((await loadCurrentDocument())?.document.assets["image-1"]?.attribution).toMatchObject({ verification: "openverse-index" });
    const canvas = (await listCanvases((await listWorkspaces())[0].id))[0];
    expect((await loadCanvasDocument(canvas.id))?.document.assets["image-1"]?.attribution).toMatchObject({ verification: "openverse-index" });
    expect(parseDrawFile(serializeDrawFile(doc)).document.assets["image-1"]?.attribution).toMatchObject({ verification: "unverified" });
  });

  it("returns null before the first autosave", async () => {
    expect(await loadCurrentDocument()).toBeNull();
  });

  it("renames canvases and workspaces while keeping the canvas document title in sync", async () => {
    const original = createEmptyDocument("Architecture");
    await saveCurrentDocument(original);
    const workspace = (await listWorkspaces())[0];
    const canvas = (await listCanvases(workspace.id))[0];
    await renameWorkspace(workspace.id, "Platform");
    await renameCanvas(canvas.id, "Service map");
    expect((await listWorkspaces())[0].name).toBe("Platform");
    expect((await listCanvases(workspace.id))[0].name).toBe("Service map");
    expect((await loadCanvasDocument(canvas.id))?.document.title).toBe("Service map");
  });

  it("duplicates an editable canvas into a new independent document", async () => {
    const source = createEmptyDocument("Original");
    source.document.elements.push({ id: "node-original", type: "rectangle", x: 11, y: 22, width: 90, height: 40 });
    source.document.canvas.viewport = { x: -40, y: 18, zoom: 0.75 };
    await saveCurrentDocument(source);
    const workspace = (await listWorkspaces())[0];
    const originalCanvas = (await listCanvases(workspace.id))[0];
    const copyCanvas = await duplicateCanvas(originalCanvas.id, "Copy");
    const copy = await loadCanvasDocument(copyCanvas.id);
    expect(copyCanvas.id).not.toBe(originalCanvas.id);
    expect(copy?.document.id).not.toBe(source.document.id);
    expect(copy?.document.title).toBe("Copy");
    expect(copy?.document.elements).toEqual(source.document.elements);
    expect(copy?.document.canvas.viewport).toEqual(source.document.canvas.viewport);
    expect(copy?.document.documentRevision).toBe(0);
  });

  it("deletes an active workspace and its documents, selecting a sibling canvas transactionally", async () => {
    const keep = createEmptyDocument("Keep");
    await saveCurrentDocument(keep);
    const keepWorkspace = (await listWorkspaces())[0];
    const doomedWorkspace = await createWorkspace("Doomed");
    const doomedCanvas = await createCanvas(doomedWorkspace.id, "Private diagram");
    const doomedDocument = await loadCanvasDocument(doomedCanvas.id);
    await setActiveCanvas(doomedCanvas.id);
    await deleteWorkspace(doomedWorkspace.id);
    expect(await listWorkspaces()).toHaveLength(1);
    expect(await listCanvases(doomedWorkspace.id)).toEqual([]);
    expect(await loadCanvasDocument(doomedCanvas.id)).toBeNull();
    expect((await loadCurrentDocument())?.document.id).toBe(keep.document.id);
    expect(keepWorkspace.id).not.toBe(doomedWorkspace.id);
    expect(doomedDocument).not.toBeNull();
  });

  it("commits MCP workspace creation with an atomic receipt and replays exact results", async () => {
    await saveCurrentDocument(createEmptyDocument("Existing"));
    const before = await getMcpWorkspaceCatalog();
    const request = {
      clientIdentity: "agent-one",
      idempotencyKey: "create-platform",
      payloadHash: "payload-create-platform",
      expectedCatalogRevision: before.catalogRevision,
      action: { type: "create_workspace" as const, name: "Platform" },
    };

    const created = await commitMcpWorkspaceOperation(request);
    const replay = await commitMcpWorkspaceOperation(request);

    expect(replay.activeWorkspaceId).toBe(created.activeWorkspaceId);
    expect(replay.activeCanvasId).toBe(created.activeCanvasId);
    expect(replay.operation).toMatchObject({ type: "create_workspace", workspaceId: created.workspace?.id, canvasId: created.canvas?.id });
    expect(await loadMcpWorkspaceOperationReceipt("agent-one", "create-platform", "payload-create-platform")).toMatchObject({ activeWorkspaceId: created.activeWorkspaceId, activeCanvasId: created.activeCanvasId });
    expect(created.workspace).toMatchObject({ name: "Platform" });
    expect(created.canvas).toMatchObject({ workspaceId: created.workspace?.id, name: "Untitled drawing" });
    expect(created.activeWorkspaceId).toBe(created.workspace?.id);
    expect(created.activeCanvasId).toBe(created.canvas?.id);
    expect(created.activeDocument.document.id).toBe(created.canvas?.documentId);
    expect(created.catalogRevision).toBe(before.catalogRevision + 1);
    expect((await listWorkspaces()).filter((item) => item.name === "Platform")).toHaveLength(1);
    expect((await listCanvases(created.workspace!.id))).toHaveLength(1);
  });

  it("replays only compact operation metadata and rebuilds current active document and catalog", async () => {
    await saveCurrentDocument(createEmptyDocument("Before"));
    const initial = await getMcpWorkspaceCatalog();
    const request = {
      clientIdentity: "agent-one", idempotencyKey: "stable-create", payloadHash: "stable-create-payload",
      expectedCatalogRevision: initial.catalogRevision, action: { type: "create_workspace" as const, name: "Agent workspace" },
    };
    const applied = await commitMcpWorkspaceOperation(request);
    const humanWorkspace = await createWorkspace("Human workspace");
    const humanCanvas = await createCanvas(humanWorkspace.id, "Human edit");
    await setActiveCanvas(humanCanvas.id);
    const catalogAfterHumanSwitch = await getMcpWorkspaceCatalog();
    await commitMcpWorkspaceOperation({
      clientIdentity: "human-editor", idempotencyKey: "human-rename-canvas", payloadHash: "human-rename-canvas-payload",
      expectedCatalogRevision: catalogAfterHumanSwitch.catalogRevision,
      action: { type: "rename_canvas", canvasId: humanCanvas.id, name: "Human edit after agent" },
    });
    expect((await getMcpWorkspaceCatalog()).activeCanvasId).toBe(humanCanvas.id);
    const replay = await loadMcpWorkspaceOperationReceipt("agent-one", "stable-create", "stable-create-payload");
    const commitReplay = await commitMcpWorkspaceOperation(request);
    expect(replay?.catalogRevision).toBeGreaterThan(applied.catalogRevision);
    expect(replay?.activeWorkspaceId).toBe(humanWorkspace.id);
    expect(replay?.activeCanvasId).toBe(humanCanvas.id);
    expect(replay?.activeDocument.document.title).toBe("Human edit after agent");
    expect(replay?.operation).toMatchObject({ type: "create_workspace", workspaceId: applied.workspace?.id, canvasId: applied.canvas?.id });
    expect(commitReplay.activeCanvasId).toBe(humanCanvas.id);
    expect(commitReplay.activeDocument.document.title).toBe("Human edit after agent");
    const receipts = await getWorkspaceReceipts();
    const receiptJson = JSON.stringify(receipts);
    expect(receiptJson).not.toContain("activeDocument");
    expect(receiptJson).not.toContain("human-only-element");
  });

  it("atomically removes workspace library rows and receipts during an MCP workspace deletion", async () => {
    await saveCurrentDocument(createEmptyDocument("Root"));
    const initial = await getMcpWorkspaceCatalog();
    const created = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "workspace-with-library", payloadHash: "workspace-with-library-payload",
      expectedCatalogRevision: initial.catalogRevision, action: { type: "create_workspace", name: "Library workspace" },
    });
    await addWorkspaceLibraryItem(created.activeWorkspaceId, {
      id: "image-backed", created: 1, elements: [{ id: "image", type: "image", fileId: "private-asset" }],
      assets: { "private-asset": { id: "private-asset", dataURL: "data:image/png;base64,SECRET_IMAGE" } },
    } as any, { clientIdentity: "agent-one", idempotencyKey: "add-image", payloadHash: "add-image-payload", expectedRevision: 0 });

    await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "delete-library-workspace", payloadHash: "delete-library-workspace-payload",
      expectedCatalogRevision: (await getMcpWorkspaceCatalog()).catalogRevision,
      action: { type: "delete_workspace", workspaceId: created.activeWorkspaceId },
    });

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction("workspaceLibrary", "readonly");
      const row = await new Promise<unknown>((resolve, reject) => {
        const request = tx.objectStore("workspaceLibrary").get(created.activeWorkspaceId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(row).toBeUndefined();
    } finally { db.close(); }
  });

  it("removes workspace receipts that refer to deleted local drawings and bounds receipt retention", async () => {
    await saveCurrentDocument(createEmptyDocument("Root"));
    const initial = await getMcpWorkspaceCatalog();
    const workspace = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "private-create", payloadHash: "private-create-payload",
      expectedCatalogRevision: initial.catalogRevision, action: { type: "create_workspace", name: "Private workspace" },
    });
    const privateDoc = structuredClone(workspace.activeDocument);
    privateDoc.document.assets.privateImage = { id: "privateImage", dataURL: "data:image/png;base64,PRIVATE_IMAGE_BYTES" };
    privateDoc.document.elements.push({ id: "private-element", type: "image", fileId: "privateImage" });
    await saveCurrentDocument(privateDoc);
    const deleted = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "delete-private", payloadHash: "delete-private-payload",
      expectedCatalogRevision: (await getMcpWorkspaceCatalog()).catalogRevision, action: { type: "delete_workspace", workspaceId: workspace.activeWorkspaceId },
    });
    expect(deleted.workspaces.some((item) => item.id === workspace.activeWorkspaceId)).toBe(false);
    let receipts = await getWorkspaceReceipts();
    expect(receipts.every((receipt) => !JSON.stringify(receipt).includes(workspace.activeWorkspaceId))).toBe(true);
    expect(receipts.every((receipt) => !JSON.stringify(receipt).includes(workspace.activeCanvasId))).toBe(true);
    expect(receipts.every((receipt) => !JSON.stringify(receipt).includes("PRIVATE_IMAGE_BYTES"))).toBe(true);
    expect(receipts.every((receipt) => !JSON.stringify(receipt).includes("private-element"))).toBe(true);

    let revision = deleted.catalogRevision;
    const current = (await getMcpWorkspaceCatalog()).activeWorkspaceId;
    for (let index = 0; index < MCP_WORKSPACE_RECEIPT_LIMIT + 1; index += 1) {
      const result = await commitMcpWorkspaceOperation({
        clientIdentity: "agent-one", idempotencyKey: `bounded-${index}`, payloadHash: `bounded-payload-${index}`,
        expectedCatalogRevision: revision, action: { type: "rename_workspace", workspaceId: current, name: `Workspace ${index}` },
      });
      revision = result.catalogRevision;
    }
    receipts = await getWorkspaceReceipts();
    expect(receipts.length).toBeLessThanOrEqual(MCP_WORKSPACE_RECEIPT_LIMIT);
    expect(receipts.some((receipt) => receipt.idempotencyKey === "bounded-0")).toBe(false);
    expect(receipts.some((receipt) => receipt.idempotencyKey === `bounded-${MCP_WORKSPACE_RECEIPT_LIMIT}`)).toBe(true);
  });

  it("cleans up compact MCP receipt references for canvases and workspaces deleted in Draw", async () => {
    await saveCurrentDocument(createEmptyDocument("Root"));
    let catalog = await getMcpWorkspaceCatalog();
    const createdWorkspace = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "ui-delete-workspace", payloadHash: "ui-delete-workspace-payload",
      expectedCatalogRevision: catalog.catalogRevision, action: { type: "create_workspace", name: "UI cleanup" },
    });
    catalog = await getMcpWorkspaceCatalog();
    const createdCanvas = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "ui-delete-canvas", payloadHash: "ui-delete-canvas-payload",
      expectedCatalogRevision: catalog.catalogRevision,
      action: { type: "create_canvas", workspaceId: createdWorkspace.activeWorkspaceId, name: "Temporary canvas" },
    });
    const deletedCanvasId = createdCanvas.canvas!.id;
    await deleteCanvas(deletedCanvasId);
    let receipts = await getWorkspaceReceipts();
    expect(receipts.every((receipt) => !(receipt.canvasIds ?? []).includes(deletedCanvasId))).toBe(true);
    await deleteWorkspace(createdWorkspace.activeWorkspaceId);
    receipts = await getWorkspaceReceipts();
    expect(receipts.every((receipt) => !(receipt.workspaceIds ?? []).includes(createdWorkspace.activeWorkspaceId))).toBe(true);
  });

  it("keeps workspace receipts scoped to the authenticated caller", async () => {
    await saveCurrentDocument(createEmptyDocument("Existing"));
    const before = await getMcpWorkspaceCatalog();
    const result = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "same-key", payloadHash: "same-payload",
      expectedCatalogRevision: before.catalogRevision,
      action: { type: "create_workspace", name: "One" },
    });
    await expect(loadMcpWorkspaceOperationReceipt("agent-two", "same-key", "same-payload")).resolves.toBeNull();
    expect(await loadMcpWorkspaceOperationReceipt("agent-one", "same-key", "same-payload")).toMatchObject({
      activeWorkspaceId: result.activeWorkspaceId, activeCanvasId: result.activeCanvasId,
      operation: { type: "create_workspace", workspaceId: result.workspace?.id, canvasId: result.canvas?.id },
    });
  });

  it("atomically applies MCP canvas rename, duplicate, select, and confirmation-approved delete targets", async () => {
    await saveCurrentDocument(createEmptyDocument("Original"));
    const catalog = await getMcpWorkspaceCatalog();
    const workspaceId = catalog.activeWorkspaceId;
    const originalCanvasId = catalog.activeCanvasId;
    const renamed = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "rename-canvas", payloadHash: "rename-hash",
      expectedCatalogRevision: catalog.catalogRevision,
      action: { type: "rename_canvas", canvasId: originalCanvasId, name: "Source map" },
    });
    expect(renamed.canvas?.name).toBe("Source map");
    expect(renamed.activeDocument.document.title).toBe("Source map");
    const duplicate = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "duplicate-canvas", payloadHash: "duplicate-hash",
      expectedCatalogRevision: renamed.catalogRevision,
      action: { type: "duplicate_canvas", canvasId: originalCanvasId },
    });
    expect(duplicate.canvas?.name).toBe("Source map copy");
    const selected = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "select-original", payloadHash: "select-hash",
      expectedCatalogRevision: duplicate.catalogRevision,
      action: { type: "select_canvas", workspaceId, canvasId: originalCanvasId },
    });
    expect(selected.activeCanvasId).toBe(originalCanvasId);
    expect(selected.activeDocument.document.title).toBe("Source map");
    const deleted = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "delete-copy", payloadHash: "delete-hash",
      expectedCatalogRevision: selected.catalogRevision,
      action: { type: "delete_canvas", canvasId: duplicate.canvas!.id },
    });
    expect(deleted.activeCanvasId).toBe(originalCanvasId);
    expect(deleted.canvases.map((item) => item.id)).toEqual([originalCanvasId]);
    expect(await loadCanvasDocument(duplicate.canvas!.id)).toBeNull();
  });

  it("rejects a reused workspace key with a different payload and stale catalog revisions without mutation", async () => {
    await saveCurrentDocument(createEmptyDocument("Existing"));
    const before = await getMcpWorkspaceCatalog();
    const first = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "rename", payloadHash: "hash-a",
      expectedCatalogRevision: before.catalogRevision,
      action: { type: "create_workspace", name: "One" },
    });
    await expect(commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "rename", payloadHash: "hash-b",
      expectedCatalogRevision: before.catalogRevision,
      action: { type: "create_workspace", name: "Two" },
    })).rejects.toThrow(/IDEMPOTENCY_KEY_REUSE/);
    await expect(commitMcpWorkspaceOperation({
      clientIdentity: "agent-two", idempotencyKey: "stale", payloadHash: "hash-c",
      expectedCatalogRevision: before.catalogRevision,
      action: { type: "create_workspace", name: "Stale" },
    })).rejects.toThrow(/CONFLICT.*catalog revision/i);
    expect((await getMcpWorkspaceCatalog()).catalogRevision).toBe(first.catalogRevision);
    expect((await listWorkspaces()).some((item) => item.name === "Two" || item.name === "Stale")).toBe(false);
  });

  it("imports a Draw document as an independently editable canvas", async () => {
    await saveCurrentDocument(createEmptyDocument("Existing"));
    const catalog = await getMcpWorkspaceCatalog();
    const workspaceId = catalog.activeWorkspaceId!;
    const imported = createEmptyDocument("Agent diagram");
    imported.document.elements.push({ id: "source-node", type: "rectangle", x: 12, y: 24, width: 90, height: 60 });
    const result = await commitMcpWorkspaceOperation({
      clientIdentity: "agent-one", idempotencyKey: "import-diagram", payloadHash: "import-hash",
      expectedCatalogRevision: catalog.catalogRevision,
      action: { type: "import_draw_file_as_canvas", workspaceId, name: "Imported", document: imported },
    });
    expect(result.canvas?.name).toBe("Imported");
    expect(result.activeDocument.document.id).not.toBe(imported.document.id);
    expect(result.activeDocument.document.elements).toEqual(imported.document.elements);
    expect((await loadCanvasDocument(result.canvas!.id))?.document.elements[0]).toMatchObject({ id: "source-node", type: "rectangle" });
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

  it("rekeys draft V5 document rows without losing canvas selections or revisions", async () => {
    const document = createEmptyDocument("Draft V5");
    document.document.documentRevision = 4;
    await seedV5Document(document);
    expect(await loadCurrentDocument()).toEqual(document);
    const workspaces = await listWorkspaces();
    expect(await listCanvases(workspaces[0].id)).toMatchObject([{ documentId: document.document.id, name: "Draft V5" }]);
    const db = await openDrawDatabaseForTest();
    const tx = db.transaction("documents", "readonly");
    const keys = await requestValue(tx.objectStore("documents").getAllKeys());
    await transactionDone(tx);
    db.close();
    expect(keys).toContainEqual(["draw-document", document.document.id]);
    expect(keys).not.toContain(document.document.id);
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
    expect(await saveCurrentDocument(editedSecond)).toMatchObject({ saved: true });

    const staleFirst = structuredClone(first);
    staleFirst.document.documentRevision = 1;
    staleFirst.document.elements.push({ id: "stale-shape", type: "rectangle", x: 0, y: 0, width: 10, height: 10 });
    expect(await saveCurrentDocument(staleFirst)).toEqual({ saved: false });
    expect((await loadCurrentDocument())?.document.id).toBe(second!.document.id);
    expect(await loadCanvasDocument(secondCanvas.id)).toEqual(editedSecond);
    const firstCanvas = (await listCanvases(workspace.id)).find((canvas) => canvas.documentId === first.document.id)!;
    expect(await loadCanvasDocument(firstCanvas.id)).toEqual(first);
  });

  it("keeps the V1 current-document alias aligned when the active canvas changes", async () => {
    const first = createEmptyDocument("First");
    await saveCurrentDocument(first);
    const workspace = (await listWorkspaces())[0];
    const secondCanvas = await createCanvas(workspace.id, "Second");
    const second = await loadCanvasDocument(secondCanvas.id);
    await setActiveCanvas(secondCanvas.id);
    expect(await readLegacyCurrentDocument()).toEqual(second);
    expect(await loadCurrentDocument()).toEqual(second);
  });

  it("persists selected library elements and referenced assets per workspace across reloads", async () => {
    const first = await createWorkspace("First project");
    const second = await createWorkspace("Second project");
    const item = {
      id: "library-flow-1",
      status: "unpublished" as const,
      created: 123,
      name: "Reusable flow",
      elements: [{ id: "node", type: "image", fileId: "asset-1", x: 12, y: 24, width: 80, height: 50 }],
      assets: { "asset-1": { id: "asset-1", dataURL: "data:image/png;base64,AA==", mimeType: "image/png" } },
    };
    await saveWorkspaceLibrary(first.id, [item], 0);
    expect(await loadWorkspaceLibrary(first.id)).toEqual([item]);
    expect(await loadWorkspaceLibrary(second.id)).toEqual([]);
    await renameWorkspaceLibraryItem(first.id, item.id, "Named flow", { clientIdentity: "human", idempotencyKey: "rename-flow", payloadHash: "rename-flow-payload", expectedRevision: 1 });
    expect(await loadWorkspaceLibrary(first.id)).toMatchObject([{ id: item.id, name: "Named flow" }]);
    await deleteWorkspaceLibraryItem(first.id, item.id, { clientIdentity: "human", idempotencyKey: "delete-flow", payloadHash: "delete-flow-payload", expectedRevision: 2 });
    expect(await loadWorkspaceLibrary(first.id)).toEqual([]);
  });

  it("does not let a stale library snapshot overwrite newer item-level changes", async () => {
    const workspace = await createWorkspace("Library race");
    const stale = await loadWorkspaceLibraryState(workspace.id);
    const item = { id: "fresh-item", created: 1, elements: [{ id: "shape", type: "rectangle" }], assets: {} } as any;
    await addWorkspaceLibraryItem(workspace.id, item, {
      clientIdentity: "client-a", idempotencyKey: "add-fresh", payloadHash: "hash-add-fresh", expectedRevision: stale.revision,
    });

    await expect(saveWorkspaceLibrary(workspace.id, stale.items, stale.revision)).rejects.toBeInstanceOf(WorkspaceLibraryConflictError);
    await expect(loadWorkspaceLibrary(workspace.id)).resolves.toMatchObject([{ id: "fresh-item" }]);
  });

  it("replays durable library mutation results and rejects reused keys with changed payloads", async () => {
    const workspace = await createWorkspace("Library idempotency");
    const item = { id: "receipt-item", created: 1, name: "Original", elements: [{ id: "shape", type: "rectangle" }], assets: {} } as any;
    const context = { clientIdentity: "mcp-client-1", idempotencyKey: "add-1", payloadHash: "payload-a", expectedRevision: 0 };
    const first = await addWorkspaceLibraryItem(workspace.id, item, context);
    const retry = await addWorkspaceLibraryItem(workspace.id, item, context);
    expect(first.revision).toBe(1);
    expect(retry).toMatchObject({ result: first.result, revision: first.revision, replayed: true });
    await expect(addWorkspaceLibraryItem(workspace.id, { ...item, name: "Changed" }, { ...context, payloadHash: "payload-b" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE" });
  });

  it("removes image payloads from library receipts after deleting their item", async () => {
    const workspace = await createWorkspace("Receipt cleanup");
    const item = {
      id: "sensitive-image-item", created: 1, elements: [{ id: "photo", type: "image", fileId: "private-asset" }],
      assets: { "private-asset": { id: "private-asset", dataURL: "data:image/png;base64,PRIVATE_LIBRARY_IMAGE" } },
    } as any;
    const added = await addWorkspaceLibraryItem(workspace.id, item, { clientIdentity: "agent", idempotencyKey: "add-photo", payloadHash: "photo-add", expectedRevision: 0 });
    await deleteWorkspaceLibraryItem(workspace.id, item.id, { clientIdentity: "agent", idempotencyKey: "delete-photo", payloadHash: "photo-delete", expectedRevision: 1 });

    const state = await loadWorkspaceLibraryState(workspace.id);
    expect(state.items).toEqual([]);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction("workspaceLibrary", "readonly");
      const row = await new Promise<any>((resolve, reject) => {
        const request = tx.objectStore("workspaceLibrary").get(workspace.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("PRIVATE_LIBRARY_IMAGE");
      expect(serialized).not.toContain('"item":');
      expect(row.receipts[JSON.stringify(["agent", "add-photo"])].result).toMatchObject({ itemId: item.id, libraryRevision: 1 });
      expect(Object.keys(row.receipts).length).toBeLessThanOrEqual(256);
    } finally { db.close(); }
    const replay = await addWorkspaceLibraryItem(workspace.id, item, { clientIdentity: "agent", idempotencyKey: "add-photo", payloadHash: "photo-add", expectedRevision: 0 });
    expect(replay).toMatchObject({ result: added.result, replayed: true });
  });

  it("expires old library receipts and caps retained retry metadata", async () => {
    const workspace = await createWorkspace("Bounded receipts");
    const item = { id: "small-item", created: 1, name: "Stable", elements: [{ id: "shape", type: "rectangle" }], assets: {} } as any;
    await saveWorkspaceLibrary(workspace.id, [item], 0);
    for (let index = 0; index < 260; index += 1) {
      await renameWorkspaceLibraryItem(workspace.id, item.id, "Stable", {
        clientIdentity: "agent", idempotencyKey: `receipt-${index}`, payloadHash: `payload-${index}`, expectedRevision: 1,
      });
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction("workspaceLibrary", "readwrite");
      const store = tx.objectStore("workspaceLibrary");
      const row = await new Promise<any>((resolve, reject) => {
        const request = store.get(workspace.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      row.receipts[JSON.stringify(["agent", "expired"])] = {
        clientIdentity: "agent", idempotencyKey: "expired", payloadHash: "expired", result: { renamed: true }, revision: 1,
        completedAt: Date.now() - 100 * 24 * 60 * 60 * 1000,
      };
      row.receipts[JSON.stringify(["agent", "legacy-content"])] = {
        clientIdentity: "agent", idempotencyKey: "legacy-content", payloadHash: "legacy-content", revision: 1,
        result: { item: { id: "legacy-item", elements: [], assets: { photo: { dataURL: "data:image/png;base64,OLD_SECRET" } } } }, completedAt: Date.now(),
      };
      store.put(row, workspace.id);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    } finally { db.close(); }
    await renameWorkspaceLibraryItem(workspace.id, item.id, "Stable", {
      clientIdentity: "agent", idempotencyKey: "trigger-prune", payloadHash: "trigger-prune", expectedRevision: 1,
    });
    const state = await loadWorkspaceLibraryState(workspace.id);
    expect(state.items).toMatchObject([{ id: "small-item", name: "Stable" }]);
    const inspectDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = inspectDb.transaction("workspaceLibrary", "readonly");
      const row = await new Promise<any>((resolve, reject) => {
        const request = tx.objectStore("workspaceLibrary").get(workspace.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(Object.keys(row.receipts)).toHaveLength(256);
      expect(row.receipts[JSON.stringify(["agent", "expired"])]).toBeUndefined();
      expect(row.receipts[JSON.stringify(["agent", "receipt-0"])]).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain("OLD_SECRET");
      expect(row.receipts[JSON.stringify(["agent", "legacy-content"])].result).toMatchObject({ itemId: "legacy-item" });
    } finally { inspectDb.close(); }
  });

  it("uses a library revision compare-and-swap so concurrent stale renames conflict", async () => {
    const workspace = await createWorkspace("Library CAS");
    const item = { id: "cas-item", created: 1, name: "Original", elements: [{ id: "shape", type: "rectangle" }], assets: {} } as any;
    await saveWorkspaceLibrary(workspace.id, [item], 0);
    const outcomes = await Promise.allSettled([
      renameWorkspaceLibraryItem(workspace.id, item.id, "First", { clientIdentity: "client-a", idempotencyKey: "rename-a", payloadHash: "hash-a", expectedRevision: 1 }),
      renameWorkspaceLibraryItem(workspace.id, item.id, "Second", { clientIdentity: "client-b", idempotencyKey: "rename-b", payloadHash: "hash-b", expectedRevision: 1 }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason instanceof WorkspaceLibraryConflictError)).toHaveLength(1);
    expect((await loadWorkspaceLibraryState(workspace.id)).revision).toBe(2);
  });

  it("removes workspace library data atomically when deleting its workspace", async () => {
    const workspace = await createWorkspace("Temporary project");
    await saveWorkspaceLibrary(workspace.id, [{ id: "temporary-item", created: 1, elements: [{ id: "temporary-shape", type: "rectangle" }], assets: {} } as any], 0);
    await deleteWorkspace(workspace.id);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction("workspaceLibrary", "readonly");
      const saved = await new Promise<unknown>((resolve, reject) => {
        const request = transaction.objectStore("workspaceLibrary").get(workspace.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(saved).toBeUndefined();
    } finally { db.close(); }
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
    expect(await loadCurrentDocument()).toEqual(first);
    expect(await listCanvases(defaultWorkspace.id)).toHaveLength(1);
    expect(await listCanvases(otherWorkspace.id)).toHaveLength(0);
    expect(await listWorkspaces()).toHaveLength(2);
  });

  it("deletes the only canvas without retaining or resurrecting its legacy alias", async () => {
    const secret = createEmptyDocument("Secret to delete");
    secret.document.elements.push({ id: "secret", type: "text", text: "private" });
    await saveCurrentDocument(secret);
    const canvas = (await listCanvases((await listWorkspaces())[0].id))[0];
    await deleteCanvas(canvas.id);
    expect(await loadCurrentDocument()).toBeNull();
    await expect(saveCurrentDocument(secret)).rejects.toThrow(/no active canvas/i);
    const db = await openDrawDatabaseForTest();
    const tx = db.transaction("documents", "readonly");
    const keys = await requestValue(tx.objectStore("documents").getAllKeys());
    const rows = await requestValue(tx.objectStore("documents").getAll());
    await transactionDone(tx);
    db.close();
    expect(keys).not.toContain("current");
    expect(keys).not.toContain("current-write-order");
    expect(JSON.stringify(rows)).not.toContain("Secret to delete");
    expect(JSON.stringify(rows)).not.toContain("private");
  });

  it("replaces content without changing canvas identity or colliding with sibling IDs", async () => {
    const initial = createEmptyDocument("Original");
    initial.document.documentRevision = 9;
    initial.document.viewRevision = 4;
    await saveCurrentDocument(initial);
    const workspace = (await listWorkspaces())[0];
    const canvasA = (await listCanvases(workspace.id))[0];
    const canvasB = await createCanvas(workspace.id, "Sibling");
    const siblingDocument = (await loadCanvasDocument(canvasB.id))!;
    const incoming = structuredClone(siblingDocument);
    incoming.document.title = "Replacement content";
    incoming.document.elements.push({ id: "new", type: "rectangle", x: 0, y: 0, width: 20, height: 10 });
    await writeStore("mcpUndo", (store) => store.put({ completedAt: Date.now() }, initial.document.id));
    await writeStore("mcpRedo", (store) => store.put({ operation: { completedAt: Date.now() } }, initial.document.id));
    await writeStore("mcpOperations", (store) => store.put({ documentId: initial.document.id }, "old-operation"));

    const outcome = await saveCurrentDocument(incoming, { replaceDocument: true });
    expect(outcome.saved).toBe(true);
    expect(outcome.document?.document.id).not.toBe(siblingDocument.document.id);
    expect(outcome.document?.document.documentRevision).toBe(10);
    expect(outcome.document?.document.viewRevision).toBeGreaterThan(4);
    expect((await listCanvases(workspace.id)).find((canvas) => canvas.id === canvasA.id)).toMatchObject({
      id: canvasA.id,
      documentId: outcome.document!.document.id,
      name: "Replacement content",
    });
    expect(await loadCanvasDocument(canvasB.id)).toEqual(siblingDocument);
    expect(await loadCurrentDocument()).toEqual(outcome.document);
    const db = await openDrawDatabaseForTest();
    const tx = db.transaction(["documents", "mcpUndo", "mcpRedo", "mcpOperations"], "readonly");
    const docKeys = await requestValue(tx.objectStore("documents").getAllKeys());
    const undo = await requestValue(tx.objectStore("mcpUndo").get(initial.document.id));
    const redo = await requestValue(tx.objectStore("mcpRedo").get(initial.document.id));
    const operations = await requestValue(tx.objectStore("mcpOperations").get("old-operation"));
    await transactionDone(tx);
    db.close();
    expect(docKeys).not.toContainEqual(["draw-document", initial.document.id]);
    expect(docKeys).not.toContainEqual(["draw-write-order", initial.document.id]);
    expect(undo).toBeUndefined();
    expect(redo).toBeUndefined();
    expect(operations).toBeUndefined();
  });

  it("drops an autosave for the old document after a replacement without throwing", async () => {
    const original = createEmptyDocument("Before replacement");
    await saveCurrentDocument(original);
    const imported = createEmptyDocument("Imported replacement");
    const replacement = await saveCurrentDocument(imported, { replaceDocument: true });
    expect(replacement.saved).toBe(true);
    await expect(saveCurrentDocument(original)).resolves.toEqual({ saved: false });
    expect(await loadCurrentDocument()).toEqual(replacement.document);
  });

  it("invalidates old MCP replay and rejects the pre-open revision after replacement", async () => {
    const before = createEmptyDocument("MCP before open");
    await saveCurrentDocument(before);
    const after = structuredClone(before);
    after.document.documentRevision = 1;
    const operation: DurableMcpOperation = {
      documentId: before.document.id, clientIdentity: "open-test-client", idempotencyKey: "pre-open", payloadHash: "pre-open-hash",
      operationId: "pre-open-operation", actor: "open-test-client", baseRevision: 0, resultingRevision: 1,
      result: { operationId: "pre-open-operation" }, beforeDocument: before, afterDocument: after, undoEligible: true, completedAt: Date.now(),
    };
    await commitMcpOperation(after, operation);
    const replacement = await saveCurrentDocument(createEmptyDocument("MCP after open"), { replaceDocument: true });
    expect(replacement.document?.document.documentRevision).toBe(2);
    expect(await loadMcpOperation(before.document.id, operation.clientIdentity, operation.idempotencyKey)).toBeNull();
    const stale = structuredClone(after);
    stale.document.documentRevision = 2;
    await expect(commitMcpOperation(stale, {
      ...operation, idempotencyKey: "stale-after-open", operationId: "stale-after-open", baseRevision: 1, resultingRevision: 2,
      beforeDocument: after, afterDocument: stale,
    })).rejects.toThrow(/CONFLICT/i);
  });

  it("serializes an autosave racing a replacement without surfacing a recovery error", async () => {
    const original = createEmptyDocument("Original for race");
    await saveCurrentDocument(original);
    const imported = createEmptyDocument("Replacement for race");
    const staleSave = saveCurrentDocument(original);
    const replacementSave = saveCurrentDocument(imported, { replaceDocument: true });
    const results = await Promise.all([staleSave, replacementSave]);
    expect(results[1].saved).toBe(true);
    expect(await loadCurrentDocument()).toMatchObject({ document: { title: "Replacement for race" } });
  });

  it("quarantines malformed V1 autosave and keeps the upgraded database usable", async () => {
    await seedLegacyCurrentDocument({ garbage: true } as never);
    await expect(loadCurrentDocument()).rejects.toBeInstanceOf(DrawStorageRecoveryError);
    await expect(listWorkspaces()).resolves.toEqual([]);
    const db = await openDrawDatabaseForTest();
    const tx = db.transaction(["documents", "workspaceMeta"], "readonly");
    const raw = await requestValue(tx.objectStore("documents").get("current"));
    const recovery = await requestValue(tx.objectStore("workspaceMeta").get("legacy-recovery"));
    await transactionDone(tx);
    db.close();
    expect(raw).toEqual({ garbage: true });
    expect(recovery).toEqual({ garbage: true });
  });

  it("repairs a missing active pointer to a valid sibling canvas and reports missing document rows", async () => {
    const first = createEmptyDocument("First");
    await saveCurrentDocument(first);
    const workspace = (await listWorkspaces())[0];
    const secondCanvas = await createCanvas(workspace.id, "Second");
    const secondDocument = (await loadCanvasDocument(secondCanvas.id))!;
    await setActiveCanvas(secondCanvas.id);
    await writeStore("workspaceMeta", (store) => store.delete("active"));
    const fallback = await loadCurrentDocument();
    expect([first.document.id, secondDocument.document.id]).toContain(fallback?.document.id);
    expect(await saveCurrentDocument(fallback!)).toMatchObject({ saved: true });

    await writeStore("workspaceMeta", (store) => store.put({ workspaceId: workspace.id, canvasId: "dangling" }, "active"));
    expect((await loadCurrentDocument())?.document.id).toBe(fallback?.document.id);
    expect(await saveCurrentDocument(fallback!)).toMatchObject({ saved: true });

    await setActiveCanvas(secondCanvas.id);
    await writeStore("documents", (store) => store.delete(["draw-document", secondDocument.document.id]));
    await expect(loadCanvasDocument(secondCanvas.id)).rejects.toThrow(/damaged|missing/i);
    await writeStore("documents", (store) => store.delete(["draw-document", first.document.id]));
    await expect(loadCurrentDocument()).rejects.toThrow(/damaged|missing/i);
    await expect(saveCurrentDocument(secondDocument)).rejects.toThrow(/damaged|missing/i);
  });

  it("selects a sibling canvas atomically when deleting the active canvas", async () => {
    const first = createEmptyDocument("First");
    await saveCurrentDocument(first);
    const workspace = (await listWorkspaces())[0];
    const sibling = await createCanvas(workspace.id, "Sibling");
    const siblingDoc = await loadCanvasDocument(sibling.id);
    const firstCanvas = (await listCanvases(workspace.id)).find((canvas) => canvas.documentId === first.document.id)!;
    await setActiveCanvas(firstCanvas.id);
    await deleteCanvas(firstCanvas.id);
    expect(await loadCurrentDocument()).toEqual(siblingDoc);
    expect((await saveCurrentDocument(siblingDoc!)).saved).toBe(true);
  });

  it.each(["current", "current-write-order"])("safely stores a document with reserved legacy ID %s", async (id) => {
    const doc = createEmptyDocument("Reserved ID");
    doc.document.id = id;
    await saveCurrentDocument(doc);
    expect(await loadCurrentDocument()).toEqual(doc);
    const db = await openDrawDatabaseForTest();
    const tx = db.transaction("documents", "readonly");
    const values = await requestValue(tx.objectStore("documents").getAll());
    await transactionDone(tx);
    db.close();
    expect(values).toContainEqual(doc);
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
    active.document.documentRevision = 9;
    await saveCurrentDocument(active);
    const staleOtherDocument = createEmptyDocument("Stale previous document");
    await saveCurrentDocument(staleOtherDocument);
    expect(await loadCurrentDocument()).toEqual(active);

    await saveCurrentDocument(staleOtherDocument, { replaceDocument: true });
    const replaced = await loadCurrentDocument();
    expect(replaced?.document.id).not.toBe(staleOtherDocument.document.id);
    expect(replaced?.document.title).toBe(staleOtherDocument.document.title);
    expect(replaced?.document.documentRevision).toBe(10);
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
    await saveCurrentDocument(before);
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

async function seedV5Document(document: import("../document/document").DrawDocument): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("draw-local", 5);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("documents");
      const workspaces = database.createObjectStore("workspaces");
      const canvases = database.createObjectStore("canvases");
      canvases.createIndex("byWorkspaceId", "workspaceId", { unique: false });
      canvases.createIndex("byDocumentId", "documentId", { unique: true });
      database.createObjectStore("workspaceMeta");
      const now = Date.now();
      const workspaceId = "old-workspace";
      const canvasId = "old-canvas";
      const transaction = request.transaction!;
      transaction.objectStore("documents").put(document, document.document.id);
      transaction.objectStore("documents").put({ sessionId: "old", sequence: 1 }, `${document.document.id}-write-order`);
      transaction.objectStore("documents").put(document, "current");
      workspaces.put({ id: workspaceId, name: "My workspace", createdAt: now, updatedAt: now }, workspaceId);
      canvases.put({ id: canvasId, workspaceId, name: document.document.title, documentId: document.document.id, createdAt: now, updatedAt: now }, canvasId);
      transaction.objectStore("workspaceMeta").put({ workspaceId, canvasId }, "active");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
}

async function readLegacyCurrentDocument(): Promise<unknown> {
  const database = await openDrawDatabaseForTest();
  const transaction = database.transaction("documents", "readonly");
  const value = await requestValue(transaction.objectStore("documents").get("current"));
  await transactionDone(transaction);
  database.close();
  return value;
}

async function writeStore(storeName: string, change: (store: IDBObjectStore) => void): Promise<void> {
  const database = await openDrawDatabaseForTest();
  const transaction = database.transaction(storeName, "readwrite");
  change(transaction.objectStore(storeName));
  await transactionDone(transaction);
  database.close();
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
