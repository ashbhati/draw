# Workspace storage API (V2 foundation)

Draw stores workspaces and canvases locally in IndexedDB. A workspace groups canvases; each canvas points to one editable `DrawDocument`. A canvas is not a `.draw` file: the portable file remains a self-contained format v1 document and can be moved independently.

## Migration and compatibility

The database moves through schema version 7. During upgrade, the former `documents["current"]` record is copied under its existing `document.id`, attached to a default workspace and canvas, and selected as active. Its portable document content, assets, scene/view revisions, app state and viewport are preserved. Malformed legacy content is quarantined and reported as a `DrawStorageRecoveryError`; it does not abort the IndexedDB upgrade. Data created by the earlier V5 draft is re-keyed. The old `current` row remains only as a compatibility alias for V1 clients; namespaced IndexedDB keys protect it from arbitrary document IDs. Existing MCP operation history remains keyed by the same document ID. Schema 7 adds the durable `mcpWorkspaceOperations` receipt store and monotonic workspace catalog revision metadata.

Fresh installs create their default workspace and first canvas on the first document save. A successful V1 `.draw` import should be passed to `createCanvas`; that API gives it a new document ID, resets local revision counters, and copies the scene and embedded assets, so import behaves as “open as new” and never overwrites the source document.

## API

`listWorkspaces()` and `listCanvases(workspaceId)` return metadata in creation order. `createWorkspace(name)` adds a workspace. `createCanvas(workspaceId, name, source?)` creates an empty document or imports `source` as a new editable document. `loadCanvasDocument(canvasId)` loads a canvas without changing the active selection. `setActiveCanvas(canvasId)` selects a canvas for the editor shell. `deleteCanvas(canvasId)` deletes its local document and MCP history; deleting the active canvas selects the first remaining intact canvas in the same transaction. `saveCurrentDocument(document)` persists only when the document is still selected, so an autosave scheduled before a canvas switch cannot overwrite or activate another canvas. Pass `{ replaceDocument: true }` only for an explicit open/replace operation in the currently selected canvas. Replace keeps the canvas ID, assigns the imported document a fresh ID, advances its scene and view revisions beyond the previous document, and removes the replaced document's private undo/redo and operation history. The returned `document` is the normalized document that the editor and MCP clients must adopt.

On load, a missing or dangling active pointer is repaired to the first intact canvas. If canvas records exist but none has a valid document, or a quarantined legacy document needs recovery, storage raises `DrawStorageRecoveryError`. A missing canvas document is not treated as a new empty drawing. If every canvas was intentionally deleted, new autosaves do not silently recreate a deleted canvas.

These functions are exported from `src/ui/storage.ts`. The editor UI and the issue #52 MCP tools use these APIs. MCP mutations run through the authenticated active editor and commit their workspace/document change and idempotency receipt in one IndexedDB transaction. Exact retries replay the original result; a reused key with a different payload conflicts. `.draw` import through MCP creates a new canvas/document and preserves the source and currently saved canvases.

## Failure behavior

Workspace/canvas operations use IndexedDB transactions. A failure while creating a canvas aborts both the canvas row and the newly copied document. Draw file export remains independent of this local database: `.draw` retains editable scene data/assets; PNG/JPEG remain flattened shareable images.
