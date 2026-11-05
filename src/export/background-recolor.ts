import type { DrawBackgroundPreset } from "../document/document";

const FOREGROUND: Record<DrawBackgroundPreset, string> = {
  blackboard: "#f6f2e9",
  white: "#1e1e1e",
};
const BACKGROUND: Record<DrawBackgroundPreset, string> = {
  blackboard: "#18191a",
  white: "#ffffff",
};

/** Adapt only Draw's default foreground/fill colors; preserve custom colors. */
export function recolorDefaultElements<T extends Record<string, unknown>>(
  elements: readonly T[],
  from: DrawBackgroundPreset,
  to: DrawBackgroundPreset,
): T[] {
  if (from === to) return elements.map((element) => ({ ...element }));
  return elements.map((element) => {
    const next = {
      ...element,
      ...(element.strokeColor === FOREGROUND[from] ? { strokeColor: FOREGROUND[to] } : {}),
      ...(element.backgroundColor === BACKGROUND[from] ? { backgroundColor: BACKGROUND[to] } : {}),
    };
    if (next.strokeColor === element.strokeColor && next.backgroundColor === element.backgroundColor) return next;
    return {
      ...next,
      version: (typeof element.version === "number" ? element.version : 0) + 1,
      versionNonce: (typeof element.versionNonce === "number" ? element.versionNonce : 0) + 1,
      updated: Date.now(),
    };
  });
}
