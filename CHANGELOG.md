# Changelog

This file records user-visible Draw releases. GitHub source tags and npm package versions are recorded separately when they differ.

## [1.2.1] — 2026-11-14

- Released the local Draw app as the public npm package `@ashbhati/draw` for macOS and Linux.
- Added the MIT project license and npm package metadata, including links to the source repository, homepage, and issue tracker.
- Clarified that Draw is a visual app with small launch commands, not a command-line drawing interface.
- Kept the V1.2.0 feature set unchanged.

See the [v1.2.1 GitHub release](https://github.com/ashbhati/draw/releases/tag/v1.2.1).

## [1.2.0] — 2026-11-12

- Simplified MCP host pairing: the host requests approval in Draw instead of requiring a copied pairing secret. Approved hosts keep access across restarts until revoked.
- Persisted MCP operation results and eligible undo/redo history across editor reloads and MCP host restarts, with revision checks and idempotent retries.
- Completed the local workspace model: one board per project workspace, with workspace lifecycle and `.draw` import available through MCP.
- Exposed native diagram creation/editing, selection, arrangement, history, background/view controls, `.draw` open/save, PNG/JPEG export, image operations, and workspace-library operations through MCP.
- Refined the toolbar with compact MCP icon controls and export dropdowns sized to keep their selected labels visible.
- Updated the MCP connection, workspace, packaging, and recovery documentation. Added the owner-supplied human/agent workflow diagram to the README.

### Validation

- 286 unit tests passed.
- 58 Chrome editor E2E flows passed.
- Production MCP/IPC E2E and installed-package MCP E2E passed.
- Production build passed with the existing large-chunk advisory.

See [Packaging](docs/PACKAGING.md) for installation details and platform support.

## [1.1.0]

See the [`v1.1.0` source tag](https://github.com/ashbhati/draw/tree/v1.1.0).
