const DRAW_UNAVAILABLE_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET"]);

export function drawStartRequiredError(error: unknown, localIpc: boolean, endpoint?: string): Error | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !DRAW_UNAVAILABLE_CODES.has(code)) return null;
  const target = localIpc ? " over local IPC" : endpoint ? ` at ${endpoint}` : "";
  return new Error(`Cannot reach Draw${target}. Start Draw, then retry.`);
}
