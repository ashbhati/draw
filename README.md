# Draw

Draw is a local-first, Excalidraw-based infinite canvas for editable diagrams. The `.draw` file is the editable source; PNG and JPEG exports are flattened images.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The current canvas autosaves in this browser on this device. Use **Save .draw** to download a portable editable document, and **Open** to restore one later. The Blackboard and White presets are saved in the document. Image exports are for sharing and cannot be edited as Draw objects.

## Verify

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The e2e suite runs the app locally in Chromium. Playwright downloads its browser separately; on managed systems where its default browser cache is unavailable, set `PLAYWRIGHT_BROWSERS_PATH` to a writable directory when installing and running the suite.

## Connect an MCP client

The local MCP server communicates with the active development canvas. Start the app with `npm run dev`, then configure your MCP client to launch `npm run mcp` from this project directory. For clients using JSON MCP configuration, the server entry is:

```json
{
  "mcpServers": {
    "draw": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/draw"
    }
  }
}
```

Available tools:

- `get_current_canvas`: flush and read the active document before returning its summary and element IDs. Optional `offset` (default `0`) and `limit` (default `250`, maximum `250`) paginate the active elements; use the returned `nextOffset` when `hasMore` is true.
- `create_diagram`: add editable labeled nodes and arrows to the open canvas.
- `update_elements`: move, resize, recolor, or change text on existing elements.

`create_diagram` returns `nodes`, mapping each caller-provided node ID to its Draw element ID; `nodeLabels` maps those node IDs to their bound text IDs. `edges` contains each created arrow's `elementId`, optional `labelElementId`, and input index. The result also includes `addedElementIds` and, when supplied, `titleElementId`. Use these returned IDs with `update_elements`.

The MCP bridge is provided by the Vite development server, bound to loopback only. Keep the Draw tab open while using its MCP tools. The MCP tools are intentionally unavailable in a production build in this first version.

## Document and licensing notes

`.draw` is a versioned JSON document containing editable scene elements, view state, background metadata, and embedded assets. `plan.draw` is the initial planning canvas and remains available to open in Draw.

The drawing engine is the `@excalidraw/excalidraw` package. Draw uses its editor API and maintains its own `.draw` document format; it does not promise Excalidraw file import/export compatibility.

The editor's bundled font files are served locally so diagrams render offline, including CJK glyphs. Their family-specific attributions and license texts are in [public/fonts/LICENSES.md](./public/fonts/LICENSES.md). The CJK font subsets are retained for multilingual documents and account for most of the font bundle's size.

See [PLAN.md](./PLAN.md) for the V1 scope, acceptance checks, and deferred capabilities.
