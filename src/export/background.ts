export type DrawExportMimeType = "image/png" | "image/jpeg";

export function selectExportElements<T extends { id: string; isDeleted?: boolean }>(
  elements: readonly T[],
  selectedElementIds: Record<string, boolean> | undefined,
): T[] {
  const live = elements.filter((element) => element.isDeleted !== true);
  const selected = selectedElementIds
    ? live.filter((element) => selectedElementIds[element.id] === true)
    : [];
  return selected.length ? selected : live;
}

const BLACKBOARD_BG = `
<defs>
  <filter id="draw-chalk-grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.024 0.03" numOctaves="4" seed="19" result="grain" />
    <feColorMatrix in="grain" type="saturate" values="0" result="mono" />
    <feComponentTransfer in="mono" result="soft-grain"><feFuncA type="table" tableValues="0 0.18" /></feComponentTransfer>
    <feBlend in="SourceGraphic" in2="soft-grain" mode="screen" />
  </filter>
  <filter id="draw-chalk-smudge" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="16" /></filter>
</defs>
<rect data-draw-background="blackboard" x="0" y="0" width="100%" height="100%" fill="#18191a" />
<rect x="0" y="0" width="100%" height="100%" fill="#18191a" filter="url(#draw-chalk-grain)" opacity=".9" />
<path d="M 0 20 C 25 8, 50 28, 100 12 M 10 52 C 42 43, 66 60, 96 46 M 5 86 C 35 72, 70 92, 98 80" pathLength="100" fill="none" stroke="#d2d0ca" stroke-width="4" stroke-linecap="round" opacity=".045" filter="url(#draw-chalk-smudge)" />
`;

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
