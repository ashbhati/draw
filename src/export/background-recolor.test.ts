import { describe, expect, it } from "vitest";
import { recolorForBackgroundPreset } from "./background-recolor";

describe("background default color migration", () => {
  it("adapts default chalk and canvas fills when changing presets", () => {
    const elements = [
      { id: "chalk", strokeColor: "#f6f2e9", backgroundColor: "#18191a", version: 3, versionNonce: 7, updated: 100 },
      { id: "custom", strokeColor: "#ff00cc", backgroundColor: "#123456" },
    ];
    const [recolored, custom] = recolorForBackgroundPreset(elements, "blackboard", "white");
    expect(recolored).toMatchObject({ id: "chalk", strokeColor: "#1e1e1e", backgroundColor: "#ffffff", version: 4 });
    expect(recolored.versionNonce).not.toBe(7);
    expect(recolored.updated).toBeGreaterThan(100);
    expect(custom).toEqual(elements[1]);
  });

  it("adapts the V1 yellow accent for white and restores it on blackboard", () => {
    const yellow = { id: "accent", strokeColor: "#f2d27a", backgroundColor: "#18191a" };
    const custom = { id: "custom", strokeColor: "#f2d27b", backgroundColor: "#123456" };
    const [onWhite, preservedCustom] = recolorForBackgroundPreset([yellow, custom], "blackboard", "white");
    expect(onWhite.strokeColor).toBe("#8a6418");
    expect(preservedCustom.strokeColor).toBe("#f2d27b");
    const [onBlackboard] = recolorForBackgroundPreset([onWhite], "white", "blackboard");
    expect(onBlackboard.strokeColor).toBe("#f2d27a");
  });
});
