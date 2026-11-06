import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/document";
import { createBridgeSynchronizer } from "./bridge-sync";

describe("bridge synchronizer", () => {
  it("registers one client once for repeated document syncs", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    const sync = createBridgeSynchronizer("tab-1", request);
    await sync(createEmptyDocument());
    await sync(createEmptyDocument());

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "/__draw/api/client", "/__draw/api/document", "/__draw/api/document", 
    ]);
  });

  it("serializes document writes so older requests cannot land after newer ones", async () => {
    const order: string[] = [];
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (String(_url).endsWith("/client")) return new Response(null, { status: 200 });
      const body = JSON.parse(String(init?.body));
      order.push(`start:${body.document.document.title}`);
      if (body.document.document.title === "first") {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      order.push(`end:${body.document.document.title}`);
      return new Response(null, { status: 200 });
    });
    const sync = createBridgeSynchronizer("tab-1", request);
    await Promise.all([
      sync({ ...createEmptyDocument(), document: { ...createEmptyDocument().document, title: "first" } }),
      sync({ ...createEmptyDocument(), document: { ...createEmptyDocument().document, title: "second" } }),
    ]);

    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });
});
