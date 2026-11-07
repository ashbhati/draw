import type { CreateElementsInput, DrawPrimitiveInput } from "./mcp-contract";

export type PrimitiveBackground = "blackboard" | "white";

export function buildPrimitiveSkeletons(
  input: Omit<CreateElementsInput, "idempotencyKey">,
  background: PrimitiveBackground,
  createId: () => string,
) {
  const onBlackboard = background === "blackboard";
  const defaultStroke = onBlackboard ? "#f6f2e9" : "#1e1e1e";
  const elementIds = Object.fromEntries(input.elements.map((element) => [element.id, createId()]));
  const inputElementsById = Object.fromEntries(input.elements.map((element) => [element.id, element]));
  const skeletons = input.elements.map((element) => buildPrimitive(element, onBlackboard, defaultStroke, elementIds, inputElementsById));
  return { skeletons, elementIds };
}

function buildPrimitive(
  element: DrawPrimitiveInput,
  onBlackboard: boolean,
  defaultStroke: string,
  elementIds: Record<string, string>,
  inputElementsById: Record<string, DrawPrimitiveInput>,
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
    let points = element.points ?? [];
    let pathX = element.x;
    let pathY = element.y;
    if (element.type === "arrow" && element.start && element.end) {
      const center = (id: string) => {
        const shape = inputElementsById[id];
        return [shape.x + (shape.width ?? 180) / 2, shape.y + (shape.height ?? 72) / 2] as const;
      };
      const start = center(element.start);
      const end = center(element.end);
      const minX = Math.min(start[0], end[0]);
      const minY = Math.min(start[1], end[1]);
      points = [[start[0] - minX, start[1] - minY], [end[0] - minX, end[1] - minY]];
      pathX = minX;
      pathY = minY;
    }
    const minX = Math.min(...points.map(([x]) => x));
    const minY = Math.min(...points.map(([, y]) => y));
    const maxX = Math.max(...points.map(([x]) => x));
    const maxY = Math.max(...points.map(([, y]) => y));
    skeleton.x = pathX + minX;
    skeleton.y = pathY + minY;
    skeleton.width = Math.max(maxX - minX, 1);
    skeleton.height = Math.max(maxY - minY, 1);
    skeleton.points = points.map(([x, y]) => [x - minX, y - minY]);
    if (element.type === "freedraw") {
      const hasExplicitPressure = element.points?.some(([, , pressure]) => pressure !== undefined) ?? false;
      skeleton.pressures = hasExplicitPressure ? element.points!.map(([, , pressure]) => pressure ?? 0.5) : [];
      skeleton.simulatePressure = !hasExplicitPressure;
    }
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
