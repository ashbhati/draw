import { describe, expect, it, vi } from "vitest";
import { acquireWriterLock } from "./writer-lock";

describe("single-writer tab lock", () => {
  it("holds an exclusive lock until the owner releases it", async () => {
    let releaseBrowserLock!: () => void;
    const browserLock = new Promise<void>((resolve) => { releaseBrowserLock = resolve; });
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => {
      await callback({ name: "draw-local-writer" });
    });
    const acquired = await acquireWriterLock({ request } as unknown as LockManager);

    expect(acquired).toMatchObject({ acquired: true, supported: true });
    expect(request).toHaveBeenCalledOnce();
    acquired.release();
    releaseBrowserLock();
  });

  it("reports an existing owner without taking the lock", async () => {
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: null) => Promise<void>) => callback(null));

    const result = await acquireWriterLock({ request } as unknown as LockManager);

    expect(result).toMatchObject({ acquired: false, supported: true });
    result.release();
  });

  it("fails closed when Web Locks are unavailable", async () => {
    const result = await acquireWriterLock(null);

    expect(result).toMatchObject({ acquired: false, supported: false });
  });
});
