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

test.beforeEach(async ({ page }) => {
  await waitForBridge(page);
  await page.locator(".excalidraw canvas").first().waitFor();
  await expect(page.getByRole("button", { name: "Blackboard" })).toBeEnabled();
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
  await page.getByRole("button", { name: "White" }).click();
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
  const cjkFontRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/fonts/Excalifont/")) localFontRequests.push(url);
    if (url.includes("/fonts/Xiaolai/")) cjkFontRequests.push(url);
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
  expect(image.byteLength).toBeGreaterThan(5_000);
  expect(await countWarmImagePixels(page, image)).toBeGreaterThan(40);
  expect(externalRequests).toEqual([]);
  expect(localFontRequests.every((url) => url.startsWith("http://127.0.0.1:5181/fonts/"))).toBe(true);
  expect(cjkFontRequests.every((url) => url.startsWith("http://127.0.0.1:5181/fonts/"))).toBe(true);
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
