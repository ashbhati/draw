export type DrawImageAttribution = {
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
  verification: "openverse-index" | "unverified";
};

const IMAGE_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const LICENSES = new Set(["cc0", "pdm", "by", "by-sa", "by-nd", "by-nc", "by-nc-sa", "by-nc-nd"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) return undefined;
  return value.trim();
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function isSafeHttpsUrl(value: unknown): value is string {
  return httpsUrl(value) !== undefined;
}

/** Rebuild a minimal, safe attribution record. File-provided verification claims are never trusted. */
export function normalizeImageAttribution(
  value: unknown,
  verification: DrawImageAttribution["verification"] = "unverified",
  requireLicense = true,
): DrawImageAttribution | null {
  if (!isRecord(value) || value.provider !== "Openverse" || typeof value.providerId !== "string" || !IMAGE_ID.test(value.providerId)) return null;
  const title = text(value.title, 500);
  const capturedAt = text(value.capturedAt, 40);
  if (!title || !capturedAt || !/^\d{4}-\d\d-\d\dT/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt))) return null;
  const license = text(value.license, 50)?.toLowerCase();
  if ((license && !LICENSES.has(license)) || (requireLicense && !license)) return null;
  const creator = text(value.creator, 500);
  const creatorUrl = httpsUrl(value.creatorUrl);
  const sourceUrl = httpsUrl(value.sourceUrl);
  const licenseVersion = text(value.licenseVersion, 40);
  const licenseUrl = httpsUrl(value.licenseUrl);
  const attribution = text(value.attribution, 1000);
  const source = text(value.source, 500);
  return {
    provider: "Openverse", providerId: value.providerId, title, capturedAt, verification,
    ...(creator ? { creator } : {}), ...(creatorUrl ? { creatorUrl } : {}), ...(sourceUrl ? { sourceUrl } : {}),
    ...(license ? { license } : {}), ...(licenseVersion ? { licenseVersion } : {}), ...(licenseUrl ? { licenseUrl } : {}),
    ...(attribution ? { attribution } : {}), ...(source ? { source } : {}),
  };
}

/** Remove malformed claims and synchronize valid claims between the image and its embedded asset. */
export function normalizeDrawImageAttributions(document: any, verification: DrawImageAttribution["verification"] | "trusted-storage" = "unverified"): void {
  const assets = document?.document?.assets;
  const elements = document?.document?.elements;
  if (!assets || typeof assets !== "object" || !Array.isArray(elements)) return;
  for (const element of elements) {
    if (!element || element.type !== "image" || typeof element.fileId !== "string") continue;
    const asset = assets[element.fileId];
    const customData = isRecord(element.customData) ? { ...element.customData } : undefined;
    const source = customData?.drawAttribution ?? asset?.attribution;
    const itemVerification = verification === "trusted-storage"
      ? isRecord(source) && source.verification === "openverse-index" ? "openverse-index" : "unverified"
      : verification === "openverse-index" && isRecord(source) && source.verification === "unverified"
        ? "unverified"
        : verification;
    const normalized = normalizeImageAttribution(source, itemVerification);
    if (!normalized) {
      if (customData) {
        delete customData.drawAttribution;
        if (Object.keys(customData).length) element.customData = customData;
        else delete element.customData;
      }
      if (asset && "attribution" in asset) {
        const { attribution: _attribution, ...safeAsset } = asset;
        assets[element.fileId] = safeAsset;
      }
      continue;
    }
    element.customData = { ...(customData ?? {}), drawAttribution: normalized };
    if (asset) assets[element.fileId] = { ...asset, attribution: normalized };
  }
}
