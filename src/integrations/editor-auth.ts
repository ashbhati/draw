import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";

const LAUNCH_CODE_TTL_MS = 60_000;
const REISSUE_THROTTLE_MS = 5_000;
const RETIRED_CODE_TTL_MS = 5 * 60_000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

export type EditorAuthState = { failedAttempts: number; lockedUntil: number };

export type EditorAuthStore = {
  load: () => Promise<EditorAuthState>;
  save: (state: EditorAuthState) => Promise<void>;
};

export type EditorAuthResult =
  | { status: "AUTHENTICATED"; clientId: string; editorSecret: string }
  | { status: "INVALID" | "EXPIRED" | "LOCKED" | "UNAVAILABLE" };

export type EditorAuthManager = {
  exchangeLaunchCode: (code: unknown, clientId: string) => Promise<EditorAuthResult>;
  requestFreshLaunchCode: () => Promise<"ISSUED" | "LOCKED" | "THROTTLED" | "UNAVAILABLE">;
  authorize: (clientId: unknown, editorSecret: unknown) => boolean;
  getActiveClientId: () => string | null;
  revokeEditorSession: () => void;
};

export type EditorAuthOptions = {
  now?: () => number;
  generateLaunchCode?: () => string;
  generateSecret?: () => string;
  /** Must display only to an interactive trusted terminal; never to a logger, URL, or API response. */
  displayLaunchCode: (code: string) => boolean | void;
  store?: EditorAuthStore;
};

export function createFileEditorAuthStore(filePath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "draw", "editor-auth-state.json")): EditorAuthStore {
  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<EditorAuthState>;
        return {
          failedAttempts: Number.isInteger(raw.failedAttempts) ? Math.min(MAX_FAILED_ATTEMPTS, Math.max(0, raw.failedAttempts!)) : 0,
          lockedUntil: Number.isFinite(raw.lockedUntil) ? Math.max(0, raw.lockedUntil!) : 0,
        };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return { failedAttempts: 0, lockedUntil: 0 };
        throw error;
      }
    },
    async save(state) {
      const directory = dirname(filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    },
  };
}

function equalSecret(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const supplied = Buffer.from(left, "utf8");
  const expected = Buffer.from(right, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function createEditorAuthManager(options: EditorAuthOptions): Promise<EditorAuthManager> {
  const now = options.now ?? Date.now;
  const generateLaunchCode = options.generateLaunchCode ?? (() => randomBytes(6).toString("hex").toUpperCase());
  const generateSecret = options.generateSecret ?? (() => randomBytes(32).toString("hex"));
  const store = options.store ?? createFileEditorAuthStore();
  let persisted = await store.load();
  let launchCode: string | null = null;
  let launchCodeExpiresAt = 0;
  let launchCodeAvailable = false;
  let lastReissueAt: number | null = null;
  const retiredLaunchCodes = new Map<string, number>();
  let active: { clientId: string; secret: string } | null = null;
  let exchangeQueue = Promise.resolve();

  const retireLaunchCode = (code: string | null, retiredAt = now()) => {
    if (code) retiredLaunchCodes.set(code, retiredAt + RETIRED_CODE_TTL_MS);
    for (const [retiredCode, expiresAt] of retiredLaunchCodes) {
      if (expiresAt <= retiredAt) retiredLaunchCodes.delete(retiredCode);
    }
    while (retiredLaunchCodes.size > 256) {
      const oldest = retiredLaunchCodes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      retiredLaunchCodes.delete(oldest);
    }
  };

  const issueLaunchCode = () => {
    launchCode = null;
    launchCodeExpiresAt = 0;
    launchCodeAvailable = false;
    if (now() < persisted.lockedUntil) return;
    const candidate = generateLaunchCode();
    // Six bytes encode 48 independent random bits. The production generator
    // is CSPRNG-backed; tests inject deterministic values for coverage.
    if (candidate.length !== 12 || !/^[A-F0-9]{12}$/.test(candidate)) return;
    const displayed = options.displayLaunchCode(candidate);
    if (displayed === false) return;
    launchCode = candidate;
    launchCodeExpiresAt = now() + LAUNCH_CODE_TTL_MS;
    launchCodeAvailable = true;
  };

  issueLaunchCode();

  return {
    exchangeLaunchCode(code, clientId) {
      const next = exchangeQueue.then(() => exchangeLaunchCodeSerialized(code, clientId));
      exchangeQueue = next.then(() => undefined, () => undefined);
      return next;
    },
    requestFreshLaunchCode() {
      const next = exchangeQueue.then(async () => {
        const currentTime = now();
        if (persisted.lockedUntil !== 0 && currentTime >= persisted.lockedUntil) {
          persisted = { failedAttempts: 0, lockedUntil: 0 };
          await store.save(persisted);
        }
        if (now() < persisted.lockedUntil) return "LOCKED" as const;
        if (lastReissueAt !== null && currentTime - lastReissueAt < REISSUE_THROTTLE_MS) return "THROTTLED" as const;
        if (launchCodeAvailable && launchCode && currentTime < launchCodeExpiresAt) {
          if (options.displayLaunchCode(launchCode) === false) return "UNAVAILABLE" as const;
          lastReissueAt = currentTime;
          return "ISSUED" as const;
        }
        if (launchCode) retireLaunchCode(launchCode, currentTime);
        launchCode = null;
        launchCodeExpiresAt = 0;
        launchCodeAvailable = false;
        issueLaunchCode();
        if (launchCodeAvailable) lastReissueAt = currentTime;
        return launchCodeAvailable ? "ISSUED" as const : "UNAVAILABLE" as const;
      });
      exchangeQueue = next.then(() => undefined, () => undefined);
      return next;
    },
    authorize(clientId, editorSecret) {
      return Boolean(active && clientId === active.clientId && equalSecret(editorSecret, active.secret));
    },
    getActiveClientId() { return active?.clientId ?? null; },
    revokeEditorSession() { active = null; },
  };

  async function exchangeLaunchCodeSerialized(code: unknown, clientId: string): Promise<EditorAuthResult> {
      const currentTime = now();
      if (persisted.lockedUntil !== 0 && currentTime >= persisted.lockedUntil) {
        persisted = { failedAttempts: 0, lockedUntil: 0 };
        await store.save(persisted);
      }
      if (currentTime < persisted.lockedUntil) return { status: "LOCKED" };
      retireLaunchCode(null, currentTime);
      if (typeof code === "string" && retiredLaunchCodes.has(code)) return { status: "EXPIRED" };
      if (launchCode && currentTime >= launchCodeExpiresAt) {
        retireLaunchCode(launchCode, currentTime);
        launchCode = null;
        launchCodeExpiresAt = 0;
        launchCodeAvailable = false;
        return { status: "EXPIRED" };
      }
      if (!launchCodeAvailable) {
        return { status: "UNAVAILABLE" };
      }
      const codeWasValidAtRequestTime = Boolean(launchCode && equalSecret(code, launchCode));
      if (!codeWasValidAtRequestTime || typeof clientId !== "string" || clientId.length < 1 || clientId.length > 200) {
        persisted = { ...persisted, failedAttempts: persisted.failedAttempts + 1 };
        if (persisted.failedAttempts >= MAX_FAILED_ATTEMPTS) {
          persisted = { failedAttempts: MAX_FAILED_ATTEMPTS, lockedUntil: currentTime + LOCKOUT_MS };
          retireLaunchCode(launchCode, currentTime);
          launchCode = null;
          launchCodeExpiresAt = 0;
          launchCodeAvailable = false;
          await store.save(persisted);
          return { status: "LOCKED" };
        }
        await store.save(persisted);
        return { status: "INVALID" };
      }

      // Consume before rotating. A successful bootstrap cannot be replayed.
      retireLaunchCode(launchCode, currentTime);
      launchCode = null;
      launchCodeExpiresAt = 0;
      active = { clientId, secret: generateSecret() };
      persisted = { failedAttempts: 0, lockedUntil: 0 };
      await store.save(persisted);
      const result = { status: "AUTHENTICATED" as const, clientId, editorSecret: active.secret };
      issueLaunchCode(); // Permit an intentional, human-launched tab takeover with a fresh code.
      return result;
  }
}
