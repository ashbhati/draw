import type { DrawBackgroundPreset } from "../document/document";

const FOREGROUND: Record<DrawBackgroundPreset, string> = {
  blackboard: "#f6f2e9",
  white: "#1e1e1e",
};
const BACKGROUND: Record<DrawBackgroundPreset, string> = {
  blackboard: "#18191a",
  white: "#ffffff",
};
const ACCENTS: Record<DrawBackgroundPreset, Record<string, string>> = {
  blackboard: { "#f2d27a": "#8a6418" },
  white: { "#8a6418": "#f2d27a" },
};

/** Adapt Draw's defaults and its V1 yellow accent; preserve other custom colors. */
export function recolorForBackgroundPreset<T extends Record<string, unknown>>(
  elements: readonly T[],
  from: DrawBackgroundPreset,
  to: DrawBackgroundPreset,
): T[] {
  if (from === to) return elements.map((element) => ({ ...element }));
  return elements.map((element) => {
    const isShape = element.type === "rectangle" || element.type === "ellipse" || element.type === "diamond";
    const next = {
      ...element,
      ...(element.strokeColor === FOREGROUND[from]
        ? { strokeColor: FOREGROUND[to] }
        : typeof element.strokeColor === "string" && ACCENTS[from][element.strokeColor]
          ? { strokeColor: ACCENTS[from][element.strokeColor] }
          : {}),
      ...(element.backgroundColor === FOREGROUND[from]
        ? { backgroundColor: FOREGROUND[to] }
        : typeof element.backgroundColor === "string" && ACCENTS[from][element.backgroundColor]
          ? { backgroundColor: ACCENTS[from][element.backgroundColor] }
          : {}),
      ...(element.backgroundColor === BACKGROUND[from]
        ? { backgroundColor: isShape && to === "blackboard" ? "transparent" : BACKGROUND[to] }
        : {}),
      ...(isShape && from === "blackboard" && to === "white" && element.backgroundColor === "transparent"
        ? { backgroundColor: BACKGROUND[to] }
        : {}),
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
