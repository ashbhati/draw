# Issue #39: safe replacement feasibility

## Decision

Draw does not offer overwrite for MCP file outputs on macOS or Linux. There is no supported platform path in the current package that can atomically replace an existing filename only when that filename still identifies the reviewed bytes. The replacement endpoint, confirmation token, and write path therefore remain unimplemented. Rechecking a hash and then calling `rename` would still have a time-of-check/time-of-use race and must not be added as a fallback.

MCP writes continue to create a temporary file and commit it with an atomic no-replace hard link. If another process creates the target first, the commit fails with `PATH_EXISTS`, and the existing bytes remain intact. Choose a new filename. This is an intentional fail-closed limitation, not an incomplete confirmation prompt.

## Platform primitive review

| Platform | Atomic primitive available | What it guarantees | Why it cannot satisfy #39 |
| --- | --- | --- | --- |
| macOS | `renamex_np` with `RENAME_EXCL` | Fails if the destination name already exists. Apple exposes a per-volume capability value for this behavior. | It prevents replacement; it does not replace an existing file conditionally. `RENAME_SWAP` exchanges names unconditionally, without comparing the old destination against the approved identity or hash. |
| Linux | `renameat2` with `RENAME_NOREPLACE` | Fails if the destination name already exists, when supported by the filesystem. | It prevents replacement. `RENAME_EXCHANGE` atomically exchanges names, but has no expected-inode or expected-hash operand. |
| Node.js `fs` | `link` and `rename` | `link` supports the current atomic no-replace commit on the same filesystem; `rename` atomically moves a source name over a destination. | Node's standard API does not expose compare-and-swap replacement. `rename` is not conditional on the destination's previous identity or contents. |

Sources: [Linux `renameat2(2)`](https://man7.org/linux/man-pages/man2/renameat2.2.html), the macOS [`renamex_np(2)` manual](https://keith.github.io/xcode-man-pages/rename.2.html) (the same manual is available locally as `man 2 rename`), [Apple's per-volume exclusive rename capability](https://developer.apple.com/documentation/foundation/urlresourcekey/volumesupportsexclusiverenamingkey), and [Node.js filesystem API](https://nodejs.org/api/fs.html).

Advisory locks do not provide the required guarantee against a process that does not cooperate with the locking protocol. A sequence that locks, hashes, and renames would therefore narrow the race only for cooperating writers, not protect an approved file against arbitrary local writers or filesystems with weaker semantics.

## Requirements before enabling overwrite

Revisit this issue only if Draw adopts a primitive and supported-filesystem contract that can atomically compare the current destination identity to the approved identity and replace it as one operation. Any implementation must retain the one-use caller/document/revision/normalized-target/hash binding, prove stale replacement fails without changing bytes, and reject unsupported filesystems without attempting an unconditional rename. Until then, the existing `PATH_EXISTS` behavior is the supported contract.

The test `lets only one concurrent no-replace writer create a target` in `src/integrations/mcp-file-access.test.ts` verifies that simultaneous MCP writers cannot replace one another's output: exactly one creates the target, the other receives `PATH_EXISTS`, and the stored bytes match the winner.
