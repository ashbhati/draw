import type { CreateElementsInput, DrawPrimitiveInput } from "./mcp-contract";

export type PrimitiveBackground = "blackboard" | "white";

export function buildPrimitiveSkeletons(
  input: CreateElementsInput,
  background: PrimitiveBackground,
  createId: () => string,
) {
  const onBlackboard = background === "blackboard";
  const defaultStroke = onBlackboard ? "#f6f2e9" : "#1e1e1e";
  const elementIds = Object.fromEntries(input.elements.map((element) => [element.id, createId()]));
  const skeletons = input.elements.map((element) => buildPrimitive(element, onBlackboard, defaultStroke, elementIds));
  return { skeletons, elementIds };
}

function buildPrimitive(
  element: DrawPrimitiveInput,
  onBlackboard: boolean,
  defaultStroke: string,
  elementIds: Record<string, string>,
): Record<string, unknown> {
  const id = elementIds[element.id];
  const strokeColor = element.strokeColor ?? defaultStroke;
  const skeleton: Record<string, unknown> = {
    id,
    type: element.type,
    x: element.x,
    y: element.y,
    strokeColor,
  };

  if (element.type === "rectangle" || element.type === "ellipse" || element.type === "diamond") {
    skeleton.width = element.width ?? 180;
    skeleton.height = element.height ?? 72;
    skeleton.backgroundColor = element.backgroundColor ?? (onBlackboard ? "transparent" : "#ffffff");
    skeleton.fillStyle = element.fillStyle ?? "solid";
    skeleton.strokeWidth = element.strokeWidth ?? 2;
    skeleton.roughness = element.roughness ?? 1;
    if (element.label) skeleton.label = { text: element.label, fontSize: 20, strokeColor };
    if (element.strokeStyle) skeleton.strokeStyle = element.strokeStyle;
  } else if (element.type === "text") {
    skeleton.text = element.text;
    skeleton.fontSize = element.fontSize ?? 20;
    skeleton.maxWidth = element.maxWidth ?? 600;
  } else {
    const points = element.points ?? [];
    const minX = Math.min(...points.map(([x]) => x));
    const minY = Math.min(...points.map(([, y]) => y));
    const maxX = Math.max(...points.map(([x]) => x));
    const maxY = Math.max(...points.map(([, y]) => y));
    skeleton.x = element.x + minX;
    skeleton.y = element.y + minY;
    skeleton.width = Math.max(maxX - minX, 1);
    skeleton.height = Math.max(maxY - minY, 1);
    skeleton.points = points.map(([x, y, pressure]) => element.type === "freedraw"
      ? [x - minX, y - minY, pressure ?? 0.5]
      : [x - minX, y - minY]);
    skeleton.strokeWidth = element.strokeWidth ?? 2;
    skeleton.roughness = element.roughness ?? 1;
    if (element.strokeStyle) skeleton.strokeStyle = element.strokeStyle;
    if (element.type === "arrow") {
      skeleton.endArrowhead = element.endArrowhead === undefined ? "arrow" : element.endArrowhead;
      if (element.start && element.end) {
        skeleton.start = { id: elementIds[element.start] };
        skeleton.end = { id: elementIds[element.end] };
      }
      if (element.label) skeleton.label = { text: element.label, fontSize: 16, strokeColor };
    }
  }
  return skeleton;
}
