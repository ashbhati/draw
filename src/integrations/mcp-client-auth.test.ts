import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMcpClientAuthManager, createFileMcpClientAuthStore, McpPairingPendingError, McpPairingRateLimitError, type McpClientAuthState } from "./mcp-client-auth";

function memoryStore(initial = { failedAttempts: 0, lockedUntil: 0, clients: [] as any[] }) {
  let value = structuredClone(initial);
  return { load: async () => structuredClone(value), save: async (next: typeof value) => { value = structuredClone(next); } };
}

describe("paired MCP client authentication", () => {
  it("requires explicit human approval and keeps the issued host grant active until revoked", async () => {
    let now = 10_000;
    const manager = await createMcpClientAuthManager({
      store: memoryStore(),
      now: () => now,
      generateIdentity: () => "client-stable-id",
      generateCapability: () => "a".repeat(64),
    });
    const request = await manager.beginPairing("Claude Code in Herdr", "b".repeat(64));

    expect(manager.authenticate("client-stable-id", "a".repeat(64))).toBe(false);
    const paired = await manager.resolvePairing(request.requestId, true);
    if (!paired) throw new Error("Approved pairing did not issue a client credential.");
    expect(paired.credential).toEqual({ clientIdentity: "client-stable-id", capability: "a".repeat(64) });
    expect(manager.authenticate(paired.credential.clientIdentity, paired.credential.capability)).toBe(true);
    now += 10 * 365 * 24 * 60 * 60_000;
    expect(manager.authenticate(paired.credential.clientIdentity, paired.credential.capability)).toBe(true);
    expect(await manager.revoke(paired.credential.clientIdentity)).toBe(true);
    expect(manager.authenticate(paired.credential.clientIdentity, paired.credential.capability)).toBe(false);
  });

  it("rejects missing, invalid, denied, expired, and revoked capabilities", async () => {
    let now = 10_000;
    const manager = await createMcpClientAuthManager({
      store: memoryStore(),
      now: () => now,
      pairingRequestTtlMs: 1_000,
      generateIdentity: () => "client-1",
      generateCapability: () => "b".repeat(64),
    });
    const request = await manager.beginPairing("MCP host", "c".repeat(64));
    expect(await manager.resolvePairing(request.requestId, false)).toBeNull();
    expect(manager.authenticate("client-1", "b".repeat(64))).toBe(false);

    now += 5_000;
    const expired = await manager.beginPairing("MCP host", "c".repeat(64));
    now += 1_001;
    await expect(manager.resolvePairing(expired.requestId, true)).rejects.toThrow();

    now += 5_000;
    const approved = await manager.beginPairing("MCP host", "c".repeat(64));
    const paired = await manager.resolvePairing(approved.requestId, true);
    if (!paired) throw new Error("Approved pairing did not issue a client credential.");
    expect(manager.authenticate("client-1", undefined)).toBe(false);
    expect(manager.authenticate("client-unknown", "b".repeat(64))).toBe(false);
    expect(manager.authenticate("client-1", "wrong")).toBe(false);
    expect(await manager.revoke("client-1")).toBe(true);
    expect(manager.authenticate("client-1", "b".repeat(64))).toBe(false);
  });

  it("migrates active one year grants to persistent access and leaves expired grants inactive", async () => {
    let now = 100_000;
    const oldCapability = "c".repeat(64);
    const oldCapabilityHash = createHash("sha256").update(oldCapability).digest("hex");
    const store = memoryStore({
      failedAttempts: 2,
      lockedUntil: now + 60_000,
      clients: [
        { clientIdentity: "legacy-active", name: "Legacy Active", fingerprint: "1".repeat(64), secretHash: oldCapabilityHash, createdAt: 1, expiresAt: now + 1_000, revokedAt: null },
        { clientIdentity: "legacy-expired", name: "Legacy Expired", fingerprint: "2".repeat(64), secretHash: "e".repeat(64), createdAt: 1, expiresAt: now - 1, revokedAt: null },
      ],
    });
    const manager = await createMcpClientAuthManager({ store, now: () => now });

    expect(manager.authenticate("legacy-active", oldCapability)).toBe(true);
    const migratedState = await store.load();
    expect(migratedState.clients[0]).toMatchObject({ expiresAt: now + 1_000, persistentAccess: true });
    expect(migratedState.clients[1].expiresAt).toBe(now - 1);
    expect(manager.authenticate("legacy-expired", "e".repeat(64))).toBe(false);

    now += 2 * 365 * 24 * 60 * 60_000;
    const restarted = await createMcpClientAuthManager({ store, now: () => now });
    expect(restarted.authenticate("legacy-active", oldCapability)).toBe(true);
    expect(restarted.authenticate("legacy-expired", "e".repeat(64))).toBe(false);
  });

  it("persists approved identities and revocation with restrictive file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-mcp-auth-"));
    const path = join(directory, "mcp-clients.json");
    try {
      const first = await createMcpClientAuthManager({
        store: createFileMcpClientAuthStore(path),
        generateIdentity: () => "durable-client",
        generateCapability: () => "d".repeat(64),
      });
      const request = await first.beginPairing("Draw MCP", "e".repeat(64));
      const paired = await first.resolvePairing(request.requestId, true);
      if (!paired) throw new Error("Approved pairing did not issue a client credential.");
      const second = await createMcpClientAuthManager({ store: createFileMcpClientAuthStore(path) });
      expect(second.authenticate(paired.credential.clientIdentity, paired.credential.capability)).toBe(true);
      await second.revoke(paired.credential.clientIdentity);
      const third = await createMcpClientAuthManager({ store: createFileMcpClientAuthStore(path) });
      expect(third.authenticate(paired.credential.clientIdentity, paired.credential.capability)).toBe(false);
      expect(JSON.parse(await readFile(path, "utf8")).clients[0].secretHash).not.toBe(paired.credential.capability);
      expect(JSON.parse(await readFile(path, "utf8")).clients[0]).toMatchObject({ persistentAccess: true });
      expect(Number.isFinite(JSON.parse(await readFile(path, "utf8")).clients[0].expiresAt)).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows only one pending approval and throttles after a denied decision", async () => {
    let now = 20_000;
    let sequence = 0;
    const manager = await createMcpClientAuthManager({
      now: () => now,
      generateIdentity: () => `client-${++sequence}`,
      store: memoryStore(),
    });
    const first = await manager.beginPairing("Host one", "1".repeat(64));
    await expect(manager.beginPairing("Host two", "2".repeat(64))).rejects.toBeInstanceOf(McpPairingPendingError);
    await manager.resolvePairing(first.requestId, false);
    await expect(manager.beginPairing("Host two", "2".repeat(64))).rejects.toThrow(/wait/i);
    now += 5_000;
    const next = await manager.beginPairing("Host two", "2".repeat(64));
    expect(next.name).toBe("Host two");
  });

  it("throttles new approval prompts for five seconds after a successful pairing", async () => {
    let now = 30_000;
    const manager = await createMcpClientAuthManager({ now: () => now, store: memoryStore() });
    const request = await manager.beginPairing("Approved host", "3".repeat(64));
    await manager.resolvePairing(request.requestId, true);

    await expect(manager.beginPairing("Another host", "4".repeat(64))).rejects.toBeInstanceOf(McpPairingRateLimitError);
    now += 5_000;
    await expect(manager.beginPairing("Another host", "4".repeat(64))).resolves.toMatchObject({ name: "Another host" });
  });

  it("keeps migrated access available in memory if persisting the migration fails", async () => {
    const currentTime = 40_000;
    const capability = "5".repeat(64);
    const initial = {
      failedAttempts: 0,
      lockedUntil: 0,
      clients: [{
        clientIdentity: "legacy-client",
        name: "Legacy host",
        fingerprint: "6".repeat(64),
        secretHash: createHash("sha256").update(capability).digest("hex"),
        createdAt: 1,
        expiresAt: currentTime + 1_000,
        revokedAt: null,
      }],
    };
    let persisted: McpClientAuthState = structuredClone(initial);
    let failFirstSave = true;
    const store = {
      load: async () => structuredClone(initial),
      save: async (next: McpClientAuthState) => {
        if (failFirstSave) {
          failFirstSave = false;
          throw new Error("disk temporarily unavailable");
        }
        persisted = structuredClone(next);
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const manager = await createMcpClientAuthManager({ store, now: () => currentTime });
      expect(manager.authenticate("legacy-client", capability)).toBe(true);
      expect(manager.list()[0]).toMatchObject({ persistentAccess: true, expiresAt: currentTime + 1_000 });
      expect(warn).toHaveBeenCalled();

      expect(await manager.revoke("legacy-client")).toBe(true);
      expect(persisted.clients[0]).toMatchObject({ persistentAccess: true, revokedAt: currentTime });
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the manager usable when clearing legacy lockout state cannot be persisted", async () => {
    let saveAttempts = 0;
    const store = {
      load: async () => ({ failedAttempts: 3, lockedUntil: 99_000, clients: [] }),
      save: async () => {
        saveAttempts += 1;
        throw new Error("disk temporarily unavailable");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const manager = await createMcpClientAuthManager({ store, now: () => 100_000 });
      await expect(manager.beginPairing("Recovered host", "7".repeat(64))).resolves.toMatchObject({ name: "Recovered host" });
      expect(saveAttempts).toBe(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reports fingerprint replacements and keeps different hosts independently revocable", async () => {
    let now = 50_000;
    let identity = 0;
    let capability = 0;
    const manager = await createMcpClientAuthManager({
      now: () => now,
      store: memoryStore(),
      generateIdentity: () => `client-${++identity}`,
      generateCapability: () => (++capability).toString(16).padStart(64, "0"),
    });
    const requestA = await manager.beginPairing("Host A", "a".repeat(64));
    const pairedA = await manager.resolvePairing(requestA.requestId, true);
    if (!pairedA) throw new Error("Host A pairing was not approved.");
    now += 5_000;
    const requestB = await manager.beginPairing("Host B", "b".repeat(64));
    const pairedB = await manager.resolvePairing(requestB.requestId, true);
    if (!pairedB) throw new Error("Host B pairing was not approved.");
    expect(await manager.revoke(pairedA.credential.clientIdentity)).toBe(true);
    expect(manager.authenticate(pairedA.credential.clientIdentity, pairedA.credential.capability)).toBe(false);
    expect(manager.authenticate(pairedB.credential.clientIdentity, pairedB.credential.capability)).toBe(true);

    now += 5_000;
    const replacement = await manager.beginPairing("Replacement B", "b".repeat(64));
    expect(replacement.replacesName).toBe("Host B");
    const pairedReplacement = await manager.resolvePairing(replacement.requestId, true);
    if (!pairedReplacement) throw new Error("Replacement pairing was not approved.");
    expect(pairedReplacement.replacedClientIdentity).toBe(pairedB.credential.clientIdentity);
    expect(manager.authenticate(pairedB.credential.clientIdentity, pairedB.credential.capability)).toBe(false);
  });
});
