import { describe, expect, it, vi } from "vitest";
import { fetchOpenverseImage, imageAttributionFromOpenverseResult, searchOpenverseImages, validateEmbeddedImage } from "./openverse";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 2, 0, 0, 0, 3,
]);

const result = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  title: "Chalk arrows",
  creator: "Artist",
  creator_url: "https://creator.example/",
  foreign_landing_url: "https://source.example/work/1",
  license: "by",
  license_version: "4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Artist, CC BY 4.0",
  provider: "Example provider",
  source: "Example collection",
  url: "https://media.example/image.png",
  thumbnail: "https://api.openverse.org/v1/images/123e4567-e89b-12d3-a456-426614174000/thumb/",
  width: 2,
  height: 3,
  filetype: "png",
};

describe("Openverse image integration", () => {
  it("normalizes search results from the fixed Openverse API and encodes filters", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify({ results: [result] }), { status: 200 }));
    const results = await searchOpenverseImages("chalk arrows", { category: "illustration", license: "by", fetcher: fetcher as typeof fetch });
    expect(results).toEqual([expect.objectContaining({
      id: result.id,
      title: result.title,
      creator: "Artist",
      license: "by",
      sourceUrl: result.foreign_landing_url,
    })]);
    expect(imageAttributionFromOpenverseResult(results[0]!)).not.toHaveProperty("id");
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/^https:\/\/api\.openverse\.org\/v1\/images\//);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("q=chalk+arrows");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("license=by");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("category=illustration");
  });

  it("rejects malformed provider result and rate-limit responses", async () => {
    await expect(searchOpenverseImages("x", { fetcher: vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch })).rejects.toThrow(/invalid response/i);
    await expect(searchOpenverseImages("x", { fetcher: vi.fn(async () => new Response("{}", { status: 429 })) as typeof fetch })).rejects.toThrow(/rate limit/i);
  });

  it("downloads an image only through the fixed Openverse proxy endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const metadata = (await searchOpenverseImages("x", { fetcher: vi.fn(async () => new Response(JSON.stringify({ results: [result] }), { status: 200 })) as typeof fetch }))[0]!;
    const image = await fetchOpenverseImage(result.id, metadata, fetcher as typeof fetch);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://api.openverse.org/v1/images/${result.id}/thumb/?full_size=true`);
    expect(image).toMatchObject({ mimeType: "image/png", width: 2, height: 3, attribution: expect.objectContaining({ creator: "Artist", license: "by" }) });
    expect(image.dataURL).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects arbitrary IDs, redirects, unsupported or mismatched MIME, oversize bytes, and excessive pixels", async () => {
    const arbitrary = vi.fn();
    const metadata = { provider: "Openverse" as const, providerId: result.id, title: "x", capturedAt: new Date().toISOString() };
    await expect(fetchOpenverseImage("https://evil.example/x", metadata, arbitrary as typeof fetch)).rejects.toThrow(/identifier/i);
    expect(arbitrary).not.toHaveBeenCalled();
    await expect(fetchOpenverseImage(result.id, metadata, vi.fn(async () => new Response(png, { status: 200, headers: { "content-type": "image/svg+xml" } })) as typeof fetch)).rejects.toThrow(/unsupported/i);
    await expect(validateEmbeddedImage(png, "image/jpeg")).rejects.toThrow(/not match/i);
    await expect(validateEmbeddedImage(new Uint8Array(8 * 1024 * 1024 + 1), "image/png")).rejects.toThrow(/size limit/i);
    const huge = png.slice();
    huge[16] = 0; huge[17] = 3; huge[18] = 13; huge[19] = 64;
    huge[20] = 0; huge[21] = 0; huge[22] = 1; huge[23] = 44;
    await expect(validateEmbeddedImage(huge, "image/png")).rejects.toThrow(/megapixel/i);
  });
});
