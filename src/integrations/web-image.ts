import { MAX_IMAGE_BYTES, validateEmbeddedImage } from "./openverse";

export function googleImagesSearchUrl(query: string): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("udm", "2");
  url.searchParams.set("q", query.trim());
  return url.href;
}

/** Fetch in the owner's browser, never through Draw's privileged local server. */
export async function fetchWebImage(value: string, options: { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048
    || !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) {
    throw new Error("Use a public HTTPS image URL, without a username or password.");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Image download timed out. Try again.")), options.timeoutMs ?? 15_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (options.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(url.href, { mode: "cors", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
    } catch (error) {
      controller.signal.throwIfAborted();
      throw new Error("This site blocks direct image import. Download the image and choose From your device instead.", { cause: error });
    }
    if (!response.ok) throw new Error(`Image download failed (HTTP ${response.status}).`);
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 2 MiB size limit.");
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^image\/(png|jpe?g)(?:;|$)/i.test(contentType)) throw new Error("Use a direct PNG or JPEG image URL, not a search result or webpage.");
    if (!response.body) throw new Error("The image response is empty.");
    reader = response.body.getReader();
    const cancel = () => { void reader?.cancel().catch(() => undefined); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        controller.signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 2 MiB size limit.");
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { ...await validateEmbeddedImage(bytes, contentType), sourceUrl: url.href };
    } finally {
      controller.signal.removeEventListener("abort", cancel);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (reader) { try { await reader.cancel(); } catch { /* Preserve the original download error. */ } }
  }
}
