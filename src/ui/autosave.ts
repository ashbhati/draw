const NO_PENDING_VALUE = Symbol("no pending autosave value");

/** Coalesce rapid edits while retaining an explicit lifecycle flush path. */
export function createDebouncedSaver<T>(
  save: (value: T) => Promise<void> | void,
  delayMs = 350,
  onError?: (error: unknown) => void,
) {
  let pending: T | typeof NO_PENDING_VALUE = NO_PENDING_VALUE;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (inFlight) await inFlight;
    if (pending === NO_PENDING_VALUE) return;

    const value = pending;
    pending = NO_PENDING_VALUE;
    const currentSave = Promise.resolve().then(() => save(value));
    inFlight = currentSave;
    try {
      await currentSave;
    } finally {
      if (inFlight === currentSave) inFlight = null;
    }

    if (pending !== NO_PENDING_VALUE) await flush();
  };

  const schedule = (value: T): void => {
    pending = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch((error: unknown) => onError?.(error));
    }, delayMs);
  };

  const cancelPending = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = NO_PENDING_VALUE;
  };

  return {
    schedule,
    flush,
    cancelPending,
    isBusy: () => timer !== null || inFlight !== null || pending !== NO_PENDING_VALUE,
  };
}
