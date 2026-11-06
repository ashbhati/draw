import { describe, expect, it } from "vitest";
import { composeBackgroundSvg, hasSelectedExportElements, selectExportElements } from "./background";

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

  it("reports whether a live scene element is selected", () => {
    const elements = [{ id: "visible" }, { id: "deleted", isDeleted: true }];
    expect(hasSelectedExportElements(elements, {})).toBe(false);
    expect(hasSelectedExportElements(elements, { deleted: true })).toBe(false);
    expect(hasSelectedExportElements(elements, { visible: true })).toBe(true);
  });

  it("places the selected white background behind existing scene elements", () => {
    const result = composeBackgroundSvg(svg, "white");
    expect(result.indexOf('data-draw-background="white"')).toBeLessThan(result.indexOf('id="scene"'));
    expect(result).toContain('fill="#ffffff"');
    expect(result).toContain('id="scene"');
  });

  it("embeds one shared charcoal texture across the full export without a repeating tile", () => {
    const result = composeBackgroundSvg(svg, "blackboard");
    expect(result.indexOf('data-draw-background="blackboard"')).toBeLessThan(result.indexOf('id="scene"'));
    expect(result).not.toContain("<pattern");
    expect(result).toContain('data-draw-background-texture="blackboard" x="0" y="0" width="100%" height="100%"');
    expect(result).toContain('preserveAspectRatio="none"');
    expect(result).toContain('href="data:image/svg+xml,');
    const embeddedTextureData = result.match(/href="data:image\/svg\+xml,([^"]+)"/)?.[1];
    expect(embeddedTextureData).toBeDefined();
    const embeddedTexture = decodeURIComponent(embeddedTextureData!);
    expect(embeddedTexture).toContain('viewBox="0 0 1280 800"');
    expect(embeddedTexture).toContain('filter id="chalk-surface" x="-12%" y="-12%" width="124%" height="124%"');
    expect(embeddedTexture).toContain('filter id="soft-dust" x="-30%" y="-200%" width="160%" height="500%"');
    expect(result).toContain('id="scene"');
  });

  it("rejects malformed SVG and unknown presets", () => {
    expect(() => composeBackgroundSvg("<div />", "blackboard")).toThrow(/complete svg/i);
    expect(() => composeBackgroundSvg(svg, "grid" as "white")).toThrow(/preset/i);
  });
});
