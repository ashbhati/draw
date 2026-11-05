import { describe, expect, it } from "vitest";
import { recolorDefaultElements } from "./background-recolor";

describe("background default color migration", () => {
  it("adapts default chalk and canvas fills when changing presets", () => {
    const elements = [
      { id: "chalk", strokeColor: "#f6f2e9", backgroundColor: "#18191a", version: 3, versionNonce: 7, updated: 100 },
      { id: "custom", strokeColor: "#ff00cc", backgroundColor: "#123456" },
    ];
    const [recolored, custom] = recolorDefaultElements(elements, "blackboard", "white");
    expect(recolored).toMatchObject({ id: "chalk", strokeColor: "#1e1e1e", backgroundColor: "#ffffff", version: 4 });
    expect(recolored.versionNonce).not.toBe(7);
    expect(recolored.updated).toBeGreaterThan(100);
    expect(custom).toEqual(elements[1]);
  });
});
