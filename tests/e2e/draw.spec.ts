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

async function freshBridgeDocument(page: Page) {
  const response = await page.request.get(`${documentApi}?flush=1`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/[\da-f]{2}/gi)!.map((channel) => parseInt(channel, 16) / 255).map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function countPixelsNear(page: Page, image: Buffer, target: [number, number, number], tolerance: number, mimeType = "image/png"): Promise<number> {
  return page.evaluate(async ({ bytes, color, limit, mime }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas pixel inspection is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (Math.abs(pixels[index] - color[0]) <= limit && Math.abs(pixels[index + 1] - color[1]) <= limit && Math.abs(pixels[index + 2] - color[2]) <= limit) count += 1;
    }
    return count;
  }, { bytes: Array.from(image), color: target, limit: tolerance, mime: mimeType });
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

async function sampleImagePatch(
  page: Page,
  image: Buffer,
  point: { x: number; y: number },
  mimeType = "image/png",
): Promise<[number, number, number]> {
  return page.evaluate(async ({ bytes, position, mime }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas pixel inspection is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const patchWidth = Math.max(1, Math.floor(bitmap.width * 0.05));
    const patchHeight = Math.max(1, Math.floor(bitmap.height * 0.05));
    const centerX = Math.floor(bitmap.width * position.x);
    const centerY = Math.floor(bitmap.height * position.y);
    const startX = Math.max(0, Math.min(bitmap.width - patchWidth, centerX - Math.floor(patchWidth / 2)));
    const startY = Math.max(0, Math.min(bitmap.height - patchHeight, centerY - Math.floor(patchHeight / 2)));
    const pixels = context.getImageData(startX, startY, patchWidth, patchHeight).data;
    const total = patchWidth * patchHeight;
    const red = pixels.reduce((sum, value, index) => sum + (index % 4 === 0 ? value : 0), 0) / total;
    const green = pixels.reduce((sum, value, index) => sum + (index % 4 === 1 ? value : 0), 0) / total;
    const blue = pixels.reduce((sum, value, index) => sum + (index % 4 === 2 ? value : 0), 0) / total;
    return [red, green, blue] as [number, number, number];
  }, { bytes: Array.from(image), position: point, mime: mimeType });
}

async function measureBoardTextureStdDev(page: Page, image: Buffer, mimeType = "image/png"): Promise<number> {
  return page.evaluate(async ({ bytes, mime }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas pixel inspection is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const pixels: number[] = [];
    const xBands: [number, number][] = [[0.03, 0.12], [0.88, 0.97]];
    for (const [startX, endX] of xBands) {
      for (let y = Math.floor(bitmap.height * 0.12); y < bitmap.height * 0.9; y += 2) {
        for (let x = Math.floor(bitmap.width * startX); x < bitmap.width * endX; x += 2) {
          const offset = (y * bitmap.width + x) * 4;
          pixels.push(data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722);
        }
      }
    }
    const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
    return Math.sqrt(pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pixels.length);
  }, { bytes: Array.from(image), mime: mimeType });
}

function maxChannelDifference(a: readonly number[], b: readonly number[]): number {
  return Math.max(...a.map((channel, index) => Math.abs(channel - b[index])));
}

async function inspectImagePixels(page: Page, image: Buffer, mimeType: "image/png" | "image/jpeg") {
  return page.evaluate(async ({ bytes, type }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not inspect exported image pixels.");
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let whiteInkPixels = 0;
    let darkInkPixels = 0;
    let greenAssetPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 205 && data[index + 1] > 195 && data[index + 2] > 180) whiteInkPixels += 1;
      if (data[index] < 65 && data[index + 1] < 65 && data[index + 2] < 65) darkInkPixels += 1;
      if (data[index + 1] > 170 && data[index] < 80 && data[index + 2] < 180) greenAssetPixels += 1;
    }
    return { width: canvas.width, height: canvas.height, whiteInkPixels, darkInkPixels, greenAssetPixels };
  }, { bytes: Array.from(image), type: mimeType });
}

async function countInkInSceneRegion(
  page: Page,
  image: Buffer,
  mimeType: "image/png" | "image/jpeg",
  region: { left: number; top: number; right: number; bottom: number },
  origin: { x: number; y: number },
  ink: "chalk" | "whiteboard-mark",
): Promise<number> {
  return page.evaluate(async ({ bytes, type, bounds, exportOrigin, expectedInk }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not inspect exported image pixels.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const left = Math.max(0, Math.floor(bounds.left - exportOrigin.x));
    const top = Math.max(0, Math.floor(bounds.top - exportOrigin.y));
    const right = Math.min(canvas.width, Math.ceil(bounds.right - exportOrigin.x));
    const bottom = Math.min(canvas.height, Math.ceil(bounds.bottom - exportOrigin.y));
    let count = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        if (expectedInk === "chalk" ? luminance > 130 : red < 230 || green < 230 || blue < 230) count += 1;
      }
    }
    return count;
  }, { bytes: Array.from(image), type: mimeType, bounds: region, exportOrigin: origin, expectedInk: ink });
}

test.beforeEach(async ({ page }) => {
  await waitForBridge(page);
  await page.locator(".excalidraw canvas").first().waitFor();
  await expect(page.getByRole("button", { name: "Blackboard Canvas" })).toBeEnabled();
});

test("canvas choices are in the main toolbar and replace the quick-start rail", async ({ page }) => {
  const toolbar = page.getByRole("group", { name: "Canvas" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Blackboard Canvas" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Whiteboard Canvas" })).toBeVisible();
  await expect(toolbar).toContainText("Canvas");
  await expect(toolbar).toContainText("Blackboard Canvas");
  await expect(toolbar).toContainText("Whiteboard Canvas");
  await expect(page.locator(".editor-shell").getByRole("group", { name: "Canvas" })).toBeVisible();
  await expect(toolbar.locator(".draw-canvas-option").first()).toBeVisible();
  await expect(page.locator(".side-rail")).toHaveCount(0);
  await expect(page.getByText("QUICK START")).toHaveCount(0);

  await toolbar.getByRole("button", { name: "Whiteboard Canvas" }).click();
  await expect(toolbar.getByRole("button", { name: "Whiteboard Canvas" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await currentBridgeDocument(page)).document.canvas.background.preset).toBe("white");
  await toolbar.getByRole("button", { name: "Blackboard Canvas" }).click();
  await expect(toolbar.getByRole("button", { name: "Blackboard Canvas" })).toHaveAttribute("aria-pressed", "true");
});

test("canvas controls fit inside the editor across responsive breakpoints", async ({ page }) => {
  const toolbar = page.getByRole("group", { name: "Canvas" });
  const selector = toolbar.getByLabel("Canvas background");
  await expect(selector.locator("option")).toHaveText(["Blackboard Canvas", "Whiteboard Canvas"]);
  const editor = page.locator(".editor-shell");
  for (const width of [360, 390, 700, 900, 950, 1019, 1020, 1021, 1100, 1400, 1920]) {
    await page.setViewportSize({ width, height: 844 });
    const editorBounds = await editor.boundingBox();
    expect(editorBounds).not.toBeNull();
    const menuControls = await page.locator(".main-menu-trigger, .App-toolbar__extra-tools-trigger").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }).filter((rect) => rect.width > 0 && rect.height > 0));
    const overlapsMenu = (bounds: { x: number; y: number; width: number; height: number }) => menuControls.some((control) =>
      bounds.x < control.x + control.width && bounds.x + bounds.width > control.x && bounds.y < control.y + control.height && bounds.y + bounds.height > control.y,
    );
    if (width <= 1020) {
      await expect(selector).toBeVisible();
      const bounds = await selector.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(editorBounds!.x);
      expect(bounds!.y).toBeGreaterThanOrEqual(editorBounds!.y);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(editorBounds!.x + editorBounds!.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(editorBounds!.y + editorBounds!.height);
      const tools = await page.evaluate(() => {
        const element = document.querySelector(".App-toolbar--mobile, .App-menu_top__left");
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      expect(tools).not.toBeNull();
      const overlapsTools = bounds!.x < tools!.x + tools!.width && bounds!.x + bounds!.width > tools!.x && bounds!.y < tools!.y + tools!.height && bounds!.y + bounds!.height > tools!.y;
      expect(overlapsTools).toBe(false);
      expect(overlapsMenu(bounds!)).toBe(false);
    } else {
      for (const button of [toolbar.getByRole("button", { name: "Blackboard Canvas" }), toolbar.getByRole("button", { name: "Whiteboard Canvas" })]) {
        const bounds = await button.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(editorBounds!.x);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(editorBounds!.x + editorBounds!.width);
        expect(overlapsMenu(bounds!)).toBe(false);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await selector.selectOption("white");
  await expect.poll(async () => (await currentBridgeDocument(page)).document.canvas.background.preset).toBe("white");
});

test("the main menu retains Find without outbound links, exporter options, or a destructive reset", async ({ page }) => {
  await page.locator('[data-testid="main-menu-trigger"]').click();
  const menu = page.locator(".dropdown-menu");

  await expect(menu.getByText("Find on canvas", { exact: true })).toBeVisible();
  await expect(menu.getByText("Export image...", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("Help", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("Reset the canvas", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("Excalidraw links", { exact: true })).toHaveCount(0);
  await expect(menu.locator('a[href^="http"]')).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/Embed scene/i)).toHaveCount(0);
  await expect(page.getByText(/Dark mode/i)).toHaveCount(0);
});

test("the bottom-right Help control is unavailable", async ({ page }) => {
  await expect(page.locator(".help-icon")).toBeHidden();
});

test("the question-mark shortcut cannot open external help", async ({ page }) => {
  await page.locator(".excalidraw").click({ position: { x: 500, y: 350 } });
  await page.keyboard.press("?");
  await expect(page.locator(".HelpDialog")).toHaveCount(0);
  await expect(page.locator('a[href^="http"]')).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Meta+Shift+E cannot open Excalidraw's image exporter", async ({ page }) => {
  await page.locator(".excalidraw").click({ position: { x: 500, y: 350 } });
  await page.keyboard.press("Meta+Shift+E");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/Embed scene/i)).toHaveCount(0);
  await expect(page.locator('a[href^="http"]')).toHaveCount(0);
});

test("Blackboard texture matches live and exports at fixed 1400x800 viewport", async ({ page }) => {
  const createResponse = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [{ id: "dark-fill", label: "Dark fill", x: 200, y: 180, width: 160, height: 100, color: "#18191a" }], edges: [] },
  } });
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
  const viewport = { width: 1400, height: 800 };
  await page.setViewportSize(viewport);
  await page.waitForTimeout(100);
  const liveBoard = await page.locator(".editor-shell").screenshot();

  const pngDownloadWait = page.waitForEvent("download");
  await page.locator("button.export-main").click();
  const png = await readFile(await (await pngDownloadWait).path());

  const jpegDownloadWait = page.waitForEvent("download");
  await page.getByLabel("Image export format").selectOption("image/jpeg");
  const jpeg = await readFile(await (await jpegDownloadWait).path());

  const boardPoints = [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, { x: 0.1, y: 0.8 }, { x: 0.9, y: 0.8 }];
  const livePixels = await Promise.all(boardPoints.map((point) => sampleImagePatch(page, liveBoard, point)));
  const pngPixels = await Promise.all(boardPoints.map((point) => sampleImagePatch(page, png, point)));
  const jpegPixels = await Promise.all(boardPoints.map((point) => sampleImagePatch(page, jpeg, point, "image/jpeg")));
  const pngDifferences = livePixels.map((pixel, index) => maxChannelDifference(pixel, pngPixels[index]));
  const jpegDifferences = livePixels.map((pixel, index) => maxChannelDifference(pixel, jpegPixels[index]));
  expect(Math.max(...pngDifferences), `live/PNG channel differences: ${pngDifferences.join(", ")}`).toBeLessThanOrEqual(3);
  expect(Math.max(...jpegDifferences), `live/JPEG channel differences: ${jpegDifferences.join(", ")}`).toBeLessThanOrEqual(14);

  const liveTextureStdDev = await measureBoardTextureStdDev(page, liveBoard);
  const pngTextureStdDev = await measureBoardTextureStdDev(page, png);
  const jpegTextureStdDev = await measureBoardTextureStdDev(page, jpeg, "image/jpeg");
  for (const [format, deviation] of [["live", liveTextureStdDev], ["PNG", pngTextureStdDev], ["JPEG", jpegTextureStdDev]] as const) {
    expect(deviation, `${format} texture standard deviation`).toBeGreaterThan(0.5);
    expect(deviation, `${format} texture standard deviation`).toBeLessThan(4);
  }
  expect(Math.abs(liveTextureStdDev - pngTextureStdDev), "live/PNG texture variation").toBeLessThan(1);

  // The export includes 32px of padding around the 160x100 node. Sample its
  // lower-right fill (away from the bound label) against the nearby board.
  const fillPixel = await sampleImagePatch(page, png, { x: 0.8, y: 0.73 });
  const adjacentBoardPixel = await sampleImagePatch(page, png, { x: 0.06, y: 0.73 });
  expect(maxChannelDifference(fillPixel, adjacentBoardPixel), "PNG dark fill continuity").toBeLessThanOrEqual(8);
  const jpegFillPixel = await sampleImagePatch(page, jpeg, { x: 0.8, y: 0.73 }, "image/jpeg");
  const jpegBoardPixel = await sampleImagePatch(page, jpeg, { x: 0.06, y: 0.73 }, "image/jpeg");
  expect(maxChannelDifference(jpegFillPixel, jpegBoardPixel), "JPEG dark fill continuity").toBeLessThanOrEqual(12);
});

test("the Draw wordmark and Open .draw action do not overlap on narrow screens", async ({ page }) => {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const brand = await page.locator(".brand-name").boundingBox();
    const open = await page.getByRole("button", { name: "Open .draw" }).boundingBox();
    expect(brand, `wordmark should be visible at ${width}px`).not.toBeNull();
    expect(open, `Open .draw should be visible at ${width}px`).not.toBeNull();
    const overlaps = brand!.x < open!.x + open!.width && brand!.x + brand!.width > open!.x && brand!.y < open!.y + open!.height && brand!.y + brand!.height > open!.y;
    expect(overlaps, `wordmark should not overlap Open .draw at ${width}px`).toBe(false);
  }
});

test("MCP create and update stay editable through save, reload, open, and image export", async ({ page }) => {
  const createdResponse = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: {
      title: "Spec → Validation",
      nodes: [
        { id: "spec", label: "Specification\nWhat & Why", x: 40, y: 100, width: 190, height: 82, shape: "rectangle" },
        { id: "implementation", label: "Implementation\nHow", x: 290, y: 100, width: 190, height: 82, shape: "rectangle", color: "#f2d27a" },
        { id: "check", label: "Validation\nDid it work?", x: 540, y: 100, width: 190, height: 82, shape: "rectangle" },
      ],
      edges: [{ from: "spec", to: "implementation" }, { from: "implementation", to: "check" }],
    },
  } });
  expect(createdResponse.ok()).toBeTruthy();
  const created = await createdResponse.json();
  expect(created.result.nodes.spec).toBeTruthy();
  expect(created.result.nodes.implementation).toBeTruthy();
  expect(created.result.nodes.check).toBeTruthy();
  expect(created.result.edges).toHaveLength(2);

  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    return created.result.addedElementIds.every((id: string) => !current.document.elements.some((element: any) => element.id === id && element.isDeleted !== true));
  }).toBe(true);

  await page.getByRole("button", { name: "Redo" }).click();
  await page.getByRole("button", { name: "Whiteboard Canvas" }).click();
  await expect(page.locator(".canvas-label")).toContainText("White");

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

test("MCP diagram titles reserve at least their live Excalifont text width", async ({ page }) => {
  const title = "Specification → Implementation → Validation";
  const response = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: {
      title,
      nodes: [
        { id: "spec", label: "Specification\nWhat & Why", x: 280, y: 150, width: 190, height: 82 },
        { id: "implementation", label: "Implementation\nHow", x: 530, y: 150, width: 190, height: 82, color: "#f2d27a" },
        { id: "validation", label: "Validation\nDid it work?", x: 780, y: 150, width: 190, height: 82 },
      ],
      edges: [{ from: "spec", to: "implementation" }, { from: "implementation", to: "validation" }],
    },
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const current = await freshBridgeDocument(page);
  const titleElement = current.document.elements.find((element: any) => element.type === "text" && !element.containerId && element.text === title);
  const renderedWidth = await page.evaluate(async (value) => {
    await document.fonts.load("20px Excalifont", value);
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("Canvas text measurement is unavailable.");
    context.font = "20px Excalifont";
    return context.measureText(value).width;
  }, title);
  expect(titleElement.fontFamily).toBe(5);
  expect(titleElement.width).toBeGreaterThanOrEqual(renderedWidth);
});

test("Open .draw restores a downloaded file that remains editable through a second save and reopen", async ({ page }) => {
  const createResponse = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [{ id: "roundtrip", label: "Downloaded editable diagram", x: 140, y: 120 }], edges: [] },
  } });
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
  const created = await createResponse.json();

  await page.getByLabel("Drawing title").fill("Portable Asset Round Trip");
  await page.getByRole("button", { name: "Whiteboard Canvas" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const canvas = page.locator(".excalidraw canvas").last();
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Could not locate the drawing canvas.");
  const panStart = { x: canvasBounds.x + canvasBounds.width - 40, y: canvasBounds.y + canvasBounds.height / 2 };
  await page.keyboard.down("Space");
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  await page.mouse.move(panStart.x - 80, panStart.y + 30);
  await page.mouse.up();
  await page.keyboard.up("Space");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ5sAAAAASUVORK5CYII=", "base64");
  await page.locator(".excalidraw").evaluate((editor, bytes) => {
    const bounds = editor.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "portable-image.png", { type: "image/png" }));
    const coordinates = { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2, bubbles: true, cancelable: true, dataTransfer: transfer };
    editor.dispatchEvent(new DragEvent("dragenter", coordinates));
    editor.dispatchEvent(new DragEvent("dragover", coordinates));
    editor.dispatchEvent(new DragEvent("drop", coordinates));
  }, Array.from(png));
  await expect.poll(async () => {
    const current = await freshBridgeDocument(page);
    return current.document.elements.some((element: any) => element.type === "image") && Object.keys(current.document.assets).length > 0;
  }).toBe(true);
  await expect.poll(async () => (await freshBridgeDocument(page)).document.title).toBe("Portable Asset Round Trip");
  await expect.poll(async () => (await freshBridgeDocument(page)).document.canvas.background.preset).toBe("white");

  const firstDownloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Save \.draw/ }).click();
  const firstDownload = await firstDownloadWait;
  const firstFilePath = await firstDownload.path();
  const firstFile = JSON.parse((await readFile(firstFilePath)).toString("utf8"));
  expect(firstFile.format).toBe("draw");
  expect(firstFile.document.elements.some((element: any) => element.id === created.result.nodes.roundtrip)).toBe(true);
  expect(firstFile.document.title).toBe("Portable Asset Round Trip");
  expect(firstFile.document.canvas.background.preset).toBe("white");
  expect(firstFile.document.canvas.viewport.zoom).toBeGreaterThan(1);
  expect(firstFile.document.canvas.viewport.x !== 0 || firstFile.document.canvas.viewport.y !== 0).toBe(true);
  expect(Object.values(firstFile.document.assets).length).toBeGreaterThan(0);
  expect(firstFile.document.elements.filter((element: any) => element.type === "image")).toHaveLength(1);

  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("draw-local");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Draw autosave database deletion was blocked."));
  }));
  page.once("dialog", (dialog) => dialog.accept());
  const firstChooserWait = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open .draw" }).click();
  await (await firstChooserWait).setFiles(firstFilePath);
  await expect.poll(async () => {
    const reopened = await freshBridgeDocument(page);
    return reopened.document.elements.some((element: any) => element.id === created.result.nodes.roundtrip);
  }).toBe(true);
  const firstReopen = await freshBridgeDocument(page);
  expect(firstReopen.document.title).toBe(firstFile.document.title);
  expect(firstReopen.document.canvas.background.preset).toBe(firstFile.document.canvas.background.preset);
  expect(firstReopen.document.canvas.viewport).toEqual(firstFile.document.canvas.viewport);
  expect(firstReopen.document.elements.filter((element: any) => element.type === "image")).toHaveLength(1);
  expect(Object.keys(firstReopen.document.assets)).toHaveLength(Object.keys(firstFile.document.assets).length);
  const localReopen = await readLocalDocument(page);
  expect(localReopen).not.toBeNull();
  expect(localReopen.document.title).toBe(firstFile.document.title);
  expect(localReopen.document.canvas.background.preset).toBe(firstFile.document.canvas.background.preset);
  expect(localReopen.document.canvas.viewport).toEqual(firstFile.document.canvas.viewport);
  expect(localReopen.document.elements.filter((element: any) => element.type === "image")).toHaveLength(1);
  expect(Object.keys(localReopen.document.assets)).toHaveLength(Object.keys(firstFile.document.assets).length);

  const editedText = "Edited after opening the downloaded file";
  const updateResponse = await page.request.post(commandApi, { data: {
    operation: "update_elements",
    input: { updates: [{ id: created.result.nodes.roundtrip, patch: { text: editedText } }] },
  } });
  expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
  await expect.poll(async () => {
    const current = await freshBridgeDocument(page);
    return current.document.elements.some((element: any) => element.originalText === editedText);
  }).toBe(true);

  const secondDownloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Save \.draw/ }).click();
  const secondDownload = await secondDownloadWait;
  const secondFilePath = await secondDownload.path();
  const secondFile = JSON.parse((await readFile(secondFilePath)).toString("utf8"));
  expect(secondFile.document.elements.some((element: any) => element.originalText === editedText)).toBe(true);

  page.once("dialog", (dialog) => dialog.accept());
  const secondChooserWait = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open .draw" }).click();
  await (await secondChooserWait).setFiles(secondFilePath);
  await expect.poll(async () => {
    const reopened = await freshBridgeDocument(page);
    return reopened.document.elements.some((element: any) => element.originalText === editedText);
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
  await expect(secondTab.getByRole("button", { name: "Whiteboard Canvas" })).toBeDisabled();
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
  const cjkFontRequests: string[] = [];
  const localOrigin = new URL(page.url()).origin;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/fonts/Excalifont/")) localFontRequests.push(url);
    if (url.includes("/fonts/Xiaolai/")) cjkFontRequests.push(url);
    if (url.startsWith("http") && !url.startsWith(localOrigin)) externalRequests.push(url);
  });
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(localOrigin)) return route.continue();
    return route.abort();
  });
  await waitForBridge(page);
  await expect(page.getByRole("button", { name: "Blackboard" })).toBeEnabled();
  const response = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [{ id: "offline", label: "Offline hand-drawn text 中文 日本語 한국어", x: 100, y: 100, color: "#f2d27a" }], edges: [] },
  } });
  expect(response.ok()).toBeTruthy();
  await expect.poll(() => localFontRequests.length).toBeGreaterThan(0);
  await expect.poll(() => cjkFontRequests.length).toBeGreaterThan(0);
  await expect.poll(async () => (await currentBridgeDocument(page)).document.elements.length).toBeGreaterThan(0);

  const downloadWait = page.waitForEvent("download");
  await page.locator("button.export-main").click();
  const exported = await downloadWait;
  const image = await readFile(await exported.path());
  expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(await countWarmImagePixels(page, image), "the exported diagram includes visible yellow diagram pixels").toBeGreaterThan(40);
  expect(await countPixelsNear(page, image, [24, 25, 26], 8), "the export includes its charcoal board background").toBeGreaterThan(1_000);
  expect(externalRequests).toEqual([]);
  expect(localFontRequests.every((url) => url.startsWith(`${localOrigin}/fonts/`))).toBe(true);
  expect(cjkFontRequests.every((url) => url.startsWith(`${localOrigin}/fonts/`))).toBe(true);
});

test("background changes recolor Draw defaults, preserve custom colors, and undo and redo", async ({ page }) => {
  await page.getByRole("button", { name: "Blackboard" }).click();
  const response = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: {
      title: "Preset test",
      nodes: [
        { id: "default", label: "Default color", x: 100, y: 100 },
        { id: "custom", label: "Custom color", x: 340, y: 100, color: "#ff00cc" },
        { id: "accent", label: "Yellow accent", x: 580, y: 100, color: "#f2d27a" },
      ],
      edges: [],
    },
  } });
  expect(response.ok()).toBeTruthy();
  const created = await response.json();
  await page.getByRole("button", { name: "White" }).click();
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    const title = current.document.elements.find((element: any) => element.id === created.result.titleElementId);
    const defaultNode = current.document.elements.find((element: any) => element.id === created.result.nodes.default);
    const customNode = current.document.elements.find((element: any) => element.id === created.result.nodes.custom);
    const accent = current.document.elements.find((element: any) => element.id === created.result.nodes.accent);
    return title?.strokeColor === "#1e1e1e" && defaultNode?.strokeColor === "#1e1e1e" && defaultNode?.backgroundColor === "#ffffff" && customNode?.strokeColor === "#ff00cc" && accent?.strokeColor === "#8a6418";
  }).toBe(true);
  expect(contrastRatio("#1e1e1e", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio("#8a6418", "#ffffff")).toBeGreaterThanOrEqual(4.5);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    const node = current.document.elements.find((element: any) => element.id === created.result.nodes.default);
    return current.document.canvas.background.preset === "blackboard" && node?.strokeColor === "#f6f2e9" && node?.backgroundColor === "#18191a";
  }).toBe(true);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect.poll(async () => (await currentBridgeDocument(page)).document.canvas.background.preset).toBe("white");
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    return current.document.elements.find((element: any) => element.id === created.result.nodes.accent)?.strokeColor;
  }).toBe("#8a6418");

  const whiteNodeResponse = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [{ id: "white-default", label: "White default", x: 580, y: 100 }], edges: [] },
  } });
  expect(whiteNodeResponse.ok()).toBeTruthy();
  const whiteNode = await whiteNodeResponse.json();
  await page.getByRole("button", { name: "Blackboard" }).click();
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    const node = current.document.elements.find((element: any) => element.id === whiteNode.result.nodes["white-default"]);
    return node?.strokeColor === "#f6f2e9" && node?.backgroundColor === "#18191a";
  }).toBe(true);
  const blackboardContrast = await currentBridgeDocument(page);
  const blackboardDefault = blackboardContrast.document.elements.find((element: any) => element.id === whiteNode.result.nodes["white-default"]);
  expect(contrastRatio(blackboardDefault.strokeColor, "#18191a")).toBeGreaterThanOrEqual(4.5);

  await page.getByRole("button", { name: "White" }).click();
  const custom = await currentBridgeDocument(page);
  expect(custom.document.elements.find((element: any) => element.id === created.result.nodes.custom)?.strokeColor).toBe("#ff00cc");
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    return current.document.elements.find((element: any) => element.id === created.result.nodes.accent)?.strokeColor;
  }).toBe("#8a6418");
});

test("blackboard background survives reload and is present in PNG and JPEG exports", async ({ page }) => {
  const response = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [{ id: "pixel-check", label: "Background pixel check", x: 160, y: 100 }], edges: [] },
  } });
  expect(response.ok()).toBeTruthy();

  for (const [mimeType, signature] of [["image/png", "89504e470d0a1a0a"], ["image/jpeg", "ffd8ff"]] as const) {
    await page.getByLabel("Image export format").selectOption(mimeType);
    const downloadWait = page.waitForEvent("download");
    await page.locator("button.export-main").click();
    const download = await downloadWait;
    const image = await readFile(await download.path());
    expect(image.subarray(0, signature.length / 2).toString("hex")).toBe(signature);
    expect(await countPixelsNear(page, image, [24, 25, 26], mimeType === "image/png" ? 3 : 18, mimeType)).toBeGreaterThan(100);
  }

  await page.reload();
  await page.locator(".excalidraw canvas").first().waitFor();
  await expect(page.getByRole("button", { name: "Blackboard" })).toHaveAttribute("aria-pressed", "true");
});

test("fresh MCP canvas reads flush a just-drawn freehand edit", async ({ page }) => {
  await page.locator('.excalidraw label[title^="Draw"]').click();
  const canvas = page.locator(".excalidraw canvas").last();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Could not locate the drawing canvas.");
  const start = { x: bounds.x + bounds.width / 2 - 100, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 35, start.y - 18);
  await page.mouse.move(start.x + 70, start.y + 8);
  await page.mouse.up();

  const current = await freshBridgeDocument(page);
  expect(current.document.elements.some((element: any) => element.type === "freedraw" && element.isDeleted !== true)).toBe(true);
});

test("one infinite canvas pans and zooms across multiple independent diagrams", async ({ page }) => {
  const response = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [
      { id: "near", label: "First diagram", x: 100, y: 120 },
      { id: "far", label: "Second diagram", x: 1800, y: 120 },
    ], edges: [] },
  } });
  expect(response.ok()).toBeTruthy();
  const created = await response.json();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const zoomed = await freshBridgeDocument(page);
  expect(zoomed.document.canvas.viewport.zoom).toBeGreaterThan(1);

  const canvas = page.locator(".excalidraw canvas").last();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Could not locate the drawing canvas.");
  const start = { x: bounds.x + bounds.width - 40, y: bounds.y + bounds.height / 2 };
  await page.keyboard.down("Space");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 180, start.y + 60);
  await page.mouse.up();
  await page.keyboard.up("Space");

  const panned = await freshBridgeDocument(page);
  expect(panned.document.canvas.viewport.x).not.toBe(zoomed.document.canvas.viewport.x);
  expect(panned.document.canvas.viewport.y).not.toBe(zoomed.document.canvas.viewport.y);
  expect(panned.document.elements.some((element: any) => element.id === created.result.nodes.near)).toBe(true);
  expect(panned.document.elements.some((element: any) => element.id === created.result.nodes.far)).toBe(true);
});

test("a reloaded .draw node remains selectable and manually editable", async ({ page }) => {
  const response = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: { nodes: [{ id: "editable", label: "Before reload", x: 100, y: 100, width: 180, height: 72 }], edges: [] },
  } });
  expect(response.ok()).toBeTruthy();
  const created = await response.json();
  await waitForBridge(page);
  await page.locator(".excalidraw canvas").first().waitFor();
  const canvas = page.locator(".excalidraw canvas").last();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Could not locate the drawing canvas.");
  const point = { x: bounds.x + 100 + 90, y: bounds.y + 100 + 36 };
  await page.mouse.click(point.x, point.y);
  await expect.poll(async () => (await freshBridgeDocument(page)).document.appState.selectedElementIds?.[created.result.nodes.editable]).toBe(true);

  await page.keyboard.press("Enter");
  const editor = page.locator(".excalidraw textarea").last();
  await expect(editor).toBeVisible();
  await editor.fill("Edited after reload");
  await page.keyboard.press("Control+Enter");
  await expect.poll(async () => {
    const current = await freshBridgeDocument(page);
    return current.document.elements.some((element: any) => element.originalText === "Edited after reload");
  }).toBe(true);
});

test("long MCP labels fit inside ellipse and diamond outlines and reroute connected arrows", async ({ page }) => {
  const create = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: {
      nodes: [
        { id: "oval", label: "Oval", x: 80, y: 100, width: 180, height: 72, shape: "ellipse" },
        { id: "diamond", label: "Diamond", x: 80, y: 320, width: 180, height: 72, shape: "diamond" },
        { id: "target-oval", label: "Target", x: 520, y: 100 },
        { id: "target-diamond", label: "Target", x: 520, y: 320 },
      ],
      edges: [{ from: "oval", to: "target-oval" }, { from: "diamond", to: "target-diamond" }],
    },
  } });
  expect(create.ok()).toBeTruthy();
  const created = await create.json();
  const longText = "A considerably longer label that should wrap to several lines inside this shape";
  const update = await page.request.post(commandApi, { data: {
    operation: "update_elements",
    input: { updates: [
      { id: created.result.nodes.oval, patch: { text: longText } },
      { id: created.result.nodes.diamond, patch: { text: longText } },
    ] },
  } });
  expect(update.ok(), await update.text()).toBeTruthy();

  const current = await currentBridgeDocument(page);
  for (const nodeId of [created.result.nodes.oval, created.result.nodes.diamond]) {
    const shape = current.document.elements.find((element: any) => element.id === nodeId);
    const label = current.document.elements.find((element: any) => element.id === created.result.nodeLabels[Object.keys(created.result.nodeLabels).find((key) => created.result.nodes[key] === nodeId)!]);
    expect(label.originalText).toBe(longText);
    expect(label.text).toContain("\n");
    const widthRatio = label.width / shape.width;
    const heightRatio = label.height / shape.height;
    if (shape.type === "ellipse") expect(widthRatio ** 2 + heightRatio ** 2).toBeLessThanOrEqual(1);
    else expect(widthRatio + heightRatio).toBeLessThanOrEqual(1);
  }

  for (const nodeId of [created.result.nodes.oval, created.result.nodes.diamond]) {
    const shape = current.document.elements.find((element: any) => element.id === nodeId);
    const arrow = current.document.elements.find((element: any) => element.type === "arrow" && element.startBinding?.elementId === nodeId);
    const [pointX, pointY] = arrow.points[0];
    const dx = (arrow.x + pointX) - (shape.x + shape.width / 2);
    const dy = (arrow.y + pointY) - (shape.y + shape.height / 2);
    if (shape.type === "ellipse") expect((dx / (shape.width / 2)) ** 2 + (dy / (shape.height / 2)) ** 2).toBeCloseTo(1, 2);
    else expect(Math.abs(dx) / (shape.width / 2) + Math.abs(dy) / (shape.height / 2)).toBeCloseTo(1, 2);
  }
});

test("routes a feedback edge around the middle node and keeps its label clear after node growth", async ({ page }) => {
  const create = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: {
      title: "Specification → Validation",
      nodes: [
        { id: "spec", label: "Specification\nWhat & Why", x: 40, y: 120, width: 190, height: 82 },
        { id: "implementation", label: "Implementation\nHow", x: 290, y: 120, width: 190, height: 82, color: "#f2d27a" },
        { id: "validation", label: "Validation\nDid it work?", x: 540, y: 120, width: 190, height: 82 },
      ],
      edges: [
        { from: "spec", to: "implementation" },
        { from: "implementation", to: "validation" },
        { from: "validation", to: "spec", label: "no: revise" },
      ],
    },
  } });
  expect(create.ok(), await create.text()).toBeTruthy();
  const created = await create.json();
  const assertBackEdgeClear = async () => {
    const current = await freshBridgeDocument(page);
    const arrow = current.document.elements.find((element: any) =>
      element.type === "arrow" && element.startBinding?.elementId === created.result.nodes.validation && element.endBinding?.elementId === created.result.nodes.spec,
    );
    const middle = current.document.elements.find((element: any) => element.id === created.result.nodes.implementation);
    const middleLabel = current.document.elements.find((element: any) => element.containerId === middle.id);
    const edgeLabel = current.document.elements.find((element: any) => element.containerId === arrow.id);
    expect(arrow.points.length).toBeGreaterThan(2);
    const points = arrow.points.map(([x, y]: number[]) => [arrow.x + x, arrow.y + y]);
    const bounds = { left: middle.x - 8, right: middle.x + middle.width + 8, top: middle.y - 8, bottom: middle.y + middle.height + 8 };
    const intersects = (a: number[], b: number[]) => {
      const dx = b[0] - a[0]; const dy = b[1] - a[1];
      let low = 0; let high = 1;
      for (const [p, q] of [[-dx, a[0] - bounds.left], [dx, bounds.right - a[0]], [-dy, a[1] - bounds.top], [dy, bounds.bottom - a[1]]]) {
        if (Math.abs(p) < 0.001) { if (q < 0) return false; continue; }
        const ratio = q / p;
        if (p < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
        if (low > high) return false;
      }
      return true;
    };
    for (let index = 1; index < points.length; index += 1) expect(intersects(points[index - 1], points[index])).toBe(false);
    const overlap = (left: number, right: number, top: number, bottom: number, other: any) =>
      left < other.x + other.width && right > other.x && top < other.y + other.height && bottom > other.y;
    expect(overlap(edgeLabel.x, edgeLabel.x + edgeLabel.width, edgeLabel.y, edgeLabel.y + edgeLabel.height, middle)).toBe(false);
    expect(overlap(edgeLabel.x, edgeLabel.x + edgeLabel.width, edgeLabel.y, edgeLabel.y + edgeLabel.height, middleLabel)).toBe(false);
    return current;
  };
  await assertBackEdgeClear();
  const longUpdate = await page.request.post(commandApi, { data: {
    operation: "update_elements",
    input: { updates: [{ id: created.result.nodes.implementation, patch: { text: "Implementation\nHow we build and validate the intended outcome" } }] },
  } });
  expect(longUpdate.ok(), await longUpdate.text()).toBeTruthy();
  await assertBackEdgeClear();
});

test("the supplied reference fixture keeps chalk, layout, and editable nodes after a .draw round trip", async ({ page }) => {
  const reference = await readFile("tests/fixtures/specification-implementation-validation.draw");
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "specification-implementation-validation.draw",
    mimeType: "application/vnd.draw+json",
    buffer: reference,
  });
  await expect.poll(async () => (await freshBridgeDocument(page)).document.elements.filter((element: any) => ["rectangle", "ellipse", "diamond"].includes(element.type)).length).toBe(3);
  const initial = await freshBridgeDocument(page);
  expect(initial.document.canvas.background.preset).toBe("blackboard");
  const nodes = initial.document.elements.filter((element: any) => ["rectangle", "ellipse", "diamond"].includes(element.type));
  expect(nodes).toHaveLength(3);
  const labels = initial.document.elements.filter((element: any) => element.type === "text" && nodes.some((node: any) => node.id === element.containerId));
  expect(labels).toHaveLength(3);
  for (const label of labels) {
    const container = initial.document.elements.find((element: any) => element.id === label.containerId);
    expect(label.x).toBeGreaterThanOrEqual(container.x);
    expect(label.y).toBeGreaterThanOrEqual(container.y);
    expect(label.x + label.width).toBeLessThanOrEqual(container.x + container.width);
    expect(label.y + label.height).toBeLessThanOrEqual(container.y + container.height);
    expect(contrastRatio(label.strokeColor, "#18191a")).toBeGreaterThanOrEqual(4.5);
    const renderedWidth = await page.evaluate(async ({ text, fontSize }) => {
      await document.fonts.load(`${fontSize}px Excalifont`, text);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("Canvas text measurement is unavailable.");
      context.font = `${fontSize}px Excalifont`;
      return Math.max(...text.split("\n").map((line) => context.measureText(line).width));
    }, { text: label.text, fontSize: label.fontSize });
    expect(label.width).toBeGreaterThanOrEqual(renderedWidth);
  }
  for (const label of initial.document.elements.filter((element: any) => element.type === "text")) {
    expect(contrastRatio(label.strokeColor, "#18191a")).toBeGreaterThanOrEqual(4.5);
  }
  const emphasizedNode = nodes.find((element: any) => element.strokeColor === "#f2d27a");
  expect(emphasizedNode).toBeTruthy();
  const emphasizedLabel = labels.find((element: any) => element.containerId === emphasizedNode.id);
  expect(contrastRatio(emphasizedLabel.strokeColor, "#18191a")).toBeGreaterThanOrEqual(4.5);
  const feedback = initial.document.elements.find((element: any) => element.type === "arrow" && element.points.length > 2);
  expect(feedback).toBeTruthy();
  const middle = nodes.find((element: any) => element.id !== feedback.startBinding.elementId && element.id !== feedback.endBinding.elementId);
  const points = feedback.points.map(([x, y]: number[]) => [feedback.x + x, feedback.y + y]);
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1]; const [x2, y2] = points[index];
    const crossesMiddle = Math.abs(x1 - x2) < 0.001
      ? x1 > middle.x && x1 < middle.x + middle.width && Math.max(y1, y2) > middle.y && Math.min(y1, y2) < middle.y + middle.height
      : Math.min(x1, x2) < middle.x + middle.width && Math.max(x1, x2) > middle.x && Math.abs(y1 - y2) < 0.001 && y1 > middle.y && y1 < middle.y + middle.height;
    expect(crossesMiddle).toBe(false);
  }

  const downloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Save \.draw/ }).click();
  const savedFile = await readFile(await (await downloadWait).path());
  const saveJson = JSON.parse(savedFile.toString("utf8"));
  await page.locator('input[type="file"]').setInputFiles({ name: "reference-roundtrip.draw", mimeType: "application/vnd.draw+json", buffer: savedFile });
  const reopened = await freshBridgeDocument(page);
  expect(reopened.document.canvas.background.preset).toBe("blackboard");
  for (const node of nodes) {
    const canvas = page.locator(".excalidraw canvas").last();
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Could not locate the drawing canvas.");
    await page.mouse.click(bounds.x + node.x + node.width / 2, bounds.y + node.y + node.height / 2);
    await expect.poll(async () => (await freshBridgeDocument(page)).document.appState.selectedElementIds?.[node.id]).toBe(true);
  }
  expect(saveJson.document.elements.filter((element: any) => element.type === "rectangle")).toHaveLength(3);
  expect(saveJson.document.elements.some((element: any) => element.type === "arrow" && element.points.length > 2)).toBe(true);
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

test("PNG and JPEG exports keep the complete editable scene even when an object is selected", async ({ page }) => {
  const createdResponse = await page.request.post(commandApi, { data: {
    operation: "create_diagram",
    input: {
      title: "Export fixture: complete scene",
      nodes: [
        { id: "first", label: "First node", x: 80, y: 100, width: 190, height: 90 },
        { id: "second", label: "Second node", x: 720, y: 100, width: 190, height: 90, color: "#f2d27a" },
      ],
      edges: [{ from: "first", to: "second", label: "kept" }],
    },
  } });
  expect(createdResponse.ok(), await createdResponse.text()).toBeTruthy();

  // A vivid embedded image makes it possible to verify that export kept assets,
  // not only the vector scene. The exported image uses a regular checker pattern.
  const imageBytes = await page.evaluate(() => {
    const source = document.createElement("canvas");
    source.width = 48;
    source.height = 48;
    const context = source.getContext("2d");
    if (!context) throw new Error("Could not create the image fixture.");
    context.fillStyle = "#00e080";
    context.fillRect(0, 0, 48, 48);
    context.fillStyle = "#ff00c8";
    context.fillRect(0, 0, 24, 24);
    context.fillRect(24, 24, 24, 24);
    return Array.from(atob(source.toDataURL("image/png").split(",")[1]), (char) => char.charCodeAt(0));
  });
  await page.locator(".excalidraw").evaluate((editor, bytes) => {
    const bounds = editor.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "export-fixture.png", { type: "image/png" }));
    const coordinates = { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 + 150, bubbles: true, cancelable: true, dataTransfer: transfer };
    editor.dispatchEvent(new DragEvent("dragenter", coordinates));
    editor.dispatchEvent(new DragEvent("dragover", coordinates));
    editor.dispatchEvent(new DragEvent("drop", coordinates));
  }, imageBytes);

  await expect.poll(async () => {
    const current = await freshBridgeDocument(page);
    return current.document.elements.some((element: any) => element.type === "image") &&
      current.document.elements.filter((element: any) => element.type === "rectangle").length >= 2 &&
      current.document.elements.some((element: any) => element.type === "arrow");
  }).toBe(true);

  // The image drop leaves an object selected, matching the reported workflow.
  // Export must still be a shareable image of the whole drawing, rather than a
  // crop containing only the current selection.
  await expect.poll(async () => Object.keys((await freshBridgeDocument(page)).document.appState.selectedElementIds ?? {}).length).toBeGreaterThan(0);
  const exportScene = await freshBridgeDocument(page);
  const liveElements = exportScene.document.elements.filter((element: any) => element.isDeleted !== true);
  const sceneBounds = liveElements.reduce((bounds: { left: number; top: number; right: number; bottom: number }, element: any) => {
    const left = Math.min(element.x, element.x + element.width, ...(element.points ?? []).map((point: number[]) => element.x + point[0]));
    const top = Math.min(element.y, element.y + element.height, ...(element.points ?? []).map((point: number[]) => element.y + point[1]));
    const right = Math.max(element.x, element.x + element.width, ...(element.points ?? []).map((point: number[]) => element.x + point[0]));
    const bottom = Math.max(element.y, element.y + element.height, ...(element.points ?? []).map((point: number[]) => element.y + point[1]));
    return { left: Math.min(bounds.left, left), top: Math.min(bounds.top, top), right: Math.max(bounds.right, right), bottom: Math.max(bounds.bottom, bottom) };
  }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const exportOrigin = { x: sceneBounds.left - 32, y: sceneBounds.top - 32 };
  const nodeLabels = ["First node", "Second node"].map((label) => {
    const element = liveElements.find((candidate: any) => candidate.type === "text" && candidate.text?.includes(label));
    if (!element) throw new Error(`Could not find editable ${label} text in the exported scene.`);
    return { label, region: { left: element.x + 1, top: element.y + 1, right: element.x + element.width - 1, bottom: element.y + element.height - 1 } };
  });
  const arrow = liveElements.find((element: any) => element.type === "arrow");
  if (!arrow?.points || arrow.points.length < 2) throw new Error("Could not find the exported arrow path.");
  const arrowSegments = arrow.points.slice(1).map((point: number[], index: number) => {
    const from = { x: arrow.x + arrow.points[index][0], y: arrow.y + arrow.points[index][1] };
    const to = { x: arrow.x + point[0], y: arrow.y + point[1] };
    return { from, to, length: Math.hypot(to.x - from.x, to.y - from.y) };
  });
  const longestArrowSegment = arrowSegments.reduce((longest: any, segment: any) => segment.length > longest.length ? segment : longest);
  const arrowSample = {
    x: longestArrowSegment.from.x + (longestArrowSegment.to.x - longestArrowSegment.from.x) * 0.25,
    y: longestArrowSegment.from.y + (longestArrowSegment.to.y - longestArrowSegment.from.y) * 0.25,
  };
  const arrowRegion = { left: arrowSample.x - 9, top: arrowSample.y - 9, right: arrowSample.x + 9, bottom: arrowSample.y + 9 };

  for (const [preset, presetButton] of [["blackboard", "Blackboard Canvas"], ["white", "Whiteboard Canvas"]] as const) {
    await page.getByRole("button", { name: presetButton }).click();
    for (const mime of ["image/png", "image/jpeg"] as const) {
      const formatControl = page.getByLabel("Image export format");
      const downloadWait = page.waitForEvent("download");
      if (await formatControl.inputValue() === mime) await page.getByRole("button", { name: "Export" }).click();
      else await formatControl.selectOption(mime);
      const image = await readFile(await (await downloadWait).path());
      const sample = await inspectImagePixels(page, image, mime);
      const corner = await sampleImagePatch(page, image, { x: 0.025, y: 0.025 }, mime);
      expect(sample.greenAssetPixels, `${mime} should preserve the embedded image`).toBeGreaterThan(50);
      if (preset === "blackboard") {
        const luminance = corner[0] * 0.2126 + corner[1] * 0.7152 + corner[2] * 0.0722;
        expect(luminance, `${mime} blackboard corner should stay charcoal`).toBeLessThanOrEqual(35);
        expect(sample.whiteInkPixels, `${mime} should preserve text and chalk strokes`).toBeGreaterThan(100);
        for (const { label, region } of nodeLabels) {
          expect(await countInkInSceneRegion(page, image, mime, region, exportOrigin, "chalk"), `${mime} should render ${label} on Blackboard`).toBeGreaterThan(0);
        }
        expect(await countInkInSceneRegion(page, image, mime, arrowRegion, exportOrigin, "chalk"), `${mime} should render its arrow on Blackboard`).toBeGreaterThan(0);
      } else {
        const tolerance = mime === "image/png" ? 1 : 12;
        expect(corner.every((channel) => channel >= 255 - tolerance), `${mime} whiteboard corner should stay white: ${corner.join(", ")}`).toBe(true);
        expect(sample.darkInkPixels, `${mime} should preserve text and shape strokes`).toBeGreaterThan(100);
        for (const { label, region } of nodeLabels) {
          expect(await countInkInSceneRegion(page, image, mime, region, exportOrigin, "whiteboard-mark"), `${mime} should render ${label} on Whiteboard`).toBeGreaterThan(0);
        }
        expect(await countInkInSceneRegion(page, image, mime, arrowRegion, exportOrigin, "whiteboard-mark"), `${mime} should render its arrow on Whiteboard`).toBeGreaterThan(0);
      }
      expect(Math.abs(sample.width - (sceneBounds.right - sceneBounds.left + 64)), `${mime} width should equal scene bounds plus 32px padding on each side`).toBeLessThanOrEqual(3);
      expect(Math.abs(sample.height - (sceneBounds.bottom - sceneBounds.top + 64)), `${mime} height should equal scene bounds plus 32px padding on each side`).toBeLessThanOrEqual(3);
    }
  }

  // Keep the original selection-export feature available as an explicit scope.
  await page.getByLabel("Export scope").selectOption("selection");
  const selectionDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const selectionImage = await readFile(await (await selectionDownload).path());
  const selectionWidth = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    return bitmap.width;
  }, Array.from(selectionImage));
  expect(selectionWidth, "selection export should remain limited to the current selection").toBeLessThan(500);
});

test("selection-only export is disabled when nothing is selected", async ({ page }) => {
  await page.getByLabel("Export scope").selectOption("selection");
  await expect(page.getByRole("button", { name: "Export" })).toBeDisabled();
});

test("selection-only export reports an empty selection when the image format changes without downloading", async ({ page }) => {
  await page.getByLabel("Export scope").selectOption("selection");
  await expect(page.getByRole("button", { name: "Export" })).toBeDisabled();

  const unexpectedDownload = page.waitForEvent("download", { timeout: 1200 }).then(() => true, () => false);
  await page.getByLabel("Image export format").selectOption("image/jpeg");
  await expect(page.getByRole("status")).toContainText("Select one or more objects to export a selection");
  expect(await unexpectedDownload).toBe(false);
});
