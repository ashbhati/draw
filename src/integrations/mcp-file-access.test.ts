import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDrawFile, loadDrawFileSnapshot, writeNewArtifact } from "./mcp-file-access";
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
    const snapshot = await loadDrawFileSnapshot(root, "round-trip.draw");
    expect(snapshot.document.document.id).toBe(source.document.id);
    expect(snapshot.fingerprint).toMatch(/^[\da-f]{64}$/);
  });

  it("rejects an oversized file from its open-handle stat before reading it", async () => {
    const root = await makeRoot();
    const oversized = join(root, "oversized.draw");
    await writeFile(oversized, "x");
    await truncate(oversized, 100 * 1024 * 1024 + 1);
    await expect(loadDrawFile(root, "oversized.draw")).rejects.toThrow(/100 MiB limit/i);
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

  it("lets only one concurrent no-replace writer create a target", async () => {
    const root = await makeRoot();
    const candidates = [
      new TextEncoder().encode("first approved bytes"),
      new TextEncoder().encode("second approved bytes"),
    ];
    const outcomes = await Promise.allSettled(candidates.map((bytes) =>
      writeNewArtifact(root, "raced.png", bytes, "png"),
    ));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ message: expect.stringMatching(/PATH_EXISTS/) });
    const stored = await readFile(join(root, "raced.png"));
    expect(candidates.some((candidate) => Buffer.from(candidate).equals(stored))).toBe(true);
  });
});
