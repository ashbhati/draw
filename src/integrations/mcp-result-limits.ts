export const MAX_INLINE_ARTIFACT_BYTES = 1024 * 1024;

export function assertInlineArtifactSize(bytes: number, label: string): number {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`${label} has an invalid byte size.`);
  if (bytes > MAX_INLINE_ARTIFACT_BYTES) {
    throw new Error(`${label} exceeds the 1 MiB inline limit; provide a path to save or export it.`);
  }
  return bytes;
}

export function assertInlineBase64Size(base64: string, label: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return assertInlineArtifactSize(Math.floor((base64.length * 3) / 4) - padding, label);
}
