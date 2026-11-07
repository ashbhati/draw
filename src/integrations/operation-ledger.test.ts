import { describe, expect, it } from "vitest";
import { canUndoMcpOperation, compactOperationLedger, OPERATION_RESULT_RETENTION_MS, OPERATION_TOMBSTONE_RETENTION_MS, resolveOperationReplay, type DurableMcpOperation } from "./operation-ledger";

const operation: DurableMcpOperation = {
  documentId: "doc-1",
  clientIdentity: "client-a",
  idempotencyKey: "key-1",
  payloadHash: "hash-a",
  operationId: "op-1",
  actor: "client-a",
  baseRevision: 4,
  resultingRevision: 5,
  result: { addedElementIds: ["shape-1"] },
  beforeDocument: {} as DurableMcpOperation["beforeDocument"],
  afterDocument: {} as DurableMcpOperation["afterDocument"],
  undoEligible: true,
  completedAt: 100,
};

describe("durable MCP operation ledger", () => {
  it("replays the original result only for the same actor, key, and payload", () => {
    expect(resolveOperationReplay(operation, { clientIdentity: "client-a", idempotencyKey: "key-1", payloadHash: "hash-a", now: 101 })).toEqual({ kind: "replay", operationId: "op-1", result: operation.result });
    expect(resolveOperationReplay(operation, { clientIdentity: "client-a", idempotencyKey: "key-1", payloadHash: "hash-b", now: 101 })).toEqual({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSE" });
  });

  it("does not reveal or replay an operation to a revoked or different identity", () => {
    expect(resolveOperationReplay(operation, { clientIdentity: "client-b", idempotencyKey: "key-1", payloadHash: "hash-a", now: 101 })).toEqual({ kind: "miss" });
    expect(resolveOperationReplay(operation, { clientIdentity: "client-a", idempotencyKey: "key-1", payloadHash: "hash-a", now: 101, revoked: true })).toEqual({ kind: "miss" });
  });

  it("reports an expired result as unknown instead of reapplying it", () => {
    expect(resolveOperationReplay(operation, { clientIdentity: "client-a", idempotencyKey: "key-1", payloadHash: "hash-a", now: 100 + 7 * 24 * 60 * 60 * 1000 + 1 })).toEqual({ kind: "unknown", reason: "idempotency_expired" });
  });

  it("compacts expired results to bounded tombstones and later evicts the oldest tombstones", () => {
    const expired = { ...operation, completedAt: 1 };
    const first = compactOperationLedger([["one", expired]], OPERATION_RESULT_RETENTION_MS + 2);
    expect(first).toHaveLength(1);
    expect(first[0][1]).toMatchObject({ tombstone: true, payloadHash: "hash-a" });
    expect(resolveOperationReplay(first[0][1], { clientIdentity: "client-a", idempotencyKey: "key-1", payloadHash: "hash-a", now: OPERATION_RESULT_RETENTION_MS + 2 })).toEqual({ kind: "unknown", reason: "idempotency_expired" });
    expect(compactOperationLedger(first, OPERATION_RESULT_RETENTION_MS + OPERATION_TOMBSTONE_RETENTION_MS + 2)).toHaveLength(0);

    const tooMany = Array.from({ length: 10_001 }, (_, index) => [String(index), {
      ...first[0][1], idempotencyKey: `key-${index}`, expiredAt: index,
    } as const] as [IDBValidKey, typeof first[number][1]]);
    const bounded = compactOperationLedger(tooMany, 20_000);
    expect(bounded).toHaveLength(10_000);
    expect(bounded.some(([key]) => key === "0")).toBe(false);
  });

  it("allows undo only for the same actor at the exact resulting document revision", () => {
    expect(canUndoMcpOperation(operation, "client-a", { id: "doc-1", documentRevision: 5 })).toBe(true);
    expect(canUndoMcpOperation(operation, "client-b", { id: "doc-1", documentRevision: 5 })).toBe(false);
    expect(canUndoMcpOperation(operation, "client-a", { id: "doc-1", documentRevision: 6 })).toBe(false);
    expect(canUndoMcpOperation(operation, "client-a", { id: "another-doc", documentRevision: 5 })).toBe(false);
  });
});
