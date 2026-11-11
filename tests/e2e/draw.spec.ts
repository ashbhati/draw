import { expect, test } from "@playwright/test";
import type { Download, Page } from "@playwright/test";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { isBundledFontURL, isSameOriginURL } from "./config";

const documentApi = "/__draw/api/document";
const commandApi = "/__draw/api/commands";

function mcpAuthHeaders() {
  const clientIdentity = process.env.DRAW_E2E_MCP_CLIENT_ID;
  const capability = process.env.DRAW_E2E_MCP_CLIENT_SECRET;
  if (!clientIdentity || !capability) throw new Error("The isolated E2E MCP client credential is unavailable.");
  return { "x-draw-client-identity": clientIdentity, authorization: `Bearer ${capability}` };
}

async function startStdioMcp(baseURL: string, documentDir: string, pairingSecret?: string, mockOpenverse = false) {
  const credentialPath = join(documentDir, "mcp-client-credential.json");
  if (!pairingSecret) {
    await writeFile(credentialPath, JSON.stringify({ installationId: "draw-e2e-mcp-host", clientIdentity: process.env.DRAW_E2E_MCP_CLIENT_ID, capability: process.env.DRAW_E2E_MCP_CLIENT_SECRET, expiresAt: Date.now() + 60 * 60_000 }), { mode: 0o600 });
    await chmod(credentialPath, 0o600);
  }
  const args = ["--import", "tsx/esm", "src/integrations/mcp-server.ts"];
  if (mockOpenverse) {
    const fixtureId = "123e4567-e89b-12d3-a456-426614174000";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ5sAAAAASUVORK5CYII=", "base64");
    const fixture = JSON.stringify({ id: fixtureId, title: "MCP chalk arrow", creator: "Draw Artist", creator_url: "https://artist.example/", foreign_landing_url: "https://source.example/chalk-arrow", license: "by", license_version: "4.0", license_url: "https://creativecommons.org/licenses/by/4.0/", attribution: "Draw Artist, CC BY 4.0", source: "Example Archive", width: 1, height: 1, filetype: "png", pngBase64: png.toString("base64") });
    const preloaderPath = join(documentDir, "mock-openverse.mjs");
    await writeFile(preloaderPath, `const fixture = ${fixture};\nlet metadataReads = 0;\nconst originalFetch = globalThis.fetch;\nglobalThis.fetch = async (input, init) => {\n const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);\n if (url.origin !== "https://api.openverse.org") return originalFetch(input, init);\n if (url.pathname === "/v1/images/") return new Response(JSON.stringify({ results: [fixture] }), { status: 200, headers: { "content-type": "application/json" } });\n if (url.pathname === "/v1/images/" + fixture.id + "/") { metadataReads += 1; return new Response(JSON.stringify({ ...fixture, title: metadataReads === 1 ? fixture.title : "Changed metadata on retry" }), { status: 200, headers: { "content-type": "application/json" } }); }\n if (url.pathname === "/v1/images/" + fixture.id + "/thumb/") return new Response(Buffer.from(fixture.pngBase64, "base64"), { status: 200, headers: { "content-type": "image/png" } });\n return new Response("not found", { status: 404 });\n};\n`);
    args.unshift("--import", preloaderPath);
  }
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, DRAW_MCP_BASE_URL: new URL(baseURL).origin, DRAW_MCP_DOCUMENT_DIR: documentDir, DRAW_MCP_CLIENT_CREDENTIAL_PATH: credentialPath, ...(pairingSecret ? { DRAW_MCP_PAIRING_SECRET: pairingSecret } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  const pending = new Map<number, { resolve: (message: any) => void; reject: (error: Error) => void }>();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
    while (output.includes("\n")) {
      const end = output.indexOf("\n");
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number") {
        const waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); waiter.resolve(message); }
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errorOutput += chunk; });
  let sequence = 0;
  const request = (method: string, params: unknown) => {
    const id = ++sequence;
    const response = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out. ${errorOutput}`)); }, 15_000);
      pending.set(id, { resolve: (message) => { clearTimeout(timeout); resolve(message); }, reject });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "draw-e2e", version: "1.0" },
  });
  if (initialized.error) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)} ${errorOutput}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    request,
    call: async (name: string, args: Record<string, unknown>) => {
      const durableMutation = ["create_diagram", "create_elements", "update_elements", "delete_elements", "duplicate_elements", "group_elements", "ungroup_elements", "arrange_elements", "undo_operation", "redo_operation", "set_canvas_settings", "set_viewport", "insert_workspace_library_item"].includes(name);
      const argumentsWithKey = durableMutation && typeof args.idempotencyKey !== "string" ? { ...args, idempotencyKey: `e2e-${crypto.randomUUID()}` } : args;
      try { return await request("tools/call", { name, arguments: argumentsWithKey }); }
      catch (error) { throw new Error(`MCP tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`); }
    },
    credentialPath,
    close: async () => {
      child.stdin.end();
      await new Promise<void>((resolve) => { child.once("exit", () => resolve()); setTimeout(() => { child.kill(); resolve(); }, 2_000); });
    },
  };
}

async function currentBridgeDocument(page: Page) {
  const response = await page.request.get(documentApi, { headers: mcpAuthHeaders() });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function freshBridgeDocument(page: Page) {
  const response = await page.request.get(`${documentApi}?flush=1`, { headers: mcpAuthHeaders() });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function waitForImageToSettle(page: Page, expectedNaturalSize: { width: number; height: number }) {
  await expect.poll(async () => {
    const snapshot = await freshBridgeDocument(page);
    const image = snapshot.document.elements.find((element: any) => element.type === "image" && element.isDeleted !== true);
    const asset = image && snapshot.document.assets?.[image.fileId];
    if (!image || !asset?.dataURL) return null;
    const naturalSize = await page.evaluate((dataURL) => new Promise<{ width: number; height: number } | null>((resolve) => {
      const decoded = new Image();
      decoded.onload = () => resolve({ width: decoded.naturalWidth, height: decoded.naturalHeight });
      decoded.onerror = () => resolve(null);
      decoded.src = dataURL;
      if (decoded.complete && decoded.naturalWidth > 0) resolve({ width: decoded.naturalWidth, height: decoded.naturalHeight });
    }), asset.dataURL);
    if (!naturalSize) return null;
    return {
      width: image.width,
      height: image.height,
      naturalWidth: naturalSize.width,
      naturalHeight: naturalSize.height,
    };
  }, { timeout: 10_000 }).toMatchObject({
    width: expectedNaturalSize.width,
    height: expectedNaturalSize.height,
    naturalWidth: expectedNaturalSize.width,
    naturalHeight: expectedNaturalSize.height,
  });
  return freshBridgeDocument(page);
}

function expectedSceneExportSize(elements: any[], padding = 32) {
  const visible = elements.filter((element) => element.isDeleted !== true);
  const left = Math.min(...visible.map((element) => element.x));
  const top = Math.min(...visible.map((element) => element.y));
  const right = Math.max(...visible.map((element) => element.x + element.width));
  const bottom = Math.max(...visible.map((element) => element.y + element.height));
  return { width: Math.ceil(right - left + padding * 2), height: Math.ceil(bottom - top + padding * 2) };
}

function expectExportSizeMatchesScene(actual: { width: number; height: number }, expected: { width: number; height: number }) {
  expect(Math.abs(actual.width - expected.width), "bitmap width must equal scene bounds plus 32px padding on both sides").toBeLessThanOrEqual(1);
  expect(Math.abs(actual.height - expected.height), "bitmap height must equal scene bounds plus 32px padding on both sides").toBeLessThanOrEqual(1);
}

async function captureSingleDownload(page: Page, trigger: () => Promise<void>): Promise<Download> {
  const observed: Download[] = [];
  const trackDownload = (download: Download) => observed.push(download);
  page.on("download", trackDownload);
  try {
    const downloadWait = page.waitForEvent("download");
    await trigger();
    const download = await downloadWait;
    await page.waitForTimeout(250);
    expect(observed, "one format change or Export click must create exactly one download before the next export").toEqual([download]);
    return download;
  } finally {
    page.off("download", trackDownload);
  }
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

async function connectEditorToMcp(page: Page, requestFreshCode = false) {
  await page.getByRole("button", { name: "Connect MCP" }).click();
  if (requestFreshCode) {
    await page.getByRole("button", { name: "Request fresh code" }).click();
    await expect(page.getByText(/fresh code was printed in the trusted terminal/i)).toBeVisible();
  }
  const codeResponse = await page.request.get("/__draw/api/e2e/active-launch-code", {
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(codeResponse.ok(), "the isolated E2E server should provide its current launch code to Playwright").toBeTruthy();
  const { code } = await codeResponse.json();
  await page.getByLabel("Launch code").fill(code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "MCP connected", exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).hash).toBe("");
}

async function waitForBridge(page: Page) {
  await page.goto("/");
  await page.locator(".topbar").waitFor();
  await connectEditorToMcp(page);
  await expect.poll(async () => {
    const health = await (await page.request.get("/__draw/api/health")).json();
    const document = await page.request.get(documentApi, { headers: mcpAuthHeaders() });
    if (!health.ok || !document.ok()) return `${JSON.stringify(health)}; document HTTP ${document.status()}: ${await document.text()}`;
    return true;
  }).toBe(true);
}

async function readLocalDocument(page: Page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("draw-local");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("documents", "readonly").objectStore("documents").get("current");
      read.onsuccess = () => { resolve(read.result ?? null); db.close(); };
      read.onerror = () => reject(read.error);
    };
  }));
}

async function currentWorkspaceId(page: Page) {
  return page.getByRole("combobox", { name: "Saved workspaces" }).inputValue();
}
async function workspaceCount(page: Page) {
  return page.getByRole("combobox", { name: "Saved workspaces" }).locator("option").count();
}
async function selectWorkspace(page: Page, id: string) {
  const picker = page.getByRole("combobox", { name: "Saved workspaces" });
  await picker.focus();
  await picker.selectOption(id);
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

async function inspectBlackboardImage(page: Page, image: Buffer, mimeType: "image/png" | "image/jpeg", includeHorizontalSeam = false) {
  return page.evaluate(async ({ encodedImage, mime, checkHorizontalSeam }) => {
    // Send one compact base64 value, decode once, and read the image pixels once.
    const binary = atob(encodedImage);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas pixel inspection is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const luma = (x: number, y: number) => {
      const offset = (y * bitmap.width + x) * 4;
      return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    };
    const regionStats = (startX: number, endX: number, startY: number, endY: number) => {
      let count = 0;
      let sum = 0;
      let sumSquares = 0;
      for (let y = Math.floor(bitmap.height * startY); y < Math.floor(bitmap.height * endY); y += 2) {
        for (let x = Math.floor(bitmap.width * startX); x < Math.floor(bitmap.width * endX); x += 2) {
          const value = luma(x, y);
          count += 1;
          sum += value;
          sumSquares += value * value;
        }
      }
      const mean = sum / count;
      return { mean, standardDeviation: Math.sqrt(sumSquares / count - mean * mean) };
    };
    const seamStats = (axis: "vertical" | "horizontal", seam: number) => {
      const sampleCount = axis === "vertical" ? bitmap.height : bitmap.width;
      let seamDifference = 0;
      let neighboringDifference = 0;
      let seamCount = 0;
      let neighborCount = 0;
      for (let index = Math.floor(sampleCount * 0.25); index < Math.floor(sampleCount * 0.75); index += 2) {
        const before = axis === "vertical" ? luma(seam - 1, index) : luma(index, seam - 1);
        const after = axis === "vertical" ? luma(seam, index) : luma(index, seam);
        seamDifference += Math.abs(after - before);
        seamCount += 1;
        for (const offset of [-5, -4, -3, -2, 2, 3, 4, 5]) {
          const x = axis === "vertical" ? seam + offset : index;
          const y = axis === "horizontal" ? seam + offset : index;
          neighboringDifference += Math.abs(luma(x, y) - luma(x - (axis === "vertical" ? 1 : 0), y - (axis === "horizontal" ? 1 : 0)));
          neighborCount += 1;
        }
      }
      return { seamDifference: seamDifference / seamCount, neighboringDifference: neighboringDifference / neighborCount };
    };
    const boardSamples: number[] = [];
    // Sample the same UI-free center-board area in live and exported images.
    for (const [startX, endX] of [[0.34, 0.42], [0.58, 0.66]] as const) {
      for (let y = Math.floor(bitmap.height * 0.3); y < Math.floor(bitmap.height * 0.7); y += 2) {
        for (let x = Math.floor(bitmap.width * startX); x < Math.floor(bitmap.width * endX); x += 2) boardSamples.push(luma(x, y));
      }
    }
    const boardMean = boardSamples.reduce((sum, value) => sum + value, 0) / boardSamples.length;
    const boardStandardDeviation = Math.sqrt(boardSamples.reduce((sum, value) => sum + (value - boardMean) ** 2, 0) / boardSamples.length);
    let horizontalGrain = 0;
    let verticalGrain = 0;
    for (const [startX, endX] of [[0.34, 0.42], [0.58, 0.66]] as const) {
      for (let y = Math.floor(bitmap.height * 0.3); y < Math.floor(bitmap.height * 0.7) - 1; y += 2) {
        for (let x = Math.floor(bitmap.width * startX); x < Math.floor(bitmap.width * endX) - 1; x += 2) {
          horizontalGrain += Math.abs(luma(x + 1, y) - luma(x, y));
          verticalGrain += Math.abs(luma(x, y + 1) - luma(x, y));
        }
      }
    }
    const grainRatio = verticalGrain / horizontalGrain;
    const nodeInterior = regionStats(0.04, 0.055, 0.27, 0.32);
    return {
      width: bitmap.width,
      height: bitmap.height,
      board: { mean: boardMean, standardDeviation: boardStandardDeviation },
      grainRatio,
      edges: {
        left: regionStats(0.005, 0.02, 0.25, 0.75),
        leftAdjacent: regionStats(0.03, 0.045, 0.25, 0.75),
        right: regionStats(0.98, 0.995, 0.25, 0.75),
        rightAdjacent: regionStats(0.955, 0.97, 0.25, 0.75),
      },
      verticalSeam: seamStats("vertical", 2000),
      ...(checkHorizontalSeam ? { horizontalSeam: seamStats("horizontal", 1200) } : {}),
      nodeInteriorStandardDeviation: nodeInterior.standardDeviation,
    };
  }, { encodedImage: image.toString("base64"), mime: mimeType, checkHorizontalSeam: includeHorizontalSeam });
}

async function inspectCompactBlackboardImage(page: Page, image: Buffer, mimeType: "image/png" | "image/jpeg", matchingLivePatch = false) {
  return page.evaluate(async ({ encodedImage, mime, matchingLivePatch }) => {
    const binary = atob(encodedImage);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas pixel inspection is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const luma = (x: number, y: number) => {
      const offset = (y * bitmap.width + x) * 4;
      return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    };
    const board: number[] = [];
    // When comparing live and exported texture, sample the same empty top-right
    // board patch. Otherwise, sample bands above and below a compact flow.
    const boardRegions = matchingLivePatch
      ? [[0.82, 0.95, 0.05, 0.16]] as const
      : [[0.03, 0.97, 0.03, 0.14], [0.03, 0.97, 0.86, 0.97]] as const;
    for (const [left, right, top, bottom] of boardRegions) {
      for (let y = Math.floor(bitmap.height * top); y < Math.floor(bitmap.height * bottom); y += 3) {
        for (let x = Math.floor(bitmap.width * left); x < Math.floor(bitmap.width * right); x += 3) board.push(luma(x, y));
      }
    }
    const mean = board.reduce((sum, value) => sum + value, 0) / board.length;
    const standardDeviation = Math.sqrt(board.reduce((sum, value) => sum + (value - mean) ** 2, 0) / board.length);
    const palette = [[47, 134, 201], [230, 75, 69], [84, 174, 102], [229, 194, 77]];
    const palettePixels = palette.map((color) => {
      let count = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (Math.abs(data[index] - color[0]) <= 38 && Math.abs(data[index + 1] - color[1]) <= 38 && Math.abs(data[index + 2] - color[2]) <= 38) count += 1;
      }
      return count;
    });
    return { width: bitmap.width, height: bitmap.height, mean, standardDeviation, palettePixels };
  }, { encodedImage: image.toString("base64"), mime: mimeType, matchingLivePatch });
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
  await page.addInitScript(() => {
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = ((object: Blob | MediaSource) => {
      if (object instanceof Blob && object.type.includes("image/svg+xml")) {
        const current = window as any;
        const sequence = (current.__drawExportSvgSequence ?? 0) + 1;
        current.__drawExportSvgSequence = sequence;
        void object.text().then((svg) => {
          current.__drawLastExportSvg = svg;
          current.__drawLastExportSvgSequence = sequence;
        });
      }
      return createObjectURL(object);
    }) as typeof URL.createObjectURL;
  });
  await waitForBridge(page);
  await page.locator(".excalidraw canvas").first().waitFor();
  await expect(page.getByRole("button", { name: "Blackboard", exact: true })).toBeEnabled();
});

test("canvas choices are in the main toolbar and replace the quick-start rail", async ({ page }) => {
  const toolbar = page.getByRole("group", { name: "Canvas" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Blackboard", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Whiteboard", exact: true })).toBeVisible();
  await expect(toolbar.getByText("Canvas:", { exact: true })).toBeVisible();
  await expect(page.locator(".editor-shell").getByRole("group", { name: "Canvas" })).toBeVisible();
  await expect(toolbar.locator(".draw-canvas-option").first()).toBeVisible();
  await expect(page.locator(".side-rail")).toHaveCount(0);
  await expect(page.getByText("QUICK START")).toHaveCount(0);

  await toolbar.getByRole("button", { name: "Whiteboard", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "Whiteboard", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await currentBridgeDocument(page)).document.canvas.background.preset).toBe("white");
  await toolbar.getByRole("button", { name: "Blackboard", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "Blackboard", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("the editor omits the redundant canvas status strip without leaving a spacer", async ({ page }) => {
  await expect(page.getByText(/Infinite canvas\s*·\s*(Blackboard|Whiteboard) Canvas/)).toHaveCount(0);
  await expect(page.locator(".editor-shell")).toBeVisible();
  const canvasArea = await page.locator(".canvas-area").boundingBox();
  const editor = await page.locator(".editor-shell").boundingBox();
  expect(canvasArea).not.toBeNull();
  expect(editor).not.toBeNull();
  expect(editor!.y - canvasArea!.y).toBeLessThanOrEqual(1);
  expect(editor!.height).toBeGreaterThan(200);
});

test("canvas controls fit inside the editor across responsive breakpoints", async ({ page }) => {
  const toolbar = page.getByRole("group", { name: "Canvas" });
  const selector = toolbar.getByLabel("Canvas background");
  await expect(selector.locator("option")).toHaveText(["Blackboard", "Whiteboard"]);
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
      let bounds: Awaited<ReturnType<typeof selector.boundingBox>> = null;
      await expect.poll(async () => { bounds = await selector.boundingBox(); return bounds !== null; }).toBe(true);
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
      for (const button of [toolbar.getByRole("button", { name: "Blackboard", exact: true }), toolbar.getByRole("button", { name: "Whiteboard", exact: true })]) {
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

test("Blackboard texture is seam-safe across large live/PNG/JPEG canvases and shows through MCP nodes", async ({ page }) => {
  const createResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-526", nodes: [
      { id: "dark-fill", label: "Readable node", x: 200, y: 180, width: 160, height: 72 },
      { id: "wide-export-anchor", label: "Wide export", x: 2400, y: 180, width: 160, height: 72 },
    ], edges: [] },
  } });
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
  const viewport = { width: 2400, height: 1700 };
  await page.setViewportSize(viewport);
  await page.waitForTimeout(100);
  const document = await currentBridgeDocument(page);
  expect(document.document.elements.filter((element: any) => element.type === "rectangle")).toEqual(expect.arrayContaining([
    expect.objectContaining({ backgroundColor: "transparent", strokeColor: "#f6f2e9" }),
  ]));
  expect(document.document.elements.some((element: any) => element.type === "text" && element.text === "Readable node" && element.strokeColor === "#f6f2e9"), "node label remains chalk colored and readable").toBe(true);
  const liveBoard = await page.locator(".editor-shell").screenshot();

  const pngDownloadWait = page.waitForEvent("download");
  await page.locator("button.export-main").click();
  const png = await readFile(await (await pngDownloadWait).path());

  const jpegDownloadWait = page.waitForEvent("download");
  await page.getByLabel("Image export format").selectOption("image/jpeg");
  const jpeg = await readFile(await (await jpegDownloadWait).path());

  const [livePixels, pngPixels, jpegPixels] = await Promise.all([
    inspectBlackboardImage(page, liveBoard, "image/png", true),
    inspectBlackboardImage(page, png, "image/png"),
    inspectBlackboardImage(page, jpeg, "image/jpeg"),
  ]);
  for (const [format, pixels] of [["live", livePixels], ["PNG", pngPixels], ["JPEG", jpegPixels]] as const) {
    expect(pixels.width, `${format} width includes the x=2000 boundary`).toBeGreaterThan(2100);
    expect(pixels.height, `${format} keeps the full board image`).toBeGreaterThan(format === "live" ? 1200 : 120);
    expect(pixels.board.standardDeviation, `${format} exposed slate is not flat`).toBeGreaterThan(2.5);
    expect(pixels.board.mean, `${format} board brightness`).toBeGreaterThan(20);
    expect(pixels.board.mean, `${format} board brightness`).toBeLessThan(80);
    expect(pixels.edges.left.standardDeviation, `${format} left edge has chalk grain`).toBeGreaterThan(3);
    expect(pixels.edges.right.standardDeviation, `${format} right edge has chalk grain`).toBeGreaterThan(3);
    expect(Math.abs(pixels.edges.left.mean - pixels.edges.leftAdjacent.mean), `${format} left edge has no vertical band`).toBeLessThan(13);
    expect(Math.abs(pixels.edges.right.mean - pixels.edges.rightAdjacent.mean), `${format} right edge has no vertical band`).toBeLessThan(13);
    expect(pixels.verticalSeam.seamDifference, `${format} vertical seam continuity`).toBeLessThan(pixels.verticalSeam.neighboringDifference * 2.2 + 2);
    if (format === "live") {
      expect(pixels.horizontalSeam!.seamDifference, "live horizontal seam continuity").toBeLessThan(pixels.horizontalSeam!.neighboringDifference * 2.2 + 2);
    }
  }
  expect(Math.abs(livePixels.board.standardDeviation - pngPixels.board.standardDeviation), "live/PNG texture variation").toBeLessThan(5);
  expect(Math.abs(livePixels.board.standardDeviation - jpegPixels.board.standardDeviation), "live/JPEG texture variation").toBeLessThan(5);
  expect(Math.abs(livePixels.board.mean - pngPixels.board.mean), "live/PNG average board color").toBeLessThan(12);
  expect(Math.abs(livePixels.board.mean - jpegPixels.board.mean), "live/JPEG average board color").toBeLessThan(14);
  expect(pngPixels.width / pngPixels.height, "PNG is a wide-short export").toBeGreaterThanOrEqual(6);
  expect(jpegPixels.width / jpegPixels.height, "JPEG is a wide-short export").toBeGreaterThanOrEqual(6);
  for (const [format, pixels] of [["PNG", pngPixels], ["JPEG", jpegPixels]] as const) {
    expect(Math.abs(pixels.grainRatio / livePixels.grainRatio), `${format}/live grain scale ratio`).toBeLessThan(1.3);
    expect(Math.abs(pixels.grainRatio / livePixels.grainRatio), `${format}/live grain scale ratio`).toBeGreaterThan(1 / 1.3);
  }

  // Sample the top-right inside the first node, away from its label and border.
  // A flat filled slab has almost no pixel variation; a transparent node keeps
  // the Blackboard residue visible under its outline and text.
  expect(pngPixels.nodeInteriorStandardDeviation, "PNG node interior retains board grain").toBeGreaterThan(2);
  expect(jpegPixels.nodeInteriorStandardDeviation, "JPEG node interior retains board grain").toBeGreaterThan(2);
});

test("natural Blackboard texture stays subdued behind a compact three-node flow in PNG and JPEG", async ({ page }) => {
  const createdResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-591",
      nodes: [
        { id: "analyze", label: "Analyze", x: 80, y: 140, width: 170, height: 76, color: "#2f86c9" },
        { id: "measure", label: "Measure", x: 360, y: 140, width: 170, height: 76, color: "#e64b45" },
        { id: "improve", label: "Improve", x: 640, y: 140, width: 170, height: 76, color: "#54ae66" },
      ],
      edges: [
        { from: "analyze", to: "measure", color: "#e5c24d" },
        { from: "measure", to: "improve", color: "#e5c24d" },
      ],
    },
  } });
  expect(createdResponse.ok(), await createdResponse.text()).toBeTruthy();
  await expect.poll(async () => {
    const current = await freshBridgeDocument(page);
    return current.document.elements.filter((element: any) => element.type === "arrow").length;
  }).toBe(2);

  await page.setViewportSize({ width: 1280, height: 360 });
  await page.locator(".draw-app").evaluate((element) => { (element as HTMLElement).style.minHeight = "0"; });
  await page.addStyleTag({ content: ".editor-shell button,.editor-shell [role=button],.editor-shell [role=toolbar],.editor-shell .App-menu_top,.editor-shell .App-menu_bottom{visibility:hidden!important}" });
  await page.waitForTimeout(100);
  const textureURL = await page.locator(".editor-shell").evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(textureURL, "live canvas uses the bundled natural texture").toContain("blackboard-texture");
  const liveShot = await page.locator(".editor-shell").screenshot();
  const pngDownloadWait = page.waitForEvent("download");
  await page.locator("button.export-main").click();
  const png = await readFile(await (await pngDownloadWait).path());
  const jpegDownloadWait = page.waitForEvent("download");
  await page.getByLabel("Image export format").selectOption("image/jpeg");
  await page.locator("button.export-main").click();
  const jpeg = await readFile(await (await jpegDownloadWait).path());

  const [livePixels, pngPixels, jpegPixels] = await Promise.all([
    inspectCompactBlackboardImage(page, liveShot, "image/png", true),
    inspectCompactBlackboardImage(page, png, "image/png", true),
    inspectCompactBlackboardImage(page, jpeg, "image/jpeg", true),
  ]);
  expect(livePixels.width / livePixels.height, "live preview and exports use comparable cover scales").toBeGreaterThan(pngPixels.width / pngPixels.height - 1);
  expect(livePixels.width / livePixels.height, "live preview and exports use comparable cover scales").toBeLessThan(pngPixels.width / pngPixels.height + 1);
  for (const [format, pixels] of [["live", livePixels], ["PNG", pngPixels], ["JPEG", jpegPixels]] as const) {
    expect(pixels.width, `${format} is a compact diagram export`).toBeLessThan(1800);
    expect(pixels.height).toBeLessThan(1200);
  }
  for (const [format, pixels] of [["live", livePixels], ["PNG", pngPixels], ["JPEG", jpegPixels]] as const) {
    expect(pixels.mean, `${format} remains a dark slate`).toBeGreaterThan(18);
    expect(pixels.mean, `${format} remains a dark slate`).toBeLessThan(90);
    expect(pixels.standardDeviation, `${format} exposed slate is not flat`).toBeGreaterThan(2.5);
    expect(pixels.standardDeviation, `${format} slate texture remains subdued`).toBeLessThan(25);
  }
  for (const [format, pixels] of [["PNG", pngPixels], ["JPEG", jpegPixels]] as const) {
    expect(pixels.palettePixels.every((count) => count > 8), `${format} keeps colored strokes and connectors visible`).toBe(true);
  }
  expect(Math.abs(pngPixels.mean - livePixels.mean), "PNG and live share the same board tone").toBeLessThan(14);
  expect(Math.abs(jpegPixels.mean - livePixels.mean), "JPEG and live share the same board tone").toBeLessThan(14);
  expect(Math.abs(pngPixels.standardDeviation - livePixels.standardDeviation), "PNG and live share the same texture strength").toBeLessThan(8);
  expect(Math.abs(jpegPixels.standardDeviation - livePixels.standardDeviation), "JPEG and live share the same texture strength").toBeLessThan(8);
  expect(Math.abs(pngPixels.mean - jpegPixels.mean), "PNG and JPEG retain similar board tone").toBeLessThan(8);
  expect(Math.abs(pngPixels.standardDeviation - jpegPixels.standardDeviation), "PNG and JPEG retain similar texture strength").toBeLessThan(6);
});

test("the Draw wordmark and Open .draw action do not overlap on narrow screens", async ({ page }) => {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const brand = await page.locator(".brand-name").boundingBox();
    const open = await page.getByRole("button", { name: "Open", exact: true }).boundingBox();
    expect(brand, `wordmark should be visible at ${width}px`).not.toBeNull();
    expect(open, `Open .draw should be visible at ${width}px`).not.toBeNull();
    const overlaps = brand!.x < open!.x + open!.width && brand!.x + brand!.width > open!.x && brand!.y < open!.y + open!.height && brand!.y + brand!.height > open!.y;
    expect(overlaps, `wordmark should not overlap Open .draw at ${width}px`).toBe(false);
  }
});

test("MCP create and update stay editable through save, reload, open, and image export", async ({ page }) => {
  const createdResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-667",
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
  await page.getByRole("button", { name: "Whiteboard", exact: true }).click();
  await expect(page.getByRole("button", { name: "Whiteboard", exact: true })).toHaveAttribute("aria-pressed", "true");

  const editedElementId = created.result.nodes.spec;
  const longText = "A considerably longer label that should wrap inside the node";
  const updateResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "update_elements",
    input: { idempotencyKey: "e2e-direct-700", updates: [{ id: editedElementId, patch: { text: longText, x: 96, y: 132 } }] },
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Whiteboard", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await readLocalDocument(page)).document.elements.some((element: any) => element.originalText === longText)).toBeTruthy();
  await connectEditorToMcp(page, true);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"][accept^=".draw"]').setInputFiles({
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
  const response = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-753",
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
  const createResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-780", nodes: [{ id: "roundtrip", label: "Downloaded editable diagram", x: 140, y: 120 }], edges: [] },
  } });
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
  const created = await createResponse.json();

  await page.getByLabel("Drawing title").fill("Portable Asset Round Trip");
  await page.getByRole("button", { name: "Whiteboard", exact: true }).click();
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
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

  await page.getByLabel("Drawing title").fill("Changed before opening saved file");
  await page.getByRole("button", { name: "Blackboard", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  const changedBeforeOpen = await freshBridgeDocument(page);
  expect(changedBeforeOpen.document.title).toBe("Changed before opening saved file");
  expect(changedBeforeOpen.document.canvas.background.preset).toBe("blackboard");
  expect(changedBeforeOpen.document.canvas.viewport).not.toEqual(firstFile.document.canvas.viewport);
  expect(changedBeforeOpen.document.elements.some((element: any) => element.id === created.result.nodes.roundtrip)).toBe(true);

  page.once("dialog", (dialog) => dialog.accept());
  const firstChooserWait = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await (await firstChooserWait).setFiles(firstFilePath);
  await expect.poll(async () => {
    const reopened = await freshBridgeDocument(page);
    return reopened.document.elements.some((element: any) => element.id === created.result.nodes.roundtrip);
  }).toBe(true);
  await expect.poll(async () => (await freshBridgeDocument(page)).document.canvas.viewport, { timeout: 10_000 })
    .toEqual(firstFile.document.canvas.viewport);
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
  const updateResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "update_elements",
    input: { idempotencyKey: "e2e-direct-866", updates: [{ id: created.result.nodes.roundtrip, patch: { text: editedText } }] },
  } });
  expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
  await expect.poll(async () => {
    const current = await freshBridgeDocument(page);
    return current.document.elements.some((element: any) => element.originalText === editedText);
  }).toBe(true);

  const secondDownloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const secondDownload = await secondDownloadWait;
  const secondFilePath = await secondDownload.path();
  const secondFile = JSON.parse((await readFile(secondFilePath)).toString("utf8"));
  expect(secondFile.document.elements.some((element: any) => element.originalText === editedText)).toBe(true);

  page.once("dialog", (dialog) => dialog.accept());
  const secondChooserWait = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await (await secondChooserWait).setFiles(secondFilePath);
  await expect.poll(async () => {
    const reopened = await freshBridgeDocument(page);
    return reopened.document.elements.some((element: any) => element.originalText === editedText);
  }).toBe(true);
});

test("fresh reads during import preserve the incoming workspace viewport", async ({ page }) => {
  const incoming = await freshBridgeDocument(page);
  incoming.document.title = "Incoming viewport";
  incoming.document.canvas.viewport = { x: -123, y: 87, zoom: 1.7 };
  await page.locator('input[type="file"][accept^=".draw"]').setInputFiles({
    name: "incoming.draw", mimeType: "application/vnd.draw+json", buffer: Buffer.from(JSON.stringify(incoming)),
  });
  let sawIncoming = false;
  for (let index = 0; index < 10; index += 1) {
    const snapshot = await freshBridgeDocument(page);
    if (snapshot.document.title === "Incoming viewport") {
      sawIncoming = true;
      expect(snapshot.document.canvas.viewport).toEqual(incoming.document.canvas.viewport);
    }
  }
  expect(sawIncoming).toBe(true);
  await expect.poll(async () => (await readLocalDocument(page))?.document.canvas.viewport).toEqual(incoming.document.canvas.viewport);
});

test("malformed .draw files leave the current canvas and local autosave untouched", async ({ page }) => {
  const create = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-894", nodes: [{ id: "keep", label: "Keep this work", x: 100, y: 100 }], edges: [] },
  } });
  expect(create.ok()).toBeTruthy();
  const before = await currentBridgeDocument(page);
  const malformed = Buffer.from(JSON.stringify({
    format: "draw", formatVersion: 1,
    document: { id: "bad", title: "Bad", canvas: { infinite: true, background: "oops", viewport: { x: 0, y: 0, zoom: 1 } }, elments: [], appState: {}, assets: {} },
  }));

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"][accept^=".draw"]').setInputFiles({ name: "broken.draw", mimeType: "application/json", buffer: malformed });
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
  await expect(secondTab.getByRole("button", { name: "Whiteboard", exact: true })).toBeDisabled();
});

test("a mounted read-only tab with an older library view cannot clear a newer library item", async ({ page }) => {
  const staleTab = await page.context().newPage();
  await staleTab.goto("/");
  await staleTab.locator(".excalidraw canvas").first().waitFor();
  await expect(staleTab.getByText(/reload this tab to edit/i)).toBeVisible();
  await expect(staleTab.getByRole("button", { name: /Manage library/ })).toHaveCount(0);

  const createdResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "readonly-library-create", nodes: [{ id: "readonly-library-node", label: "Persisted from writer", x: 100, y: 100 }], edges: [] },
  } });
  expect(createdResponse.ok(), await createdResponse.text()).toBeTruthy();
  const created = await createdResponse.json();
  const current = await freshBridgeDocument(page);
  const emptyListResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: { operation: "list_workspace_library", input: { documentId: current.document.id } } });
  expect(emptyListResponse.ok(), await emptyListResponse.text()).toBeTruthy();
  const emptyList = await emptyListResponse.json();
  const addedResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "add_selection_to_workspace_library",
    input: {
      documentId: current.document.id, expectedDocumentRevision: current.document.documentRevision,
      expectedLibraryRevision: emptyList.result.libraryRevision, idempotencyKey: "readonly-library-add",
      itemId: "readonly-library-item", elementIds: [created.result.nodes["readonly-library-node"]], name: "Writer's new item",
    },
  } });
  expect(addedResponse.ok(), await addedResponse.text()).toBeTruthy();

  await expect(staleTab.getByRole("button", { name: /Manage library/ })).toHaveCount(0);
  await staleTab.waitForTimeout(150);
  const storedLibrary = await staleTab.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction("workspaceLibrary", "readonly");
      const records = await new Promise<any[]>((resolve, reject) => {
        const request = transaction.objectStore("workspaceLibrary").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return records.flatMap((record) => Array.isArray(record) ? record : record.items ?? []);
    } finally { db.close(); }
  });
  expect(storedLibrary).toContainEqual(expect.objectContaining({ id: "readonly-library-item", name: "Writer's new item" }));
  await staleTab.close();
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

test("loads fonts and exports the hand-drawn scene without network access", async ({ page, baseURL }) => {
  const externalRequests: string[] = [];
  const localFontRequests: string[] = [];
  const cjkFontRequests: string[] = [];
  if (!baseURL) throw new Error("Playwright did not provide the configured base URL.");
  const localOrigin = new URL(baseURL).origin;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/fonts/Excalifont/")) localFontRequests.push(url);
    if (url.includes("/fonts/Xiaolai/")) cjkFontRequests.push(url);
    if (url.startsWith("http") && !isSameOriginURL(url, localOrigin)) externalRequests.push(url);
  });
  await page.route("**/*", (route) => {
    const requestURL = route.request().url();
    if (requestURL.startsWith("data:") || isSameOriginURL(requestURL, localOrigin)) return route.continue();
    return route.abort();
  });
  await waitForBridge(page);
  await expect(page.getByRole("button", { name: "Blackboard", exact: true })).toBeEnabled();
  const response = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-978", nodes: [{ id: "offline", label: "Offline hand-drawn text 中文 日本語 한국어", x: 100, y: 100, color: "#f2d27a" }], edges: [] },
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
  const board = await inspectCompactBlackboardImage(page, image, "image/png");
  expect(board.mean, "the export includes a dark slate board").toBeLessThan(90);
  expect(board.standardDeviation, "the exposed board texture is not flat").toBeGreaterThan(2.5);
  expect(externalRequests).toEqual([]);
  expect(localFontRequests.every((url) => isBundledFontURL(url, localOrigin))).toBe(true);
  expect(cjkFontRequests.every((url) => isBundledFontURL(url, localOrigin))).toBe(true);
});

test("background changes recolor Draw defaults, preserve custom colors, and undo and redo", async ({ page }) => {
  await page.getByRole("button", { name: "Blackboard", exact: true }).click();
  const response = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-1003",
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
    return current.document.canvas.background.preset === "blackboard" && node?.strokeColor === "#f6f2e9" && node?.backgroundColor === "transparent";
  }).toBe(true);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect.poll(async () => (await currentBridgeDocument(page)).document.canvas.background.preset).toBe("white");
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    return current.document.elements.find((element: any) => element.id === created.result.nodes.accent)?.strokeColor;
  }).toBe("#8a6418");

  const whiteNodeResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-1042", nodes: [{ id: "white-default", label: "White default", x: 580, y: 100 }], edges: [] },
  } });
  expect(whiteNodeResponse.ok()).toBeTruthy();
  const whiteNode = await whiteNodeResponse.json();
  await page.getByRole("button", { name: "Blackboard", exact: true }).click();
  await expect.poll(async () => {
    const current = await currentBridgeDocument(page);
    const node = current.document.elements.find((element: any) => element.id === whiteNode.result.nodes["white-default"]);
    return node?.strokeColor === "#f6f2e9" && node?.backgroundColor === "transparent";
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
  const response = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-1068", nodes: [{ id: "pixel-check", label: "Background pixel check", x: 160, y: 100 }], edges: [] },
  } });
  expect(response.ok()).toBeTruthy();

  for (const [mimeType, signature] of [["image/png", "89504e470d0a1a0a"], ["image/jpeg", "ffd8ff"]] as const) {
    const formatControl = page.getByLabel("Image export format");
    const downloadWait = page.waitForEvent("download");
    if (await formatControl.inputValue() === mimeType) await page.locator("button.export-main").click();
    else await formatControl.selectOption(mimeType); // Changing format exports immediately.
    const download = await downloadWait;
    const image = await readFile(await download.path());
    expect(image.subarray(0, signature.length / 2).toString("hex")).toBe(signature);
    const board = await inspectCompactBlackboardImage(page, image, mimeType);
    expect(board.mean, `${mimeType} retains a dark slate background`).toBeLessThan(90);
    expect(board.standardDeviation, `${mimeType} retains visible slate texture`).toBeGreaterThan(2.5);
  }

  await page.reload();
  await page.locator(".excalidraw canvas").first().waitFor();
  await expect(page.getByRole("button", { name: "Blackboard", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Connect MCP", exact: true })).toBeEnabled();
  await connectEditorToMcp(page, true);
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

test("MCP creates rendered editable primitives with relationships that stay editable after reopen", async ({ page }) => {
  await page.getByRole("button", { name: "Whiteboard", exact: true }).click();
  const response = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_elements",
    input: { idempotencyKey: "e2e-direct-1112", elements: [
      { id: "box", type: "rectangle", x: 100, y: 100, width: 140, height: 72, strokeColor: "#e64b45", label: "Source" },
      { id: "oval", type: "ellipse", x: 400, y: 100, width: 120, height: 72, strokeColor: "#54ae66", label: "Target" },
      { id: "decision", type: "diamond", x: 600, y: 100, width: 120, height: 72, fillStyle: "hachure", strokeColor: "#2f86c9" },
      { id: "caption", type: "text", x: 100, y: 250, text: "A long agent-authored note that wraps within its maximum width", maxWidth: 220, fontSize: 24, strokeColor: "#d946ef" },
      { id: "connector", type: "line", x: 100, y: 360, points: [[0, 0], [120, 40]], strokeStyle: "dashed", strokeColor: "#0077cc" },
      { id: "flow", type: "arrow", x: 170, y: 136, points: [[0, 0], [290, 0]], start: "box", end: "oval", label: "feeds", endArrowhead: "triangle", strokeColor: "#ca52de" },
      { id: "chalk", type: "freedraw", x: 300, y: 360, points: [[-10, 5], [0, 12], [10, 25, 0.7]], strokeColor: "#00a86b" },
    ] },
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const created = await response.json();
  expect(created.result.elementIds).toMatchObject({ box: expect.any(String), oval: expect.any(String), decision: expect.any(String), caption: expect.any(String), connector: expect.any(String), flow: expect.any(String), chalk: expect.any(String) });
  expect(created.result.addedElementIds).toHaveLength(10);
  expect(created.result.addedElementIds).toEqual(expect.arrayContaining([
    ...Object.values(created.result.elementIds), ...Object.values(created.result.labelElementIds),
  ]));

  const current = await freshBridgeDocument(page);
  const byInputId = Object.fromEntries(Object.entries(created.result.elementIds).map(([key, id]) => [key, current.document.elements.find((element: any) => element.id === id)]));
  expect(byInputId.box).toMatchObject({ type: "rectangle", width: 140, height: 72, strokeColor: "#e64b45", backgroundColor: "#ffffff" });
  expect(byInputId.oval).toMatchObject({ type: "ellipse", width: 120, height: 72, strokeColor: "#54ae66", backgroundColor: "#ffffff" });
  expect(byInputId.decision).toMatchObject({ type: "diamond", fillStyle: "hachure", strokeColor: "#2f86c9", backgroundColor: "#ffffff" });
  expect(byInputId.caption).toMatchObject({ type: "text", originalText: "A long agent-authored note that wraps within its maximum width", fontSize: 24 });
  expect(byInputId.caption.text).toContain("\n");
  expect(byInputId.caption.width).toBeLessThanOrEqual(222);
  expect(byInputId.connector).toMatchObject({ type: "line", strokeStyle: "dashed", width: 120, height: 40, strokeColor: "#0077cc" });
  expect(byInputId.flow).toMatchObject({ type: "arrow", endArrowhead: "triangle", startBinding: { elementId: created.result.elementIds.box }, endBinding: { elementId: created.result.elementIds.oval } });
  expect(byInputId.chalk).toMatchObject({ type: "freedraw" });
  expect(byInputId.chalk.points).toHaveLength(3);
  expect(byInputId.chalk.width).toBeGreaterThan(0);
  expect(byInputId.chalk.height).toBeGreaterThan(0);
  expect(byInputId.chalk.points.every((point: number[]) => point.length === 2)).toBe(true);
  expect(byInputId.chalk.pressures).toEqual([0.5, 0.5, 0.7]);
  expect(byInputId.chalk.simulatePressure).toBe(false);

  const sourceLabelId = created.result.labelElementIds.box;
  const arrowLabelId = created.result.labelElementIds.flow;
  expect(sourceLabelId).toBeTruthy();
  expect(arrowLabelId).toBeTruthy();
  expect(current.document.elements.find((element: any) => element.id === sourceLabelId)).toMatchObject({ type: "text", containerId: created.result.elementIds.box, text: "Source" });
  expect(current.document.elements.find((element: any) => element.id === arrowLabelId)).toMatchObject({ type: "text", containerId: created.result.elementIds.flow, text: "feeds" });
  expect(byInputId.box.boundElements).toContainEqual({ id: sourceLabelId, type: "text" });
  expect(created.result.elements.find((element: any) => element.id === "flow")).toMatchObject({ startElementId: created.result.elementIds.box, endElementId: created.result.elementIds.oval, labelElementId: arrowLabelId });

  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => {
    const undone = await freshBridgeDocument(page);
    return Object.values(created.result.elementIds).some((id: any) => undone.document.elements.some((element: any) => element.id === id && element.isDeleted !== true));
  }).toBe(false);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect.poll(async () => {
    const redone = await freshBridgeDocument(page);
    return Object.values(created.result.elementIds).every((id: any) => redone.document.elements.some((element: any) => element.id === id && element.isDeleted !== true));
  }).toBe(true);

  const downloadWait = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const drawBuffer = await readFile(await (await downloadWait).path());
  const saved = JSON.parse(drawBuffer.toString("utf8"));
  expect(saved.format).toBe("draw");
  for (const id of Object.values(created.result.elementIds)) {
    expect(saved.document.elements.some((element: any) => element.id === id && element.isDeleted !== true)).toBe(true);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"][accept^=".draw"]').setInputFiles({ name: "mcp-primitives.draw", mimeType: "application/vnd.draw+json", buffer: drawBuffer });
  await expect.poll(async () => {
    const reopened = await freshBridgeDocument(page);
    return Object.values(created.result.elementIds).every((id: any) => reopened.document.elements.some((element: any) => element.id === id && element.isDeleted !== true));
  }).toBe(true);

  const canvas = page.locator(".excalidraw canvas").last();
  await expect(canvas).toBeVisible();
  let bounds: Awaited<ReturnType<typeof canvas.boundingBox>> = null;
  await expect.poll(async () => {
    bounds = await canvas.boundingBox();
    return bounds !== null;
  }).toBe(true);
  if (!bounds) throw new Error("Could not locate the drawing canvas.");
  const view = current.document.appState;
  const zoom = typeof view.zoom?.value === "number" ? view.zoom.value : 1;
  const screenX = bounds.x + (byInputId.caption.x + (view.scrollX ?? 0) + 10) * zoom;
  const screenY = bounds.y + (byInputId.caption.y + (view.scrollY ?? 0) + 10) * zoom;
  await page.mouse.click(screenX, screenY);
  await expect.poll(async () => (await freshBridgeDocument(page)).document.appState.selectedElementIds?.[created.result.elementIds.caption]).toBe(true);
  await page.keyboard.press("Enter");
  const editor = page.locator(".excalidraw textarea").last();
  await expect(editor).toBeVisible();
  await editor.fill("Edited by a human after reopening");
  await page.keyboard.press("Control+Enter");
  await expect.poll(async () => {
    const edited = await freshBridgeDocument(page);
    return edited.document.elements.some((element: any) => element.id === created.result.elementIds.caption && element.text === "Edited by a human after reopening");
  }).toBe(true);

  const pngWait = page.waitForEvent("download");
  await page.locator("button.export-main").click();
  const image = await readFile(await (await pngWait).path());
  const swatches: Array<[string, [number, number, number]]> = [
    ["rectangle", [230, 75, 69]], ["ellipse", [84, 174, 102]], ["diamond", [47, 134, 201]],
    ["text", [217, 70, 239]], ["line", [0, 119, 204]], ["arrow", [202, 82, 222]], ["freedraw", [0, 168, 107]],
  ];
  for (const [name, rgb] of swatches) {
    expect(await countPixelsNear(page, image, rgb, 26), `${name} is visibly rendered in the PNG`).toBeGreaterThan(8);
  }
});

test("one infinite canvas pans and zooms across multiple independent diagrams", async ({ page }) => {
  const response = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-1217", nodes: [
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

test("rapid Chrome pan events debounce viewport revision and preserve scene revision", async ({ page }) => {
  await freshBridgeDocument(page);
  const initial = await currentBridgeDocument(page);
  await page.clock.install();
  const canvas = page.locator(".excalidraw canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The editor canvas is not visible.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < 8; index += 1) await page.mouse.wheel(0, 60);

  await page.clock.runFor(249);
  const beforeSettle = await currentBridgeDocument(page);
  expect(beforeSettle.document.documentRevision).toBe(initial.document.documentRevision);
  expect(beforeSettle.document.viewRevision).toBe(initial.document.viewRevision);

  await page.clock.runFor(351);
  const settled = await currentBridgeDocument(page);
  expect(settled.document.documentRevision).toBe(initial.document.documentRevision);
  expect(settled.document.viewRevision).toBe(initial.document.viewRevision + 1);
  expect(settled.document.canvas.viewport).not.toEqual(initial.document.canvas.viewport);

  await page.mouse.wheel(0, 90);
  await page.clock.runFor(249);
  const beforeSecondSettle = await currentBridgeDocument(page);
  expect(beforeSecondSettle.document.viewRevision).toBe(settled.document.viewRevision);
  await page.clock.runFor(351);
  const secondSettled = await currentBridgeDocument(page);
  expect(secondSettled.document.documentRevision).toBe(initial.document.documentRevision);
  expect(secondSettled.document.viewRevision).toBe(settled.document.viewRevision + 1);
});

test("a reloaded .draw node remains selectable and manually editable", async ({ page }) => {
  const response = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-1280", nodes: [{ id: "editable", label: "Before reload", x: 100, y: 100, width: 180, height: 72 }], edges: [] },
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
  const create = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-1307",
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
  const update = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "update_elements",
    input: { idempotencyKey: "e2e-direct-1322", updates: [
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
  const create = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-1355",
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
  const longUpdate = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "update_elements",
    input: { idempotencyKey: "e2e-direct-1403", updates: [{ id: created.result.nodes.implementation, patch: { text: "Implementation\nHow we build and validate the intended outcome" } }] },
  } });
  expect(longUpdate.ok(), await longUpdate.text()).toBeTruthy();
  await assertBackEdgeClear();
});

test("the supplied reference fixture keeps chalk, layout, and editable nodes after a .draw round trip", async ({ page }) => {
  const reference = await readFile("tests/fixtures/specification-implementation-validation.draw");
  page.on("dialog", (dialog) => dialog.accept());
  const drawFileInput = page.locator('input[type="file"][accept^=".draw"]');
  await drawFileInput.evaluate((input: HTMLInputElement) => { input.value = ""; });
  await drawFileInput.setInputFiles({
    name: "specification-implementation-validation.draw",
    mimeType: "application/vnd.draw+json",
    buffer: reference,
  });
  await expect.poll(async () => {
    const local = await readLocalDocument(page);
    return local.document.elements.filter((element: any) => ["rectangle", "ellipse", "diamond"].includes(element.type)).length;
  }).toBe(3);
  await expect.poll(async () => {
    const health = await (await page.request.get("/__draw/api/health")).json();
    const local = await readLocalDocument(page);
    return health.ok && typeof local.document.documentRevision === "number";
  }).toBe(true);
  await expect.poll(async () => {
    const local = await readLocalDocument(page);
    const live = await freshBridgeDocument(page);
    return live.document.documentRevision === local.document.documentRevision &&
      live.document.elements.filter((element: any) => ["rectangle", "ellipse", "diamond"].includes(element.type)).length === 3;
  }).toBe(true);
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
    // Canvas text measurement and serialized element bounds can differ by a
    // fraction of a CSS pixel across browser/platform font rasterizers.
    expect(label.width + 1).toBeGreaterThanOrEqual(renderedWidth);
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedFile = await readFile(await (await downloadWait).path());
  const saveJson = JSON.parse(savedFile.toString("utf8"));
  await page.locator('input[type="file"][accept^=".draw"]').setInputFiles({ name: "reference-roundtrip.draw", mimeType: "application/vnd.draw+json", buffer: savedFile });
  const reopened = await freshBridgeDocument(page);
  expect(reopened.document.canvas.background.preset).toBe("blackboard");
  for (const node of nodes) {
    const canvas = page.locator(".excalidraw canvas:visible").last();
    await expect(canvas).toBeVisible();
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const drawDownload = await downloadWait;
  const saved = JSON.parse((await readFile(await drawDownload.path())).toString("utf8"));
  expect(saved.document.elements.some((element: any) => element.type === "image")).toBe(true);
  expect(Object.keys(saved.document.assets)).not.toHaveLength(0);

  await page.reload();
  await page.locator(".excalidraw canvas").first().waitFor();
  expect((await readLocalDocument(page)).document.elements.some((element: any) => element.type === "image")).toBe(true);
  expect(Object.keys((await readLocalDocument(page)).document.assets)).not.toHaveLength(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('input[type="file"][accept^=".draw"]').setInputFiles({
    name: "image-roundtrip.draw",
    mimeType: "application/vnd.draw+json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect.poll(async () => {
    const reopened = await currentBridgeDocument(page);
    return reopened.document.elements.some((element: any) => element.type === "image") && Object.keys(reopened.document.assets).length > 0;
  }).toBe(true);
});

test("image tool offers device and Google web import, embeds bytes, and saves with the workspace name", async ({ page }) => {
  // Exercise Excalidraw's file-input fallback, which Chrome automation can supply.
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; });
  await page.reload(); await waitForBridge(page);
  await expect(page.getByRole("button", { name: "Images", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Image credits", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add selection to library|Manage library/ })).toHaveCount(0);
  await expect(page.locator(".default-sidebar-trigger")).not.toBeVisible();
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 20; canvas.height = 20;
    const context = canvas.getContext("2d")!; context.fillStyle = "#cc4411"; context.fillRect(0, 0, 20, 20);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  await page.route("https://images.example/robot.png", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.locator("label").filter({ has: page.getByRole("radio", { name: "Insert image", exact: true }) }).click();
  const dialog = page.getByRole("dialog", { name: "Insert image" });
  await expect(dialog).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "From your device" }).click();
  await (await chooser).setFiles({ name: "local.png", mimeType: "image/png", buffer: png });
  await page.keyboard.press("Escape");
  await page.locator("label").filter({ has: page.getByRole("radio", { name: "Insert image", exact: true }) }).click();
  await dialog.getByRole("button", { name: "From the web" }).click();
  await page.getByLabel("Search Google Images", { exact: true }).fill("robot & chalk");
  await page.context().route("https://www.google.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Search</h1>" }));
  const popupWait = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: /Search Google Images/ }).click();
  const popup = await popupWait;
  await popup.waitForLoadState();
  expect(new URL(popup.url()).searchParams.get("q")).toBe("robot & chalk");
  expect(new URL(popup.url()).searchParams.get("udm")).toBe("2");
  await popup.close();
  await page.getByLabel("Image URL", { exact: true }).fill("https://images.example/robot.png");
  await dialog.getByRole("button", { name: "Add image", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await readLocalDocument(page))?.document.elements.some((el: any) => el.customData?.drawSourceUrl === "https://images.example/robot.png")).toBe(true);
  const saved = await readLocalDocument(page);
  const image = saved.document.elements.find((el: any) => el.customData?.drawSourceUrl);
  expect(saved.document.assets[image.fileId].dataURL).toMatch(/^data:image\/png;base64,/);
  page.once("dialog", (dialog) => dialog.accept("Project 1"));
  await page.getByRole("button", { name: "Rename workspace", exact: true }).click();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const downloaded = await wait;
  expect(downloaded.suggestedFilename()).toBe("Project-1.draw");
  const file = JSON.parse(await readFile(await downloaded.path(), "utf8"));
  expect(file.document.assets[image.fileId].dataURL).toBe(saved.document.assets[image.fileId].dataURL);
  await page.reload();
  await waitForBridge(page);
  await expect.poll(async () => (await readLocalDocument(page))?.document.assets[image.fileId]?.dataURL).toBe(saved.document.assets[image.fileId].dataURL);
  await page.locator('input[type="file"][accept^=".draw"]').setInputFiles({ name: downloaded.suggestedFilename(), mimeType: "application/vnd.draw+json", buffer: Buffer.from(JSON.stringify(file)) });
  await expect.poll(async () => (await freshBridgeDocument(page)).document.elements.some((el: any) => el.customData?.drawSourceUrl === "https://images.example/robot.png")).toBe(true);
});

test("web image import reports blocked sources and Escape restores toolbar focus", async ({ page }) => {
  await page.route("https://images.example/blocked.png", (route) => route.abort("failed"));
  await page.locator("label").filter({ has: page.getByRole("radio", { name: "Insert image", exact: true }) }).click();
  const dialog = page.getByRole("dialog", { name: "Insert image" });
  await dialog.getByRole("button", { name: "From the web" }).click();
  await dialog.getByLabel("Image URL").fill("https://images.example/blocked.png");
  await dialog.getByRole("button", { name: "Add image", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("From your device");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("radio", { name: "Insert image", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
});

for (const switchWorkspace of [false, true]) {
  test(`pending web import cannot insert after ${switchWorkspace ? "an agent switches workspace" : "the owner cancels"}`, async ({ page, baseURL }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
      canvas.getContext("2d")!.fillRect(0, 0, 8, 8);
      return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    await page.route("https://images.example/slow.png", async (route) => {
      requested(); await gate;
      await route.fulfill({ contentType: "image/png", body: png }).catch(() => undefined);
    });
    const original = await currentWorkspaceId(page);
    await page.locator("label").filter({ has: page.getByRole("radio", { name: "Insert image", exact: true }) }).click();
    const dialog = page.getByRole("dialog", { name: "Insert image" });
    await dialog.getByRole("button", { name: "From the web" }).click();
    await dialog.getByLabel("Image URL").fill("https://images.example/slow.png");
    await dialog.getByRole("button", { name: "Add image", exact: true }).click();
    await started;
    try {
      if (switchWorkspace) {
        const directory = await mkdtemp(join(tmpdir(), "draw-web-switch-"));
        const mcp = await startStdioMcp(baseURL!, directory);
        try {
          const catalogResponse = await mcp.call("list_workspaces", {});
          const catalog = JSON.parse(catalogResponse.result.content[0].text);
          const response = await mcp.call("create_workspace", { expectedCatalogRevision: catalog.catalogRevision, idempotencyKey: "switch-during-web-import", name: "Other project" });
          expect(response.result?.isError, response.result?.content?.[0]?.text).not.toBe(true);
        } finally { await mcp.close(); await rm(directory, { recursive: true, force: true }); }
      } else {
        await page.keyboard.press("Escape");
      }
    } finally { release(); }
    if (switchWorkspace) {
      await expect(dialog.getByRole("alert")).toContainText("workspace changed");
      await page.keyboard.press("Escape");
      expect(await currentWorkspaceId(page)).not.toBe(original);
    }
    await expect(dialog).not.toBeVisible();
    const current = await freshBridgeDocument(page);
    expect(current.document.elements.filter((element: any) => element.type === "image")).toHaveLength(0);
    expect(Object.keys(current.document.assets)).toHaveLength(0);
    if (switchWorkspace) await selectWorkspace(page, original);
    const originalDocument = await freshBridgeDocument(page);
    expect(originalDocument.document.elements.filter((element: any) => element.type === "image")).toHaveLength(0);
    expect(Object.keys(originalDocument.document.assets)).toHaveLength(0);
    await page.locator("label").filter({ has: page.getByRole("radio", { name: "Insert image", exact: true }) }).click();
    await dialog.getByRole("button", { name: "From the web" }).click();
    await expect(dialog.getByRole("button", { name: "Add image", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")))).toBe(true);
  });
}

test("paired MCP Openverse image claims remain unverified after save and reload", async ({ page }) => {
  const current = await freshBridgeDocument(page);
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ5sAAAAASUVORK5CYII=";
  const response = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "insert_openverse_image",
    input: {
      documentId: current.document.id, expectedDocumentRevision: current.document.documentRevision, idempotencyKey: "forged-openverse-attribution",
      x: 100, y: 100, width: 24, height: 24, mimeType: "image/png", dataURL: png,
      attribution: { provider: "Openverse", providerId: id, title: "Forged verified claim", creator: "Caller", license: "by", licenseVersion: "4.0", capturedAt: "2026-01-01T00:00:00.000Z", verification: "openverse-index" },
      idempotencyPayload: { imageId: id, x: 100, y: 100, width: 24, height: 24 },
    },
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect.poll(async () => {
    const document = await freshBridgeDocument(page);
    const image = document.document.elements.find((element: any) => element.type === "image");
    return image && document.document.assets[image.fileId]?.attribution?.verification;
  }).toBe("unverified");
  await page.reload();
  await waitForBridge(page);
  await expect.poll(async () => {
    const document = await freshBridgeDocument(page);
    const image = document.document.elements.find((element: any) => element.type === "image");
    return image && document.document.assets[image.fileId]?.attribution?.verification;
  }).toBe("unverified");
});

test("stdio MCP searches Openverse, inserts by provider ID, and saves a reopenable attributed Draw document", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("Playwright baseURL is required for the MCP image insertion test.");
  const current = await freshBridgeDocument(page);
  const documentDir = await mkdtemp(join(tmpdir(), "draw-openverse-mcp-"));
  const mcp = await startStdioMcp(baseURL, documentDir, undefined, true);
  try {
    const available = await mcp.request("tools/list", {});
    const toolNames = available.result.tools.map((tool: any) => tool.name);
    expect(toolNames).toContain("search_openverse_images");
    expect(toolNames).toContain("insert_openverse_image");

    const search = await mcp.call("search_openverse_images", { documentId: current.document.id, expectedDocumentRevision: current.document.documentRevision, query: "chalk arrow", category: "illustration" });
    expect(search.error).toBeUndefined();
    const searchResult = JSON.parse(search.result.content[0].text);
    expect(searchResult.results[0]).toMatchObject({ id: "123e4567-e89b-12d3-a456-426614174000", license: "by", creator: "Draw Artist" });

    const inserted = await mcp.call("insert_openverse_image", {
      documentId: current.document.id, expectedDocumentRevision: current.document.documentRevision,
      idempotencyKey: "e2e-mcp-openverse-insert", imageId: searchResult.results[0].id, x: 420, y: 280,
    });
    expect(inserted.error).toBeUndefined();
    const insertedResult = JSON.parse(inserted.result.content[0].text);
    expect(insertedResult).toMatchObject({ embedded: true, license: "by", title: "MCP chalk arrow" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const retry = await mcp.call("insert_openverse_image", {
      documentId: current.document.id, expectedDocumentRevision: current.document.documentRevision,
      idempotencyKey: "e2e-mcp-openverse-insert", imageId: searchResult.results[0].id, x: 420, y: 280,
    });
    expect(retry.error).toBeUndefined();
    expect(JSON.parse(retry.result.content[0].text)).toEqual(insertedResult);

    const changed = await freshBridgeDocument(page);
    expect(changed.document.elements.filter((element: any) => element.type === "image")).toHaveLength(1);
    const imageElement = changed.document.elements.find((element: any) => element.type === "image");
    expect(imageElement).toBeTruthy();
    expect(changed.document.assets[imageElement.fileId]).toMatchObject({ attribution: { providerId: searchResult.results[0].id, license: "by", sourceUrl: "https://source.example/chalk-arrow", verification: "unverified" }, dataURL: expect.stringMatching(/^data:image\/png;base64,/) });

    const latestCanvas = await mcp.call("get_current_canvas", {});
    expect(latestCanvas.error).toBeUndefined();
    const latestSummary = JSON.parse(latestCanvas.result.content[0].text);
    expect(latestSummary.documentRevision).toBe(changed.document.documentRevision);
    const saved = await mcp.call("save_document", { documentId: latestSummary.documentId, expectedDocumentRevision: latestSummary.documentRevision });
    expect(saved.error).toBeUndefined();
    expect(saved.result.content[0].text).toMatch(/"saved": true/);
    const savedResult = JSON.parse(saved.result.content[0].text);
    const savedDocument = JSON.parse(savedResult.drawFile);
    expect(savedDocument.document.assets[imageElement.fileId].attribution.providerId).toBe(searchResult.results[0].id);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('input[type="file"][accept^=".draw"]').setInputFiles({ name: "mcp-openverse.draw", mimeType: "application/vnd.draw+json", buffer: Buffer.from(JSON.stringify(savedDocument)) });
    await expect.poll(async () => {
      const reopened = await freshBridgeDocument(page);
      const image = reopened.document.elements.find((element: any) => element.type === "image");
      return image && reopened.document.assets[image.fileId]?.attribution?.providerId;
    }).toBe(searchResult.results[0].id);
  } finally {
    await mcp.close();
    await rm(documentDir, { recursive: true, force: true });
  }
});

test("PNG and JPEG exports keep the complete editable scene even when an object is selected", async ({ page }) => {
  test.setTimeout(60_000);
  const createdResponse = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-direct-1539",
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
  const settledScene = await waitForImageToSettle(page, { width: 48, height: 48 });

  // The image drop leaves an object selected, matching the reported workflow.
  // Export must still be a shareable image of the whole drawing, rather than a
  // crop containing only the current selection.
  await expect.poll(async () => Object.keys((await freshBridgeDocument(page)).document.appState.selectedElementIds ?? {}).length).toBeGreaterThan(0);
  const exportScene = settledScene;
  const liveElements = exportScene.document.elements.filter((element: any) => element.isDeleted !== true);
  // Excalidraw normalizes its SVG viewBox to (0, 0), so use the scene's
  // minimum element coordinates only to map the semantic pixel samples.
  // Export dimensions are validated independently against that SVG viewBox.
  const bounds = {
    left: Math.min(...liveElements.map((element: any) => element.x)),
    top: Math.min(...liveElements.map((element: any) => element.y)),
    right: Math.max(...liveElements.map((element: any) => element.x + element.width)),
    bottom: Math.max(...liveElements.map((element: any) => element.y + element.height)),
  };
  const exportOrigin = { x: bounds.left - 32, y: bounds.top - 32 };
  const expectedSize = expectedSceneExportSize(liveElements);
  // Prove that the independent scene-bounds oracle rejects an intentionally
  // wrong export size/padding before it is used to validate real exports.
  expect(() => expectExportSizeMatchesScene({ width: expectedSize.width + 32, height: expectedSize.height - 32 }, expectedSize)).toThrow();
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

  for (const [preset, presetButton] of [["blackboard", "Blackboard"], ["white", "Whiteboard"]] as const) {
    await page.getByRole("button", { name: presetButton, exact: true }).click();
    for (const mime of ["image/png", "image/jpeg"] as const) {
      const formatControl = page.getByLabel("Image export format");
      const sequenceBeforeExport = await page.evaluate(() => {
        const current = window as any;
        const previous = current.__drawExportSvgSequence ?? 0;
        current.__drawLastExportSvg = undefined;
        current.__drawLastExportSvgSequence = undefined;
        return previous;
      });
      const download = await captureSingleDownload(page, async () => {
        if (await formatControl.inputValue() === mime) await page.getByRole("button", { name: "Export" }).click();
        else await formatControl.selectOption(mime); // Changing format exports immediately.
      });
      expect(download.suggestedFilename().endsWith(mime === "image/png" ? ".png" : ".jpg"), `${mime} export should download with the matching image extension`).toBe(true);
      const image = await readFile(await download.path());
      const sample = await inspectImagePixels(page, image, mime);
      const svgViewport = await page.evaluate(async (startingSequence) => {
        const current = window as any;
        const deadline = Date.now() + 10_000;
        while ((current.__drawLastExportSvgSequence ?? 0) <= startingSequence || typeof current.__drawLastExportSvg !== "string") {
          if (Date.now() > deadline) throw new Error("Timed out waiting for the SVG from this export.");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const svg = current.__drawLastExportSvg as string;
        const document = new DOMParser().parseFromString(svg, "image/svg+xml");
        const root = document.documentElement;
        const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
        const width = Number.parseFloat(root.getAttribute("width") ?? "");
        const height = Number.parseFloat(root.getAttribute("height") ?? "");
        if (!viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || !Number.isFinite(width) || !Number.isFinite(height)) {
          throw new Error("The export SVG has no finite intrinsic dimensions and viewBox.");
        }
        return { x: viewBox[0], y: viewBox[1], viewWidth: viewBox[2], viewHeight: viewBox[3], width, height };
      }, sequenceBeforeExport);
      expect(Math.abs(sample.width - svgViewport.width), `${mime} bitmap width should match its exact SVG export input`).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.height - svgViewport.height), `${mime} bitmap height should match its exact SVG export input`).toBeLessThanOrEqual(1);
      expect(Math.abs(svgViewport.viewWidth - svgViewport.width), "SVG viewBox width should map one scene unit to one export pixel").toBeLessThanOrEqual(1);
      expect(Math.abs(svgViewport.viewHeight - svgViewport.height), "SVG viewBox height should map one scene unit to one export pixel").toBeLessThanOrEqual(1);
      expectExportSizeMatchesScene(sample, expectedSize);
      const corner = await sampleImagePatch(page, image, { x: 0.025, y: 0.025 }, mime);
      expect(sample.greenAssetPixels, `${mime} should preserve the embedded image`).toBeGreaterThan(50);
      if (preset === "blackboard") {
        const luminance = corner[0] * 0.2126 + corner[1] * 0.7152 + corner[2] * 0.0722;
        expect(luminance, `${mime} blackboard corner should stay charcoal`).toBeLessThanOrEqual(90);
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

test("a human pairs an MCP host, the secret stays out of tool output, and revocation blocks it", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required for the MCP pairing test.");
  const directory = await mkdtemp(join(tmpdir(), "draw-mcp-pairing-e2e-"));
  const secondDirectory = await mkdtemp(join(tmpdir(), "draw-mcp-pairing-second-e2e-"));
  let replacementMcp: Awaited<ReturnType<typeof startStdioMcp>> | null = null;
  let secondMcp: Awaited<ReturnType<typeof startStdioMcp>> | null = null;
  await page.goto("/");
  await connectEditorToMcp(page);
  await expect(page.getByRole("button", { name: "MCP clients" })).toBeVisible();
  await page.getByRole("button", { name: "MCP clients" }).click();
  const pairingSecret = await page.locator(".mcp-pairing-secret code").innerText();
  expect(pairingSecret).toMatch(/^[a-f\d]{64}$/i);
  const mcp = await startStdioMcp(baseURL, directory, pairingSecret);
  try {
    const discovery = await mcp.request("tools/list", {});
    expect(discovery.result.tools.map((tool: { name: string }) => tool.name)).toContain("pair_mcp_client");
    const pairing = mcp.call("pair_mcp_client", {});
    await expect(page.getByRole("heading", { name: "Approve MCP client?" })).toBeVisible();
    const visibleFingerprint = await page.locator("section[aria-labelledby='draw-mcp-pairing-title'] code").innerText();
    expect(visibleFingerprint).toMatch(/^[a-f\d]{64}$/i);
    await page.getByRole("button", { name: "Approve client" }).click();
    const paired = await pairing;
    expect(paired.result.isError).not.toBe(true);
    const publicResult = JSON.parse(paired.result.content[0].text);
    expect(publicResult).toMatchObject({ paired: true, fingerprint: visibleFingerprint });
    expect(paired.result.content[0].text).not.toContain(pairingSecret);
    const credential = JSON.parse(await readFile(mcp.credentialPath, "utf8"));
    expect(credential.capability).toMatch(/^[a-f\d]{64}$/i);
    expect(credential.clientIdentity).toBe(publicResult.clientIdentity);
    expect((await stat(mcp.credentialPath)).mode & 0o777).toBe(0o600);
    expect(paired.result.content[0].text).not.toContain(credential.capability);
    expect((await mcp.call("get_current_canvas", {})).result.isError).not.toBe(true);

    const clientRow = page.locator(".mcp-client-row").filter({ hasText: publicResult.clientIdentity });
    await expect(clientRow).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    // Pairing-secret requests are intentionally rate-limited to one per five seconds.
    await page.waitForTimeout(5_000);
    await page.getByRole("button", { name: "MCP clients" }).click();
    const replacementSecret = await page.locator(".mcp-pairing-secret code").innerText();
    const sameHostMcp = await startStdioMcp(baseURL, directory, replacementSecret);
    replacementMcp = sameHostMcp;
    const replacementPairing = sameHostMcp.call("pair_mcp_client", {});
    await expect(page.getByRole("heading", { name: "Approve MCP client?" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("will revoke the existing paired client");
    await page.getByRole("button", { name: "Approve client" }).click();
    const replacementPaired = await replacementPairing;
    expect(replacementPaired.result.isError).not.toBe(true);
    const replacementPublicResult = JSON.parse(replacementPaired.result.content[0].text);
    expect(replacementPublicResult.clientIdentity).not.toBe(publicResult.clientIdentity);
    await expect(clientRow).toContainText("revoked");

    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForTimeout(5_000);
    await page.getByRole("button", { name: "MCP clients" }).click();
    const secondPairingSecret = await page.locator(".mcp-pairing-secret code").innerText();
    const mcp2 = await startStdioMcp(baseURL, secondDirectory, secondPairingSecret);
    secondMcp = mcp2;
    const secondPairing = mcp2.call("pair_mcp_client", {});
    await expect(page.getByRole("heading", { name: "Approve MCP client?" })).toBeVisible();
    const secondFingerprint = await page.locator("section[aria-labelledby='draw-mcp-pairing-title'] code").innerText();
    expect(secondFingerprint).toMatch(/^[a-f\d]{64}$/i);
    await page.getByRole("button", { name: "Approve client" }).click();
    const secondPaired = await secondPairing;
    expect(secondPaired.result.isError).not.toBe(true);
    const secondPublicResult = JSON.parse(secondPaired.result.content[0].text);
    expect(secondPublicResult.clientIdentity).not.toBe(publicResult.clientIdentity);
    expect((await mcp2.call("get_current_canvas", {})).result.isError).not.toBe(true);

    const replacementRow = page.locator(".mcp-client-row").filter({ hasText: replacementPublicResult.clientIdentity });
    const revocationResponse = page.waitForResponse((response) => response.url().includes(`/__draw/api/mcp/clients/${replacementPublicResult.clientIdentity}`) && response.request().method() === "DELETE");
    await replacementRow.getByRole("button", { name: "Revoke" }).click();
    expect((await revocationResponse).status()).toBe(200);
    await expect(replacementRow).toContainText("revoked");
    const afterRevocation = await mcp.call("get_current_canvas", {});
    expect(Boolean(afterRevocation.error || afterRevocation.result?.isError)).toBe(true);
    expect((await mcp2.call("get_current_canvas", {})).result.isError).not.toBe(true);
  } finally {
    await secondMcp?.close();
    await replacementMcp?.close();
    await mcp.close();
    await rm(secondDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("revoking an MCP client cancels its pending command without overwriting a later human edit", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required for the in-flight revocation test.");
  const directory = await mkdtemp(join(tmpdir(), "draw-mcp-revocation-e2e-"));
  let mcp: Awaited<ReturnType<typeof startStdioMcp>> | null = null;
  let resumeAck!: () => void;
  let ackIntercepted!: () => void;
  let ackContinued!: () => void;
  let didIntercept = false;
  let credential: any;
  let command: any;
  const ackGate = new Promise<void>((resolve) => { resumeAck = resolve; });
  const ackSeen = new Promise<void>((resolve) => { ackIntercepted = resolve; });
  const ackDone = new Promise<void>((resolve) => { ackContinued = resolve; });
  try {
    await page.goto("/");
    await connectEditorToMcp(page);
    await page.waitForTimeout(5_000);
    await page.getByRole("button", { name: "MCP clients" }).click();
    const pairingSecret = await page.locator(".mcp-pairing-secret code").innerText();
    mcp = await startStdioMcp(baseURL, directory, pairingSecret);
    const pairing = mcp.call("pair_mcp_client", {});
    await expect(page.getByRole("heading", { name: "Approve MCP client?" })).toBeVisible();
    await page.getByRole("button", { name: "Approve client" }).click();
    expect((await pairing).result.isError).not.toBe(true);
    credential = JSON.parse(await readFile(mcp.credentialPath, "utf8"));
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const initial = await currentBridgeDocument(page);
    await page.route("**/__draw/api/commands/*/ack", async (route) => {
      didIntercept = true;
      ackIntercepted();
      await ackGate;
      try { await route.continue(); } finally { ackContinued(); }
    });
    command = {
      operation: "create_diagram",
      input: {
        idempotencyKey: "revoke-pending-command",
        documentId: initial.document.id,
        expectedDocumentRevision: initial.document.documentRevision,
        nodes: [{ id: "cancel-node", label: "MCP edit", x: 180, y: 160, width: 220, height: 90 }],
        edges: [],
      },
    };
    await page.evaluate(({ body, headers }) => {
      (window as any).__pendingMcpResponse = fetch("/__draw/api/commands", {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
      }).then(async (response) => ({ status: response.status, body: await response.json() }));
    }, { body: command, headers: { "x-draw-client-identity": credential.clientIdentity, authorization: `Bearer ${credential.capability}` } });
    await ackSeen;
    const afterMcp = await currentBridgeDocument(page);
    expect(afterMcp.document.elements.some((element: any) => element.text === "MCP edit" || element.originalText === "MCP edit")).toBe(true);
    const node = afterMcp.document.elements.find((element: any) => element.id === afterMcp.document.elements.find((candidate: any) => candidate.text === "MCP edit" || candidate.originalText === "MCP edit")?.containerId) as any;
    const canvas = page.locator(".excalidraw canvas").last();
    const bounds = await canvas.boundingBox();
    if (!bounds || !node) throw new Error("Could not locate the pending MCP node.");
    await page.mouse.click(bounds.x + node.x + node.width / 2, bounds.y + node.y + node.height / 2);
    await page.keyboard.press("Enter");
    const editor = page.locator(".excalidraw textarea").last();
    await expect(editor).toBeVisible();
    await editor.fill("Human edit after MCP");
    await page.keyboard.press("Control+Enter");
    await expect.poll(async () => (await currentBridgeDocument(page)).document.elements.some((element: any) => element.originalText === "Human edit after MCP")).toBe(true);

    await page.waitForTimeout(5_000);
    await page.getByRole("button", { name: "MCP clients" }).click();
    const row = page.locator(".mcp-client-row").filter({ hasText: credential.clientIdentity });
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(row).toContainText("revoked");
  } finally {
    resumeAck();
    if (didIntercept) {
      await ackDone;
      await page.unroute("**/__draw/api/commands/*/ack");
    }
    await mcp?.close();
    await rm(directory, { recursive: true, force: true });
  }
  const response = await page.evaluate(async () => await (window as any).__pendingMcpResponse);
  expect(response.status).toBe(401);
  const retry = await page.request.post("/__draw/api/commands", {
    headers: { "x-draw-client-identity": credential.clientIdentity, authorization: `Bearer ${credential.capability}` },
    data: command,
  });
  expect(retry.status()).toBe(401);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const savedFile = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = JSON.parse(await readFile(await (await savedFile).path(), "utf8"));
  expect(saved.document.elements).toEqual(expect.arrayContaining([expect.objectContaining({ originalText: "Human edit after MCP" })]));
  expect(saved.document.elements.filter((element: any) => element.originalText === "Human edit after MCP")).toHaveLength(1);
});

test("revocation rolls back in place and retains the selected human scene and undo history", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required for the rollback-history test.");
  const directory = await mkdtemp(join(tmpdir(), "draw-mcp-rollback-history-e2e-"));
  let mcp: Awaited<ReturnType<typeof startStdioMcp>> | null = null;
  let resumeAck!: () => void;
  let ackIntercepted!: () => void;
  let ackContinued!: () => void;
  let ackStatus: number | null = null;
  let editorSecret = "";
  const ackGate = new Promise<void>((resolve) => { resumeAck = resolve; });
  const ackSeen = new Promise<void>((resolve) => { ackIntercepted = resolve; });
  const ackDone = new Promise<void>((resolve) => { ackContinued = resolve; });
  try {
    await page.goto("/");
    await connectEditorToMcp(page);
    page.on("request", (request) => {
      if (request.url().endsWith("/__draw/api/mcp/clients")) editorSecret = request.headers()["x-draw-editor-secret"] ?? editorSecret;
    });
    await page.waitForTimeout(5_000);
    await page.getByRole("button", { name: "MCP clients" }).click();
    const pairingSecret = await page.locator(".mcp-pairing-secret code").innerText();
    mcp = await startStdioMcp(baseURL, directory, pairingSecret);
    const pairing = mcp.call("pair_mcp_client", {});
    await expect(page.getByRole("heading", { name: "Approve MCP client?" })).toBeVisible();
    await page.getByRole("button", { name: "Approve client" }).click();
    expect((await pairing).result.isError).not.toBe(true);
    const credential = JSON.parse(await readFile(mcp.credentialPath, "utf8"));
    await page.getByRole("button", { name: "Close", exact: true }).click();

    const beforeFixture = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const fixtureResponse = await mcp.call("create_diagram", {
      documentId: beforeFixture.documentId, expectedDocumentRevision: beforeFixture.documentRevision,
      nodes: [{ id: "update-target", label: "Existing MCP node", x: 650, y: 180, width: 220, height: 90 }], edges: [],
    });
    expect(fixtureResponse.error).toBeUndefined();
    const fixture = JSON.parse(fixtureResponse.result.content[0].text);
    const updateTargetId = fixture.nodes["update-target"];

    await page.locator('.excalidraw label[title^="Rectangle"]').click();
    const canvas = page.locator(".excalidraw canvas").last();
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Could not locate the canvas.");
    const startX = bounds.x + bounds.width / 2 - 70;
    const startY = bounds.y + bounds.height / 2 - 30;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 140, startY + 100);
    await page.mouse.up();
    await expect.poll(async () => (await currentBridgeDocument(page)).document.elements.some((element: any) => element.type === "rectangle")).toBe(true);
    const initial = await currentBridgeDocument(page);
    const humanRectangle = initial.document.elements.find((element: any) => element.type === "rectangle");
    await page.locator('.excalidraw label[title^="Selection"]').click();
    await page.mouse.click(bounds.x + humanRectangle.x + humanRectangle.width / 2, bounds.y + humanRectangle.y + humanRectangle.height / 2);
    await expect.poll(async () => (await currentBridgeDocument(page)).document.appState.selectedElementIds?.[humanRectangle.id]).toBe(true);
    const beforeUpdate = await currentBridgeDocument(page);

    await page.route("**/__draw/api/commands/*/ack", async (route) => {
      ackIntercepted();
      await ackGate;
      const response = await route.fetch();
      ackStatus = response.status();
      try { await route.fulfill({ response }); } finally { ackContinued(); }
    });
    await page.evaluate(({ headers, documentId, documentRevision, updateTargetId }) => {
      (window as any).__pendingMcpResponse = fetch("/__draw/api/commands", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ operation: "update_elements", input: {
          idempotencyKey: "revoke-update-command",
          documentId,
          expectedDocumentRevision: documentRevision,
          updates: [{ id: updateTargetId, patch: { text: "Should roll back" } }],
        } }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }));
    }, {
      headers: { "x-draw-client-identity": credential.clientIdentity, authorization: `Bearer ${credential.capability}` },
      documentId: beforeUpdate.document.id,
      documentRevision: beforeUpdate.document.documentRevision,
      updateTargetId,
    });
    await ackSeen;
    expect((await currentBridgeDocument(page)).document.elements.some((element: any) => element.originalText === "Should roll back")).toBe(true);

    const revokeResponse = await page.request.delete(`/__draw/api/mcp/clients/${credential.clientIdentity}`, {
      headers: { "content-type": "application/json", origin: new URL(page.url()).origin, "x-draw-editor-secret": editorSecret }, data: {},
    });
    expect(revokeResponse.status()).toBe(200);
    resumeAck();
    await expect.poll(() => ackStatus).toBe(410);
    await ackDone;
    await expect.poll(async () => (await currentBridgeDocument(page)).document.elements.some((element: any) => element.originalText === "Should roll back")).toBe(false);
    const canceledResponse = await page.evaluate(async () => await (window as any).__pendingMcpResponse);
    expect(canceledResponse.status).toBe(401);
    expect(ackStatus).toBe(410);
    await expect.poll(async () => (await currentBridgeDocument(page)).document.appState.selectedElementIds?.[humanRectangle.id]).toBe(true);
    const undoButton = page.getByRole("button", { name: "Undo" });
    await expect(undoButton).toBeEnabled();
    let humanRectangleStillPresent = true;
    for (let attempt = 0; attempt < 6 && humanRectangleStillPresent && await undoButton.isEnabled(); attempt += 1) {
      await undoButton.click();
      await page.waitForTimeout(80);
      humanRectangleStillPresent = (await currentBridgeDocument(page)).document.elements.some((element: any) => element.id === humanRectangle.id && element.isDeleted !== true);
    }
    await expect.poll(async () => (await currentBridgeDocument(page)).document.elements.some((element: any) => element.id === humanRectangle.id && element.isDeleted !== true)).toBe(false);
  } finally {
    resumeAck();
    await page.unroute("**/__draw/api/commands/*/ack").catch(() => undefined);
    await mcp?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP mutation replay and actor-safe undo/redo survive editor and stdio-client reloads", async ({ page, baseURL }) => {
  // This flow includes several editor and stdio restarts; allow for a loaded
  // Chrome worker while keeping each individual MCP request timeout bounded.
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("Playwright baseURL is required for the MCP integration test.");
  const directory = await mkdtemp(join(tmpdir(), "draw-mcp-durable-e2e-"));
  let mcp = await startStdioMcp(baseURL, directory);
  try {
    await waitForBridge(page);
    const initial = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const request = {
      documentId: initial.documentId,
      expectedDocumentRevision: initial.documentRevision,
      idempotencyKey: "same-request-across-restart",
      nodes: [{ id: "durable-node", label: "Created exactly once", x: 180, y: 150, width: 240, height: 100 }],
      edges: [],
    };
    const first = await mcp.call("create_diagram", request);
    expect(first.error).toBeUndefined();
    const originalResult = JSON.parse(first.result.content[0].text);
    await mcp.close();
    await page.reload();
    await waitForBridge(page);
    mcp = await startStdioMcp(baseURL, directory);

    const retry = await mcp.call("create_diagram", request);
    expect(retry.error).toBeUndefined();
    const replayedResult = JSON.parse(retry.result.content[0].text);
    expect(replayedResult.operationId).toBe(originalResult.operationId);
    expect(replayedResult.nodes).toEqual(originalResult.nodes);
    const payloadConflict = await mcp.call("create_diagram", { ...request, nodes: [{ id: "durable-node", label: "Different payload", x: 180, y: 150 }] });
    expect(payloadConflict.result?.isError).toBe(true);
    expect(payloadConflict.result?.content?.[0]?.text).toMatch(/IDEMPOTENCY_KEY_REUSE/i);
    let snapshot = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(snapshot.documentRevision, JSON.stringify({ originalResult, snapshot })).toBe(originalResult.documentRevision);
    expect(snapshot.elements.filter((element: any) => element.id === originalResult.nodes["durable-node"])).toHaveLength(1);

    const viewportRequest = {
      documentId: snapshot.documentId,
      expectedViewRevision: snapshot.viewRevision,
      idempotencyKey: "viewport-replay-after-reload",
      action: "set",
      x: -240,
      y: -80,
      zoom: 1.4,
    };
    const viewportFirst = await mcp.call("set_viewport", viewportRequest);
    expect(viewportFirst.error).toBeUndefined();
    const viewportResult = JSON.parse(viewportFirst.result.content[0].text);
    await mcp.close();
    await page.reload();
    await waitForBridge(page);
    mcp = await startStdioMcp(baseURL, directory);
    const viewportRetry = await mcp.call("set_viewport", viewportRequest);
    expect(viewportRetry.error).toBeUndefined();
    expect(JSON.parse(viewportRetry.result.content[0].text)).toEqual(viewportResult);

    const undo = await mcp.call("undo_operation", {
      documentId: snapshot.documentId,
      operationId: originalResult.operationId,
      expectedDocumentRevision: snapshot.documentRevision,
      idempotencyKey: "durable-undo-after-reload",
    });
    expect(undo.error).toBeUndefined();
    expect(undo.result?.isError, JSON.stringify(undo)).not.toBe(true);
    snapshot = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(snapshot.elements.filter((element: any) => element.id === originalResult.nodes["durable-node"] && element.isDeleted !== true), JSON.stringify(undo)).toHaveLength(0);
    await mcp.close();
    await page.reload();
    await waitForBridge(page);
    mcp = await startStdioMcp(baseURL, directory);
    snapshot = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(snapshot.elements.filter((element: any) => element.id === originalResult.nodes["durable-node"] && element.isDeleted !== true)).toHaveLength(0);

    const redo = await mcp.call("redo_operation", {
      documentId: snapshot.documentId,
      operationId: originalResult.operationId,
      expectedDocumentRevision: snapshot.documentRevision,
      idempotencyKey: "durable-redo-after-reload",
    });
    expect(redo.error).toBeUndefined();
    expect(redo.result?.isError).not.toBe(true);
    snapshot = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(snapshot.elements.filter((element: any) => element.id === originalResult.nodes["durable-node"] && element.isDeleted !== true)).toHaveLength(1);
    const redoneResult = JSON.parse(redo.result.content[0].text);

    await page.locator('.excalidraw label[title^="Rectangle"]').click();
    const canvas = page.locator(".excalidraw canvas").last();
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Could not locate the canvas for the later human edit.");
    await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2 + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 170, bounds.y + bounds.height / 2 + 190);
    await page.mouse.up();
    await expect.poll(async () => (await freshBridgeDocument(page)).document.elements.filter((element: any) => element.type === "rectangle" && element.isDeleted !== true).length).toBe(2);
    await mcp.close();
    await page.reload();
    await waitForBridge(page);
    mcp = await startStdioMcp(baseURL, directory);
    snapshot = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const rejectedUndo = await mcp.call("undo_operation", {
      documentId: snapshot.documentId,
      operationId: redoneResult.operationId,
      expectedDocumentRevision: snapshot.documentRevision,
      idempotencyKey: "undo-after-later-human-edit",
    });
    expect(rejectedUndo.result?.isError).toBe(true);
    const afterRejectedUndo = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(afterRejectedUndo.elements.filter((element: any) => element.type === "rectangle" && element.isDeleted !== true)).toHaveLength(2);
  } finally {
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("damaged MCP history leaves the drawing editable and the next committed mutation cleans corruption", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required for the MCP integration test.");
  const directory = await mkdtemp(join(tmpdir(), "draw-mcp-corrupt-ledger-"));
  const mcp = await startStdioMcp(baseURL, directory);
  try {
    await waitForBridge(page);
    const initial = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    await page.evaluate(async ({ documentId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("draw-local");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = db.transaction(["mcpUndo", "mcpRedo", "mcpOperations", "mcpMeta"], "readwrite");
      transaction.objectStore("mcpUndo").put({ broken: true }, documentId);
      transaction.objectStore("mcpRedo").put({ broken: true }, documentId);
      transaction.objectStore("mcpOperations").put({ broken: true }, JSON.stringify([documentId, "damaged-client", "damaged-key"]));
      transaction.objectStore("mcpMeta").put(31, "commit-count");
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      db.close();
    }, { documentId: initial.documentId });
    await page.reload();
    await waitForBridge(page);
    await expect(page.getByText(/drawing loaded, but stored MCP undo history is damaged/i)).toBeVisible();

    const current = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const created = await mcp.call("create_diagram", {
      documentId: current.documentId,
      expectedDocumentRevision: current.documentRevision,
      idempotencyKey: "recover-after-corrupt-history",
      nodes: [{ id: "recovery-node", label: "Still editable", x: 100, y: 100 }],
      edges: [],
    });
    expect(created.error).toBeUndefined();
    expect(created.result?.isError).not.toBe(true);
    expect(JSON.parse(created.result.content[0].text).nodes["recovery-node"]).toBeTruthy();
    const state = await page.evaluate(async (documentId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("draw-local");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = db.transaction(["mcpUndo", "mcpRedo", "mcpOperations"], "readonly");
      const undo = await new Promise((resolve, reject) => { const request = transaction.objectStore("mcpUndo").get(documentId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const redo = await new Promise((resolve, reject) => { const request = transaction.objectStore("mcpRedo").get(documentId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const broken = await new Promise((resolve, reject) => { const request = transaction.objectStore("mcpOperations").get(JSON.stringify([documentId, "damaged-client", "damaged-key"])); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close();
      return { undo, redo, broken };
    }, current.documentId);
    expect(state.undo).toBeTruthy();
    expect(state.redo).toBeUndefined();
    expect(state.broken).toBeUndefined();
  } finally {
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real stdio MCP tools create, edit, undo, save, reopen, export, and reject paths safely", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required for the MCP integration test.");
  const directory = await mkdtemp(join(tmpdir(), "draw-mcp-e2e-"));
  const mcp = await startStdioMcp(baseURL, directory);
  try {
    await page.locator(".excalidraw canvas").first().waitFor();
    await expect.poll(async () => (await (await page.request.get("/__draw/api/health")).json())).toMatchObject({ ok: true });
    const initializedTools = await mcp.request("tools/list", {});
    expect(initializedTools.result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      "create_diagram", "update_elements", "delete_elements", "duplicate_elements", "set_selection",
      "group_elements", "ungroup_elements", "arrange_elements", "undo_operation", "redo_operation",
      "set_canvas_settings", "set_viewport", "open_document", "save_document", "export_image",
      "list_workspace_library", "read_workspace_library_item", "add_selection_to_workspace_library", "rename_workspace_library_item", "delete_workspace_library_item", "insert_workspace_library_item",
    ]));

    const initial = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const createdResponse = await mcp.call("create_diagram", { documentId: initial.documentId, expectedDocumentRevision: initial.documentRevision, title: "MCP lifecycle", nodes: [
      { id: "first", label: "First editable node", x: 160, y: 120 },
      { id: "second", label: "Second editable node", x: 440, y: 120 },
    ], edges: [{ from: "first", to: "second" }] });
    expect(createdResponse.error).toBeUndefined();
    const created = JSON.parse(createdResponse.result.content[0].text);
    expect(created.nodes.first).toBeTruthy();
    const snapshotResponse = await mcp.call("get_current_canvas", { offset: 0, limit: 250 });
    const snapshot = JSON.parse(snapshotResponse.result.content[0].text);
    expect(snapshot.documentId).toBeTruthy();
    expect(snapshot.elements.some((element: any) => element.id === created.nodes.first)).toBe(true);

    const staleSelection = await mcp.call("set_selection", { documentId: snapshot.documentId, expectedDocumentRevision: snapshot.documentRevision - 1, idempotencyKey: "stale-selection", ids: [created.nodes.first] });
    expect(staleSelection.result.isError).toBe(true);
    expect(staleSelection.result.content[0].text).toContain("CONFLICT");
    const selectResponse = await mcp.call("set_selection", { documentId: snapshot.documentId, expectedDocumentRevision: snapshot.documentRevision, idempotencyKey: "stdio-library-select", ids: [created.nodes.first, created.nodes.second] });
    expect(selectResponse.error).toBeUndefined();
    const emptyLibrary = JSON.parse((await mcp.call("list_workspace_library", { documentId: snapshot.documentId })).result.content[0].text);
    const addContext = { itemId: "stdio-workspace-item", elementIds: [created.nodes.first, created.nodes.second], name: "MCP reusable pair", documentId: snapshot.documentId, expectedDocumentRevision: snapshot.documentRevision, expectedLibraryRevision: emptyLibrary.libraryRevision, idempotencyKey: "stdio-library-add" };
    const libraryAdded = await mcp.call("add_selection_to_workspace_library", addContext);
    expect(libraryAdded.error).toBeUndefined();
    const libraryAddResult = JSON.parse(libraryAdded.result.content[0].text);
    const libraryAddRetry = await mcp.call("add_selection_to_workspace_library", addContext);
    expect(JSON.parse(libraryAddRetry.result.content[0].text)).toEqual(libraryAddResult);
    const changedAdd = await mcp.call("add_selection_to_workspace_library", { ...addContext, name: "Changed payload" });
    expect(changedAdd.result?.isError ?? changedAdd.error !== undefined).toBeTruthy();
    const libraryList = JSON.parse((await mcp.call("list_workspace_library", { documentId: snapshot.documentId })).result.content[0].text);
    expect(libraryList.items).toEqual([expect.objectContaining({ id: "stdio-workspace-item", name: "MCP reusable pair", elementCount: 4 })]);
    const unchangedAddRetry = await mcp.call("add_selection_to_workspace_library", { ...addContext, name: "Changed payload" });
    expect(unchangedAddRetry.result?.isError ?? unchangedAddRetry.error !== undefined).toBeTruthy();
    expect(JSON.parse((await mcp.call("list_workspace_library", { documentId: snapshot.documentId })).result.content[0].text).libraryRevision).toBe(libraryList.libraryRevision);
    const libraryRead = JSON.parse((await mcp.call("read_workspace_library_item", { documentId: snapshot.documentId, itemId: "stdio-workspace-item" })).result.content[0].text);
    expect(libraryRead.item.assets).toEqual({});
    let libraryContext = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const renameContext = { itemId: "stdio-workspace-item", name: "MCP flow library item", documentId: libraryContext.documentId, expectedDocumentRevision: libraryContext.documentRevision, expectedLibraryRevision: libraryList.libraryRevision, idempotencyKey: "stdio-library-rename" };
    const renamed = await mcp.call("rename_workspace_library_item", renameContext);
    expect(renamed.error).toBeUndefined();
    const renameResult = JSON.parse(renamed.result.content[0].text);
    const renameRetry = await mcp.call("rename_workspace_library_item", renameContext);
    expect(JSON.parse(renameRetry.result.content[0].text)).toEqual(renameResult);
    const changedRename = await mcp.call("rename_workspace_library_item", { ...renameContext, name: "Changed name" });
    expect(changedRename.result?.isError ?? changedRename.error !== undefined).toBeTruthy();
    const currentLibrary = JSON.parse((await mcp.call("list_workspace_library", { documentId: libraryContext.documentId })).result.content[0].text);
    const raceBase = { itemId: "stdio-workspace-item", documentId: libraryContext.documentId, expectedDocumentRevision: libraryContext.documentRevision, expectedLibraryRevision: currentLibrary.libraryRevision };
    const renameRace = await Promise.all([
      mcp.call("rename_workspace_library_item", { ...raceBase, name: "Concurrent A", idempotencyKey: "stdio-library-race-a" }),
      mcp.call("rename_workspace_library_item", { ...raceBase, name: "Concurrent B", idempotencyKey: "stdio-library-race-b" }),
    ]);
    expect(renameRace.filter((response) => response.error || response.result?.isError)).toHaveLength(1);
    libraryContext = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const insertedResponse = await mcp.call("insert_workspace_library_item", { itemId: "stdio-workspace-item", documentId: libraryContext.documentId, expectedDocumentRevision: libraryContext.documentRevision, idempotencyKey: "stdio-library-insert" });
    expect(insertedResponse.error).toBeUndefined();
    const insertedLibrary = JSON.parse(insertedResponse.result.content[0].text);
    expect(insertedLibrary.addedElementIds).toHaveLength(4);
    expect(new Set(insertedLibrary.addedElementIds).size).toBe(4);
    libraryContext = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const libraryCopyEdit = await mcp.call("update_elements", { documentId: libraryContext.documentId, expectedDocumentRevision: libraryContext.documentRevision, updates: [{ id: insertedLibrary.addedElementIds.find((id: string) => libraryContext.elements.find((element: any) => element.id === id)?.type === "text"), patch: { text: "Edited library copy" } }] });
    expect(libraryCopyEdit.error).toBeUndefined();
    libraryContext = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(libraryContext.elements.some((element: any) => element.originalText === "Edited library copy")).toBe(true);
    const libraryBeforeDelete = JSON.parse((await mcp.call("list_workspace_library", { documentId: libraryContext.documentId })).result.content[0].text);
    const deleteContext = { itemId: "stdio-workspace-item", documentId: libraryContext.documentId, expectedDocumentRevision: libraryContext.documentRevision, expectedLibraryRevision: libraryBeforeDelete.libraryRevision, idempotencyKey: "stdio-library-delete" };
    const deleteChallenge = await mcp.call("delete_workspace_library_item", deleteContext);
    const deletionApproval = JSON.parse(deleteChallenge.result.content[0].text);
    expect(deletionApproval.status).toBe("NEEDS_CONFIRMATION");
    await expect(page.getByRole("dialog", { name: "Delete a library item?" })).toBeVisible();
    await page.getByRole("button", { name: "Approve deletion" }).click();
    const libraryRemoved = await mcp.call("delete_workspace_library_item", { ...deleteContext, confirmationToken: deletionApproval.confirmationToken });
    expect(libraryRemoved.error).toBeUndefined();
    const deletedResult = JSON.parse(libraryRemoved.result.content[0].text);
    const deleteRetry = await mcp.call("delete_workspace_library_item", { ...deleteContext, confirmationToken: deletionApproval.confirmationToken });
    expect(JSON.parse(deleteRetry.result.content[0].text)).toEqual(deletedResult);
    expect(JSON.parse((await mcp.call("list_workspace_library", { documentId: libraryContext.documentId })).result.content[0].text).items).toEqual([]);
    let live = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const group = await mcp.call("group_elements", { documentId: live.documentId, expectedDocumentRevision: live.documentRevision, ids: [created.nodes.first, created.nodes.second] });
    expect(group.error).toBeUndefined();
    live = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const arrange = await mcp.call("arrange_elements", { documentId: live.documentId, expectedDocumentRevision: live.documentRevision, ids: [created.nodes.first, created.nodes.second], action: "align", alignment: "center_y" });
    expect(arrange.error).toBeUndefined();
    live = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const ungroup = await mcp.call("ungroup_elements", { documentId: live.documentId, expectedDocumentRevision: live.documentRevision, ids: [created.nodes.first, created.nodes.second] });
    expect(ungroup.error).toBeUndefined();
    live = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const duplicate = await mcp.call("duplicate_elements", { documentId: live.documentId, expectedDocumentRevision: live.documentRevision, ids: [created.nodes.first] });
    expect(duplicate.error).toBeUndefined();
    const duplicateIds = JSON.parse(duplicate.result.content[0].text).addedElementIds;
    live = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const deletion = await mcp.call("delete_elements", { documentId: live.documentId, expectedDocumentRevision: live.documentRevision, ids: duplicateIds });
    expect(deletion.error).toBeUndefined();

    const beforeEdit = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const editResponse = await mcp.call("update_elements", { documentId: beforeEdit.documentId, expectedDocumentRevision: beforeEdit.documentRevision, updates: [{ id: created.nodes.first, patch: { x: 190, text: "Edited through MCP" } }] });
    expect(editResponse.error).toBeUndefined();
    const edited = JSON.parse(editResponse.result.content[0].text);
    const undoResponse = await mcp.call("undo_operation", { documentId: snapshot.documentId, operationId: edited.operationId, expectedDocumentRevision: edited.documentRevision });
    expect(undoResponse.error).toBeUndefined();
    const undoneCanvas = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(undoneCanvas.elements.find((element: any) => element.id === created.nodes.first).text).not.toBe("Edited through MCP");
    const undone = JSON.parse(undoResponse.result.content[0].text);
    const redoResponse = await mcp.call("redo_operation", { documentId: snapshot.documentId, operationId: edited.operationId, expectedDocumentRevision: undone.documentRevision });
    expect(redoResponse.error).toBeUndefined();

    const beforeSettings = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const settings = await mcp.call("set_canvas_settings", { documentId: beforeSettings.documentId, expectedDocumentRevision: beforeSettings.documentRevision, title: "Settings are not undoable", background: "white" });
    expect(settings.error).toBeUndefined();
    const settingsResult = JSON.parse(settings.result.content[0].text);
    const settingsUndo = await mcp.call("undo_operation", { documentId: beforeSettings.documentId, operationId: edited.operationId, expectedDocumentRevision: settingsResult.documentRevision });
    expect(settingsUndo.result?.isError).toBe(true);
    const afterSettings = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(afterSettings.title).toBe("Settings are not undoable");
    expect(afterSettings.background).toBe("white");
    const viewport = await mcp.call("set_viewport", { documentId: afterSettings.documentId, expectedViewRevision: afterSettings.viewRevision, action: "set", x: -200, y: -100, zoom: 1.25 });
    expect(viewport.error).toBeUndefined();
    const viewportResult = JSON.parse(viewport.result.content[0].text);
    expect(viewportResult.viewport).toMatchObject({ x: -200, y: -100, zoom: 1.25 });
    expect(viewportResult.viewRevision).toBeGreaterThan(afterSettings.viewRevision);

    // A later human history operation invalidates the MCP undo token. The MCP
    // request must fail closed instead of consuming this subsequent editor work.
    const preHumanAction = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    await page.getByRole("button", { name: "Undo" }).click();
    const staleAfterHumanUndo = await mcp.call("update_elements", {
      documentId: preHumanAction.documentId,
      expectedDocumentRevision: preHumanAction.documentRevision,
      updates: [{ id: created.nodes.first, patch: { x: 333 } }],
    });
    expect(staleAfterHumanUndo.result?.isError).toBe(true);
    const afterHumanUndo = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const unsafeUndo = await mcp.call("undo_operation", { documentId: afterHumanUndo.documentId, operationId: edited.operationId, expectedDocumentRevision: afterHumanUndo.documentRevision });
    expect(unsafeUndo.result?.isError).toBe(true);
    await page.getByRole("button", { name: "Redo" }).click();

    const current = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    const savedResponse = await mcp.call("save_document", { path: "stdio-roundtrip.draw", documentId: current.documentId, expectedDocumentRevision: current.documentRevision });
    expect(savedResponse.error).toBeUndefined();
    const savedFile = JSON.parse(await readFile(join(directory, "stdio-roundtrip.draw"), "utf8"));
    expect(savedFile.format).toBe("draw");
    expect(savedFile.document.elements.some((element: any) => element.id === created.nodes.first)).toBe(true);
    const collision = await mcp.call("save_document", { path: "stdio-roundtrip.draw", documentId: current.documentId, expectedDocumentRevision: current.documentRevision });
    expect(collision.result?.isError).toBe(true);
    expect(JSON.stringify(collision)).toMatch(/PATH_EXISTS/);

    const exportedResponse = await mcp.call("export_image", { documentId: current.documentId, format: "png", scope: "canvas" });
    expect(exportedResponse.error).toBeUndefined();
    expect(exportedResponse.result.content.some((part: any) => part.type === "image" && part.mimeType === "image/png" && part.data.length > 100)).toBe(true);

    const confirmationResponse = await mcp.call("open_document", { path: "stdio-roundtrip.draw", documentId: current.documentId, expectedDocumentRevision: current.documentRevision });
    const challenge = JSON.parse(confirmationResponse.result.content[0].text);
    expect(challenge.status).toBe("NEEDS_CONFIRMATION");
    await expect(page.getByRole("dialog", { name: "Open a Draw document?" })).toBeVisible();
    const forgedApproval = await page.request.post(`/__draw/api/confirmations/${encodeURIComponent(challenge.confirmationToken)}/respond`, {
      data: { clientId: "forged-local-mcp-client", approved: true },
    });
    expect(forgedApproval.status()).toBe(401);
    await page.getByRole("button", { name: "Keep current canvas" }).click();
    const denied = await mcp.call("open_document", { path: "stdio-roundtrip.draw", documentId: current.documentId, expectedDocumentRevision: current.documentRevision, confirmationToken: challenge.confirmationToken });
    expect(JSON.parse(denied.result.content[0].text).status).toBe("DENIED");
    const approvedChallengeResponse = await mcp.call("open_document", { path: "stdio-roundtrip.draw", documentId: current.documentId, expectedDocumentRevision: current.documentRevision });
    const approvedChallenge = JSON.parse(approvedChallengeResponse.result.content[0].text);
    await expect(page.getByRole("dialog", { name: "Open a Draw document?" })).toBeVisible();
    await page.getByRole("button", { name: "Approve opening" }).click();
    const openResponse = await mcp.call("open_document", { path: "stdio-roundtrip.draw", documentId: current.documentId, expectedDocumentRevision: current.documentRevision, confirmationToken: approvedChallenge.confirmationToken });
    expect(openResponse.error).toBeUndefined();
    const openResult = JSON.parse(openResponse.result.content[0].text);
    expect(openResult.opened).toBe(true);
    await expect.poll(async () => (await (await page.request.get("/__draw/api/document?flush=1", { headers: mcpAuthHeaders() })).json()).document.elements.some((element: any) => element.id === created.nodes.first)).toBe(true);
    const reopened = JSON.parse((await mcp.call("get_current_canvas", {})).result.content[0].text);
    expect(reopened.documentRevision).toBeGreaterThan(current.documentRevision);
    expect(openResult.documentId).toBe(reopened.documentId);
    expect(openResult.documentRevision).toBe(reopened.documentRevision);
    const reusedToken = await mcp.call("open_document", { path: "stdio-roundtrip.draw", documentId: reopened.documentId, expectedDocumentRevision: reopened.documentRevision, confirmationToken: approvedChallenge.confirmationToken });
    expect(JSON.parse(reusedToken.result.content[0].text).status).toBe("EXPIRED");
    const unsafe = await mcp.call("open_document", { path: "../outside.draw", documentId: current.documentId, expectedDocumentRevision: current.documentRevision });
    expect(unsafe.result?.isError ?? unsafe.error !== undefined).toBeTruthy();
  } finally {
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace combobox and action controls share sizing and keyboard focus", async ({ page }) => {
  const picker = page.getByRole("combobox", { name: "Saved workspaces" });
  await expect(picker.locator("option:checked")).toHaveText("My workspace");
  await picker.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "New workspace" })).toBeFocused();
  for (const name of ["New workspace", "Rename workspace", "Delete workspace"]) {
    const button = page.getByRole("button", { name, exact: true });
    expect((await button.boundingBox())?.height).toBe(32);
    await expect(button.locator("svg")).toHaveCount(1);
  }
});

test("workspaces create, switch, rename, delete, and survive reload with one board each", async ({ page }) => {
  const originalWorkspaceId = await currentWorkspaceId(page);
  await expect(page.locator('nav select[aria-label="Canvas"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New canvas" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open", exact: true })).toHaveAttribute("title", /Open a \.draw file/);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveAttribute("title", /Save the editable \.draw file/);
  await expect(page.getByRole("button", { name: "New workspace" })).toHaveAttribute("title", "Create a new workspace");
  await expect(page.getByRole("button", { name: "Rename workspace" })).toHaveAttribute("title", "Rename the selected workspace");
  await expect(page.getByRole("button", { name: "Delete workspace" })).toHaveAttribute("title", "Delete the selected workspace and its drawing");
  await expect(page.getByRole("combobox", { name: "Saved workspaces" })).toHaveAttribute("title", "Choose the active workspace");
  await expect(page.getByRole("combobox", { name: "Saved workspaces" }).locator("option:checked")).toHaveText("My workspace");
  await page.getByLabel("Drawing title").fill("Alpha notes");
  await expect.poll(async () => (await readLocalDocument(page))?.document.title).toBe("Alpha notes");

  await page.getByRole("button", { name: "New workspace" }).click();
  await expect.poll(() => workspaceCount(page)).toBe(2);
  await expect(page.getByLabel("Drawing title")).toHaveValue("Untitled drawing");
  await page.reload();
  await page.locator(".topbar").waitFor();
  await expect.poll(() => workspaceCount(page)).toBe(2);
  await expect(page.getByLabel("Drawing title")).toHaveValue("Untitled drawing");
  await selectWorkspace(page, originalWorkspaceId);
  await expect(page.getByLabel("Drawing title")).toHaveValue("Alpha notes");
  await expect(page.getByRole("combobox", { name: "Saved workspaces" })).toBeFocused();

  page.once("dialog", (dialog) => dialog.accept("Research workspace"));
  await page.getByRole("button", { name: "Rename workspace" }).click();
  await expect(page.getByRole("combobox", { name: "Saved workspaces" }).locator("option:checked")).toHaveText("Research workspace");
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect.poll(() => workspaceCount(page)).toBe(3);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete workspace" }).click();
  await expect.poll(() => workspaceCount(page)).toBe(2);
  await expect(page.getByLabel("Drawing title")).toHaveValue("Alpha notes");
});

test("pending autosave is preserved when switching workspaces", async ({ page }) => {
  const originalWorkspaceId = await currentWorkspaceId(page);
  await page.getByLabel("Drawing title").fill("Pending board edit");
  await expect(page.locator(".save-indicator.saving")).toBeVisible();
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(page.getByLabel("Drawing title")).toHaveValue("Untitled drawing");
  await selectWorkspace(page, originalWorkspaceId);
  await expect(page.getByLabel("Drawing title")).toHaveValue("Pending board edit");
  await expect(page.getByText("Saved on this device")).toBeVisible();
  await expect(page.getByText(/reload the page to continue/i)).toHaveCount(0);
});

test("deleting a workspace removes its board and library state", async ({ page }) => {
  await page.getByRole("button", { name: "New workspace" }).click();
  await expect(page.getByLabel("Drawing title")).toHaveValue("Untitled drawing");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete workspace" }).click();
  await expect.poll(() => workspaceCount(page)).toBe(1);
  await expect(page.getByText("Saved on this device")).toBeVisible();
});

test("a read-only tab does not bootstrap a fresh workspace or active canvas pointer", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const win = window as typeof window & { __drawLockReady?: Promise<void> };
    win.__drawLockReady = new Promise<void>((resolve) => {
      void navigator.locks.request("draw-local-writer-v1", { mode: "exclusive" }, async () => {
        resolve();
        await new Promise<void>(() => {});
      });
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(baseURL!);
    await page.evaluate(() => (window as typeof window & { __drawLockReady?: Promise<void> }).__drawLockReady);
    await expect(page.getByText(/already open in another tab/i)).toBeVisible();
    const records = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("draw-local");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const values = await new Promise<{ workspaces: unknown[]; canvases: unknown[]; pointer: unknown }>((resolve, reject) => {
        const tx = db.transaction(["workspaces", "canvases", "workspaceMeta"], "readonly");
        const workspaces = tx.objectStore("workspaces").getAll();
        const canvases = tx.objectStore("canvases").getAll();
        const pointer = tx.objectStore("workspaceMeta").get("activeCanvas");
        tx.oncomplete = () => resolve({ workspaces: workspaces.result, canvases: canvases.result, pointer: pointer.result });
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return values;
    });
    expect(records).toEqual({ workspaces: [], canvases: [], pointer: undefined });
  } finally {
    await context.close();
  }
});

test("opening a .draw file creates a separate editable workspace", async ({ page }) => {
  const create = await page.request.post(commandApi, { headers: mcpAuthHeaders(), data: {
    operation: "create_diagram",
    input: { idempotencyKey: "e2e-workspace-import-fixture", nodes: [{ id: "import-fixture", label: "Preserve in imported copy", x: 100, y: 100 }], edges: [] },
  } });
  expect(create.ok(), await create.text()).toBeTruthy();
  const before = await readLocalDocument(page);
  const source = structuredClone(before);
  source.document.id = "portable-source-id";
  source.document.title = "Imported reference";
  const oldWorkspaceId = await currentWorkspaceId(page);
  const countBefore = await workspaceCount(page);
  const importInput = page.locator('input[type="file"][accept^=".draw"]');
  await importInput.setInputFiles({ name: "reference.draw", mimeType: "application/vnd.draw+json", buffer: Buffer.from(JSON.stringify(source)) });
  await expect.poll(() => workspaceCount(page)).toBe(countBefore + 1);
  await expect(page.getByLabel("Drawing title")).toHaveValue("Imported reference");
  const importedWorkspaceId = await currentWorkspaceId(page);
  expect(importedWorkspaceId).not.toBe(oldWorkspaceId);
  const imported = await readLocalDocument(page);
  expect(imported.document.id).not.toBe("portable-source-id");
  expect(imported.document.elements).toEqual(before.document.elements);
  await selectWorkspace(page, oldWorkspaceId);
  await expect(page.getByLabel("Drawing title")).toHaveValue(before.document.title);
  expect((await readLocalDocument(page)).document.elements).toEqual(before.document.elements);
});

test("V1 current-document data migrates into the default workspace without losing its editable scene", async ({ page }) => {
  const legacy = await readLocalDocument(page);
  legacy.document.title = "Migrated V1 diagram";
  legacy.document.documentRevision = 12;
  legacy.document.canvas.viewport = { x: -38, y: 52, zoom: 0.8 };
  await page.evaluate(async (document) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("draw-local");
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Draw database remained open during the migration fixture."));
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local", 4);
      request.onupgradeneeded = () => request.result.createObjectStore("documents");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("documents", "readwrite");
      tx.objectStore("documents").put(document, "current");
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    database.close();
  }, legacy);
  await page.reload();
  await page.locator(".topbar").waitFor();
  await expect(page.getByLabel("Drawing title")).toHaveValue("Migrated V1 diagram");
  await expect.poll(() => workspaceCount(page)).toBe(1);
  await expect(page.locator('nav select[aria-label="Canvas"]')).toHaveCount(0);
  const migrated = await readLocalDocument(page);
  expect(migrated.document.elements).toEqual(legacy.document.elements);
  expect(migrated.document.canvas.viewport).toEqual(legacy.document.canvas.viewport);
  expect(migrated.document.documentRevision).toBe(12);
});

test("stdio MCP manages workspaces with durable replay, safe imports, and human-approved deletion", async ({ page, baseURL }) => {
  const directory = await mkdtemp(join(tmpdir(), "draw-e2e-workspace-mcp-"));
  const source = await readLocalDocument(page);
  source.document.id = "mcp-import-source";
  source.document.title = "Agent import source";
  source.document.elements = [{ id: "agent-import-node", type: "rectangle", x: 80, y: 90, width: 180, height: 90, angle: 0, strokeColor: "#e03131", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 410, version: 1, versionNonce: 411, isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false }];
  await writeFile(join(directory, "agent-source.draw"), JSON.stringify(source), { mode: 0o600 });
  let mcp: Awaited<ReturnType<typeof startStdioMcp>> | null = null;
  try {
    mcp = await startStdioMcp(baseURL!, directory);
    const result = async (response: any) => {
      expect(response.error, JSON.stringify(response.error)).toBeUndefined();
      expect(response.result?.isError, response.result?.content?.[0]?.text).not.toBe(true);
      return JSON.parse(response.result.content[0].text);
    };
    const initial = await result(await mcp.call("list_workspaces", {}));
    expect(initial.activeWorkspaceId).toBeTruthy();
    expect(initial.activeCanvasId).toBeTruthy();
    expect(initial.activeDocument.document.id).toBeTruthy();
    const revision = initial.catalogRevision;
    const createArgs = { expectedCatalogRevision: revision, idempotencyKey: "mcp-create-workspace-e2e", name: "Agent project" };
    const created = await result(await mcp.call("create_workspace", createArgs));
    expect(created.activeWorkspaceId).not.toBe(initial.activeWorkspaceId);
    expect(created.activeCanvasId).toBeTruthy();
    expect(created.activeDocument.document.id).toBeTruthy();
    const retry = await result(await mcp.call("create_workspace", createArgs));
    expect(retry.activeWorkspaceId).toBe(created.activeWorkspaceId);
    await page.getByLabel("Drawing title").fill("Human edited agent workspace");
    await expect.poll(async () => (await readLocalDocument(page))?.document.title).toBe("Human edited agent workspace");
    const afterFirstCreate = await result(await mcp.call("list_workspaces", {}));
    const humanWorkspace = await result(await mcp.call("create_workspace", {
      expectedCatalogRevision: afterFirstCreate.catalogRevision, idempotencyKey: "mcp-human-workspace-e2e", name: "Human workspace",
    }));
    expect(humanWorkspace.activeWorkspaceId).not.toBe(created.activeWorkspaceId);
    await page.getByLabel("Drawing title").fill("Current human canvas");
    await expect.poll(async () => (await readLocalDocument(page))?.document.title).toBe("Current human canvas");
    const currentCanvas = page.locator(".excalidraw canvas").last();
    const currentBounds = await currentCanvas.boundingBox();
    if (!currentBounds) throw new Error("The active editable canvas is unavailable after adding a canvas.");
    await page.locator('.excalidraw label[title^="Rectangle"]').click();
    const rectangleX = currentBounds.x + currentBounds.width / 2 - 60;
    const rectangleY = currentBounds.y + currentBounds.height / 2 - 35;
    await page.mouse.move(rectangleX, rectangleY);
    await page.mouse.down(); await page.mouse.move(rectangleX + 120, rectangleY + 70, { steps: 2 }); await page.mouse.up();
    await expect.poll(async () => (await readLocalDocument(page))?.document.elements.length).toBe(1);
    const currentBeforeReplay = await readLocalDocument(page);
    const currentWorkspace = await currentWorkspaceId(page);
    const activeCatalog = await result(await mcp.call("list_workspaces", {}));
    const currentCanvasId = activeCatalog.activeCanvasId;
    const safeReplay = await result(await mcp.call("create_workspace", createArgs));
    expect(safeReplay.activeWorkspaceId).toBe(currentWorkspace);
    expect(safeReplay.activeCanvasId).toBe(currentCanvasId);
    expect(safeReplay.activeDocument.document.title).toBe("Current human canvas");
    expect(safeReplay.activeDocument.document.elements).toHaveLength(1);
    expect(await readLocalDocument(page)).toEqual(currentBeforeReplay);
    await expect(page.getByLabel("Drawing title")).toHaveValue("Current human canvas");
    const conflict = await mcp.call("create_workspace", { ...createArgs, name: "Changed intent" });
    expect(conflict.result?.isError).toBe(true);
    const beforeImport = await result(await mcp.call("list_workspaces", {}));
    const canvasArgs = { expectedCatalogRevision: beforeImport.catalogRevision, idempotencyKey: "mcp-import-canvas-e2e", workspaceId: created.activeWorkspaceId, path: "agent-source.draw", name: "Imported agent plan" };
    const imported = await result(await mcp.call("import_draw_file_as_canvas", canvasArgs));
    expect(imported.activeWorkspaceId).not.toBe(created.activeWorkspaceId);
    expect(imported.activeCanvasId).not.toBe(created.activeCanvasId);
    expect(imported.activeDocument.document.title).toBe("Imported agent plan");
    expect(imported.activeDocument.document.elements.some((element: any) => element.id === "agent-import-node")).toBe(true);
    const stale = await mcp.call("create_canvas", { expectedCatalogRevision: created.catalogRevision, idempotencyKey: "mcp-stale-catalog", workspaceId: created.activeWorkspaceId, name: "Should conflict" });
    expect(stale.result?.isError).toBe(true);
    const importedWorkspaceCanvases = await result(await mcp.call("list_canvases", { workspaceId: imported.activeWorkspaceId }));
    expect(importedWorkspaceCanvases.canvases).toHaveLength(1);
    expect(importedWorkspaceCanvases.canvases[0].id).toBe(imported.activeCanvasId);
    const duplicate = await result(await mcp.call("duplicate_canvas", { expectedCatalogRevision: imported.catalogRevision, idempotencyKey: "mcp-duplicate-canvas-e2e", canvasId: imported.activeCanvasId, name: "Editable duplicate" }));
    expect(duplicate.activeWorkspaceId).not.toBe(imported.activeWorkspaceId);
    expect(duplicate.activeCanvasId).not.toBe(imported.activeCanvasId);
    expect(duplicate.activeDocument.document.elements.some((element: any) => element.id === "agent-import-node")).toBe(true);
    await expect.poll(async () => (await readLocalDocument(page))?.document.id).toBe(duplicate.activeDocument.document.id);
    const confirmationCatalog = await result(await mcp.call("list_workspaces", {}));
    const rejectedCanvasDelete = await mcp.call("delete_canvas", {
      expectedCatalogRevision: confirmationCatalog.catalogRevision,
      idempotencyKey: "mcp-delete-canvas-rejected-e2e", canvasId: created.activeCanvasId,
    });
    expect(rejectedCanvasDelete.result?.isError ?? rejectedCanvasDelete.error !== undefined).toBe(true);
    expect(rejectedCanvasDelete.result?.content?.[0]?.text ?? rejectedCanvasDelete.error?.message ?? "").toMatch(/delete_workspace/i);
    await expect(page.getByRole("dialog", { name: "Delete this workspace?" })).toHaveCount(0);
    const spoofedConfirmation = await page.request.post("/__draw/api/confirmations", { headers: mcpAuthHeaders(), data: {
      action: "delete_workspace", documentId: confirmationCatalog.activeDocument.document.id,
      expectedDocumentRevision: confirmationCatalog.activeDocument.document.documentRevision,
      expectedCatalogRevision: confirmationCatalog.catalogRevision, targetId: created.activeWorkspaceId,
      idempotencyKey: "raw-spoofed-confirmation", fingerprint: "f".repeat(64),
      targetName: "Forged target", workspaceName: "Forged project", canvasCount: 999,
    } });
    expect(spoofedConfirmation.ok(), await spoofedConfirmation.text()).toBeTruthy();
    await expect(page.getByRole("dialog", { name: "Delete this workspace?" })).toBeVisible();
    const spoofDialogText = await page.getByRole("dialog").innerText();
    expect(spoofDialogText).toContain("Agent project");
    expect(spoofDialogText).not.toContain("Forged target");
    expect(spoofDialogText).not.toContain("Forged project");
    expect(spoofDialogText).toContain("1 canvas(es)");
    expect(spoofDialogText).not.toContain("999 canvas(es)");
    await page.getByRole("button", { name: "Keep drawings" }).click();
    const deleteArgs = { expectedCatalogRevision: duplicate.catalogRevision, idempotencyKey: "mcp-delete-workspace-e2e", workspaceId: created.activeWorkspaceId };
    const needsApproval = await result(await mcp.call("delete_workspace", deleteArgs));
    expect(needsApproval.status).toBe("NEEDS_CONFIRMATION");
    await expect(page.getByRole("dialog", { name: "Delete this workspace?" })).toBeVisible();
    await page.getByRole("button", { name: "Keep drawings" }).click();
    const denied = await mcp.call("delete_workspace", { ...deleteArgs, confirmationToken: needsApproval.confirmationToken });
    expect(denied.result?.isError).toBe(true);
    const latest = await result(await mcp.call("list_workspaces", {}));
    const secondArgs = { expectedCatalogRevision: latest.catalogRevision, idempotencyKey: "mcp-delete-workspace-approved-e2e", workspaceId: created.activeWorkspaceId };
    const approval = await result(await mcp.call("delete_workspace", secondArgs));
    await expect(page.getByRole("dialog", { name: "Delete this workspace?" })).toBeVisible();
    await page.getByRole("button", { name: "Approve deletion" }).click();
    const deleted = await result(await mcp.call("delete_workspace", { ...secondArgs, confirmationToken: approval.confirmationToken }));
    expect(deleted.workspaces.some((workspace: any) => workspace.id === created.activeWorkspaceId)).toBe(false);
    await page.reload();
    await page.locator(".topbar").waitFor();
    await connectEditorToMcp(page);
    const afterReload = await result(await mcp.call("list_workspaces", {}));
    expect(afterReload.workspaces.some((workspace: any) => workspace.id === created.activeWorkspaceId)).toBe(false);
    expect(afterReload.activeDocument.document.id).toBeTruthy();
  } finally {
    await mcp?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stdio MCP library follows the active workspace across A to B and back", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required for the workspace-library integration test.");
  const directory = await mkdtemp(join(tmpdir(), "draw-e2e-workspace-library-switch-"));
  const mcp = await startStdioMcp(baseURL, directory);
  try {
    const result = async (response: any) => {
      expect(response.error, JSON.stringify(response.error)).toBeUndefined();
      expect(response.result?.isError, response.result?.content?.[0]?.text).not.toBe(true);
      return JSON.parse(response.result.content[0].text);
    };
    const aCatalog = await result(await mcp.call("list_workspaces", {}));
    const aDocument = await result(await mcp.call("get_current_canvas", {}));
    const aDiagram = await result(await mcp.call("create_diagram", {
      documentId: aDocument.documentId, expectedDocumentRevision: aDocument.documentRevision,
      idempotencyKey: "workspace-a-library-node", nodes: [{ id: "node-a", label: "Project A item", x: 100, y: 100 }], edges: [],
    }));
    const aAfterCreate = await result(await mcp.call("get_current_canvas", {}));
    const aLibrary = await result(await mcp.call("list_workspace_library", { documentId: aAfterCreate.documentId }));
    await result(await mcp.call("add_selection_to_workspace_library", {
      documentId: aAfterCreate.documentId, expectedDocumentRevision: aAfterCreate.documentRevision,
      expectedLibraryRevision: aLibrary.libraryRevision, idempotencyKey: "workspace-a-library-add",
      itemId: "workspace-a-item", elementIds: [aDiagram.nodes["node-a"]], name: "Project A library item",
    }));

    const b = await result(await mcp.call("create_workspace", {
      expectedCatalogRevision: aCatalog.catalogRevision, idempotencyKey: "workspace-b-create", name: "Project B",
    }));
    const bDocument = await result(await mcp.call("get_current_canvas", {}));
    const bEmpty = await result(await mcp.call("list_workspace_library", { documentId: bDocument.documentId }));
    expect(bEmpty.workspaceId).toBe(b.activeWorkspaceId);
    expect(bEmpty.items).toEqual([]);
    await expect(page.getByRole("button", { name: /Manage library/ })).toHaveCount(0);

    const bDiagram = await result(await mcp.call("create_diagram", {
      documentId: bDocument.documentId, expectedDocumentRevision: bDocument.documentRevision,
      idempotencyKey: "workspace-b-library-node", nodes: [{ id: "node-b", label: "Project B item", x: 120, y: 120 }], edges: [],
    }));
    const bAfterCreate = await result(await mcp.call("get_current_canvas", {}));
    const bLibrary = await result(await mcp.call("list_workspace_library", { documentId: bAfterCreate.documentId }));
    await result(await mcp.call("add_selection_to_workspace_library", {
      documentId: bAfterCreate.documentId, expectedDocumentRevision: bAfterCreate.documentRevision,
      expectedLibraryRevision: bLibrary.libraryRevision, idempotencyKey: "workspace-b-library-add",
      itemId: "workspace-b-item", elementIds: [bDiagram.nodes["node-b"]], name: "Project B library item",
    }));
    expect((await result(await mcp.call("list_workspace_library", { documentId: bAfterCreate.documentId }))).items)
      .toEqual([expect.objectContaining({ id: "workspace-b-item", name: "Project B library item" })]);

    const beforeSelectA = await result(await mcp.call("list_workspaces", {}));
    const restoredA = await result(await mcp.call("select_workspace", {
      expectedCatalogRevision: beforeSelectA.catalogRevision, idempotencyKey: "workspace-a-select", workspaceId: aCatalog.activeWorkspaceId,
    }));
    const restoredDocument = await result(await mcp.call("get_current_canvas", {}));
    expect(restoredDocument.documentId).toBe(restoredA.activeDocument.document.id);
    const restoredLibrary = await result(await mcp.call("list_workspace_library", { documentId: restoredDocument.documentId }));
    expect(restoredLibrary.workspaceId).toBe(aCatalog.activeWorkspaceId);
    expect(restoredLibrary.items).toEqual([expect.objectContaining({ id: "workspace-a-item", name: "Project A library item" })]);
    const wrongWorkspaceInsert = await mcp.call("insert_workspace_library_item", {
      documentId: restoredDocument.documentId, expectedDocumentRevision: restoredDocument.documentRevision,
      idempotencyKey: "wrong-project-insert", itemId: "workspace-b-item",
    });
    expect(wrongWorkspaceInsert.result?.isError ?? wrongWorkspaceInsert.error !== undefined).toBeTruthy();
    const latestA = await result(await mcp.call("get_current_canvas", {}));
    await result(await mcp.call("insert_workspace_library_item", {
      documentId: latestA.documentId, expectedDocumentRevision: latestA.documentRevision,
      idempotencyKey: "right-project-insert", itemId: "workspace-a-item",
    }));
    expect(restoredLibrary.items.map((item: any) => item.name)).toContain("Project A library item");
    expect(restoredLibrary.items.map((item: any) => item.name)).not.toContain("Project B library item");
  } finally {
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("quarantined autosave can be exported while new edits resume autosaving in a fresh workspace", async ({ page }) => {
  const raw = { format: "draw", formatVersion: 1, document: { id: "damaged-original", title: "Preserve this raw payload", elemnts: [] } };
  await page.evaluate(async (raw) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("draw-local");
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Fixture database is still open"));
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local", 4);
      request.onupgradeneeded = () => request.result.createObjectStore("documents");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("documents", "readwrite");
    tx.objectStore("documents").put(raw, "current");
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, raw);
  await page.reload();
  const recovery = page.getByRole("region", { name: "Workspace recovery" });
  await expect(recovery).toBeVisible();
  const downloadWait = page.waitForEvent("download");
  await recovery.getByRole("button", { name: "Download recovery backup (JSON)" }).click();
  const downloaded = await downloadWait;
  const path = await downloaded.path();
  expect(path).toBeTruthy();
  expect(JSON.parse(await readFile(path!, "utf8"))).toEqual(raw);
  await page.getByLabel("Drawing title").fill("New edits kept safely");
  await page.locator('.excalidraw label[title^="Rectangle"]').click();
  const board = await page.locator(".excalidraw canvas").last().boundingBox();
  if (!board) throw new Error("Recovery board is unavailable");
  await page.mouse.move(board.x + board.width * 0.55, board.y + 120);
  await page.mouse.down();
  await page.mouse.move(board.x + board.width * 0.55 + 140, board.y + 220, { steps: 3 });
  await page.mouse.up();
  const draftWait = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const draft = await draftWait;
  const draftPath = await draft.path();
  const draftDocument = JSON.parse(await readFile(draftPath!, "utf8"));
  expect(draftDocument.document.elements).toHaveLength(1);
  await recovery.getByRole("button", { name: "Enable autosave in new workspace" }).click();
  await expect(recovery).toBeHidden();
  await expect(page.getByLabel("Drawing title")).toHaveValue("New edits kept safely");
  await page.getByLabel("Drawing title").fill("Autosave restored");
  await expect(page.locator(".save-indicator")).toHaveText("Saved on this device");
  await page.reload();
  await expect(page.getByLabel("Drawing title")).toHaveValue("Autosave restored");
  const retainedWait = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download recovery backup (JSON)" }).click();
  const retained = await retainedWait;
  expect(JSON.parse(await readFile((await retained.path())!, "utf8"))).toEqual(raw);
  const normalized = (elements: any[]) => elements.map((element) => ({ ...element, boundElements: element.boundElements ?? [] }));
  expect(normalized((await readLocalDocument(page)).document.elements)).toEqual(normalized(draftDocument.document.elements));
});

test("a malformed saved library is downloadable while its drawing and autosave remain usable", async ({ page }) => {
  const document = await readLocalDocument(page);
  document.document.title = "Preserved drawing";
  document.document.elements.push({ id: "library-recovery-shape", type: "rectangle", x: 100, y: 100, width: 100, height: 80 });
  const rawLibrary = { items: [{ opaque: "preserve this library payload" }], revision: -1 };
  await page.evaluate(async ({ document, rawLibrary }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("draw-local");
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Fixture database is still open"));
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("draw-local", 10);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("documents"); database.createObjectStore("workspaces");
        const canvases = database.createObjectStore("canvases");
        canvases.createIndex("byWorkspaceId", "workspaceId");
        canvases.createIndex("byDocumentId", "documentId", { unique: true });
        database.createObjectStore("workspaceMeta"); database.createObjectStore("workspaceLibrary");
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["documents", "workspaces", "canvases", "workspaceMeta", "workspaceLibrary"], "readwrite");
    tx.objectStore("documents").put(document, ["draw-document", document.document.id]);
    tx.objectStore("documents").put(document, "current");
    tx.objectStore("workspaces").put({ id: "damaged-library-workspace", name: "Preserved project", createdAt: 1, updatedAt: 1 }, "damaged-library-workspace");
    tx.objectStore("canvases").put({ id: "preserved-board", workspaceId: "damaged-library-workspace", documentId: document.document.id, name: document.document.title, createdAt: 1, updatedAt: 1 }, "preserved-board");
    tx.objectStore("workspaceMeta").put({ workspaceId: "damaged-library-workspace", canvasId: "preserved-board" }, "active");
    tx.objectStore("workspaceMeta").put(true, "has-canvas-history");
    tx.objectStore("workspaceLibrary").put(rawLibrary, "damaged-library-workspace");
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, { document, rawLibrary });
  await page.reload();
  await expect(page.getByLabel("Drawing title")).toHaveValue("Preserved drawing");
  const notice = page.getByRole("region", { name: "Library recovery", exact: true });
  await expect(notice).toBeVisible();
  const backupWait = page.waitForEvent("download");
  await notice.getByRole("button", { name: /Download library backup/ }).click();
  const backup = await backupWait;
  expect(JSON.parse(await readFile((await backup.path())!, "utf8")).raw).toEqual(rawLibrary);
  await notice.getByRole("button", { name: "Dismiss library notice" }).click();
  await page.getByLabel("Drawing title").fill("Still autosaving");
  await expect(page.locator(".save-indicator")).toHaveText("Saved on this device");
  await page.reload();
  await expect(page.getByLabel("Drawing title")).toHaveValue("Still autosaving");
  expect((await readLocalDocument(page)).document.elements).toMatchObject([{ id: "library-recovery-shape", type: "rectangle" }]);
  await page.getByRole("button", { name: "Dismiss library notice" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Library recovery backups", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Library recovery", exact: true })).toHaveCount(0);
});

test("MCP clients dialog closes from its sticky heading and with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await page.goto("/");
  await connectEditorToMcp(page);
  const trigger = page.getByRole("button", { name: "MCP clients", exact: true });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "MCP clients" });
  await expect(dialog).toBeVisible();
  const secret = dialog.locator(".mcp-pairing-secret");
  await expect(secret).toBeVisible();
  const closeButton = dialog.getByRole("button", { name: "Close MCP clients" });
  await expect(closeButton).toBeVisible();
  await expect(closeButton).toBeFocused();
  await trigger.evaluate((button) => button.focus());
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await page.mouse.click(850, 10);
  await expect(dialog).toBeVisible();
  await expect(secret).toBeVisible();
  const closeBox = await closeButton.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.y).toBeGreaterThanOrEqual(0);
  expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(500);
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await closeButton.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator(".mcp-pairing-secret")).toHaveCount(0);

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
