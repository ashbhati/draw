# Draw: Product Plan

## Product goal

Build a local-first, Excalidraw-like drawing tool for creating and editing hand-drawn diagrams on one persistent infinite canvas. The initial visual direction is the charcoal chalkboard style in the GAI World deck and the supplied human-machine flow example.

The first release is for one person on one canvas. It should be easy to draw manually, ask Codex to create or edit diagrams through MCP, save the editable work, close the app, and return to it later.

## Product principles

- **The `.draw` file is the editable source.** It stores the canvas scene and its diagram elements, not just a rendered image.
- **PNG and JPEG are flattened exports.** They are for sharing and do not preserve editable objects.
- **One infinite canvas can hold multiple diagrams.** Project folders and multiple pages are deferred.
- **Background is a document choice.** Start with Blackboard Canvas and Whiteboard Canvas presets and restore the selected preset when reopening a `.draw` file.
- **Draw owns the product and file format.** Excalidraw's MIT-licensed React editor package is the recommended starting point for drawing interactions, not a requirement to support Excalidraw file import/export.
- **AI creates native editable objects.** Generated diagrams should be text, shapes, arrows, and paths that can be selected and edited after creation.

## First release scope

### Canvas and editing

- One persistent, infinite canvas with pan and zoom.
- Selection and movement of individual objects and groups.
- Freehand strokes, text, rectangles, ellipses, diamonds, lines, and arrows.
- Connectors, eraser, undo, redo, duplicate, and keyboard shortcuts.
- Several diagrams can live on the same canvas and remain independently editable.

### Background and style

- A visible background picker with **Blackboard Canvas** and **Whiteboard Canvas** controls.
- The Blackboard Canvas uses a charcoal texture, chalk-like lettering and strokes, and a restrained palette: white for structure, yellow for emphasis, with occasional green or other accents.
- The Whiteboard Canvas provides a clean alternative for conventional sketching.
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

Canvas navigation, selection, drawing primitives, text, connectors, undo/redo, and an initial Blackboard Canvas/Whiteboard Canvas selector.

### Milestone 2: Durable editable files

Autosave plus explicit `.draw` open/save. Confirm all editable scene information and embedded assets round-trip. This is the first release gate.

### Milestone 3: Chalkboard style and image export

Finish the chalkboard treatment, preserve the background preset in the document, and export PNG/JPEG with the selected background.

### Milestone 4: MCP authoring

Connect Codex to the open document for diagram creation and targeted edits. Verify MCP-generated elements remain editable in the canvas and survive `.draw` save/reopen.

## First-release acceptance checks

- Create more than one diagram on the same infinite canvas; pan and zoom between them. **[Status: covered]**
- Switch between Blackboard Canvas and Whiteboard Canvas and confirm the choice persists after reopening. **[Status: covered]**
- Create text, freehand strokes, shapes, arrows, and embedded assets; save as `.draw`, close, and reopen. **[Status: covered in Chrome E2E]**
- Confirm every saved object is still individually selectable and editable, with geometry, colors, text, relationships, assets, background, and viewport restored. **[Status: covered in Chrome E2E]**
- Export PNG and JPEG and confirm they include the selected background while the `.draw` file remains the editable source. **[Status: covered]**
- Create a diagram through MCP, edit it manually, save/reopen it, and confirm the result remains intact. **[Status: covered in Chrome E2E]**
- Use the supplied Specification → Implementation → Validation example as a visual check for layout, chalk contrast, yellow emphasis, and editability. **[Status: covered in Chrome E2E using the committed top-row reconstruction; lower human/machine illustrations remain visual guidance]**

## V1 implementation status

The core local-first V1 is implemented: one infinite canvas, Blackboard Canvas/Whiteboard Canvas presets, editable `.draw` save/open, browser-local autosave, flattened PNG/JPEG export, and MCP creation/targeted edits. All listed acceptance flows are covered in automated Chrome E2E, including pan/zoom, manual drawing, both backgrounds, editable save/reopen, assets, image exports, reference flow, and MCP edits. Safari and Firefox have not been checked. The MCP bridge currently requires the Vite development server and an open Draw tab; a packaged production/desktop host is outside the current local development workflow and still needs explicit scope for release.

Estimate: after the current review fixes, the remaining acceptance and visual-polish work is roughly **2–4 hours**, assuming the local Vite workflow is acceptable for V1. A standalone production app and MCP host would be additional work, likely **a few days**, depending on the packaging target.

## Revisit after the first release

Keep these out of the first build, then prioritize them based on actual use:

- Multiple canvases, projects, folders, and pages.
- Cloud sync, user accounts, collaboration, view/edit permissions, and comments.
- Excalidraw file import/export or compatibility, if it becomes useful.
- Broader Excalidraw feature coverage after a focused feature audit.
- Additional board/background presets, libraries, richer illustration tools, and presentation workflows.

## Initial decisions

- **Canvas model:** one infinite scene, multiple diagrams within it.
- **Persistence:** local working autosave plus portable `.draw` documents.
- **Initial backgrounds:** Blackboard Canvas and Whiteboard Canvas.
- **Image exports:** PNG and JPEG; flattened by definition.
- **Interoperability:** no Excalidraw-file compatibility requirement for v1.
- **Future scope:** revisit the deferred capabilities after the first release is implemented and used.
