import type { DrawDocument } from "../document/document";

export const OPERATION_RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const OPERATION_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const OPERATION_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_OPERATION_TOMBSTONES_PER_CLIENT = 10_000;

export type DurableMcpOperation = {
  documentId: string;
  clientIdentity: string;
  idempotencyKey: string;
  payloadHash: string;
  operationId: string;
  actor: string;
  baseRevision: number;
  resultingRevision: number;
  /** View CAS fields are optional only for pre-#38 operation records. */
  baseViewRevision?: number;
  resultingViewRevision?: number;
  result: Record<string, unknown>;
  beforeDocument: DrawDocument;
  afterDocument: DrawDocument;
  undoEligible: boolean;
  completedAt: number;
};

export type DurableMcpTombstone = Pick<DurableMcpOperation, "documentId" | "clientIdentity" | "idempotencyKey" | "payloadHash" | "operationId" | "completedAt"> & {
  expiredAt: number;
  tombstone: true;
};

export type DurableMcpOperationResult = Omit<DurableMcpOperation, "beforeDocument" | "afterDocument" | "undoEligible">;
export type OperationLedgerEntry = DurableMcpOperationResult | DurableMcpTombstone;
export type DurableMcpRedo = { operation: DurableMcpOperation; undoneRevision: number };

export type ReplayResolution =
  | { kind: "miss" }
  | { kind: "replay"; operationId: string; result: Record<string, unknown> }
  | { kind: "conflict"; code: "IDEMPOTENCY_KEY_REUSE" }
  | { kind: "unknown"; reason: "idempotency_expired" };

export function operationLedgerKey(documentId: string, clientIdentity: string, idempotencyKey: string): string {
  return JSON.stringify([documentId, clientIdentity, idempotencyKey]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export async function hashMcpOperation(operation: string, input: Record<string, unknown>): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure operation hashing is unavailable in this browser.");
  const { idempotencyKey: _idempotencyKey, idempotencyPayload, ...payload } = input;
  const stablePayload = operation === "insert_image" && idempotencyPayload && typeof idempotencyPayload === "object" && !Array.isArray(idempotencyPayload)
    ? idempotencyPayload
    : payload;
  const bytes = new TextEncoder().encode(canonicalJson({ operation, input: stablePayload }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function resolveOperationReplay(
  entry: OperationLedgerEntry | null,
  query: { clientIdentity: string; idempotencyKey: string; payloadHash: string; now: number; revoked?: boolean },
): ReplayResolution {
  if (!entry || query.revoked || entry.clientIdentity !== query.clientIdentity || entry.idempotencyKey !== query.idempotencyKey) return { kind: "miss" };
  if (entry.payloadHash !== query.payloadHash) return { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSE" };
  if ("tombstone" in entry || query.now - entry.completedAt >= OPERATION_RESULT_RETENTION_MS) return { kind: "unknown", reason: "idempotency_expired" };
  return { kind: "replay", operationId: entry.operationId, result: entry.result };
}

export function canUndoMcpOperation(
  operation: DurableMcpOperation | null,
  clientIdentity: string,
  currentDocument: { id: string; documentRevision: number },
  now = Date.now(),
): boolean {
  return Boolean(operation
    && operation.undoEligible
    && now - operation.completedAt < OPERATION_SNAPSHOT_RETENTION_MS
    && operation.actor === clientIdentity
    && operation.clientIdentity === clientIdentity
    && operation.documentId === currentDocument.id
    && operation.resultingRevision === currentDocument.documentRevision);
}

export function canRedoMcpOperation(
  redo: DurableMcpRedo | null,
  clientIdentity: string,
  currentDocument: { id: string; documentRevision: number },
  now = Date.now(),
): boolean {
  return Boolean(redo
    && now - redo.operation.completedAt < OPERATION_SNAPSHOT_RETENTION_MS
    && redo.operation.actor === clientIdentity
    && redo.operation.clientIdentity === clientIdentity
    && redo.operation.documentId === currentDocument.id
    && redo.undoneRevision === currentDocument.documentRevision);
}

export function sameSceneSnapshot(left: DrawDocument | null | undefined, right: DrawDocument | null | undefined): boolean {
  if (!left || !right) return false;
  const scene = (value: DrawDocument) => ({
    id: value.document.id,
    title: value.document.title,
    background: value.document.canvas.background,
    elements: value.document.elements.map((element) => {
      const { version: _version, versionNonce: _nonce, updated: _updated, index: _index, ...semantic } = element as typeof element & Record<string, unknown>;
      if (semantic.boundElements == null) semantic.boundElements = [];
      return semantic;
    }),
    assets: value.document.assets,
  });
  return canonicalJson(scene(left)) === canonicalJson(scene(right));
}

export function compactOperationLedger(
  entries: Array<[IDBValidKey, OperationLedgerEntry]>,
  now: number,
): Array<[IDBValidKey, OperationLedgerEntry]> {
  const compacted: Array<[IDBValidKey, OperationLedgerEntry]> = [];
  for (const [key, value] of entries) {
    if ("tombstone" in value) {
      if (now < value.expiredAt + OPERATION_TOMBSTONE_RETENTION_MS) compacted.push([key, value]);
      continue;
    }
    if (now - value.completedAt < OPERATION_RESULT_RETENTION_MS) {
      compacted.push([key, value]);
      continue;
    }
    const tombstone: DurableMcpTombstone = {
      documentId: value.documentId,
      clientIdentity: value.clientIdentity,
      idempotencyKey: value.idempotencyKey,
      payloadHash: value.payloadHash,
      operationId: value.operationId,
      completedAt: value.completedAt,
      expiredAt: value.completedAt + OPERATION_RESULT_RETENTION_MS,
      tombstone: true,
    };
    if (now < tombstone.expiredAt + OPERATION_TOMBSTONE_RETENTION_MS) compacted.push([key, tombstone]);
  }
  const groups = new Map<string, Array<[IDBValidKey, DurableMcpTombstone]>>();
  for (const entry of compacted) {
    if (!("tombstone" in entry[1])) continue;
    const group = `${entry[1].documentId}\u0000${entry[1].clientIdentity}`;
    groups.set(group, [...groups.get(group) ?? [], entry as [IDBValidKey, DurableMcpTombstone]]);
  }
  const expiredKeys = new Set<IDBValidKey>();
  for (const group of groups.values()) {
    group.sort((left, right) => left[1].expiredAt - right[1].expiredAt);
    for (const [key] of group.slice(0, Math.max(0, group.length - MAX_OPERATION_TOMBSTONES_PER_CLIENT))) expiredKeys.add(key);
  }
  return compacted.filter(([key]) => !expiredKeys.has(key));
}
