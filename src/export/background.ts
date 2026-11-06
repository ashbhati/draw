import blackboardTexture from "../ui/blackboard-texture.svg?raw";

export type DrawExportMimeType = "image/png" | "image/jpeg";

export function selectExportElements<T extends { id: string; isDeleted?: boolean; containerId?: string | null }>(
  elements: readonly T[],
  selectedElementIds: Record<string, boolean> | undefined,
): T[] {
  const live = elements.filter((element) => element.isDeleted !== true);
  const selected = selectedElementIds
    ? live.filter((element) => selectedElementIds[element.id] === true)
    : [];
  if (!selected.length) return live;
  const selectedIds = new Set(selected.map((element) => element.id));
  return live.filter((element) => selectedIds.has(element.id) || (element.containerId != null && selectedIds.has(element.containerId)));
}

const BLACKBOARD_BG = `<image data-draw-background="blackboard" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" href="data:image/svg+xml,${encodeURIComponent(blackboardTexture)}" />`;

export function hasSelectedExportElements<T extends { id: string; isDeleted?: boolean }>(
  elements: readonly T[],
  selectedElementIds: Record<string, boolean> | undefined,
): boolean {
  return Boolean(selectedElementIds && elements.some(
    (element) => element.isDeleted !== true && selectedElementIds[element.id] === true,
  ));
}

function backgroundLayer(preset: "blackboard" | "white"): string {
  if (preset === "white") {
    return '<rect data-draw-background="white" x="0" y="0" width="100%" height="100%" fill="#ffffff" />';
  }
  return BLACKBOARD_BG;
}

/** Insert a persistent canvas background before any exported scene elements. */
export function composeBackgroundSvg(
  svg: string,
  preset: "blackboard" | "white",
): string {
  if (preset !== "blackboard" && preset !== "white") {
    throw new TypeError("Background preset must be blackboard or white.");
  }
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!openTag || !/<\/svg\s*>/i.test(svg)) {
    throw new TypeError("Expected a complete SVG document.");
  }
  return svg.replace(openTag, `${openTag}\n${backgroundLayer(preset)}`);
}

/** Render an SVG to a shareable PNG/JPEG. The result is flattened by design. */
export async function renderExportBlob(
  svg: string,
  mimeType: DrawExportMimeType,
  quality = 0.92,
): Promise<Blob> {
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new TypeError("Image export must be PNG or JPEG.");
  }
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RangeError("JPEG quality must be between 0 and 1.");
  }
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("PNG/JPEG export requires a browser canvas.");
  }

  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error("SVG export has no usable dimensions.");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create an image export canvas.");
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mimeType, mimeType === "image/jpeg" ? quality : undefined);
    });
    if (!blob) throw new Error(`Could not encode ${mimeType}.`);
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
