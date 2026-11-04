import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const documentApi = "/__draw/api/document";
const commandApi = "/__draw/api/commands";

async function currentBridgeDocument(page: Page) {
  const response = await page.request.get(documentApi);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function readLocalDocument(page: Page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("draw-local", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("documents", "readonly").objectStore("documents").get("current");
      read.onsuccess = () => { resolve(read.result ?? null); db.close(); };
      read.onerror = () => reject(read.error);
    };
  }));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".topbar").waitFor();
  await page.locator(".excalidraw canvas").first().waitFor();
  await expect(page.getByRole("button", { name: "Blackboard" })).toBeEnabled();
});

test("MCP create and update stay editable through save, reload, open, and image export", async ({ page }) => {
  await page.getByRole("button", { name: "White" }).click();
  await expect(page.locator(".canvas-label")).toContainText("White");
  const createdResponse = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: {
      title: "Browser review flow",
      nodes: [
        { id: "spec", label: "Specification", x: 80, y: 120, shape: "rectangle" },
        { id: "check", label: "Validation", x: 390, y: 120, shape: "ellipse" },
      ],
      edges: [{ from: "spec", to: "check", label: "Built and checked" }],
    },
  } });
  expect(createdResponse.ok()).toBeTruthy();
  const created = await createdResponse.json();
  expect(created.result.nodes.spec).toBeTruthy();
  expect(created.result.nodes.check).toBeTruthy();
  expect(created.result.edges).toHaveLength(1);

  const editedElementId = created.result.nodes.spec;
  const afterCreate = await currentBridgeDocument(page);
  const updateResponse = await page.request.post(commandApi, { data: {
    operation: "update_elements",
    input: { updates: [{ id: editedElementId, patch: { text: "Requirements", x: 96, y: 132 } }] },
  } });
  expect(updateResponse.ok(), `${await updateResponse.text()} map=${editedElementId} ids=${afterCreate.document.elements.map((element: any) => element.id).join(",")}`).toBeTruthy();
  const document = await currentBridgeDocument(page);
  expect(document.document.canvas.background.preset).toBe("white");
  expect(document.document.elements.some((element: any) => element.text === "Requirements")).toBeTruthy();
  expect((await readLocalDocument(page)).document.elements.some((element: any) => element.text === "Requirements")).toBeTruthy();

  const drawDownloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Save \.draw/ }).click();
  const drawDownload = await drawDownloadWait;
  const drawBuffer = await readFile(await drawDownload.path());
  const savedFile = JSON.parse(drawBuffer.toString("utf8"));
  expect(savedFile.format).toBe("draw");
  expect(savedFile.document.elements.some((element: any) => element.text === "Requirements")).toBeTruthy();

  const pngWait = page.waitForEvent("download");
  await page.locator("button.export-main").click();
  const png = await pngWait;
  expect((await readFile(await png.path())).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

  const jpegWait = page.waitForEvent("download");
  await page.getByLabel("Image export format").selectOption("image/jpeg");
  const jpeg = await jpegWait;
  expect((await readFile(await jpeg.path())).subarray(0, 3).toString("hex")).toBe("ffd8ff");

  await page.reload();
  await page.locator(".excalidraw canvas").first().waitFor();
  await expect(page.locator(".canvas-label")).toContainText("White");
  expect((await readLocalDocument(page)).document.elements.some((element: any) => element.text === "Requirements")).toBeTruthy();

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "roundtrip.draw",
    mimeType: "application/vnd.draw+json",
    buffer: drawBuffer,
  });
  await expect.poll(async () => {
    const reopened = await currentBridgeDocument(page);
    return reopened.document.elements.some((element: any) => element.text === "Requirements");
  }).toBe(true);
});

test("malformed .draw files leave the current canvas and local autosave untouched", async ({ page }) => {
  const create = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [{ id: "keep", label: "Keep this work", x: 100, y: 100 }], edges: [] },
  } });
  expect(create.ok()).toBeTruthy();
  const before = await currentBridgeDocument(page);
  const malformed = Buffer.from(JSON.stringify({
    format: "draw", formatVersion: 1,
    document: { id: "bad", title: "Bad", canvas: { infinite: true, background: "oops", viewport: { x: 0, y: 0, zoom: 1 } }, elments: [], appState: {}, assets: {} },
  }));

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({ name: "broken.draw", mimeType: "application/json", buffer: malformed });
  await expect(page.getByRole("status").filter({ hasText: /background|elements/i })).toBeVisible();
  const after = await currentBridgeDocument(page);
  expect(after.document.id).toBe(before.document.id);
  expect(after.document.elements).toEqual(before.document.elements);
  expect((await readLocalDocument(page)).document.elements).toEqual(before.document.elements);
});

test("a second tab is read-only while the first tab owns local autosave", async ({ page, context }) => {
  const secondTab = await context.newPage();
  await secondTab.goto("/");
  await secondTab.locator(".excalidraw canvas").first().waitFor();

  await expect(secondTab.getByText(/already open in another tab/i)).toBeVisible();
  await expect(secondTab.getByLabel("Drawing title")).toBeDisabled();
  await expect(secondTab.getByRole("button", { name: "White" })).toBeDisabled();
});

test("title edits flush to IndexedDB on pagehide and survive reload", async ({ page }) => {
  await page.getByLabel("Drawing title").fill("Pagehide preserved");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => (await readLocalDocument(page))?.document.title).toBe("Pagehide preserved");
  await page.reload();
  await page.locator(".topbar").waitFor();
  await expect(page.getByLabel("Drawing title")).toHaveValue("Pagehide preserved");
});
