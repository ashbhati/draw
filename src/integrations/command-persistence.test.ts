import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/document";
import { persistAppliedDocument } from "./command-persistence";

describe("persistence after an MCP scene mutation", () => {
  it("reports persistence failures as warnings without converting an applied edit into a failed command", async () => {
    const document = createEmptyDocument("Applied");
    const save = vi.fn(async () => { throw new Error("quota exceeded"); });
    const sync = vi.fn(async () => undefined);

    const warning = await persistAppliedDocument(document, save, sync);

    expect(save).toHaveBeenCalledWith(document);
    expect(sync).toHaveBeenCalledWith(document);
    expect(warning).toMatch(/edit was applied/i);
    expect(warning).toMatch(/quota exceeded/i);
  });

  it("returns no warning when both durable storage paths succeed", async () => {
    const document = createEmptyDocument("Applied");

    await expect(persistAppliedDocument(document, vi.fn(), vi.fn())).resolves.toBeUndefined();
  });
});
