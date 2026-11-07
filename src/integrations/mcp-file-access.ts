import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DrawDocumentError, parseDrawFile, serializeDrawFile, type DrawDocument } from "../document/document";

const MAX_DRAW_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function assertPlainFilename(name: string, kind: "draw" | "png" | "jpeg"): void {
  const ext = extname(name).toLowerCase();
  const valid = kind === "draw" ? ext === ".draw" : kind === "png" ? ext === ".png" : ext === ".jpg" || ext === ".jpeg";
  if (!name || name.length > 160 || name === "." || name === ".." || basename(name) !== name || isAbsolute(name) || name.includes("/") || name.includes("\\") || name.startsWith("~") || !valid) {
    throw new Error(`File path must be a plain filename inside the configured Draw folder with the matching ${kind} extension.`);
  }
}

async function configuredDirectory(root: string): Promise<string> {
  if (!root || !isAbsolute(root)) throw new Error("Set DRAW_MCP_DOCUMENT_DIR to an absolute, user-approved Draw folder before using MCP file tools.");
  const canonical = await realpath(resolve(root));
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) throw new Error("DRAW_MCP_DOCUMENT_DIR must point to a directory.");
  return canonical;
}

async function targetInRoot(root: string, name: string, kind: "draw" | "png" | "jpeg", mayNotExist: boolean): Promise<{ root: string; target: string }> {
  assertPlainFilename(name, kind);
  const canonicalRoot = await configuredDirectory(root);
  const target = join(canonicalRoot, name);
  if (dirname(target) !== canonicalRoot) throw new Error("File path escapes the configured Draw folder.");
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Symbolic link targets are not allowed for MCP file operations.");
    if (!stat.isFile()) throw new Error("MCP file target must be a regular file.");
    if (mayNotExist) throw new Error(`PATH_EXISTS: File "${name}" already exists; choose a new filename. Existing files are never overwritten by MCP.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root: canonicalRoot, target };
}

export async function loadDrawFileSnapshot(root: string, filename: string): Promise<{ document: DrawDocument; fingerprint: string }> {
  const { target } = await targetInRoot(root, filename, "draw", false);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("MCP file target must be a regular file.");
    if (stat.size > MAX_DRAW_BYTES) throw new Error("Draw file exceeds the 100 MiB limit.");
    const file = await handle.readFile();
    if (file.byteLength > MAX_DRAW_BYTES) throw new Error("Draw file exceeds the 100 MiB limit.");
    return { document: parseDrawFile(file.toString("utf8")), fingerprint: createHash("sha256").update(file).digest("hex") };
  } catch (error) {
    if (error instanceof DrawDocumentError || (error instanceof Error && /Draw file exceeds|regular file/.test(error.message))) throw error;
    throw new Error("Could not safely read the requested Draw file.");
  } finally {
    await handle?.close();
  }
}

export async function loadDrawFile(root: string, filename: string): Promise<DrawDocument> {
  return (await loadDrawFileSnapshot(root, filename)).document;
}

export async function drawFileFingerprint(root: string, filename: string): Promise<string> {
  const { target } = await targetInRoot(root, filename, "draw", false);
  const file = await readFile(target);
  if (file.byteLength > MAX_DRAW_BYTES) throw new Error("Draw file exceeds the 100 MiB limit.");
  return createHash("sha256").update(file).digest("hex");
}

export async function writeNewArtifact(root: string, filename: string, bytes: Uint8Array, kind: "draw" | "png" | "jpeg"): Promise<string> {
  const { root: canonicalRoot, target } = await targetInRoot(root, filename, kind, true);
  const maxBytes = kind === "draw" ? MAX_DRAW_BYTES : MAX_IMAGE_BYTES;
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error(`Artifact must be between 1 byte and ${Math.round(maxBytes / 1024 / 1024)} MiB.`);
  if (kind === "draw") {
    const parsed = parseDrawFile(new TextDecoder().decode(bytes));
    bytes = new TextEncoder().encode(serializeDrawFile(parsed));
  }
  const temporary = join(canonicalRoot, `.draw-mcp-${randomUUID()}.tmp`);
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fileHandle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await fileHandle.writeFile(bytes);
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await link(temporary, target); // Atomic no-replace commit on the same filesystem.
    const directoryHandle = await open(canonicalRoot, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return filename;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`PATH_EXISTS: File "${filename}" already exists; choose a new filename. Existing files are never overwritten by MCP.`);
    throw new Error("Could not safely write the requested artifact inside the configured Draw folder.");
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
