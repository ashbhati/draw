import { describe, expect, it, vi } from "vitest";
import { fetchWebImage, googleImagesSearchUrl } from "./web-image";

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ5sAAAAASUVORK5CYII=", "base64"));
describe("web image import", () => {
  it("encodes a Google Images query without injecting URL parameters", () => {
    const url = new URL(googleImagesSearchUrl("robot & chalk #1"));
    expect(url.origin).toBe("https://www.google.com");
    expect(url.searchParams.get("q")).toBe("robot & chalk #1");
    expect(url.searchParams.get("udm")).toBe("2");
  });
  it("embeds validated image bytes using an anonymous CORS request", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(png, { headers: { "content-type": "image/png" } }));
    const image = await fetchWebImage("https://images.example/robot.png", { fetcher });
    expect(image).toMatchObject({ width: 1, height: 1, mimeType: "image/png", dataURL: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(fetcher).toHaveBeenCalledWith("https://images.example/robot.png", expect.objectContaining({ credentials: "omit", mode: "cors", redirect: "error", referrerPolicy: "no-referrer" }));
  });
  it.each(["file:///etc/passwd", "http://images.example/a.png", "https://user:pass@images.example/a", "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/a", "https://10.0.0.1/a"])("rejects unsafe URL %s before fetching", async (url) => {
    const fetcher = vi.fn();
    await expect(fetchWebImage(url, { fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports CORS failures with a local-file fallback", async () => {
    await expect(fetchWebImage("https://images.example/a.png", { fetcher: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) })).rejects.toThrow(/download.*device/i);
  });
  it("rejects oversized streamed bytes and cancels the reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel });
    await expect(fetchWebImage("https://images.example/a.png", { fetcher: vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "image/png" } })) })).rejects.toThrow(/2 MiB/);
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects HTML search result pages and honors cancellation", async () => {
    await expect(fetchWebImage("https://images.example/page", { fetcher: vi.fn().mockResolvedValue(new Response("<html/>", { headers: { "content-type": "text/html" } })) })).rejects.toThrow(/PNG or JPEG/);
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn();
    await expect(fetchWebImage("https://images.example/a.png", { fetcher, signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
