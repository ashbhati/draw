# Draw MCP capability matrix

This document translates the V2 goal—agents should be able to do the meaningful work available to a person in Draw—into a reviewable capability and safety contract. The target is **semantic capability parity**, not a remote imitation of every mouse gesture: an agent asks for “create a labeled box”, while the editor remains responsible for rendering, hit testing, and canvas interaction.

The matrix describes current V1 behavior as inspected in `src/integrations/mcp-server.ts`, `src/integrations/mcp-contract.ts`, `src/integrations/diagram-builder.ts`, `src/integrations/scene-updates.ts`, and `src/App.tsx`. Proposed V2 tools below are names to agree on, not claims that those tools exist today.

## Current V1 and proposed V2 coverage

| Human-facing capability | Current V1 MCP | V2 target | Notes |
| --- | --- | --- | --- |
| Read the active drawing | `get_current_canvas` reads title, document ID, background, viewport, element count, assets count, and a page of elements. | Retain; add a stable document revision/snapshot cursor and complete relationship/style metadata. | Current page uses offset/limit, maximum 250. It returns element IDs, type, text excerpt, geometry, container/bound-element links, and colors. |
| Create a diagram of labeled nodes and connectors | `create_diagram` creates rectangle, ellipse, and diamond nodes and arrows, with optional labels/title and colors. | Retain as a high-level convenience tool; add general authoring for every supported native element kind. | V1 creates editable Draw/Excalidraw elements, not a raster image. |
| Create standalone text, line, or freehand stroke | Not available. | `create_elements` (proposed) supports text, line, arrow, freehand, and supported shape primitives with validated geometry and styles. | Image insertion is covered by [V2 issue #35](https://github.com/ashbhati/draw/issues/35). |
| Move, resize, recolor, or edit text | `update_elements` supports text, position, dimensions, stroke color, and background color. | Retain and complete type-specific geometry/text behavior, all relevant style fields, and arrow/label routing. | Existing element IDs come from `get_current_canvas` or `create_diagram` results. |
| Select, duplicate, delete, group, align, reorder | Not available. | `duplicate_elements`, `delete_elements`, and `arrange_elements` (proposed) use explicit IDs and semantic options. | Do not make MCP depend on transient mouse selection when callers can identify objects by ID. Grouping/reordering should remain native scene operations. |
| Undo/redo | Not exposed. | `undo` and `redo` (proposed), with every successful MCP mutation included in normal app history. | The human must be able to undo an agent's work with the same editor controls. |
| Choose Blackboard/Whiteboard background | Not available. | `set_canvas_settings` (proposed) supports the same background presets and other document-level settings that are safe to expose. | Preserve the V1 rule that existing custom colors are not silently changed beyond the existing preset adaptation behavior. |
| Pan, zoom, fit or center content | Read returns viewport; no MCP viewport change. | `set_viewport` and/or `fit_content` (proposed). | Return applied viewport and document revision. A viewport operation must not move diagram elements. |
| Rename document | No MCP tool. | Include in `set_canvas_settings` or a dedicated rename operation. | This modifies document metadata, not an element. |
| Open a `.draw` file | Human UI file picker only. | `open_document` (proposed), accepting a user-approved document/resource or app-provided file handle. | Never accept an arbitrary path and read it without user approval. Opening a document must clearly replace or switch the active document and must not destroy the previous one. |
| Save editable `.draw` document | Human UI download only; MCP mutations update the active app document and local autosave. | `save_document` (proposed) returns the complete editable document as a resource/artifact or saves through an explicitly approved location. | Preserve elements, app state, background, viewport, embedded assets, and metadata. |
| Export PNG/JPEG | Human UI only. | `export_image` (proposed) returns an image resource/artifact. | This is a flattened shareable output; it must not be confused with or replace `.draw`. Support whole canvas and explicit element-ID selection. |
| Insert/inspect external images | Human UI's Excalidraw asset support can place images; V2 image search is not yet present. | MCP image search/insert using the provider flow in [#35](https://github.com/ashbhati/draw/issues/35). | Download and embed image bytes; preserve source, creator, and license metadata. Avoid hotlinks and unsafe SVG. |
| Browse/add a reusable library | Library browse exists; saving selections to the library is deferred. | Keep tracked in [#11](https://github.com/ashbhati/draw/issues/11); optionally expose library add/insert via MCP after parity contract is agreed. | Do not conflate the local reusable library with an external image search provider. |
| Organize multiple projects/documents | One current V1 canvas/document. | Workspace and canvas operations tracked in [#34](https://github.com/ashbhati/draw/issues/34). | Workspace is the project container; canvas is an individual editable document. |

The MCP process itself currently requires the Vite development server and an open Draw tab. Installed/production MCP support is tracked in [#28](https://github.com/ashbhati/draw/issues/28).

## Proposed semantic tool groups

Tool names are placeholders until the implementation issues settle the final schema.

### Inspect and author

- `get_current_canvas`: retain; return `documentId`, `documentRevision`, title, background, viewport, assets summary, and paginated element records. Include relationships and style values needed to make a reliable next edit.
- `create_diagram`: retain as a compact, higher-level operation for common labeled node-and-edge diagrams.
- `create_elements`: create one or more native shapes, text blocks, lines, arrows, and freehand strokes. Support caller-local IDs to define relationships inside the batch and return a mapping to stable Draw element IDs.
- Image provider search and insertion should be a separate semantic flow: search, inspect/license-check, then insert selected result. This avoids downloading an unexpected asset as a side effect of a vague diagram request.

### Edit and arrange

- `update_elements`: retain; support type-aware style/geometry/text changes and return IDs, resulting geometry, document revision, and any warnings.
- `delete_elements`, `duplicate_elements`, `arrange_elements`, `undo`, and `redo`: add as needed for human-equivalent document work. Arrangement operations should use clear parameters such as `bringToFront`, `align: "left"`, or `distribute: "horizontal"`, not raw canvas gestures.
- Mutations that refer to an existing element must fail explicitly if the element ID is stale or belongs to another document. By default, mutations target the active document and should not implicitly change project/canvas context.

### Document and output

- `set_canvas_settings`: change the active document title, background preset, and other safe document-level fields.
- `set_viewport` / `fit_content`: change only the view, and report the resulting viewport.
- `open_document`: operate on file data/resource supplied by the client or a user-approved app file handle. Do not treat an untrusted path string as permission to read arbitrary local files.
- `save_document`: produce the native editable `.draw` document through an MCP resource/artifact, or write only inside a configured, user-approved Draw directory. Do not silently overwrite an existing file; require a confirmation or an explicit, previously granted overwrite policy.
- `export_image`: return a flattened PNG/JPEG separately from the editable document. If an image file is written locally, use the same approval/allowlist rules as `save_document`.

## Identifier and revision contract

- `documentId` is the stable identity of one Draw document. It is distinct from a workspace or canvas display name.
- Every scene element has a stable Draw-generated `elementId`. A caller-provided node/temporary ID is only a request-local alias and is mapped to Draw IDs in the response; it must never be treated as the persistent ID unless the API explicitly accepts and validates it.
- Creation responses return complete mappings for created shapes, standalone text, labels, arrows, and edge labels, plus parent/binding relationships. Avoid a flat list of generated IDs with no explanation.
- `get_current_canvas` supports bounded pages and returns a snapshot/revision token. A stable cursor should be tied to that snapshot so edits between page requests cannot silently shift pagination and omit or repeat elements.
- Mutations accept an optional `expectedDocumentRevision`; if the active document changed after the agent read it, return a conflict with the latest revision and ask the caller to re-read and reconcile. Do not auto-apply stale positional edits.
- All returned IDs are scoped to `documentId`. Cross-document IDs fail validation.

## Mutation, history, and retry semantics

- Validate the complete mutation batch before applying it. Prefer all-or-nothing behavior for one tool call; if partial application is needed, return an explicit per-element status and the revision of the resulting document.
- Each successful mutation is one undoable transaction in the editor's normal history. Batched changes should not create a separate undo step per low-level element unless that is an intentional, documented user-visible behavior.
- Every mutation returns an operation ID, the target `documentId`, resulting `documentRevision`, affected element IDs, and `applied: true|false`.
- A repeated request with the same idempotency key returns the original result and does not duplicate scene elements. Keep the idempotency record long enough to cover transport retries; report when its retention expires.
- If a request times out, the client must be able to query the operation ID or read the latest document revision before deciding whether to retry. A timeout must never be interpreted as proof that no mutation occurred.
- Persistence failure after a scene mutation is reported as “applied, not confirmed saved” with IDs/revision and recovery instructions; do not report a simple failure that encourages a duplicate create.
- Conflicts from a human edit during an agent operation are surfaced explicitly. Do not overwrite the human's newer document state.

## File and local-data safety boundaries

The installed MCP runtime must stay local-first and loopback-bound, per [#28](https://github.com/ashbhati/draw/issues/28). MCP's stdio process does not itself grant permission to access arbitrary files.

- Default operations work on the currently active document already opened in Draw.
- For open/save/export, prefer document bytes returned as an MCP resource/artifact and let the user choose a local destination in Draw. If direct local writes are introduced, require an explicit allowlisted directory configured by the user and reject paths outside it after canonicalization (including traversal and symlink escapes).
- Never accept arbitrary local path reads, network URLs as filesystem paths, or implicit overwrite of an existing document. Ask for confirmation before replacing/switching away from a dirty document.
- Do not expose credentials, browser storage, or unrelated local files through `get_current_canvas` or other resources.
- Remote image search is a separate network capability. Show the provider/source and license metadata, validate download URL/size/type, sanitize or disallow SVG, and embed validated bytes in the Draw document rather than rendering a remote URL at reopen time.

## `.draw` compatibility requirements

V1 uses a versioned JSON `.draw` format (`format: "draw"`, `formatVersion: 1`) containing document identity/title, an infinite canvas with Blackboard/Whiteboard background and viewport, native editor elements, app state, and assets. V2 MCP must use the same document model as the UI.

- An MCP-authored file must validate as a normal Draw document and reopen through the existing Open flow.
- Preserve native element fields, text/container bindings, arrow bindings, asset bytes and references, app state, background, viewport, and stable IDs needed to continue editing.
- Do not serialize only an image or a simplified representation when saving `.draw`.
- Keep V1 files readable. If V2 needs new fields or a new schema, provide a tested migration and preserve unknown compatible element metadata where possible; do not silently drop unsupported content.
- PNG/JPEG remain flattened exports and are never substituted for the editable `.draw` source.

## Minimum verification for MCP parity work

For each new tool group, add schema/contract tests and an end-to-end test using the real stdio MCP server and a running Draw tab/app. At minimum, verify:

1. An agent creates multiple native element types, including text, line/freehand and labeled arrows.
2. `get_current_canvas` returns all elements over multiple pages with stable IDs, relationships, and a consistent revision.
3. The agent updates, arranges, deletes or duplicates elements, then undoes and redoes the operation in app history.
4. A human can select and edit an agent-created element in Chrome.
5. The active drawing saves as `.draw`, reloads with its assets/background/viewport intact, and remains editable.
6. PNG/JPEG export is a separate flattened artifact with the chosen background and selection scope.
7. Invalid IDs, stale revisions, disallowed paths, write conflicts, duplicate idempotency keys, and delayed acknowledgements fail or recover as specified without data loss or duplicate objects.

Tests should exercise the user-visible flow in Chrome. Unit tests alone do not establish that Draw can render and edit the resulting scene or that the save/open and export round trips preserve it.

## Product decisions to confirm during issue #31 review

- Is “same capabilities” about the same document operations, or should MCP also expose every editor preference and toolbar setting? Recommended scope: document and scene capabilities, not purely cosmetic app preferences.
- Should `open_document` be allowed to replace the active document, or should agents create/switch canvases only after a human confirms? Recommended default: explicit confirmation for replacement; prefer create/switch within the selected project.
- Should direct MCP writes be limited to the current document, or may an agent create and select canvases within the active project? Recommended default: current document until workspace authorization is designed in #34.
- Should all active assets be embedded in a `.draw` file? Recommended yes for reliable offline reopen, subject to size limits and retained license/attribution metadata.
- For export, should an MCP call return bytes as an artifact, or should Draw prompt the human for a download location? Recommended: artifact/resource by default, optional save-to-directory only with explicit configured permission.
