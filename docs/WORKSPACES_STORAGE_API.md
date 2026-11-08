# Workspace storage API (V2 foundation)

Draw stores workspaces and canvases locally in IndexedDB. A workspace groups canvases; each canvas points to one editable `DrawDocument`. A canvas is not a `.draw` file: the portable file remains a self-contained format v1 document and can be moved independently.

## Migration and compatibility

The database moves from schema version 4 to 5. During upgrade, the former `documents["current"]` record is copied under its existing `document.id`, attached to a default workspace and canvas, and selected as active. Its portable document content, assets, scene/view revisions, app state and viewport are preserved. The old `current` key remains as a compatibility alias for V1 clients; new reads and writes address documents by ID and the selected canvas pointer. Existing MCP operation history remains keyed by the same document ID.

Fresh installs create their default workspace and first canvas on the first document save. A successful V1 `.draw` import should be passed to `createCanvas`; that API gives it a new document ID, resets local revision counters, and copies the scene and embedded assets, so import behaves as “open as new” and never overwrites the source document.

## API

`listWorkspaces()` and `listCanvases(workspaceId)` return metadata in creation order. `createWorkspace(name)` adds a workspace. `createCanvas(workspaceId, name, source?)` creates an empty document or imports `source` as a new editable document. `loadCanvasDocument(canvasId)` loads a canvas without changing the active selection. `setActiveCanvas(canvasId)` selects a canvas for the editor shell. `deleteCanvas(canvasId)` deletes its local document and MCP undo/redo snapshots; deleting the active canvas clears the active pointer. `saveCurrentDocument(document)` persists only when the document is still selected, so an autosave scheduled before a canvas switch cannot overwrite or activate another canvas. Pass `{ replaceDocument: true }` only for an explicit open/replace operation in the currently selected canvas.

These functions are exported from `src/ui/storage.ts`. They provide the model and persistence surface for the workspace UI in the next PR; this PR intentionally does not add UI.

## Failure behavior

Workspace/canvas operations use IndexedDB transactions. A failure while creating a canvas aborts both the canvas row and the newly copied document. Draw file export remains independent of this local database: `.draw` retains editable scene data/assets; PNG/JPEG remain flattened shareable images.
