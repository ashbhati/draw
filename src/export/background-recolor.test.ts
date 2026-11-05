import { describe, expect, it } from "vitest";
import { recolorDefaultElements } from "./background-recolor";

describe("background default color migration", () => {
  it("adapts default chalk and canvas fills when changing presets", () => {
    const elements = [
      { id: "chalk", strokeColor: "#f6f2e9", backgroundColor: "#18191a" },
      { id: "custom", strokeColor: "#ff00cc", backgroundColor: "#123456" },
    ];
    expect(recolorDefaultElements(elements, "blackboard", "white")).toEqual([
      { id: "chalk", strokeColor: "#1e1e1e", backgroundColor: "#ffffff" },
      elements[1],
    ]);
  });
});
