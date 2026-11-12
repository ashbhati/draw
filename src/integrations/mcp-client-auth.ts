import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";

const PAIRING_REQUEST_TTL_MS = 2 * 60_000;
const PAIRING_REQUEST_THROTTLE_MS = 5_000;
const LEGACY_CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60_000;

export type PairedMcpClient = {
  clientIdentity: string;
  name: string;
  fingerprint: string;
  secretHash: string;
  createdAt: number;
  expiresAt?: number;
  persistentAccess?: true;
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

export type PairedMcpCredential = { clientIdentity: string; capability: string; expiresAt?: number };
export type McpPairingResolution = { credential: PairedMcpCredential; replacedClientIdentity?: string };

export type McpClientAuthManager = {
  beginPairing: (name: unknown, fingerprint: unknown) => Promise<McpPairingRequest>;
  cancelPairing: (requestId: string) => Promise<boolean>;
  resolvePairing: (requestId: string, approved: boolean) => Promise<McpPairingResolution | null>;
  authenticate: (clientIdentity: unknown, capability: unknown) => boolean;
  list: () => Array<Omit<PairedMcpClient, "secretHash">>;
  revoke: (clientIdentity: string) => Promise<boolean>;
};

export type McpClientAuthOptions = {
  now?: () => number;
  generateIdentity?: () => string;
  generateCapability?: () => string;
  generateRequestId?: () => string;
  pairingRequestTtlMs?: number;
  pairingRequestThrottleMs?: number;
  store?: McpClientAuthStore;
};

export class McpPairingRateLimitError extends Error {
  constructor() {
    super("Please wait a few seconds before requesting another MCP approval.");
    this.name = "McpPairingRateLimitError";
  }
}

export class McpPairingPendingError extends Error {
  constructor() {
    super("An MCP approval is already pending. Approve or deny it in Draw before requesting another.");
    this.name = "McpPairingPendingError";
  }
}

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
      (client.expiresAt !== undefined && !Number.isFinite(client.expiresAt)) ||
      (client.persistentAccess !== undefined && client.persistentAccess !== true) ||
      (client.revokedAt !== null && !Number.isFinite(client.revokedAt))) {
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

function activeClient(client: PairedMcpClient | undefined, currentTime: number): client is PairedMcpClient {
  return Boolean(client && client.revokedAt === null && (client.persistentAccess === true || client.expiresAt === undefined || client.expiresAt > currentTime));
}

function genericPairingError(): Error {
  return new Error("Pairing is unavailable. Check that Draw is open and try again.");
}

export async function createMcpClientAuthManager(options: McpClientAuthOptions = {}): Promise<McpClientAuthManager> {
  const now = options.now ?? Date.now;
  const makeIdentity = options.generateIdentity ?? (() => randomBytes(16).toString("hex"));
  const makeCapability = options.generateCapability ?? (() => randomBytes(32).toString("hex"));
  const makeRequestId = options.generateRequestId ?? (() => randomBytes(16).toString("hex"));
  const pairingRequestTtl = options.pairingRequestTtlMs ?? PAIRING_REQUEST_TTL_MS;
  const pairingRequestThrottle = options.pairingRequestThrottleMs ?? PAIRING_REQUEST_THROTTLE_MS;
  const store = options.store ?? createFileMcpClientAuthStore();
  const loadedState = normalizeState(await store.load());
  const currentTime = now();
  let migratedPersistentAccess = false;
  let state: McpClientAuthState = {
    failedAttempts: 0,
    lockedUntil: 0,
    clients: loadedState.clients.map((client) => {
      const needsLegacyExpiry = client.expiresAt === undefined;
      const needsPersistentMarker = client.revokedAt === null && client.persistentAccess !== true &&
        (client.expiresAt === undefined || client.expiresAt > currentTime);
      if (needsLegacyExpiry || needsPersistentMarker) {
        migratedPersistentAccess = true;
        return {
          ...client,
          // Keep a finite expiry for compatibility with older Draw releases.
          // Current releases honor persistentAccess and ignore this fallback.
          ...(needsLegacyExpiry ? { expiresAt: currentTime + LEGACY_CREDENTIAL_TTL_MS } : {}),
          ...(needsPersistentMarker ? { persistentAccess: true as const } : {}),
        };
      }
      return client;
    }),
  };
  if (migratedPersistentAccess || loadedState.failedAttempts !== 0 || loadedState.lockedUntil !== 0) {
    try {
      await store.save(state);
    } catch (error) {
      console.warn(
        `Draw could not persist MCP client ${migratedPersistentAccess ? "migration" : "legacy authentication cleanup"}. The normalized state remains available in memory; check that the credential store is writable.`,
        error,
      );
    }
  }
  let pending: McpPairingRequest | null = null;
  let lastPairingDecisionAt: number | null = null;
  let queue = Promise.resolve();

  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    beginPairing(name, fingerprint) {
      return serialize(async () => {
        const currentTime = now();
        if (pending && pending.expiresAt <= currentTime) {
          pending = null;
          lastPairingDecisionAt = currentTime;
        }
        // A concurrent retry while a host is awaiting human approval must not
        // replace the pending request or trigger another confirmation dialog.
        if (pending) throw new McpPairingPendingError();
        const validShape = typeof name === "string" && name.trim().length > 0 && name.trim().length <= 100 &&
          typeof fingerprint === "string" && /^[a-f\d]{64}$/i.test(fingerprint);
        if (!validShape) throw genericPairingError();
        if (lastPairingDecisionAt !== null && currentTime - lastPairingDecisionAt < pairingRequestThrottle) {
          throw new McpPairingRateLimitError();
        }
        const existing = state.clients.find((client) => client.fingerprint === fingerprint.toLowerCase() && activeClient(client, currentTime));
        pending = {
          requestId: makeRequestId(), name: name.trim(), fingerprint: fingerprint.toLowerCase(),
          expiresAt: currentTime + pairingRequestTtl,
          ...(existing ? { replacesName: existing.name } : {}),
        };
        return { ...pending };
      });
    },
    cancelPairing(requestId) {
      return serialize(async () => {
        if (!pending || pending.requestId !== requestId) return false;
        pending = null;
        lastPairingDecisionAt = now();
        return true;
      });
    },
    resolvePairing(requestId, approved) {
      return serialize(async () => {
        if (!pending || pending.requestId !== requestId || pending.expiresAt <= now()) {
          if (pending?.requestId === requestId) {
            pending = null;
            lastPairingDecisionAt = now();
          }
          throw genericPairingError();
        }
        const request = pending;
        pending = null;
        const decisionTime = now();
        lastPairingDecisionAt = decisionTime;
        if (!approved) {
          return null;
        }
        const clientIdentity = makeIdentity();
        const capability = makeCapability();
        if (!/^[A-F\d]{64}$/i.test(capability) || state.clients.some((client) => client.clientIdentity === clientIdentity)) {
          throw new Error("Could not create a unique MCP client credential.");
        }
        const replacedClient = state.clients.find((client) => client.fingerprint === request.fingerprint && activeClient(client, now()));
        const nextState = {
          ...state,
          failedAttempts: 0,
          lockedUntil: 0,
          clients: [...state.clients.map((client) => client.fingerprint === request.fingerprint && activeClient(client, now()) ? { ...client, revokedAt: now() } : client), {
            clientIdentity,
            name: request.name,
            fingerprint: request.fingerprint,
            secretHash: sha256(capability),
            createdAt: decisionTime,
            expiresAt: decisionTime + LEGACY_CREDENTIAL_TTL_MS,
            persistentAccess: true as const,
            revokedAt: null,
          }],
        };
        await store.save(nextState);
        state = nextState;
        return {
          credential: { clientIdentity, capability },
          ...(replacedClient ? { replacedClientIdentity: replacedClient.clientIdentity } : {}),
        };
      });
    },
    authenticate(clientIdentity, capability) {
      const identity = typeof clientIdentity === "string" ? clientIdentity : "";
      const supplied = typeof capability === "string" ? capability : "";
      const client = state.clients.find((entry) => entry.clientIdentity === identity);
      const isActive = activeClient(client, now());
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
