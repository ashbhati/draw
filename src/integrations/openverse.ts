export const OPENVERSE_API = "https://api.openverse.org/v1";
export const MAX_OPENVERSE_RESULTS = 24;
// This keeps the base64 MCP command well below the bridge's 4 MiB envelope cap.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;

export interface OpenverseAttribution {
  provider: "Openverse";
  providerId: string;
  title: string;
  creator?: string;
  creatorUrl?: string;
  sourceUrl?: string;
  license?: string;
  licenseVersion?: string;
  licenseUrl?: string;
  attribution?: string;
  source?: string;
  capturedAt: string;
}

export interface OpenverseImageResult extends OpenverseAttribution {
  id: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  fileType?: string;
}

export interface EmbeddedOpenverseImage {
  dataURL: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  attribution: OpenverseAttribution;
}

const IMAGE_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const ALLOWED_LICENSES = new Set(["cc0", "pdm", "by", "by-sa", "by-nd", "by-nc", "by-nc-sa", "by-nc-nd"]);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

function normalizeResult(raw: unknown): OpenverseImageResult | null {
  if (!record(raw) || typeof raw.id !== "string" || !IMAGE_ID.test(raw.id)) return null;
  const license = optionalText(raw.license)?.toLowerCase();
  if (license && !ALLOWED_LICENSES.has(license)) return null;
  const thumbnailUrl = `${OPENVERSE_API}/images/${raw.id}/thumb/`;
  const width = Number.isSafeInteger(raw.width) && Number(raw.width) > 0 ? Number(raw.width) : undefined;
  const height = Number.isSafeInteger(raw.height) && Number(raw.height) > 0 ? Number(raw.height) : undefined;
  return {
    provider: "Openverse",
    providerId: raw.id,
    id: raw.id,
    title: optionalText(raw.title) ?? "Untitled image",
    ...(optionalText(raw.creator) ? { creator: optionalText(raw.creator) } : {}),
    ...(safeHttpUrl(raw.creator_url) ? { creatorUrl: safeHttpUrl(raw.creator_url) } : {}),
    ...(safeHttpUrl(raw.foreign_landing_url) ? { sourceUrl: safeHttpUrl(raw.foreign_landing_url) } : {}),
    ...(license ? { license } : {}),
    ...(optionalText(raw.license_version) ? { licenseVersion: optionalText(raw.license_version) } : {}),
    ...(safeHttpUrl(raw.license_url) ? { licenseUrl: safeHttpUrl(raw.license_url) } : {}),
    ...(optionalText(raw.attribution) ? { attribution: optionalText(raw.attribution) } : {}),
    ...(optionalText(raw.source) ? { source: optionalText(raw.source) } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(optionalText(raw.filetype) ? { fileType: optionalText(raw.filetype) } : {}),
    thumbnailUrl,
    capturedAt: new Date().toISOString(),
  };
}

export async function getOpenverseImageMetadata(id: string, fetcher: typeof fetch = fetch): Promise<OpenverseImageResult> {
  if (!IMAGE_ID.test(id)) throw new Error("A valid Openverse image identifier is required.");
  const response = await fetcher(`${OPENVERSE_API}/images/${id}/`, { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw apiError(response);
  const metadata = normalizeResult(await response.json());
  if (!metadata || metadata.providerId !== id) throw new Error("Openverse returned incomplete or invalid attribution metadata for this image.");
  return metadata;
}

function apiError(response: Response): Error {
  if (response.status === 429) return new Error("Openverse rate limit reached. Wait a moment before searching again.");
  if (response.status >= 500) return new Error("Openverse is temporarily unavailable. Try again later.");
  return new Error(`Openverse request failed (HTTP ${response.status}).`);
}

export async function searchOpenverseImages(
  query: string,
  options: { license?: string; category?: "illustration" | "photograph" | "digitized_artwork"; page?: number; fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<OpenverseImageResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || normalizedQuery.length > 200) throw new Error("Search query must contain 1 to 200 characters.");
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 20) throw new Error("Search page must be between 1 and 20.");
  if (options.license && !ALLOWED_LICENSES.has(options.license)) throw new Error("Choose a supported Creative Commons license filter.");
  if (options.category && !["illustration", "photograph", "digitized_artwork"].includes(options.category)) throw new Error("Choose a supported image category filter.");
  const url = new URL(`${OPENVERSE_API}/images/`);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(Math.min(12, MAX_OPENVERSE_RESULTS)));
  url.searchParams.set("filter_dead", "true");
  url.searchParams.set("mature", "false");
  if (options.license) url.searchParams.set("license", options.license);
  if (options.category) url.searchParams.set("category", options.category);
  const response = await (options.fetcher ?? fetch)(url, { headers: { accept: "application/json" }, signal: options.signal });
  if (!response.ok) throw apiError(response);
  const body: unknown = await response.json();
  if (!record(body) || !Array.isArray(body.results)) throw new Error("Openverse returned an invalid response.");
  return body.results.slice(0, MAX_OPENVERSE_RESULTS).map(normalizeResult).filter((value): value is OpenverseImageResult => value !== null);
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || String.fromCharCode(...bytes.slice(1, 4)) !== "PNG" || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    const size = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (size < 2 || offset + size > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!, width: (bytes[offset + 5]! << 8) | bytes[offset + 6]! };
    }
    offset += size;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64");
}

export async function validateEmbeddedImage(bytes: Uint8Array, contentType: string): Promise<{ mimeType: "image/png" | "image/jpeg"; width: number; height: number; dataURL: string }> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 2 MiB size limit or is empty.");
  const normalizedType = contentType.split(";")[0]?.trim().toLowerCase();
  const png = normalizedType === "image/png" ? readPngDimensions(bytes) : null;
  const jpeg = normalizedType === "image/jpeg" || normalizedType === "image/jpg" ? readJpegDimensions(bytes) : null;
  if (normalizedType !== "image/png" && normalizedType !== "image/jpeg" && normalizedType !== "image/jpg") throw new Error("Unsupported image format. Use PNG or JPEG; SVG and animated formats are not accepted.");
  if (!png && !jpeg) throw new Error("Image bytes do not match the declared PNG or JPEG format.");
  const dimensions = png ?? jpeg!;
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw new Error("Image exceeds the 40-megapixel dimension limit.");
  const mimeType = png ? "image/png" : "image/jpeg";
  return { mimeType, ...dimensions, dataURL: `data:${mimeType};base64,${bytesToBase64(bytes)}` };
}

export async function fetchOpenverseImage(
  id: string,
  attribution: OpenverseAttribution,
  fetcher: typeof fetch = fetch,
): Promise<EmbeddedOpenverseImage> {
  if (!IMAGE_ID.test(id) || attribution.providerId !== id) throw new Error("A valid Openverse image identifier is required.");
  const url = `${OPENVERSE_API}/images/${id}/thumb/?full_size=true`;
  const response = await fetcher(url, { headers: { accept: "image/png,image/jpeg" }, redirect: "error" });
  if (!response.ok) throw apiError(response);
  const finalUrl = response.url ? new URL(response.url) : new URL(url);
  if (finalUrl.origin !== new URL(OPENVERSE_API).origin) throw new Error("Openverse image redirect was rejected.");
  const mimeType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 2 MiB size limit.");
  if (!response.body) throw new Error("Openverse returned an empty image response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("Image exceeds the 2 MiB size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const validated = await validateEmbeddedImage(bytes, mimeType);
  return { ...validated, attribution };
}

export function imageAttributionFromOpenverseResult(result: OpenverseImageResult): OpenverseAttribution {
  const { id: _id, thumbnailUrl: _thumbnailUrl, width: _width, height: _height, fileType: _fileType, ...attribution } = result;
  return attribution;
}
