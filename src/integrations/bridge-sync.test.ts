import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/document";
import { createBridgeSynchronizer } from "./bridge-sync";

describe("bridge synchronizer", () => {
  it("syncs only with the authenticated per-tab secret", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    const sync = createBridgeSynchronizer("tab-1", () => "tab-secret", request);
    await sync(createEmptyDocument());
    await sync(createEmptyDocument());

    expect(request.mock.calls.map(([url]) => url)).toEqual(["/__draw/api/document", "/__draw/api/document"]);
    expect((request.mock.calls[0][1]?.headers as Record<string, string>)["x-draw-editor-secret"]).toBe("tab-secret");
  });

  it("serializes document writes so older requests cannot land after newer ones", async () => {
    const order: string[] = [];
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      order.push(`start:${body.document.document.title}`);
      if (body.document.document.title === "first") {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      order.push(`end:${body.document.document.title}`);
      return new Response(null, { status: 200 });
    });
    const sync = createBridgeSynchronizer("tab-1", () => "tab-secret", request);
    await Promise.all([
      sync({ ...createEmptyDocument(), document: { ...createEmptyDocument().document, title: "first" } }),
      sync({ ...createEmptyDocument(), document: { ...createEmptyDocument().document, title: "second" } }),
    ]);

    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("fails closed when the editor tab has no authenticated secret", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const sync = createBridgeSynchronizer("tab-1", () => null, request);
    await expect(sync(createEmptyDocument())).rejects.toThrow(/connect this draw editor/i);
    expect(request).not.toHaveBeenCalled();
  });
});
