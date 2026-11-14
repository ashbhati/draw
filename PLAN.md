# Draw: Product Plan

## Product goal

Draw is a local-first, Excalidraw-like drawing tool for creating and editing diagrams on infinite canvases. The visual direction is the charcoal Blackboard style in the GAI World deck and the supplied human-machine flow example.

The project began with one local canvas. The current V1.2.0 release organizes projects as workspaces, each with one editable infinite board, and lets a human or an MCP-connected agent create and edit the same native drawing.

## Product principles

- **The `.draw` file is the editable source.** It stores the canvas scene and its diagram elements, not just a rendered image.
- **PNG and JPEG are flattened exports.** They are for sharing and do not preserve editable objects.
- **A workspace represents one project and contains one infinite board.** Create a separate workspace for each project; multiple boards within one workspace are deferred.
- **Background is a document choice.** Start with Blackboard and Whiteboard presets and restore the selected preset when reopening a `.draw` file.
- **Draw owns the product and file format.** Excalidraw's MIT-licensed React editor package is the recommended starting point for drawing interactions, not a requirement to support Excalidraw file import/export.
- **AI creates native editable objects.** Generated diagrams should be text, shapes, arrows, and paths that can be selected and edited after creation.

## Original V1 scope (delivered)

### Canvas and editing

- One persistent, infinite canvas with pan and zoom.
- Selection and movement of individual objects and groups.
- Freehand strokes, text, rectangles, ellipses, diamonds, lines, and arrows.
- Connectors, eraser, undo, redo, duplicate, and keyboard shortcuts.
- Several diagrams can live on the same canvas and remain independently editable.

### Background and style

- A visible background picker with **Blackboard** and **Whiteboard** controls.
- The Blackboard preset uses a charcoal texture, chalk-like lettering and strokes, and a restrained palette: white for structure, yellow for emphasis, with occasional green or other accents.
- The Whiteboard preset provides a clean alternative for conventional sketching.
- Store the selected background and its style version in the `.draw` document. Background changes must not flatten or merge the diagrams.

### Editable Draw document

Create a portable, versioned `.draw` format containing:

- Canvas metadata and background preset/version.
- Editable scene elements, stable element IDs, positions, dimensions, text, colors, strokes, and relationships.
- Embedded user assets so a document does not depend on a temporary local path.
- Viewport position and zoom, so reopening returns to a useful place on the canvas.

The application should also autosave a working copy locally. Explicit **Open** and **Save** operations are the durable portability path. The initial format may wrap the editor engine's scene representation, but the file is Draw's own format and does not promise Excalidraw interchange compatibility. Any engine-specific representation must be isolated so it can be migrated later.

### Export

- Export the selected content or whole canvas as PNG or JPEG.
- Render the chosen background into the export.
- Make it clear that image exports are flattened; use `.draw` to preserve editability.

### MCP

- Run a local MCP server that works with the open Draw document.
- Provide tools to create a diagram and make targeted edits using the same native elements as manual drawing.
- Return stable element IDs and reflect changes in the open canvas so the user can immediately inspect and edit the result.

## Implementation approach

1. Inspect the empty `draw/` workspace and establish a small React + TypeScript application.
2. Integrate the official Excalidraw editor package for the standard canvas interactions; customize the shell, backgrounds, styling, persistence, and Draw file handling in this app.
3. Use the public Excalidraw source and documentation as the main reference. Use REA for specific live behavior questions that source inspection does not answer; do not spend the first release attempting full feature parity.
4. Keep a Draw document adapter between the app's persistence/MCP layer and the editor scene API.
5. Stabilize save/open and round-trip behavior before adding MCP authoring.

## Build sequence

### Milestone 1: A usable canvas

Canvas navigation, selection, drawing primitives, text, connectors, undo/redo, and an initial Blackboard/Whiteboard selector.

### Milestone 2: Durable editable files

Autosave plus explicit `.draw` open/save. Confirm all editable scene information and embedded assets round-trip. This is the first release gate.

### Milestone 3: Chalkboard style and image export

Finish the chalkboard treatment, preserve the background preset in the document, and export PNG/JPEG with the selected background.

### Milestone 4: MCP authoring

Connect Codex to the open document for diagram creation and targeted edits. Verify MCP-generated elements remain editable in the canvas and survive `.draw` save/reopen.

## First-release acceptance checks

- Create more than one diagram on the same infinite canvas; pan and zoom between them. **[Status: covered]**
- Switch between Blackboard and Whiteboard and confirm the choice persists after reopening. **[Status: covered]**
- Create text, freehand strokes, shapes, arrows, and embedded assets; save as `.draw`, close, and reopen. **[Status: covered in Chrome E2E]**
- Confirm every saved object is still individually selectable and editable, with geometry, colors, text, relationships, assets, background, and viewport restored. **[Status: covered in Chrome E2E]**
- Export PNG and JPEG and confirm they include the selected background while the `.draw` file remains the editable source. **[Status: covered]**
- Create a diagram through MCP, edit it manually, save/reopen it, and confirm the result remains intact. **[Status: covered in Chrome E2E]**
- Use the supplied Specification → Implementation → Validation example as a visual check for layout, chalk contrast, yellow emphasis, and editability. **[Status: covered in Chrome E2E using the committed top-row reconstruction; lower human/machine illustrations remain visual guidance]**

## V1.0 implementation record

V1.0 delivered the original one-canvas baseline: Blackboard/Whiteboard presets, editable `.draw` save/open, browser-local autosave, flattened PNG/JPEG export, and initial MCP diagram creation/targeted edits. The left quick-start rail and Excalidraw outbound menu links were removed; background selection was placed in the main editor toolbar. The Blackboard uses a natural slate texture with irregular chalk residue and uniform cover scaling on the live board and image exports. Default MCP node fills are transparent on Blackboard so the texture remains visible. The texture source and applicable terms are recorded in [docs/ASSET_ATTRIBUTION.md](./docs/ASSET_ATTRIBUTION.md).

The initial acceptance flows covered pan/zoom, manual drawing, both backgrounds, editable save/reopen, assets, image exports, the supplied reference diagram, MCP edits, and Blackboard texture comparisons. The full release status is updated below.

## V1.2.0 release status

V1.2.0 is tagged on `main` as [`v1.2.0`](https://github.com/ashbhati/draw/tree/v1.2.0). It completes the local V2 scope recorded in this plan:

- **Workspaces:** each project has one board; workspaces can be created, switched, renamed, deleted, and restored after reload. Opening a `.draw` file creates a separate workspace.
- **MCP parity for core drawing work:** agents can read the active drawing, create and edit native elements, select, arrange, group, duplicate, delete, undo/redo their eligible changes, manage viewport and background settings, import/open/save `.draw`, and export PNG/JPEG. Workspace lifecycle and image/library operations are available through MCP where supported.
- **MCP connection:** Draw authenticates the editor tab with a one-use launch code. An MCP host then requests an in-app approval without a manually copied pairing secret. Approved host access survives host and app restarts until revoked; credentials are stored locally with restrictive permissions.
- **Images:** the human image picker supports local images and direct image URLs discovered via Google Images. MCP image search/insertion uses the Openverse API with embedded image data and attribution metadata.
- **Runtime:** the packaged CLI runs the production app and MCP host through private per-user local IPC on macOS and Linux.
- **Manual UI refinement:** export controls retain readable labels and compact MCP controls use accessible icon buttons.

V1.2.0 validation passed 286 unit tests, 58 Chrome editor E2E flows, the production MCP/IPC round trip, and the installed-package MCP E2E flow. The build passed with the existing large-chunk advisory. The default local release command expects Playwright Chromium to be installed; on this machine the same browser flows were run with system Chrome. The npm package is not published because the repository still has no owner-selected root project license; the GitHub source tag is available.

Known limits for this release: one board per workspace, MCP file save never overwrites an existing file (`PATH_EXISTS`), Google Images is an external search tab rather than an embedded gallery, and the package supports macOS/Linux only. Details are in [README.md](README.md), [docs/PACKAGING.md](docs/PACKAGING.md), and [docs/MCP_CAPABILITY_MATRIX.md](docs/MCP_CAPABILITY_MATRIX.md).

## Deferred beyond V1.2.0

These remain deferred beyond V1.2.0 and can be prioritized based on actual use:

- Cloud sync, user accounts, collaboration, view/edit permissions, and comments.
- Excalidraw file import/export or compatibility, if it becomes useful.
- Multiple boards within one workspace.
- A first-party online image results gallery and additional image providers; the current Google Images flow opens an external search tab.
- A human-facing reusable-library interface; legacy library storage and MCP tools remain for compatibility.
- Additional background presets, richer illustration tools, and presentation workflows.
- Windows support and signed/notarized desktop installers.

## Workspace model

Draw stores workspaces and their one-board documents in browser-local IndexedDB. Schema 11 migrates older boards into individual workspaces while preserving editable scenes, IDs, histories, active selection, and library data. The workspace dropdown changes the active project; adjacent icon buttons create, rename, and delete workspaces. Deleting a workspace requires confirmation and removes its board and associated local data. Browser autosave is the local working copy; explicit `.draw` Save remains the portable backup/transfer format. MCP canvas-named compatibility tools create/select workspaces with one board. See [Workspace storage](docs/WORKSPACES_STORAGE_API.md) and [Autosave recovery](docs/AUTOSAVE_RECOVERY.md).

## Initial decisions

- **Workspace model:** one infinite board per project workspace; multiple diagrams within that board.
- **Persistence:** local working autosave plus portable `.draw` documents.
- **Initial backgrounds:** Blackboard and Whiteboard.
- **Image exports:** PNG and JPEG; flattened by definition.
- **Interoperability:** no Excalidraw-file compatibility requirement for v1.
- **Current release:** V1.2.0; deferred work is listed in [Deferred beyond V1.2.0](#deferred-beyond-v120).
