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
    const code = await manager.issuePairingCode();
    const request = await manager.beginPairing(code, "Claude Code", "b".repeat(64));

    expect(manager.authenticate("client-stable-id", "a".repeat(64))).toBe(false);
    const paired = await manager.resolvePairing(request.requestId, true);
    if (!paired) throw new Error("Approved pairing did not issue a client credential.");
    expect(paired).toMatchObject({ clientIdentity: "client-stable-id", capability: "a".repeat(64) });
    expect(manager.authenticate(paired.clientIdentity, paired.capability)).toBe(true);
    expect(manager.authenticate(paired.clientIdentity, "wrong")).toBe(false);
    expect(await manager.issuePairingCode()).toBeNull();
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
    const code = await manager.issuePairingCode();
    const request = await manager.beginPairing(code, "MCP host", "c".repeat(64));
    await manager.resolvePairing(request.requestId, true);
    expect(manager.authenticate("client-1", undefined)).toBe(false);
    expect(manager.authenticate("client-unknown", "b".repeat(64))).toBe(false);
    expect(manager.authenticate("client-1", "wrong")).toBe(false);
    await expect(manager.beginPairing(code, "MCP host", "c".repeat(64))).rejects.toThrow();
    now += 5_000;
    const expiringCode = await manager.issuePairingCode();
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
      const request = await first.beginPairing(await first.issuePairingCode(), "Draw MCP", "e".repeat(64));
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
    await manager.issuePairingCode();
    await expect(manager.beginPairing("wrong-code", "host", "f".repeat(64))).rejects.toThrow();
    await expect(manager.beginPairing("wrong-code", "host", "f".repeat(64))).rejects.toThrow(/pairing is unavailable/i);
    expect(await manager.issuePairingCode()).toBeNull();
    const afterRestart = await createMcpClientAuthManager({ store, maxFailedAttempts: 2, generatePairingCode: () => "B".repeat(64) });
    expect(await afterRestart.issuePairingCode()).toBeNull();
  });

  it("does not extend a lockout and resets the failed counter after expiry", async () => {
    let now = 1_000;
    const store = memoryStore();
    const manager = await createMcpClientAuthManager({
      now: () => now,
      store,
      maxFailedAttempts: 2,
      generatePairingCode: () => "A".repeat(64),
    });
    await manager.issuePairingCode();
    await expect(manager.beginPairing("wrong", "host", "f".repeat(64))).rejects.toThrow();
    await expect(manager.beginPairing("wrong", "host", "f".repeat(64))).rejects.toThrow();
    const initialLockout = (await store.load()).lockedUntil;
    now += 10 * 60_000;
    await expect(manager.beginPairing("wrong", "host", "f".repeat(64))).rejects.toThrow();
    expect((await store.load()).lockedUntil).toBe(initialLockout);
    now = initialLockout;
    await manager.issuePairingCode();
    expect(await store.load()).toMatchObject({ failedAttempts: 0, lockedUntil: 0 });
    await expect(manager.beginPairing("wrong", "host", "f".repeat(64))).rejects.toThrow();
    expect(await store.load()).toMatchObject({ failedAttempts: 1, lockedUntil: 0 });
  });

  it("does not let a rejected pairing request disturb an existing pending request", async () => {
    const manager = await createMcpClientAuthManager({
      store: memoryStore(),
      generatePairingCode: () => "A".repeat(64),
      generateRequestId: () => "request-one",
    });
    const code = await manager.issuePairingCode();
    const first = await manager.beginPairing(code, "host one", "1".repeat(64));
    await expect(manager.beginPairing(code, "host two", "2".repeat(64))).rejects.toThrow();
    expect(await manager.resolvePairing(first.requestId, true)).toMatchObject({ clientIdentity: expect.any(String) });
  });

  it("always performs capability hash comparison for unknown, revoked, and expired identities", async () => {
    const manager = await createMcpClientAuthManager({
      store: memoryStore(),
      generatePairingCode: () => "A".repeat(64),
      generateIdentity: () => "client-known",
      generateCapability: () => "c".repeat(64),
    });
    const request = await manager.beginPairing(await manager.issuePairingCode(), "host", "3".repeat(64));
    await manager.resolvePairing(request.requestId, true);
    expect(manager.authenticate("client-unknown", "c".repeat(64))).toBe(false);
    expect(manager.authenticate("client-known", "wrong")).toBe(false);
  });

  it("reports fingerprint replacements and keeps different hosts independently revocable", async () => {
    let now = 50_000;
    let identity = 0;
    let capability = 0;
    const manager = await createMcpClientAuthManager({
      now: () => now,
      store: memoryStore(),
      generatePairingCode: () => "A".repeat(64),
      generateIdentity: () => `client-${++identity}`,
      generateCapability: () => (++capability).toString(16).padStart(64, "0"),
    });
    const codeA = await manager.issuePairingCode();
    const requestA = await manager.beginPairing(codeA, "Host A", "a".repeat(64));
    const pairedA = await manager.resolvePairing(requestA.requestId, true);
    if (!pairedA) throw new Error("Host A pairing was not approved.");
    now += 5_000;
    const codeB = await manager.issuePairingCode();
    const requestB = await manager.beginPairing(codeB, "Host B", "b".repeat(64));
    const pairedB = await manager.resolvePairing(requestB.requestId, true);
    if (!pairedB) throw new Error("Host B pairing was not approved.");
    expect(await manager.revoke(pairedA.clientIdentity)).toBe(true);
    expect(manager.authenticate(pairedA.clientIdentity, pairedA.capability)).toBe(false);
    expect(manager.authenticate(pairedB.clientIdentity, pairedB.capability)).toBe(true);

    now += 5_000;
    const replacementCode = await manager.issuePairingCode();
    const replacement = await manager.beginPairing(replacementCode, "Replacement A", "b".repeat(64));
    expect(replacement.replacesName).toBe("Host B");
    const pairedReplacement = await manager.resolvePairing(replacement.requestId, true);
    if (!pairedReplacement) throw new Error("Replacement pairing was not approved.");
    expect(manager.authenticate(pairedB.clientIdentity, pairedB.capability)).toBe(false);
  });

  it("throttles pairing-secret issue/reissue and reuses the same live secret", async () => {
    let now = 20_000;
    let sequence = 0;
    const manager = await createMcpClientAuthManager({
      now: () => now,
      generatePairingCode: () => (++sequence).toString(16).padStart(64, "0"),
      store: memoryStore(),
    });
    const first = await manager.issuePairingCode();
    expect(first).toBeTruthy();
    expect(await manager.issuePairingCode()).toBeNull();
    now += 5_000;
    expect(await manager.issuePairingCode()).toBe(first);
    expect(sequence).toBe(1);
  });
});
