import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditorAuthManager, createFileEditorAuthStore } from "./editor-auth";

function createMemoryStore() {
  let state: { failedAttempts: number; lockedUntil: number } = { failedAttempts: 0, lockedUntil: 0 };
  return {
    load: vi.fn(async () => ({ ...state })),
    save: vi.fn(async (next: { failedAttempts: number; lockedUntil: number }) => { state = { ...next }; }),
  };
}

describe("editor session authentication", () => {
  it("exchanges a one-use launch code for a secret-bound tab lease", async () => {
    const terminalCodes: string[] = [];
    const codes = ["ABCDEF123456", "FEDCBA654321"];
    const store = createMemoryStore();
    const auth = await createEditorAuthManager({
      now: () => 1_000,
      generateLaunchCode: () => codes.shift()!,
      generateSecret: () => "tab-secret-256-bit",
      displayLaunchCode: (code) => { terminalCodes.push(code); },
      store,
    });

    expect(terminalCodes).toEqual(["ABCDEF123456"]);
    expect(await auth.exchangeLaunchCode("ABCDEF123456", "tab-a")).toEqual({ status: "AUTHENTICATED", clientId: "tab-a", editorSecret: "tab-secret-256-bit" });
    expect(auth.authorize("tab-a", "tab-secret-256-bit")).toBe(true);
    expect(auth.authorize("tab-b", "tab-secret-256-bit")).toBe(false);
    expect(auth.authorize("tab-a", "wrong-secret")).toBe(false);
    expect((await auth.exchangeLaunchCode("ABCDEF123456", "tab-a")).status).toBe("INVALID");
    expect(terminalCodes).toEqual(["ABCDEF123456", "FEDCBA654321"]);
    expect(store.save).toHaveBeenCalled();
  });

  it("expires codes without charging a failed attempt and permits a human-requested reissue", async () => {
    let now = 1_000;
    const codes = ["ABCDEF123456", "FEDCBA654321", "C0FFEE123456", "A1A2A3A4A5A6"];
    const displayed: string[] = [];
    const store = createMemoryStore();
    const auth = await createEditorAuthManager({
      now: () => now,
      generateLaunchCode: () => codes.shift()!,
      generateSecret: () => "tab-secret",
      displayLaunchCode: (code) => { displayed.push(code); },
      store,
    });
    const connected = await auth.exchangeLaunchCode("ABCDEF123456", "tab-a");
    expect(connected.status).toBe("AUTHENTICATED");
    now += 60_001;

    expect(await auth.exchangeLaunchCode("FEDCBA654321", "tab-b")).toEqual({ status: "EXPIRED" });
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenLastCalledWith({ failedAttempts: 0, lockedUntil: 0 });
    expect(auth.authorize("tab-a", "tab-secret")).toBe(true);
    expect(await auth.requestFreshLaunchCode()).toBe("ISSUED");
    expect(displayed).toEqual(["ABCDEF123456", "FEDCBA654321", "C0FFEE123456"]);
    expect(await auth.exchangeLaunchCode("C0FFEE123456", "tab-b")).toMatchObject({ status: "AUTHENTICATED", clientId: "tab-b" });
    expect(auth.authorize("tab-a", "tab-secret")).toBe(false);
  });

  it("fails closed when no trusted interactive terminal is available", async () => {
    const store = createMemoryStore();
    const auth = await createEditorAuthManager({
      generateLaunchCode: () => "ABCDEF123456",
      generateSecret: () => "never-issued",
      displayLaunchCode: () => false,
      store,
    });

    expect(await auth.exchangeLaunchCode("ABCDEF123456", "tab-a")).toEqual({ status: "UNAVAILABLE" });
    expect(await auth.requestFreshLaunchCode()).toBe("UNAVAILABLE");
    expect(store.save).not.toHaveBeenCalled();
    expect(auth.authorize("tab-a", "never-issued")).toBe(false);
  });

  it("uses generic failures and persists the five-attempt lockout across manager restarts", async () => {
    let now = 5_000;
    const store = createMemoryStore();
    const display = vi.fn();
    const first = await createEditorAuthManager({
      now: () => now,
      generateLaunchCode: () => "ABCDEF123456",
      generateSecret: () => "unused",
      displayLaunchCode: display,
      store,
    });
    expect((await first.exchangeLaunchCode("ABCDEF123456", "tab-a")).status).toBe("AUTHENTICATED");

    const failures: Awaited<ReturnType<typeof first.exchangeLaunchCode>>[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) failures.push(await first.exchangeLaunchCode("WRONGCODE000", "tab-a"));
    expect(failures.map((result) => result.status)).toEqual(["INVALID", "INVALID", "INVALID", "INVALID", "LOCKED"]);
    expect(store.save).toHaveBeenLastCalledWith({ failedAttempts: 5, lockedUntil: now + 15 * 60_000 });
    expect(first.authorize("tab-a", "unused")).toBe(true);
    expect(await first.requestFreshLaunchCode()).toBe("LOCKED");

    const restarted = await createEditorAuthManager({
      now: () => now,
      generateLaunchCode: () => "SECOND000000",
      generateSecret: () => "still-unused",
      displayLaunchCode: display,
      store,
    });
    expect(display).toHaveBeenCalledTimes(2);
    expect((await restarted.exchangeLaunchCode("SECOND000000", "tab-b")).status).toBe("LOCKED");
  });

  it("requires a fresh launch code for takeover and revokes only the prior editor lease", async () => {
    const codes = ["AAAAAA000001", "BBBBBB000002", "CCCCCC000003"];
    const secrets = ["secret-one", "secret-two"];
    const auth = await createEditorAuthManager({
      now: () => 10_000,
      generateLaunchCode: () => codes.shift()!,
      generateSecret: () => secrets.shift()!,
      displayLaunchCode: () => undefined,
      store: createMemoryStore(),
    });

    const first = await auth.exchangeLaunchCode("AAAAAA000001", "tab-a");
    expect(first.status).toBe("AUTHENTICATED");
    const second = await auth.exchangeLaunchCode("BBBBBB000002", "tab-b");
    expect(second.status).toBe("AUTHENTICATED");
    expect(auth.authorize("tab-a", "secret-one")).toBe(false);
    expect(auth.authorize("tab-b", "secret-two")).toBe(true);
    auth.revokeEditorSession();
    expect(auth.authorize("tab-b", "secret-two")).toBe(false);
  });

  it("persists lockout state in a permission-restricted file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "draw-editor-auth-"));
    try {
      const filePath = join(directory, "state.json");
      const store = createFileEditorAuthStore(filePath);
      await store.save({ failedAttempts: 5, lockedUntil: 123_456 });
      expect(await store.load()).toEqual({ failedAttempts: 5, lockedUntil: 123_456 });
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ failedAttempts: 5, lockedUntil: 123_456 });
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
