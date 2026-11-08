import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebouncedSaver } from "./autosave";

describe("debounced autosave", () => {
  afterEach(() => vi.useRealTimers());

  it("persists the latest value after the debounce window", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => undefined);
    const autosave = createDebouncedSaver(save, 350);

    autosave.schedule("first");
    autosave.schedule("latest");
    await vi.advanceTimersByTimeAsync(349);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledExactlyOnceWith("latest");
  });

  it("flushes a pending value immediately for a lifecycle event", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => undefined);
    const autosave = createDebouncedSaver(save, 350);
    autosave.schedule("last edit");

    await autosave.flush();

    expect(save).toHaveBeenCalledExactlyOnceWith("last edit");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a pending value when its owning canvas is abandoned", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => undefined);
    const autosave = createDebouncedSaver(save, 350);
    autosave.schedule("deleted canvas scene");
    autosave.cancelPending();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
    expect(autosave.isBusy()).toBe(false);
  });

  it("does not overlap saves and flushes changes queued during a save", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const save = vi.fn(async (value: string) => {
      if (value === "first") await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const autosave = createDebouncedSaver(save, 350);
    autosave.schedule("first");
    const firstFlush = autosave.flush();
    await Promise.resolve();
    autosave.schedule("second");
    const secondFlush = autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([firstFlush, secondFlush]);

    expect(save.mock.calls.map(([value]) => value)).toEqual(["first", "second"]);
  });
});
