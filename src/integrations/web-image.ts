import { MAX_IMAGE_BYTES, validateEmbeddedImage } from "./openverse";

export function googleImagesSearchUrl(query: string): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("udm", "2");
  url.searchParams.set("q", query.trim());
  return url.href;
}

const GOOGLE_IMAGES_SEARCH_HINT = "That is a Google Images results page, not an image file. In the search tab, right-click the image and choose Copy image, return to Draw, then choose Paste copied image.";

export function isGoogleImagesSearchUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const isGoogle = host === "google.com" || host.endsWith(".google.com") || /(?:^|\.)google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host);
    return isGoogle && (url.pathname === "/imgres" || (url.pathname === "/search" && (url.searchParams.get("udm") === "2" || url.searchParams.get("tbm") === "isch")));
  } catch {
    return false;
  }
}

export async function validateClipboardImage(blob: Blob) {
  const mimeType = blob.type.split(";")[0]?.trim().toLowerCase();
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error("The clipboard does not contain a PNG or JPEG image. In Google Images, right-click the image and choose Copy image.");
  if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) throw new Error("Copied image must be between 1 byte and 2 MiB.");
  return validateEmbeddedImage(new Uint8Array(await blob.arrayBuffer()), mimeType);
}

export async function readClipboardImage(readClipboard: () => Promise<ClipboardItems> = () => navigator.clipboard.read()) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
    throw new Error("This browser cannot read copied images here. Download the image and choose From your device instead.");
  }
  let items: ClipboardItems;
  try {
    items = await readClipboard();
  } catch {
    throw new Error("Could not read the clipboard. Click Paste copied image and allow clipboard access, or download the image and choose From your device.");
  }
  for (const item of items) {
    const mimeType = ["image/png", "image/jpeg"].find((type) => item.types.includes(type));
    if (mimeType) return validateClipboardImage(await item.getType(mimeType));
  }
  throw new Error("No PNG or JPEG image was found in the clipboard. In Google Images, right-click the image and choose Copy image.");
}

/** Fetch in the owner's browser, never through Draw's privileged local server. */
export async function fetchWebImage(value: string, options: { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const url = new URL(value.trim());
  if (isGoogleImagesSearchUrl(url.href)) throw new Error(GOOGLE_IMAGES_SEARCH_HINT);
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
