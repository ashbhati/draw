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

async function waitForBridge(page: Page) {
  const registrationRequest = page.waitForRequest((request) => request.url().endsWith("/__draw/api/client") && request.method() === "PUT");
  const documentRequest = page.waitForRequest((request) => request.url().endsWith(documentApi) && request.method() === "PUT");
  await page.goto("/");
  await page.locator(".topbar").waitFor();
  const registered = await registrationRequest;
  const synced = await documentRequest;
  expect(synced.postDataJSON().clientId).toBe(registered.postDataJSON().clientId);
  const health = await (await page.request.get("/__draw/api/health")).json();
  expect(health.clientReady && health.documentReady).toBe(true);
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

async function countWarmImagePixels(page: Page, image: Buffer): Promise<number> {
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas pixel inspection is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let warm = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 170 && pixels[index + 1] > 110 && pixels[index] > pixels[index + 1] * 1.08 && pixels[index + 1] > pixels[index + 2] * 1.08) warm += 1;
    }
    return warm;
  }, Array.from(image));
}

test.beforeEach(async ({ page }) => {
  await waitForBridge(page);
  await page.locator(".excalidraw canvas").first().waitFor();
  await expect(page.getByRole("button", { name: "Blackboard" })).toBeEnabled();
});

test("MCP create and update stay editable through save, reload, open, and image export", async ({ page }) => {
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

  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    return created.result.addedElementIds.every((id: string) => !current.document.elements.some((element: any) => element.id === id && element.isDeleted !== true));
  }).toBe(true);

  await page.getByRole("button", { name: "White" }).click();
  await expect(page.locator(".canvas-label")).toContainText("White");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    return created.result.addedElementIds.every((id: string) => current.document.elements.some((element: any) => element.id === id && element.isDeleted !== true));
  }).toBe(true);

  const editedElementId = created.result.nodes.spec;
  const longText = "A considerably longer label that should wrap inside the node";
  const updateResponse = await page.request.post(commandApi, { data: {
    operation: "update_elements",
    input: { updates: [{ id: editedElementId, patch: { text: longText, x: 96, y: 132 } }] },
  } });
  expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
  const document = await currentBridgeDocument(page);
  expect(document.document.canvas.background.preset).toBe("white");
  const wrappedLabel = document.document.elements.find((element: any) => element.id === created.result.nodeLabels.spec);
  const wrappedContainer = document.document.elements.find((element: any) => element.id === editedElementId);
  expect(wrappedLabel.originalText).toBe(longText);
  expect(wrappedLabel.text).toContain("\n");
  expect(wrappedLabel.text.split("\n").join(" ")).toBe(longText);
  expect(wrappedContainer.height).toBeGreaterThanOrEqual(wrappedLabel.height + 20);
  expect((await readLocalDocument(page)).document.elements.some((element: any) => element.originalText === longText && element.text.includes("\n"))).toBeTruthy();

  const drawDownloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Save \.draw/ }).click();
  const drawDownload = await drawDownloadWait;
  const drawBuffer = await readFile(await drawDownload.path());
  const savedFile = JSON.parse(drawBuffer.toString("utf8"));
  expect(savedFile.format).toBe("draw");
  expect(savedFile.document.elements.some((element: any) => element.originalText === longText)).toBeTruthy();

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
  expect((await readLocalDocument(page)).document.elements.some((element: any) => element.originalText === longText)).toBeTruthy();

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "roundtrip.draw",
    mimeType: "application/vnd.draw+json",
    buffer: drawBuffer,
  });
  await expect.poll(async () => {
    const reopened = await currentBridgeDocument(page);
    return reopened.document.elements.some((element: any) => element.originalText === longText);
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

  await expect(secondTab.getByText(/reload this tab to edit/i)).toBeVisible();
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

test("coalesces a pointer drag to a bounded number of whole-document bridge writes", async ({ page }) => {
  const documentPuts: string[] = [];
  const clientPuts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT") return;
    if (request.url().endsWith(documentApi)) documentPuts.push(request.postData() ?? "");
    if (request.url().endsWith("/__draw/api/client")) clientPuts.push(request.postData() ?? "");
  });

  await page.keyboard.press("r");
  const canvas = page.locator(".excalidraw canvas").last();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Could not locate the drawing canvas.");
  const start = { x: bounds.x + bounds.width / 2 - 70, y: bounds.y + bounds.height / 2 - 30 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 40; step += 1) {
    await page.mouse.move(start.x + step * 2, start.y + step);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);

  expect(documentPuts.length).toBeLessThanOrEqual(2);
  expect(clientPuts).toHaveLength(0);
});

test("loads fonts and exports the hand-drawn scene without network access", async ({ page }) => {
  const externalRequests: string[] = [];
  const localFontRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/fonts/Excalifont/")) localFontRequests.push(url);
    if (url.startsWith("http") && !url.startsWith("http://127.0.0.1:5181")) externalRequests.push(url);
  });
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith("http://127.0.0.1:5181")) return route.continue();
    return route.abort();
  });
  await waitForBridge(page);
  await expect(page.getByRole("button", { name: "Blackboard" })).toBeEnabled();
  const response = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [{ id: "offline", label: "Offline hand-drawn text", x: 100, y: 100, color: "#f2d27a" }], edges: [] },
  } });
  expect(response.ok()).toBeTruthy();
  await expect.poll(() => localFontRequests.length).toBeGreaterThan(0);
  await expect.poll(async () => (await currentBridgeDocument(page)).document.elements.length).toBeGreaterThan(0);

  const downloadWait = page.waitForEvent("download");
  await page.locator("button.export-main").click();
  const exported = await downloadWait;
  const image = await readFile(await exported.path());
  expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(image.byteLength).toBeGreaterThan(5_000);
  expect(await countWarmImagePixels(page, image)).toBeGreaterThan(40);
  expect(externalRequests).toEqual([]);
  expect(localFontRequests.every((url) => url.startsWith("http://127.0.0.1:5181/fonts/"))).toBe(true);
});

test("background changes adapt Draw defaults while preserving chosen colors", async ({ page }) => {
  await page.getByRole("button", { name: "Blackboard" }).click();
  const response = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: {
      title: "Preset test",
      nodes: [{ id: "custom", label: "Custom color", x: 100, y: 100, color: "#ff00cc" }],
      edges: [],
    },
  } });
  expect(response.ok()).toBeTruthy();
  const created = await response.json();
  await page.getByRole("button", { name: "White" }).click();
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    const title = current.document.elements.find((element: any) => element.id === created.result.titleElementId);
    const node = current.document.elements.find((element: any) => element.id === created.result.nodes.custom);
    return title?.strokeColor === "#1e1e1e" && node?.strokeColor === "#ff00cc" && node?.backgroundColor === "#ffffff";
  }).toBe(true);
});

test("embedded image assets survive autosave and editable Draw save/reopen", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ5sAAAAASUVORK5CYII=", "base64");
  await page.locator(".excalidraw").evaluate((editor, bytes) => {
    const bounds = editor.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "embedded.png", { type: "image/png" }));
    const coordinates = { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2, bubbles: true, cancelable: true, dataTransfer: transfer };
    editor.dispatchEvent(new DragEvent("dragenter", coordinates));
    editor.dispatchEvent(new DragEvent("dragover", coordinates));
    editor.dispatchEvent(new DragEvent("drop", coordinates));
  }, Array.from(png));

  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    return current.document.elements.some((element: any) => element.type === "image") && Object.keys(current.document.assets).length > 0;
  }).toBe(true);
  const autosaved = await readLocalDocument(page);
  expect(Object.values(autosaved.document.assets).some((asset: any) => asset.dataURL?.startsWith("data:image/png;base64,"))).toBe(true);

  const downloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Save \.draw/ }).click();
  const drawDownload = await downloadWait;
  const saved = JSON.parse((await readFile(await drawDownload.path())).toString("utf8"));
  expect(saved.document.elements.some((element: any) => element.type === "image")).toBe(true);
  expect(Object.keys(saved.document.assets)).not.toHaveLength(0);

  await page.reload();
  await page.locator(".excalidraw canvas").first().waitFor();
  expect((await readLocalDocument(page)).document.elements.some((element: any) => element.type === "image")).toBe(true);
  expect(Object.keys((await readLocalDocument(page)).document.assets)).not.toHaveLength(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "image-roundtrip.draw",
    mimeType: "application/vnd.draw+json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect.poll(async () => {
    const reopened = await currentBridgeDocument(page);
    return reopened.document.elements.some((element: any) => element.type === "image") && Object.keys(reopened.document.assets).length > 0;
  }).toBe(true);
});
