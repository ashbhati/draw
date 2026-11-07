# Draw

Draw is a local-first, Excalidraw-based infinite canvas for editable diagrams. The `.draw` file is the editable source; PNG and JPEG exports are flattened images.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The current canvas autosaves in this browser on this device. Use **Save .draw** to download a portable editable document, and **Open** to restore one later. The Blackboard and Whiteboard presets are saved in the document. Image exports are for sharing and cannot be edited as Draw objects.

For MCP use, start `npm run dev` yourself in a trusted terminal that you control. Do not start the Vite server from an agent or automation PTY. Keep that terminal open: it prints a random one-use editor code, valid for 60 seconds. Manually type the code into Draw's **Connect MCP** dialog. The code is never returned over HTTP or included in a URL. After a browser reload, connect again with the newly printed code; if the code expired or was missed, use **Request fresh code** in the dialog and then type the code shown in the terminal.

After connecting the editor, open **MCP clients** in Draw and copy the one-time pairing secret into the MCP host's protected secret configuration as `DRAW_MCP_PAIRING_SECRET`. Secret issuance is throttled to once every five seconds. Configure the host to run `npm run mcp`, then call the `pair_mcp_client` tool (it takes no secret argument). Draw shows the client name and fingerprint and waits for your approval. Re-pairing the same fingerprint revokes the old identity, and Draw warns you before approval. On approval, the MCP process stores its capability in `~/.config/draw/mcp-client-credential.json` with mode `0600`; set `DRAW_MCP_CLIENT_CREDENTIAL_PATH` to use another protected path, and `DRAW_MCP_CLIENT_NAME` to label the host. The pairing secret is consumed once. Remove it from host configuration after pairing. Revoking a host in Draw immediately blocks its requests and cancels its pending bridge work; other hosts and the editor remain connected.

The bridge requires the paired capability on document reads, confirmations, and commands, and separately requires the active editor-tab secret for editor sync and acknowledgements. In the development bridge, an unpaired local loopback process can invalidate a pending pairing secret or trigger the temporary pairing lockout by submitting wrong secrets; it cannot gain access to the canvas or revoke the editor lease. The Vite bridge is not a sandbox against a fully compromised process running as the same OS user, which may be able to inspect that user's memory or credential files. Use only trusted local MCP hosts. The installed runtime in issue #28 will use authenticated local IPC to prevent unpaired loopback requests from consuming pairing attempts.

## Verify

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The e2e suite runs the app locally in Chromium and selects an available loopback port for each run. To pin a run to a specific port, set `DRAW_E2E_BASE_URL`, for example `DRAW_E2E_BASE_URL=http://127.0.0.1:5197 npm run test:e2e`. It starts its own strict-port server and does not reuse an existing server by default. Set `DRAW_E2E_REUSE_SERVER=1` only when intentionally reusing the server at that URL. Playwright downloads its browser separately; on managed systems where its default browser cache is unavailable, set `PLAYWRIGHT_BROWSERS_PATH` to a writable directory when installing and running the suite.

## Connect an MCP client

The local MCP server communicates with the active development canvas. First start Draw yourself from a trusted terminal and manually connect the tab using the printed code. Then configure your MCP client to launch `npm run mcp` from this project directory. For clients using JSON MCP configuration, the server entry is:

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
- `create_diagram`: add editable labeled nodes and arrows to the open canvas.
- `create_elements`: add native editable rectangles, ellipses, diamonds, standalone text, lines, arrows, and freehand strokes. Provide a unique caller-side `id` for each element; the result maps those IDs to Draw element IDs and reports label and arrow endpoint relationships. Coordinates use canvas units. `line`, `arrow`, and `freedraw` points are offsets relative to the element's `x` and `y`; bounds are derived from their points. Lines and arrows accept two-number points. Freedraw accepts `[x,y]` points or optional pressure as `[x,y,pressure]`; Draw stores native `[x,y]` points with a separate `pressures` array and `simulatePressure` flag. If no point supplies pressure, pressure is simulated. If any point supplies pressure, omitted point pressures default to `0.5`. Zero-length paths are rejected.
- Shapes accept a `label`; arrows accept a `label` and either both `start` and `end` IDs or neither. Bound endpoints must reference shapes created in the same call. When both bindings are supplied, Draw derives the initial arrow path from the bound shapes' centers and ignores the arrow's supplied `x`, `y`, and `points`; the editor attaches the ends to the shapes. Unbound arrows use the supplied path. Standalone text accepts `maxWidth` (default 600 canvas units) and wraps to fit. The primitive API supports only the fields listed in the `create_elements` tool schema; it does not expose arbitrary Excalidraw element properties, images, frames, or app state.
- `update_elements`: move, resize, recolor, or change text on existing elements.
- `delete_elements`, `duplicate_elements`, `group_elements`, `ungroup_elements`, and `arrange_elements`: edit selected element IDs with revision-guarded batches. `arrange_elements` supports layer order, alignment, and distribution.
- `set_selection`: select or clear element IDs in the editor; selection is temporary and is not saved in `.draw`.
- `undo_operation` and `redo_operation`: act on the latest eligible MCP operation by its returned `operationId`. Draw rejects an undo after any later human scene change; eligibility is intentionally not retained across page reloads or MCP restarts.
- `set_canvas_settings` and `set_viewport`: set the document title/background or pan, zoom, and fit-to-content. Scene and view revisions are tracked separately.
- `save_document`, `open_document`, and `export_image`: save editable `.draw` documents, reopen them, and return PNG/JPEG image artifacts. Direct file operations require `DRAW_MCP_DOCUMENT_DIR`; MCP paths are basenames within that folder. Existing output files fail with `PATH_EXISTS` and are never overwritten; save-as to a new filename. Safe overwrite is tracked in [issue #39](https://github.com/ashbhati/draw/issues/39). Replacing a populated canvas returns `NEEDS_CONFIRMATION` with a one-use token; approve or deny it in Draw, then retry `open_document` with the token. Editor-side sync, acknowledgements, and approval require the active tab's secret; MCP reads, confirmation requests, and commands require the paired host capability.
- `pair_mcp_client`: pair the local MCP host after the human copies Draw's one-time secret into protected host configuration. The tool accepts no pairing code and does not return the capability to the model.

Every scene mutation should include `documentId` and the latest `expectedDocumentRevision` from `get_current_canvas`. Viewport commands use `expectedViewRevision`. This detects stale agent context before changing the active document.

`create_diagram` returns `nodes`, mapping each caller-provided node ID to its Draw element ID; `nodeLabels` maps those node IDs to their bound text IDs. `edges` contains each created arrow's `elementId`, optional `labelElementId`, and input index. The result also includes `addedElementIds` and, when supplied, `titleElementId`. Use these returned IDs with `update_elements`.

The MCP bridge is provided by the Vite development server, bound to loopback only. Keep the Draw tab open while using its MCP tools. The MCP tools are intentionally unavailable in a production build in this first version.

## Document and licensing notes

`.draw` is a versioned JSON document containing editable scene elements, view state, background metadata, and embedded assets. `plan.draw` is the initial planning canvas and remains available to open in Draw.

Switching between Blackboard and Whiteboard adapts Draw's default chalk and its V1 yellow accent for contrast. Other custom colors are preserved.

The drawing engine is the `@excalidraw/excalidraw` package. Draw uses its editor API and maintains its own `.draw` document format; it does not promise Excalidraw file import/export compatibility.

The editor's bundled font files are served locally so diagrams render offline, including CJK glyphs. Their family-specific attributions and license texts are in [public/fonts/LICENSES.md](./public/fonts/LICENSES.md). The CJK font subsets are retained for multilingual documents and account for most of the font bundle's size. The Blackboard background's generation source and applicable terms are recorded in [docs/ASSET_ATTRIBUTION.md](./docs/ASSET_ATTRIBUTION.md).

See [PLAN.md](./PLAN.md) for the V1 scope, acceptance checks, and deferred capabilities.
