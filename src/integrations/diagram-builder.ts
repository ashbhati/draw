import type { CreateDiagramInput } from "./mcp-contract";

export type DiagramBackground = "blackboard" | "white";

export function buildDiagramSkeletons(
  input: CreateDiagramInput,
  background: DiagramBackground,
  createId: () => string,
) {
  const onBlackboard = background === "blackboard";
  const defaultStroke = onBlackboard ? "#f6f2e9" : "#1e1e1e";
  const nodeElementIds: Record<string, string> = {};
  const edgeElementIds: string[] = [];
  const skeletons: Record<string, unknown>[] = [];

  if (input.title) {
    skeletons.push({
      id: createId(), type: "text",
      x: Math.min(...input.nodes.map((node) => node.x)),
      y: Math.max(Math.min(...input.nodes.map((node) => node.y)) - 56, 72),
      text: input.title, fontSize: 20,
      strokeColor: onBlackboard ? "#f6f2e9" : "#1e1e1e", roughness: 1,
    });
  }

  for (const node of input.nodes) {
    const id = createId();
    nodeElementIds[node.id] = id;
    const strokeColor = node.color ?? defaultStroke;
    skeletons.push({
      id,
      type: node.shape === "ellipse" ? "ellipse" : node.shape === "diamond" ? "diamond" : "rectangle",
      x: node.x, y: node.y, width: node.width ?? 180, height: node.height ?? 72,
      strokeColor,
      backgroundColor: onBlackboard ? "transparent" : "#ffffff",
      fillStyle: "solid", strokeWidth: 2, roughness: 1,
      label: { text: node.label, fontSize: 20, strokeColor },
    });
  }

  for (const edge of input.edges) {
    const from = input.nodes.find((node) => node.id === edge.from);
    const to = input.nodes.find((node) => node.id === edge.to);
    if (!from || !to) continue;
    const fromWidth = from.width ?? 180;
    const fromHeight = from.height ?? 72;
    const toWidth = to.width ?? 180;
    const toHeight = to.height ?? 72;
    const sx = from.x + fromWidth / 2;
    const sy = from.y + fromHeight / 2;
    const ex = to.x + toWidth / 2;
    const ey = to.y + toHeight / 2;
    const id = createId();
    edgeElementIds.push(id);
    const strokeColor = edge.color ?? defaultStroke;
    skeletons.push({
      id, type: "arrow", x: sx, y: sy, points: [[0, 0], [ex - sx, ey - sy]],
      start: { id: nodeElementIds[edge.from] }, end: { id: nodeElementIds[edge.to] },
      endArrowhead: "arrow", strokeColor,
      ...(edge.label ? { label: { text: edge.label, fontSize: 16, strokeColor } } : {}),
    });
  }

  return { skeletons, nodeElementIds, edgeElementIds };
}
