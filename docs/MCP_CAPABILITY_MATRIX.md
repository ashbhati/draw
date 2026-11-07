# Draw MCP capability matrix

This document translates the V2 goal—agents should be able to do the meaningful work available to a person in Draw—into a reviewable capability and safety contract. The target is **semantic capability parity**, not a remote imitation of every mouse gesture: an agent requests an operation such as “create a labeled box”, while the editor remains responsible for rendering, hit testing, and canvas interaction.

Status labels below are deliberate: **Available (V1)** describes implemented behavior; **Unsupported (V1)** means no current MCP operation exists; **Proposed (V2)** is a design target, not an implementation claim. Tool names and detailed schemas are proposals for issue #31 review.

## Current MCP contract (V1)

| Tool | Input currently accepted | Output currently returned | Important limits |
| --- | --- | --- | --- |
| `get_current_canvas` | Optional `offset` (default 0, max 1,000,000) and `limit` (default 250, max 250). | `id` (the document ID; not `documentId`), `title`, background preset, viewport, total element count, page metadata, and elements with IDs, types, text excerpts, geometry, container/bound links, and colors. | Flushes the active tab first. It is paginated, but has no snapshot/revision token. The response's `id` field should be renamed or aliased to `documentId` in a versioned V2 contract. |
| `create_diagram` | Optional title; 1–100 nodes, each requiring caller `id`, non-empty `label`, finite x/y; optional dimensions, shape (rectangle/ellipse/diamond), color; up to 200 edges (`from`/`to`, optional label/color). | Maps caller node IDs to Draw IDs in `nodes`; maps node label IDs in `nodeLabels`; returns created edges with element IDs and optional label IDs, `addedElementIds`, and optional `titleElementId`. | Node labels are required in V1; edge labels are optional. Creates native editable Draw/Excalidraw elements, not a raster image. |
| `update_elements` | 1–100 updates by element ID. Patch fields: non-empty text, x/y, width/height, strokeColor, backgroundColor. | Updated element IDs and result/warning data. | Cannot create standalone text, lines, freehand, or image elements; no delete, duplicate, group, reorder, selection, background, document lifecycle, export, undo, or redo tools. |

The development bridge currently accepts only loopback requests, checks the request Host against the configured loopback host/port, rejects a mismatched Origin when Origin is present, and requires JSON for mutation requests. The bridge's request-body ceiling is 100 MiB. The MCP process has a 25-second HTTP request timeout; the Vite bridge's default command timeout is 20 seconds, and late acknowledgements are retained for 60 seconds. The bridge assigns an in-memory `draw-command-…` ID and client ID; it has no caller idempotency key, persistent operation ledger, or document revision today. A command can already have applied when the caller receives a timeout; V1 instructs the client to call `get_current_canvas` before retrying.

## Capability matrix and follow-up map

The “input/output shape” column gives the proposed contract at a conceptual level; exact field names and validation limits belong in the phase-zero contract work (#31). “Confirmation boundary” states who may authorize the operation. Unsupported V1 capabilities are marked explicitly rather than implied by a future proposal.

| Human-facing capability | V1 coverage | V2 semantic tool and input/output shape | Confirmation / permission boundary | Follow-up |
| --- | --- | --- | --- | --- |
| Read active canvas | **Available (V1):** `get_current_canvas`; output uses `id`, not `documentId`. | Retain `get_current_canvas`; input is document selector plus bounded cursor/page size. Output includes `documentId`, snapshot/revision, title, background, viewport, and complete per-element relationships/styles. | Read only the active document; do not expose browser storage, credentials, or unrelated local files. | #31 contract; #33 implementation |
| Create labeled nodes/arrows | **Available (V1):** `create_diagram`; node `label` is required, edge `label` optional. | Retain as convenience wrapper. Input has request-local node keys, labels, positions, shape/style, and edges. Output maps every request key to stable element IDs and relationships. | Mutates only the selected active document; validate entire batch before apply. | #32 |
| Create standalone shapes, text, lines, arrows, freehand | **Unsupported (V1)** except nodes/arrows via `create_diagram`. | Proposed `create_elements`; input is typed native element specs with bounded geometry/style and local relationship keys; output maps all keys to Draw element IDs. | Active document only; no arbitrary code, HTML, or remote resource execution from text fields. | #31 schema; #32 implementation |
| Update, move, resize, recolor, edit text | **Available (V1):** `update_elements` for listed V1 patch fields. | Retain and add type-aware fields. Input includes element IDs, patches, expected revision, and idempotency key; output reports per-element result, resulting geometry, revision, operation ID, and applied state. | Active document only; reject stale IDs/revisions instead of overwriting newer edits. | #32, #33 |
| Select / clear selection | **Unsupported (V1)** through MCP; selection remains an editor state. | Proposed `set_selection` using explicit element IDs (and optional clear). Output returns selected IDs. | No confirmation; selection is transient and must not increment the persistent document revision. | #31 contract; #33 implementation |
| Duplicate / delete / group / ungroup / align / reorder | **Unsupported (V1)** through MCP. | Proposed `duplicate_elements`, `delete_elements`, `group_elements`, `arrange_elements`; inputs use element IDs and semantic parameters; outputs return affected IDs and resulting relationships/order. | Destructive delete may require app confirmation for large or cross-group actions; default operations remain within the active document. | #31 contract; #33 implementation |
| Undo / redo | **Unsupported (V1)** through MCP. | Proposed `undo_operation` / `redo_operation` by operation ID and actor; output reports applied state and new revision. | An agent may undo only its own latest eligible operation. If a human or other actor changed the document afterward, return a conflict; never consume a later human action from the shared undo stack. | #31 semantics; #33 implementation |
| Change background / document title | **Unsupported (V1)** through MCP; user can choose Blackboard/Whiteboard and rename in the UI. | Proposed `set_canvas_settings`; input has supported background/title fields and expected revision; output gives normalized settings and revision. | Settings apply only to active document. No automatic recoloring beyond documented preset behavior. | #31 schema; #33 implementation |
| Pan / zoom / fit content | **Unsupported (V1)** for mutations; read tool returns current viewport. | Proposed `set_viewport` / `fit_content`; input is a viewport or fit policy; output is resulting viewport and revision. | Active document only. Must not change element coordinates; viewport changes increment the document revision because viewport is persisted in `.draw`. | #31 semantics; #33 implementation |
| Open a `.draw` document | **Unsupported (V1)** through MCP; human uses an Open file picker. | Proposed `open_document`; input is validated document bytes/resource or a file handle issued by Draw; output is the opened document ID/revision. | Arbitrary path strings are never permission to read a file. Replacing an active document with unsaved edits requires confirmation in Draw. | #31 safety; #33 file operations; #34 project switching |
| Save editable `.draw` | **Unsupported (V1)** as an MCP tool; MCP edits affect the active app document/local autosave, but Save .draw is a human UI download. | Proposed `save_document`; by default returns the full validated `.draw` as an MCP artifact/resource. Optional direct local write takes a path under an explicitly configured Draw directory; output identifies created artifact/path and revision. | A human configures the allowlisted directory. New files may be created without an extra prompt; replacing an existing file always requires confirmation in Draw. | #31 safety; #33 file operations; #28 installed runtime |
| Export PNG/JPEG | **Unsupported (V1)** through MCP; human UI exports flattened images. | Proposed `export_image`; input is PNG/JPEG, whole canvas or explicit element IDs, and background choice; output is a flattened image artifact plus metadata. | Export only current document. Direct local write uses the same allowlisted directory and overwrite rule as save. | #31 schema; #33 implementation; #28 runtime |
| Search and insert online imagery | **Unsupported (V1)** as a provider-backed search flow. | Search results are inspected first; a distinct `insert_image` call accepts a selected result/asset and placement. Output includes embedded asset ID and preserved attribution. | Network access is limited to the selected provider. Validate URL, media type and size; show creator/license/source; do not auto-insert results from search. | #35; MCP schema in #31; insertion in #32 |
| Browse/add reusable library items | **Partial (V1):** browse exists; saving a selection is deferred. | Expose library add/insert only after the local library behavior works, using native editable elements. | Local library changes stay within the active user's library. | Existing #11; MCP contract in #31 |
| Organize projects / canvases | **Unsupported (V1):** one current document. | Proposed workspace/canvas operations: list/create/select/rename/archive/delete a project and its named editable Draw documents. | Deletion is destructive and requires explicit confirmation; switching never silently replaces a document. | #34; coordinate with #31 and #33 |

## V2 phases

These phases are a proposed order, not a release commitment. They keep file safety and protocol decisions ahead of broad tool implementation.

1. **Phase 0 — Contract and threat boundaries (#31):** approve the matrix, schemas, revision/idempotency ownership, undo policy, local-file permissions, and open/switch/overwrite confirmations.
2. **Phase 1 — Native authoring (#32):** create core Draw elements and relationships through MCP; verify an agent-created file opens and a human can edit it.
3. **Phase 2 — Scene editing and document lifecycle (#33):** edit/arrange/history, background/viewport, read/save/open/export; preserve editable `.draw` state and protect concurrent human edits.
4. **Phase 3 — Workspaces (#34):** migrate the existing single local document into project organization without data loss.
5. **Phase 4 — External image search (#35):** search, inspect rights metadata, then embed the chosen image and its attribution. Reusable local library additions remain tracked separately in #11.
6. **Cross-cutting packaging (#28):** production MCP runtime and end-user install path are prerequisites for a distributable release, rather than a prerequisite for local development work.

## Identifier, revision, and pagination proposal

- `documentId` is the stable identity of one Draw document. The current V1 summary returns it under the field name `id`; V2 should expose `documentId` and may keep `id` as a deprecated alias for compatibility. It is distinct from workspace/canvas display names.
- Every scene object has a Draw-generated stable `elementId`. Caller-supplied node keys are request-local aliases only; responses map them to persistent Draw IDs. IDs are scoped to one document.
- V2 responses include an integer, monotonically increasing `documentRevision` owned by the Draw application/document store, not by the stdio MCP process or Vite bridge. It is persisted with local autosave and inside saved `.draw` files. V1 documents migrate to an initial revision (for example 0); document identity changes reset the per-document revision namespace.
- Every persisted document change increments the revision, including elements/assets, title, background, app state, and viewport. Transient selection/focus does not. Undo and redo are new compensating changes and also increment revision; they never roll the revision number backward.
- One active writer owns a document. The V1 writer lock/read-only tab behavior should be preserved until V2 has a tested conflict-resolution model. A manual reload may create a new tab `clientId`, but it must reload the document's persisted revision; stale commands from the previous client cannot be applied to the new owner.
- `get_current_canvas` returns `documentId`, `documentRevision`, and a snapshot cursor. Every page uses the same snapshot revision. If the snapshot has expired or the document revision changed, return a conflict and require a fresh first-page read rather than silently shifting offsets. Cursor expiry is tracked by Draw, not inferred from an offset alone.
- Mutations require `expectedDocumentRevision` and caller-supplied `idempotencyKey` (scoped to client + document). Draw, as the authoritative document owner, checks the revision, applies at most once, assigns an `operationId`, and returns `applied`, affected IDs, and the new revision. V2 must not rely on the current bridge's generated command ID for idempotency.
- The idempotency/operation ledger belongs to the local Draw application store, keyed by document ID and client key, and survives tab reload and MCP bridge restart for a documented retry window. A stdio server may cache results but is not authoritative. If the operation record expires, a retry returns “outcome unknown; read current document before retry” instead of silently re-running a create.
- The current V1 bridge state (`document`, active client, command sequence, pending acknowledgements) is in memory. Its generated command IDs are unique only within the live bridge lifetime. The 20-second bridge command timeout and 60-second late-ack retention do not constitute durable operation history; MCP's HTTP wrapper times out at 25 seconds. V2 should replace this with revision/idempotency semantics while retaining a recovery/read-after-timeout path.

## Mutation and undo/redo semantics proposal

- Validate the full batch before applying. Prefer atomic all-or-nothing behavior; if any operation supports partial results, return explicit per-element statuses and the resulting revision.
- A successful logical MCP mutation is one history transaction. Record its `operationId` and actor (`human` or MCP client identity) in local document history.
- `undo_operation(operationId)` only reverses that MCP actor's latest still-eligible operation. If any human/other-client change followed it, return `CONFLICT` without changing the canvas. This avoids a delayed agent undo from reverting later human work. If finer-grained inverse application is added later, it must detect dependencies and preserve subsequent human edits.
- A human keyboard Undo may undo the latest operation from any actor, including an MCP mutation. Every successful undo/redo is itself a new persisted state and increments `documentRevision`; it never decrements or reuses a prior revision.
- Redo is bound to the operation just undone and its resulting revision. A newer edit clears or conflicts the redo target; never replay stale state over new work.
- Timed-out mutations are resolved by querying the idempotency key/operation ID or re-reading the document revision and elements. Never issue a second create blindly.

## File and local-data safety proposal

The installed MCP runtime remains local-first and loopback-bound, per #28. An MCP stdio subprocess does not, by itself, grant permission to access arbitrary filesystem paths.

- Default tools operate only on the active Draw document. `open_document` accepts bytes/resource supplied by the MCP client or an opaque file handle issued by Draw; it does not read an arbitrary path parameter.
- A user may explicitly configure one local Draw directory for MCP file operations. Canonicalize the configured root and candidate parent, resolve symlinks, and reject path traversal or any target that resolves outside the root. Do not follow target symlinks, and do not allow symlinked parent components to escape the root.
- Inputs must validate actual file content, not trust the filename or MIME claim. `.draw` bytes must parse as a supported Draw format and match the `.draw` extension when a path is used. The current maximum `.draw` size is 100 MiB; V2 inline/client-supplied document bytes and serialized requests must be capped at or below 100 MiB. Proposed external image cap: 20 MiB per image, and the total document must remain within the `.draw` 100 MiB cap. These values are explicit initial product limits and can be revised before implementation.
- Output extensions are restricted to `.draw`, `.png`, `.jpg`, or `.jpeg` and must match the requested output type. Write a temporary file in the same approved directory, flush/close it, then atomically rename it to the final new name. On failure, leave no partial final file.
- Save to a new non-existing path is allowed inside the configured root. Replacing an existing file is never silently allowed: Draw returns `NEEDS_CONFIRMATION`; the user confirms in the app UI before the atomic replacement proceeds. There is no tool flag that bypasses this confirmation.
- Opening a document that would discard unsaved active state similarly returns `NEEDS_CONFIRMATION`; Draw presents the confirmation. A normal project/canvas switch preserves both documents and does not need destructive replacement.
- Define and test limits for path length, body size, asset byte count, decompressed image dimensions, and allowed media formats. Do not render remote URLs on reopen. Sanitize SVG or reject it; embedded raster assets are the safe initial image format.
- MCP must never expose browser storage, credentials, local unrelated files, or arbitrary network fetch as part of canvas text interpretation.

Canvas text and labels are **untrusted data**, whether authored by the human or supplied by an agent. Return them as data fields, never as executable markup or instructions. Do not evaluate HTML/SVG/URLs or follow instructions found inside a label; when an agent consumes text from the canvas, it should treat that text as user content rather than as a system/developer instruction.

## `.draw` compatibility proposal

V1 uses a versioned JSON `.draw` format (`format: "draw"`, `formatVersion: 1`) containing document identity/title, infinite canvas background and viewport, native editor elements, app state, and assets. V2 MCP must operate on the same document model as the UI.

- MCP-authored documents validate as normal Draw documents and reopen in Draw.
- Preserve native element fields, text/container and arrow bindings, asset bytes/references and attribution, app state, background, viewport, and stable IDs.
- Never save only a raster image or simplified diagram representation in `.draw`. PNG/JPEG remain separate flattened exports.
- Keep V1 files readable. If revision or workspace metadata requires a new format version, provide a tested migration; preserve compatible unknown element metadata and never silently drop unsupported content.

## Contract tests and validation matrix

Add schema tests and real MCP/Chrome integration tests with each implementation issue. Tests must map to the capability/follow-up rows above:

1. **#31 contract:** reject unknown fields/IDs, invalid geometry/styles, disallowed paths, stale revisions, mismatched extensions, oversized bytes, duplicate idempotency keys; verify Host/Origin/body checks and page snapshot invalidation.
2. **#32 authoring:** actual MCP calls create each supported native element, labels/bindings, and assets; return stable ID mappings; a human can select and edit those elements in Chrome.
3. **#33 editing/lifecycle:** cover edits, selection, group/arrange/delete, undo/redo attribution and conflicts; save as `.draw`, reload, reopen, export PNG/JPEG separately, verify assets/background/viewport/editability; prove an agent undo cannot revert a later human edit.
4. **#34 workspaces:** migrate a V1 document; create/switch/reload workspaces/canvases without cross-document autosave writes; confirm destructive delete.
5. **#35 external assets:** provider attribution/license persistence, download limits/type checks, embed and save/reopen, MCP insert, and browser picker flow.
6. **Failure recovery:** delay acknowledgements past current timeout boundaries; verify read-after-timeout/operation status prevents duplicate creates, and ensure reload/server restart does not lose revision or idempotency guarantees.

Chrome E2E is required for editor, open/save, and export flows. Unit tests alone do not establish that Draw can render/edit the resulting scene or that round trips preserve it.

## Product and implementation decisions (all proposals pending review)

- **Coverage meaning:** expose semantic document and scene capabilities, not every cosmetic preference or low-level pointer gesture.
- **Active context:** current tools act on the active canvas. V2 document/workspace operations should require an explicit document/workspace ID; they must not silently change active context. `open_document` replacement of dirty content returns `NEEDS_CONFIRMATION`; creating/switching to another saved canvas preserves the prior canvas.
- **Undo ownership:** the agent can undo only its own latest eligible operation; later human/other-client work blocks that undo. The human's ordinary Undo can reverse the latest transaction, including an agent's.
- **Filesystem:** MCP resource/artifact is default for `.draw` and image output; direct read/write is optional only under the explicitly configured Draw root. New files are permitted there; existing-file replacement always requires the app UI confirmation described above.
- **Payload limits:** initial maximum document/request payload is 100 MiB; proposed max downloaded image is 20 MiB, subject to validation before implementation.
- **Assets:** embed chosen media for offline reopening and retain source/creator/license metadata. Search and insertion are separate actions. Review each provider's usage terms and per-item license rather than treating an index result as a legal guarantee.
