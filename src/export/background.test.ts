import { describe, expect, it } from "vitest";
import { composeBackgroundSvg, selectExportElements } from "./background";

describe("export background composition", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect id="scene" x="20" y="20" width="40" height="40" /></svg>';

  it("exports selected content when selected and falls back to the whole canvas", () => {
    const elements = [{ id: "one" }, { id: "two" }, { id: "three" }];
    expect(selectExportElements(elements, { two: true }).map((element) => element.id)).toEqual(["two"]);
    expect(selectExportElements(elements, {}).map((element) => element.id)).toEqual(["one", "two", "three"]);
  });

  it("keeps labels bound to selected containers and arrows", () => {
    const elements = [
      { id: "box", type: "rectangle" },
      { id: "box-label", type: "text", containerId: "box" },
      { id: "other-box", type: "rectangle" },
      { id: "arrow", type: "arrow" },
      { id: "arrow-label", type: "text", containerId: "arrow" },
      { id: "unrelated", type: "text" },
    ];
    expect(selectExportElements(elements, { box: true }).map((element) => element.id)).toEqual(["box", "box-label"]);
    expect(selectExportElements(elements, { arrow: true }).map((element) => element.id)).toEqual(["arrow", "arrow-label"]);
  });

  it("places the selected white background behind existing scene elements", () => {
    const result = composeBackgroundSvg(svg, "white");
    expect(result.indexOf('data-draw-background="white"')).toBeLessThan(result.indexOf('id="scene"'));
    expect(result).toContain('fill="#ffffff"');
    expect(result).toContain('id="scene"');
  });

  it("adds a textured charcoal board without flattening the scene markup", () => {
    const result = composeBackgroundSvg(svg, "blackboard");
    expect(result.indexOf('data-draw-background="blackboard"')).toBeLessThan(result.indexOf('id="scene"'));
    expect(result).toContain("feTurbulence");
    expect(result).toContain('fill="#18191a"');
    expect(result).toContain('id="scene"');
  });

  it("rejects malformed SVG and unknown presets", () => {
    expect(() => composeBackgroundSvg("<div />", "blackboard")).toThrow(/complete svg/i);
    expect(() => composeBackgroundSvg(svg, "grid" as "white")).toThrow(/preset/i);
  });
});
