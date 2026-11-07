import type { CreateElementsInput, DrawPrimitiveInput } from "./mcp-contract";

export type PrimitiveBackground = "blackboard" | "white";

export function buildPrimitiveSkeletons(
  input: CreateElementsInput,
  background: PrimitiveBackground,
  createId: () => string,
) {
  const onBlackboard = background === "blackboard";
  const defaultStroke = onBlackboard ? "#f6f2e9" : "#1e1e1e";
  const elementIds: Record<string, string> = {};
  const skeletons = input.elements.map((element) => buildPrimitive(element, onBlackboard, defaultStroke, createId, elementIds));
  return { skeletons, elementIds };
}

function buildPrimitive(
  element: DrawPrimitiveInput,
  onBlackboard: boolean,
  defaultStroke: string,
  createId: () => string,
  elementIds: Record<string, string>,
): Record<string, unknown> {
  const id = createId();
  elementIds[element.id] = id;
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
    if (element.strokeStyle) skeleton.strokeStyle = element.strokeStyle;
  } else if (element.type === "text") {
    skeleton.text = element.text;
    skeleton.fontSize = element.fontSize ?? 20;
  } else {
    skeleton.points = element.points;
    skeleton.strokeWidth = element.strokeWidth ?? 2;
    skeleton.roughness = element.roughness ?? 1;
    if (element.strokeStyle) skeleton.strokeStyle = element.strokeStyle;
    if (element.type === "arrow") skeleton.endArrowhead = element.endArrowhead === undefined ? "arrow" : element.endArrowhead;
  }
  return skeleton;
}
