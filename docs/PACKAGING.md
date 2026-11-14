# Draw package and local MCP runtime

## V1.2.0 source release

Draw V1.2.0 is available on GitHub as commit `96d8fb6` and tag [`v1.2.0`](https://github.com/ashbhati/draw/tree/v1.2.0). The package metadata is version `1.2.0`. The GitHub source release is available, but the package has not been published to npm because the repository still has no owner-selected root project license.

## Supported package slice

- Intended distribution: a public npm CLI package named `@ashbhati/draw` (not yet published).
- Runtime: macOS/Linux with Node.js in the range `>=20.19.0 <21 || >=22.12.0`.
- `draw start`: serves the production Vite build on loopback and starts the per-user MCP IPC socket.
- `draw mcp`: runs the MCP stdio host and sends MCP bridge operations through that Unix domain socket.
- The browser editor connects to the local app over loopback HTTP, authenticates with the one-use terminal launch code, and receives bridge events on a short-lived ticketed Server-Sent Events stream.
- Agent MCP operations must use the private socket and paired host capability. Editor sync and acknowledgements require the active editor secret. MCP mutations are handled against the currently authenticated editor tab and active document.

## Local IPC boundary

On macOS the socket directory is `~/Library/Application Support/Draw/run`. On Linux it is `$XDG_RUNTIME_DIR/draw`, falling back to `~/.local/run/draw`. Draw checks that the directory is not a symlink, is owned by the current UID, and sets its mode to `0700`. The socket is created by the OS in that directory and changed to mode `0600` before Draw reports it ready. The kernel applies those owner/permission checks before accepting a connection. The runtime also checks socket ownership and marks requests only after they arrived on that socket.

The MCP socket accepts only the MCP pairing, document-read, command, and confirmation-consumption API routes. Production loopback HTTP explicitly rejects those routes before reaching account or pairing state. The browser event stream requires a one-use, 30-second ticket issued with the authenticated editor secret. Same-OS-user processes are trusted: a process running as the same UID can read that user's memory and files and can connect to the private socket. This is not a sandbox between same-user processes.

The Vite development bridge remains a separate, loopback-only development transport. It is not enabled by the package's `draw start` command.

## Install, upgrades, and removal

After the package is published:

```sh
npm install --global @ashbhati/draw
draw start
npm install --global @ashbhati/draw@latest
npm uninstall --global @ashbhati/draw
```

Starting Draw opens the local URL from an interactive terminal; `draw start --no-open` prints the URL without launching a browser. The user keeps the process running and opens the URL in Chrome or another supported browser. The package does not host drawings remotely. `.draw` files remain the editable copies; browser autosave lives in that browser profile and is not removed by package upgrades or uninstall.

## Package validation and release gate

Run the complete release gate before publishing the npm package or cutting a future release:

```sh
npm ci
npx playwright install chromium
npm run test:release
```

`test:release` runs unit/config tests, the production build, the Chrome browser suite, production MCP round-trip, and a real `npm pack` + clean-prefix install followed by the packaged Chrome/MCP round-trip. The packaged CLI tests run from an empty temporary working directory with no `node_modules`, covering `draw help`, `draw start`, and `draw mcp`. GitHub Actions runs this release gate on Node 20 and 22 for pull requests and main-branch pushes.

For V1.2.0, the release checks passed: 286 unit tests, the build, 58 editor Chrome E2E flows, the production MCP/IPC flow, and the installed-package MCP E2E flow. The local machine did not have Playwright's bundled Chromium installed, so those browser flows used system Chrome. CI installs Playwright Chromium before running `test:release`.

To run only the packaged browser check against an already installed tarball:

```sh
DRAW_PACKAGE_BIN=/absolute/path/to/test-prefix/node_modules/@ashbhati/draw/bin/draw.js npm run test:e2e:package
```

This flow starts `draw start` in a trusted pseudo-terminal, connects the production UI in Chrome, pairs a local stdio MCP host through `draw mcp`, rejects unpaired HTTP reads, and creates and verifies an editable diagram through IPC. Before transmitting a paired capability, the MCP client verifies that the socket and parent directory are owned by its OS user, are not symlinks, and have private permissions. Overlong socket paths fail with guidance to set `DRAW_RUNTIME_DIR` to a shorter per-user path. The end-user manual acceptance flow should also save and reopen a `.draw` file and export PNG/JPEG.

**npm publication is gated on the owner selecting and adding a root project license.** No license file or SPDX identifier is present. Once the owner selects the project license, add it at the repository root, set the package's `license` field to the matching SPDX identifier, and publish the reviewed package version from its release tag with `npm publish --access public`.

## Deferred platform work

- Windows support, including named-pipe ACLs and a Windows production test run.
- Signed and notarized desktop installers.
- A GUI-managed background service or OS startup integration.
- Same-UID adversarial isolation; the documented trust boundary is the local OS account.
