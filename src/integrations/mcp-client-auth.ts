import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";

const PAIRING_TTL_MS = 5 * 60_000;
const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const MAX_FAILED_ATTEMPTS = 5;
const PAIRING_CODE_REISSUE_MS = 5_000;

export type PairedMcpClient = {
  clientIdentity: string;
  name: string;
  fingerprint: string;
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

export type McpClientAuthState = {
  failedAttempts: number;
  lockedUntil: number;
  clients: PairedMcpClient[];
};

export type McpClientAuthStore = {
  load: () => Promise<McpClientAuthState>;
  save: (state: McpClientAuthState) => Promise<void>;
};

export type McpPairingRequest = {
  requestId: string;
  name: string;
  fingerprint: string;
  expiresAt: number;
  replacesName?: string;
};

export type PairedMcpCredential = { clientIdentity: string; capability: string; expiresAt: number };

export type McpClientAuthManager = {
  issuePairingCode: () => Promise<string | null>;
  beginPairing: (code: unknown, name: unknown, fingerprint: unknown) => Promise<McpPairingRequest>;
  cancelPairing: (requestId: string) => Promise<boolean>;
  resolvePairing: (requestId: string, approved: boolean) => Promise<PairedMcpCredential | null>;
  authenticate: (clientIdentity: unknown, capability: unknown) => boolean;
  list: () => Array<Omit<PairedMcpClient, "secretHash">>;
  revoke: (clientIdentity: string) => Promise<boolean>;
};

export type McpClientAuthOptions = {
  now?: () => number;
  generatePairingCode?: () => string;
  generateIdentity?: () => string;
  generateCapability?: () => string;
  generateRequestId?: () => string;
  pairingCodeTtlMs?: number;
  maxFailedAttempts?: number;
  store?: McpClientAuthStore;
};

function emptyState(): McpClientAuthState {
  return { failedAttempts: 0, lockedUntil: 0, clients: [] };
}

function normalizeState(value: unknown): McpClientAuthState {
  if (typeof value !== "object" || value === null) throw new Error("MCP client credential store is invalid.");
  const candidate = value as Partial<McpClientAuthState>;
  if (!Array.isArray(candidate.clients)) throw new Error("MCP client credential store is invalid.");
  const clients = candidate.clients.map((client): PairedMcpClient => {
    if (typeof client !== "object" || client === null || typeof client.clientIdentity !== "string" ||
      typeof client.name !== "string" || typeof client.fingerprint !== "string" ||
      typeof client.secretHash !== "string" || !/^[a-f\d]{64}$/i.test(client.secretHash) || !Number.isFinite(client.createdAt) ||
      !Number.isFinite(client.expiresAt) || (client.revokedAt !== null && !Number.isFinite(client.revokedAt))) {
      throw new Error("MCP client credential store is invalid.");
    }
    return { ...client };
  });
  return {
    failedAttempts: Number.isSafeInteger(candidate.failedAttempts) ? Math.max(0, candidate.failedAttempts!) : 0,
    lockedUntil: Number.isFinite(candidate.lockedUntil) ? Math.max(0, candidate.lockedUntil!) : 0,
    clients,
  };
}

/** Stores capability hashes only; the bearer secret is returned once to the pairing host. */
export function createFileMcpClientAuthStore(filePath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "draw", "mcp-clients.json")): McpClientAuthStore {
  return {
    async load() {
      try {
        return normalizeState(JSON.parse(await readFile(filePath, "utf8")));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyState();
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function genericPairingError(): Error {
  return new Error("Pairing is unavailable. Check the code and retry from Draw.");
}

export async function createMcpClientAuthManager(options: McpClientAuthOptions = {}): Promise<McpClientAuthManager> {
  const now = options.now ?? Date.now;
  const makeCode = options.generatePairingCode ?? (() => randomBytes(32).toString("hex").toUpperCase());
  const makeIdentity = options.generateIdentity ?? (() => randomBytes(16).toString("hex"));
  const makeCapability = options.generateCapability ?? (() => randomBytes(32).toString("hex"));
  const makeRequestId = options.generateRequestId ?? (() => randomBytes(16).toString("hex"));
  const pairingTtl = options.pairingCodeTtlMs ?? PAIRING_TTL_MS;
  const maxFailedAttempts = options.maxFailedAttempts ?? MAX_FAILED_ATTEMPTS;
  const store = options.store ?? createFileMcpClientAuthStore();
  let state = normalizeState(await store.load());
  let pairingCode: string | null = null;
  let pairingExpiresAt = 0;
  let lastPairingCodeIssuedAt: number | null = null;
  let pending: McpPairingRequest | null = null;
  let queue = Promise.resolve();

  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    issuePairingCode() {
      return serialize(async () => {
        const currentTime = now();
        if (pending && pending.expiresAt <= currentTime) pending = null;
        if (state.lockedUntil && currentTime >= state.lockedUntil) {
          state = { ...state, failedAttempts: 0, lockedUntil: 0 };
          await store.save(state);
        }
        if (currentTime < state.lockedUntil || pending && pending.expiresAt > currentTime) return null;
        if (lastPairingCodeIssuedAt !== null && currentTime - lastPairingCodeIssuedAt < PAIRING_CODE_REISSUE_MS) return null;
        if (pairingCode && currentTime < pairingExpiresAt) {
          lastPairingCodeIssuedAt = currentTime;
          return pairingCode;
        }
        const candidate = makeCode();
        if (!/^[A-F\d]{64}$/i.test(candidate)) return null;
        pairingCode = candidate.toUpperCase();
        pairingExpiresAt = currentTime + pairingTtl;
        lastPairingCodeIssuedAt = currentTime;
        return pairingCode;
      });
    },
    beginPairing(code, name, fingerprint) {
      return serialize(async () => {
        const currentTime = now();
        if (state.lockedUntil && currentTime >= state.lockedUntil) {
          state = { ...state, failedAttempts: 0, lockedUntil: 0 };
          await store.save(state);
        }
        if (pending && pending.expiresAt <= currentTime) pending = null;
        if (currentTime < state.lockedUntil) throw genericPairingError();
        // A concurrent retry while a host is awaiting human approval must not
        // consume the pending request, invalidate another code, or add strikes.
        if (pending) throw genericPairingError();
        const supplied = typeof code === "string" ? code.toUpperCase() : "";
        const matches = pairingCode !== null && supplied.length === pairingCode.length && /^[A-F\d]{64}$/i.test(supplied) && constantTimeHexEqual(sha256(supplied), sha256(pairingCode));
        const validShape = typeof name === "string" && name.trim().length > 0 && name.trim().length <= 100 &&
          typeof fingerprint === "string" && /^[a-f\d]{64}$/i.test(fingerprint);
        if (!matches || currentTime >= pairingExpiresAt || !validShape) {
          if (!matches || !validShape || currentTime >= pairingExpiresAt) {
            state = { ...state, failedAttempts: state.failedAttempts + 1 };
            if (state.failedAttempts >= maxFailedAttempts) {
              state = { ...state, failedAttempts: maxFailedAttempts, lockedUntil: currentTime + LOCKOUT_MS };
            }
            await store.save(state);
          }
          pairingCode = null;
          pairingExpiresAt = 0;
          throw genericPairingError();
        }
        pairingCode = null;
        pairingExpiresAt = 0;
        const existing = state.clients.find((client) => client.fingerprint === fingerprint.toLowerCase() && client.revokedAt === null && client.expiresAt > currentTime);
        pending = {
          requestId: makeRequestId(), name: name.trim(), fingerprint: fingerprint.toLowerCase(),
          expiresAt: currentTime + 2 * 60_000,
          ...(existing ? { replacesName: existing.name } : {}),
        };
        return { ...pending };
      });
    },
    cancelPairing(requestId) {
      return serialize(async () => {
        if (!pending || pending.requestId !== requestId) return false;
        pending = null;
        return true;
      });
    },
    resolvePairing(requestId, approved) {
      return serialize(async () => {
        if (!pending || pending.requestId !== requestId || pending.expiresAt <= now()) {
          if (pending?.requestId === requestId) pending = null;
          throw genericPairingError();
        }
        const request = pending;
        pending = null;
        if (!approved) return null;
        const clientIdentity = makeIdentity();
        const capability = makeCapability();
        if (!/^[A-F\d]{64}$/i.test(capability) || state.clients.some((client) => client.clientIdentity === clientIdentity)) {
          throw new Error("Could not create a unique MCP client credential.");
        }
        const expiresAt = now() + CREDENTIAL_TTL_MS;
        state = {
          ...state,
          failedAttempts: 0,
          lockedUntil: 0,
          clients: [...state.clients.map((client) => client.fingerprint === request.fingerprint && client.revokedAt === null ? { ...client, revokedAt: now() } : client), {
            clientIdentity,
            name: request.name,
            fingerprint: request.fingerprint,
            secretHash: sha256(capability),
            createdAt: now(),
            expiresAt,
            revokedAt: null,
          }],
        };
        await store.save(state);
        return { clientIdentity, capability, expiresAt };
      });
    },
    authenticate(clientIdentity, capability) {
      const identity = typeof clientIdentity === "string" ? clientIdentity : "";
      const supplied = typeof capability === "string" ? capability : "";
      const client = state.clients.find((entry) => entry.clientIdentity === identity);
      const isActive = Boolean(client && client.revokedAt === null && client.expiresAt > now());
      const expectedHash = isActive ? client!.secretHash : "0".repeat(64);
      const matches = constantTimeHexEqual(expectedHash, sha256(supplied));
      return isActive && matches;
    },
    list() {
      return state.clients.map(({ secretHash: _secretHash, ...client }) => ({ ...client }));
    },
    revoke(clientIdentity) {
      return serialize(async () => {
        const index = state.clients.findIndex((client) => client.clientIdentity === clientIdentity && client.revokedAt === null);
        if (index < 0) return false;
        const clients = state.clients.slice();
        clients[index] = { ...clients[index], revokedAt: now() };
        state = { ...state, clients };
        await store.save(state);
        return true;
      });
    },
  };
}
