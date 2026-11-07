import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpClientAuthManager, createFileMcpClientAuthStore } from "./mcp-client-auth";

function memoryStore() {
  let value = { failedAttempts: 0, lockedUntil: 0, clients: [] as any[] };
  return { load: async () => structuredClone(value), save: async (next: typeof value) => { value = structuredClone(next); } };
}

describe("paired MCP client authentication", () => {
  it("requires a human-approved pairing and authenticates the issued stable identity", async () => {
    const manager = await createMcpClientAuthManager({
      store: memoryStore(),
      generatePairingCode: () => "A".repeat(64),
      generateIdentity: () => "client-stable-id",
      generateCapability: () => "a".repeat(64),
    });
    const code = manager.issuePairingCode();
    const request = await manager.beginPairing(code, "Claude Code", "b".repeat(64));

    expect(manager.authenticate("client-stable-id", "a".repeat(64))).toBe(false);
    const paired = await manager.resolvePairing(request.requestId, true);
    if (!paired) throw new Error("Approved pairing did not issue a client credential.");
    expect(paired).toMatchObject({ clientIdentity: "client-stable-id", capability: "a".repeat(64) });
    expect(manager.authenticate(paired.clientIdentity, paired.capability)).toBe(true);
    expect(manager.authenticate(paired.clientIdentity, "wrong")).toBe(false);
    expect(manager.issuePairingCode()).toBeNull();
  });

  it("rejects missing, invalid, expired, reused, and revoked capabilities without disclosing identity existence", async () => {
    let now = 10_000;
    const manager = await createMcpClientAuthManager({
      store: memoryStore(),
      now: () => now,
      pairingCodeTtlMs: 1_000,
      generatePairingCode: () => "A".repeat(64),
      generateIdentity: () => "client-1",
      generateCapability: () => "b".repeat(64),
    });
    const code = manager.issuePairingCode();
    const request = await manager.beginPairing(code, "MCP host", "c".repeat(64));
    await manager.resolvePairing(request.requestId, true);
    expect(manager.authenticate("client-1", undefined)).toBe(false);
    expect(manager.authenticate("client-unknown", "b".repeat(64))).toBe(false);
    expect(manager.authenticate("client-1", "wrong")).toBe(false);
    await expect(manager.beginPairing(code, "MCP host", "c".repeat(64))).rejects.toThrow();
    now += 5_000;
    const expiringCode = manager.issuePairingCode();
    now += 1_001;
    await expect(manager.beginPairing(expiringCode, "MCP host", "c".repeat(64))).rejects.toThrow();
    await manager.revoke("client-1");
    expect(manager.authenticate("client-1", "b".repeat(64))).toBe(false);
  });

  it("persists paired identities and revocation with restrictive file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-mcp-auth-"));
    const path = join(directory, "mcp-clients.json");
    try {
      const first = await createMcpClientAuthManager({
        store: createFileMcpClientAuthStore(path),
        generatePairingCode: () => "A".repeat(64),
        generateIdentity: () => "durable-client",
        generateCapability: () => "d".repeat(64),
      });
      const request = await first.beginPairing(first.issuePairingCode(), "Draw MCP", "e".repeat(64));
      const paired = await first.resolvePairing(request.requestId, true);
      if (!paired) throw new Error("Approved pairing did not issue a client credential.");
      const second = await createMcpClientAuthManager({ store: createFileMcpClientAuthStore(path) });
      expect(second.authenticate(paired.clientIdentity, paired.capability)).toBe(true);
      await second.revoke(paired.clientIdentity);
      const third = await createMcpClientAuthManager({ store: createFileMcpClientAuthStore(path) });
      expect(third.authenticate(paired.clientIdentity, paired.capability)).toBe(false);
      expect(JSON.parse(await readFile(path, "utf8")).clients[0].secretHash).not.toBe(paired.capability);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rate limits failed pairing-code attempts", async () => {
    const store = memoryStore();
    const manager = await createMcpClientAuthManager({ store, maxFailedAttempts: 2, generatePairingCode: () => "A".repeat(64) });
    manager.issuePairingCode();
    await expect(manager.beginPairing("wrong-code", "host", "f".repeat(64))).rejects.toThrow();
    await expect(manager.beginPairing("wrong-code", "host", "f".repeat(64))).rejects.toThrow(/pairing is unavailable/i);
    expect(manager.issuePairingCode()).toBeNull();
    const afterRestart = await createMcpClientAuthManager({ store, maxFailedAttempts: 2, generatePairingCode: () => "B".repeat(64) });
    expect(afterRestart.issuePairingCode()).toBeNull();
  });

  it("throttles pairing-secret issue/reissue and reuses the same live secret", async () => {
    let now = 20_000;
    let sequence = 0;
    const manager = await createMcpClientAuthManager({
      now: () => now,
      generatePairingCode: () => (++sequence).toString(16).padStart(64, "0"),
      store: memoryStore(),
    });
    const first = manager.issuePairingCode();
    expect(first).toBeTruthy();
    expect(manager.issuePairingCode()).toBeNull();
    now += 5_000;
    expect(manager.issuePairingCode()).toBe(first);
    expect(sequence).toBe(1);
  });
});
