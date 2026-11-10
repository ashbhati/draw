# Draw

Draw is a local-first, Excalidraw-based infinite canvas for editable diagrams. The `.draw` file is the editable source; PNG and JPEG exports are flattened images.

## Install and launch

The planned end-user distribution is the public npm package `@ashbhati/draw`. It supports macOS and Linux with Node.js 20.19+ or 22.12+.

Once the package is published:

```sh
npm install --global @ashbhati/draw
draw start
```

`draw start` serves the production app on `http://127.0.0.1:4173` and opens the local browser when started from an interactive terminal. Use `draw start --no-open` to open the URL yourself, or `draw start --port 4300` to choose a different port. Keep the terminal process running while you use Draw. Draw autosaves the active workspace in the current browser on this device. Autosave is the local working copy; use **Save** (the download icon) to create a portable editable `.draw` file. Use **Open** (the open-file icon) to import a `.draw` file as a separate workspace, and **Export** to create a flattened PNG or JPEG for sharing.

The `.draw` file preserves editable elements, canvas settings, and embedded images. PNG and JPEG files do not preserve editable data. Save `.draw` files in a folder you back up; browser autosave is separate, stays in that browser profile and device, and is not a substitute for saving a portable file. If Draw cannot load its autosave, use its recovery panel to export the quarantined working copy or start a fresh workspace. See [Autosave recovery](docs/AUTOSAVE_RECOVERY.md).

Public npm publication is pending the owner's choice of a root project license. No license has been selected or added by this implementation. Install commands above are ready for that release and do not work until the package is published.

## Run from source

For contributors, clone the repository and use the Vite development server:

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Draw organizes work into **Workspaces**, one per project, with one infinite editable board in each workspace. The selected workspace name stays visible beside the saved-workspaces list icon. Use the icon buttons to create, rename, or delete a workspace; their accessible names and tooltips explain each action. Deleting a workspace asks for confirmation and removes its board, reusable library, and local history. The Blackboard and Whiteboard choices change the active board's appearance.

Use **Save** to download the active editable document. **Open** imports that file into a new workspace, leaving the current project intact. PNG and JPEG exports are flattened images for sharing and cannot be edited as Draw objects.

The reusable library is scoped to the current workspace. Select diagram elements and choose **Add selection to library** to save them with their bound labels and referenced image assets. Choose **Manage library** to insert a fresh editable copy, rename an item, or remove it. Library contents persist in this browser on this device and do not sync between devices.

## Connect an MCP client

1. Start Draw with `draw start` and keep that terminal open. The terminal shows a random, one-use editor launch code. Type it into Draw's **Connect MCP** dialog. The code expires after one minute and is never returned over HTTP or included in a URL.
2. In Draw, open **MCP clients** and copy the one-time pairing secret into your MCP client's protected environment configuration as `DRAW_MCP_PAIRING_SECRET`.
3. Configure the MCP client to run Draw's packaged MCP host:

```json
{
  "mcpServers": {
    "draw": {
      "command": "draw",
      "args": ["mcp"],
      "env": {
        "DRAW_MCP_DOCUMENT_DIR": "/absolute/path/to/a/dedicated/draw-documents-folder",
        "DRAW_MCP_PAIRING_SECRET": "paste-the-one-time-secret-here"
      }
    }
  }
}
```

4. Ask the agent to call `pair_mcp_client`. Draw displays the host name and fingerprint and waits for your approval. The tool takes no secret argument. After approval, remove `DRAW_MCP_PAIRING_SECRET` from the host configuration. The MCP host stores its capability in `~/.config/draw/mcp-client-credential.json` with mode `0600`; set `DRAW_MCP_CLIENT_CREDENTIAL_PATH` to another absolute, user-owned path if desired. Set `DRAW_MCP_CLIENT_NAME` to label the host.

The app and MCP host communicate through a Unix domain socket in a per-user directory (mode `0700`; socket mode `0600`). On macOS it is under `~/Library/Application Support/Draw/run`; on Linux it is under `$XDG_RUNTIME_DIR/draw` or `~/.local/run/draw`. The MCP API is not exposed over loopback HTTP. This protects against other OS accounts and unauthenticated loopback clients. Processes running as the same OS user are inside Draw's trust boundary; do not run untrusted MCP hosts as your account. Keep Draw running with the document open while the agent works. Agent edits target the active document in the authenticated editor tab, so you can immediately inspect and continue editing them.

Pairing secrets expire and are consumed once. Secret issuance is throttled to once every five seconds. Revoking a host in Draw blocks its future requests and cancels its pending bridge work. The MCP client's stored capability is separate from the editor launch code and pairing secret.

To upgrade, run `npm install --global @ashbhati/draw@latest`. To uninstall, run `npm uninstall --global @ashbhati/draw`. Your `.draw` files and local browser autosave are not removed by uninstalling the package.

For contributors using the Vite bridge, see [Development MCP setup](#development-mcp-setup).

### Development MCP setup

When running from source, start `npm run dev` yourself in a trusted terminal. Type its one-minute launch code into Draw's **Connect MCP** dialog. Configure the client with `npm run mcp` and `cwd` set to the repository; the development bridge uses loopback HTTP and requires the Draw tab to remain open. Its localhost pairing surface is intended only for trusted local development, not as the production MCP transport.

The bridge requires the paired capability on document reads, confirmations, and commands, and separately requires the active editor-tab secret for editor sync and acknowledgements. In the Vite development bridge, unpaired loopback traffic can invalidate a pending pairing secret or trigger a temporary pairing lockout. Use only trusted local MCP hosts while running the development server. The packaged runtime restricts MCP routes to its private Unix socket; same-OS-user processes remain trusted.

## Verify

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The e2e suite runs the app locally in Chromium and selects an available loopback port for each run. To pin a run to a specific port, set `DRAW_E2E_BASE_URL`, for example `DRAW_E2E_BASE_URL=http://127.0.0.1:5197 npm run test:e2e`. It starts its own strict-port server and does not reuse an existing server by default. Set `DRAW_E2E_REUSE_SERVER=1` only when intentionally reusing the server at that URL. Playwright downloads its browser separately; on managed systems where its default browser cache is unavailable, set `PLAYWRIGHT_BROWSERS_PATH` to a writable directory when installing and running the suite.

## Configure a development MCP client

From a source checkout, configure your MCP client to launch `npm run mcp` from this project directory. For clients using JSON MCP configuration, the server entry is:

```json
{
  "mcpServers": {
    "draw": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/draw",
      "env": {
        "DRAW_MCP_DOCUMENT_DIR": "/absolute/path/to/a/dedicated/draw-documents-folder"
      }
    }
  }
}
```

Available tools:

- `get_current_canvas`: flush and read the active document before returning its summary and element IDs. Optional `offset` (default `0`) and `limit` (default `250`, maximum `250`) paginate the active elements; use the returned `nextOffset` when `hasMore` is true.
- `search_openverse_images`: search Openverse by query, illustration category and license, after checking the active document ID/revision. Search requests go to Openverse; results are third-party license claims that the user must verify.
- `insert_openverse_image`: insert by Openverse asset ID only. Draw downloads through Openverse's fixed API endpoint, accepts PNG/JPEG up to 2 MiB and 16 megapixels, and embeds the image and attribution metadata in the editable `.draw` file. Arbitrary URLs and SVG are rejected. Use the same `idempotencyKey` for retries.
- `create_diagram`: add editable labeled nodes and arrows to the open canvas.
- `create_elements`: add native editable rectangles, ellipses, diamonds, standalone text, lines, arrows, and freehand strokes. Provide a unique caller-side `id` for each element; the result maps those IDs to Draw element IDs and reports label and arrow endpoint relationships. Coordinates use canvas units. `line`, `arrow`, and `freedraw` points are offsets relative to the element's `x` and `y`; bounds are derived from their points. Lines and arrows accept two-number points. Freedraw accepts `[x,y]` points or optional pressure as `[x,y,pressure]`; Draw stores native `[x,y]` points with a separate `pressures` array and `simulatePressure` flag. If no point supplies pressure, pressure is simulated. If any point supplies pressure, omitted point pressures default to `0.5`. Zero-length paths are rejected.
- Shapes accept a `label`; arrows accept a `label` and either both `start` and `end` IDs or neither. Bound endpoints must reference shapes created in the same call. When both bindings are supplied, Draw derives the initial arrow path from the bound shapes' centers and ignores the arrow's supplied `x`, `y`, and `points`; the editor attaches the ends to the shapes. Unbound arrows use the supplied path. Standalone text accepts `maxWidth` (default 600 canvas units) and wraps to fit. The primitive API supports only the fields listed in the `create_elements` tool schema; images are inserted through the separate validated Openverse tools.
- `update_elements`: move, resize, recolor, or change text on existing elements.
- `delete_elements`, `duplicate_elements`, `group_elements`, `ungroup_elements`, and `arrange_elements`: edit selected element IDs with revision-guarded batches. `arrange_elements` supports layer order, alignment, and distribution.
- `set_selection`: select or clear element IDs in the editor; selection is temporary and is not saved in `.draw`.
- `undo_operation` and `redo_operation`: act on the latest eligible MCP operation by its returned `operationId`. Draw rejects an undo after any later human scene change; eligibility is intentionally not retained across page reloads or MCP restarts.
- `set_canvas_settings` and `set_viewport`: set the document title/background or pan, zoom, and fit-to-content. Scene and view revisions are tracked separately.
- `save_document`, `open_document`, and `export_image`: save editable `.draw` documents, reopen them, and return PNG/JPEG image artifacts. Direct file operations require `DRAW_MCP_DOCUMENT_DIR`; MCP paths are basenames within that folder. Existing output files fail with `PATH_EXISTS` and are never overwritten; save-as to a new filename. Safe overwrite is tracked in [issue #39](https://github.com/ashbhati/draw/issues/39). Replacing a populated canvas returns `NEEDS_CONFIRMATION` with a one-use token; approve or deny it in Draw, then retry `open_document` with the token. Editor-side sync, acknowledgements, and approval require the active tab's secret; MCP reads, confirmation requests, and commands require the paired host capability.
- `list_workspaces` and `list_canvases`: read stable IDs, active workspace/canvas, catalog revision, and the active editable document with its revisions. The UI presents one board per workspace; `list_canvases` returns that workspace's sole board.
- `create_workspace`, `rename_workspace`, `select_workspace`, `create_canvas`, `rename_canvas`, `duplicate_canvas`, and `select_canvas`: manage project organization and editable boards. For compatibility with earlier MCP clients, `create_canvas` and `duplicate_canvas` create a new workspace containing one board; the result reports the actual workspace and canvas IDs. `rename_canvas` renames the board and its document title; `select_canvas` selects its owning workspace. Every mutation takes the latest `expectedCatalogRevision` and a stable `idempotencyKey`; retry an identical intent with the same key.
- `import_draw_file_as_canvas`: validate a `.draw` file from `DRAW_MCP_DOCUMENT_DIR` and create a new workspace with one board and an independent document ID. The existing workspace and source file remain intact.
- `delete_canvas` is unsupported because a board is the whole contents of a workspace. Use `delete_workspace` instead; its one-time confirmation covers the board, workspace library, and local history. A denial, stale request, or expired token leaves saved data intact.
- `pair_mcp_client`: pair the local MCP host after the human copies Draw's one-time secret into protected host configuration. The tool accepts no pairing code and does not return the capability to the model.
- `list_workspace_library` and `read_workspace_library_item`: inspect workspace library items and their current `libraryRevision`.
- `add_selection_to_workspace_library`, `rename_workspace_library_item`, and `delete_workspace_library_item`: mutate library items using `expectedLibraryRevision` and `idempotencyKey`. Same-key/same-payload retries return the stored result; a changed payload conflicts. Delete requires one-use owner approval in Draw, and an approved retry returns its stored result.
- `insert_workspace_library_item`: insert a fresh editable copy using the document revision and idempotency key.

Every scene mutation should include `documentId` and the latest `expectedDocumentRevision` from `get_current_canvas`. Viewport commands use `expectedViewRevision`. This detects stale agent context before changing the active document.

Workspace mutations instead use `expectedCatalogRevision` from `list_workspaces` and a stable `idempotencyKey`. A successful workspace result returns the updated catalog plus active IDs/document. Exact retries return the current catalog/document plus compact operation IDs, never an old scene snapshot. Local receipts expire after 30 days, are capped at 1,000 entries, and are removed when their referenced canvas/workspace is deleted. The delete-workspace dialog derives the workspace name from Draw's local catalog; MCP-supplied display text is ignored. Receipts are local to this browser profile and are not included in exported `.draw` files.

`create_diagram` returns `nodes`, mapping each caller-provided node ID to its Draw element ID; `nodeLabels` maps those node IDs to their bound text IDs. `edges` contains each created arrow's `elementId`, optional `labelElementId`, and input index. The result also includes `addedElementIds` and, when supplied, `titleElementId`. Use these returned IDs with `update_elements`.

The MCP tool schemas and behavior are described above. The source development bridge runs through Vite; the packaged MCP runtime uses authenticated local IPC.

## Document and licensing notes

`.draw` is a versioned JSON document containing editable scene elements, view state, background metadata, and embedded assets. `plan.draw` is the initial planning canvas and remains available to open in Draw.

The **Images** picker and the MCP image tools use the [Openverse API](https://api.openverse.org/v1/). Each inserted image stores its creator, source, and license metadata beside the embedded bytes. **Image credits** provides an attribution report. Draw identifies Openverse as the search source and is not endorsed by Openverse. The API is rate limited, and [Openverse's terms](https://docs.openverse.org/terms_of_service/) prohibit scraping. Openverse indexes third-party claims; verify the item page and license terms before sharing or commercial use. File-supplied attribution is shown as unverified, URLs are restricted to HTTPS, and fetched requests time out. The online picker needs network access; saved images remain available offline.

Switching between Blackboard and Whiteboard adapts Draw's default chalk and its V1 yellow accent for contrast. Other custom colors are preserved.

The drawing engine is the `@excalidraw/excalidraw` package. Draw uses its editor API and maintains its own `.draw` document format; it does not promise Excalidraw file import/export compatibility.

The editor's bundled font files are served locally so diagrams render offline, including CJK glyphs. Their family-specific attributions and license texts are in [public/fonts/LICENSES.md](./public/fonts/LICENSES.md). The CJK font subsets are retained for multilingual documents and account for most of the font bundle's size. The Blackboard background's generation source and applicable terms are recorded in [docs/ASSET_ATTRIBUTION.md](./docs/ASSET_ATTRIBUTION.md).

See [PLAN.md](./PLAN.md) for the V1 scope, acceptance checks, and deferred capabilities.

See [docs/HERDR_CODE_REVIEW_WORKFLOW.md](./docs/HERDR_CODE_REVIEW_WORKFLOW.md) for the repeatable Codex implementation and Claude Code review workflow in Herdr, including setup and handoff prompts.

See [docs/HERDR_CODE_REVIEW_WORKFLOW.md](./docs/HERDR_CODE_REVIEW_WORKFLOW.md) for the repeatable Codex implementation and Claude Code review workflow in Herdr, including setup and handoff prompts.
