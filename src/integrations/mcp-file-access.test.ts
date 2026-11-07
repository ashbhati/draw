import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDrawFile, writeNewArtifact } from "./mcp-file-access";
import { serializeDrawFile, createEmptyDocument } from "../document/document";

const roots: string[] = [];
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "draw-mcp-files-"));
  roots.push(root);
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("MCP document file access", () => {
  it("writes and reloads a native editable Draw file under the configured root", async () => {
    const root = await makeRoot();
    const source = createEmptyDocument("Round trip");
    source.document.elements.push({ id: "shape-1", type: "rectangle", x: 20, y: 40 });
    const written = await writeNewArtifact(root, "round-trip.draw", new TextEncoder().encode(serializeDrawFile(source)), "draw");
    expect(written).toBe("round-trip.draw");
    const reopened = await loadDrawFile(root, "round-trip.draw");
    expect(reopened.document.elements).toEqual(source.document.elements);
    expect(reopened.document.id).toBe(source.document.id);
  });

  it("refuses traversal, absolute paths and a symbolic link target", async () => {
    const root = await makeRoot();
    await expect(loadDrawFile(root, "../secret.draw")).rejects.toThrow(/plain filename/i);
    await expect(loadDrawFile(root, "/tmp/secret.draw")).rejects.toThrow(/plain filename/i);
    const outside = join(root, "outside.draw");
    await writeFile(outside, "not a Draw file");
    await symlink(outside, join(root, "linked.draw"));
    await expect(loadDrawFile(root, "linked.draw")).rejects.toThrow(/symbolic link/i);
  });

  it("fails closed on a collision instead of overwriting a saved document", async () => {
    const root = await makeRoot();
    const existing = new TextEncoder().encode("keep this");
    await writeFile(join(root, "same.draw"), existing);
    await expect(writeNewArtifact(root, "same.draw", new TextEncoder().encode("replace"), "draw")).rejects.toThrow(/already exists/i);
    expect(await readFile(join(root, "same.draw"), "utf8")).toBe("keep this");
  });
});
