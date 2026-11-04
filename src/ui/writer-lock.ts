const DRAW_WRITER_LOCK_NAME = "draw-local-writer-v1";

export type WriterLock = {
  acquired: boolean;
  supported: boolean;
  release: () => void;
};

/** Keep one tab as the only editor/autosave writer for this browser profile. */
export function acquireWriterLock(
  lockManager: LockManager | null = typeof navigator !== "undefined" ? navigator.locks : null,
): Promise<WriterLock> {
  if (!lockManager) {
    return Promise.resolve({ acquired: false, supported: false, release: () => undefined });
  }

  return new Promise<WriterLock>((resolve, reject) => {
    let settled = false;
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((release) => { releaseLock = release; });
    const request = lockManager.request(
      DRAW_WRITER_LOCK_NAME,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          settled = true;
          resolve({ acquired: false, supported: true, release: () => undefined });
          return;
        }
        settled = true;
        resolve({ acquired: true, supported: true, release: releaseLock });
        await holdLock;
      },
    );
    void request.catch((error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
