import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getLocalMcpIdentity, readLocalMcpCredential, writeLocalMcpCredential } from "./mcp-client-credentials";

describe("local MCP host credentials", () => {
  it("creates a stable local identity and atomically stores the capability with restrictive permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-mcp-host-"));
    const path = join(directory, "client.json");
    try {
      const first = await getLocalMcpIdentity(path);
      const second = await getLocalMcpIdentity(path);
      expect(first).toEqual(second);
      await writeLocalMcpCredential({ ...first, clientIdentity: "paired-id", capability: "a".repeat(64), expiresAt: Date.now() + 1000 }, path);
      expect(await readLocalMcpCredential(path)).toMatchObject({ clientIdentity: "paired-id", capability: "a".repeat(64) });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed stored credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-mcp-host-invalid-"));
    const path = join(directory, "client.json");
    try {
      await writeFile(path, JSON.stringify({ installationId: "host", clientIdentity: "paired-id", capability: "not-a-capability" }));
      await chmod(path, 0o600);
      await expect(readLocalMcpCredential(path)).rejects.toThrow(/invalid/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects host credential files readable by other users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-mcp-host-mode-"));
    const path = join(directory, "client.json");
    try {
      await writeFile(path, JSON.stringify({ installationId: "host", clientIdentity: "id", capability: "b".repeat(64) }));
      await chmod(path, 0o644);
      await expect(readLocalMcpCredential(path)).rejects.toThrow(/permissions are too broad/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects symlink credentials and permission changes made after pairing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-mcp-host-race-"));
    const path = join(directory, "client.json");
    const target = join(directory, "target.json");
    try {
      await writeLocalMcpCredential({ installationId: "host", clientIdentity: "id", capability: "c".repeat(64) }, target);
      await symlink(target, path);
      await expect(readLocalMcpCredential(path)).rejects.toThrow(/permissions|symlink|symbolic/i);
      await rm(path);
      await writeLocalMcpCredential({ installationId: "host", clientIdentity: "id", capability: "c".repeat(64) }, path);
      await chmod(path, 0o644);
      await expect(readLocalMcpCredential(path)).rejects.toThrow(/permissions are too broad/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads the originally opened file if its path is replaced during validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-mcp-host-open-race-"));
    const path = join(directory, "client.json");
    const replacement = join(directory, "replacement.json");
    try {
      const original = { installationId: "host", clientIdentity: "original", capability: "d".repeat(64) };
      const attacker = { installationId: "host", clientIdentity: "attacker", capability: "e".repeat(64) };
      await writeLocalMcpCredential(original, path);
      await writeLocalMcpCredential(attacker, replacement);
      const credential = await readLocalMcpCredential(path, async (filePath, flags) => {
        const handle = await import("node:fs/promises").then(({ open }) => open(filePath, flags));
        await rm(filePath);
        await symlink(replacement, filePath);
        return handle;
      });
      expect(credential?.clientIdentity).toBe("original");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
