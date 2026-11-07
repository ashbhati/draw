import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const forbidden = [
  "/__draw/api/e2e/active-launch-code",
  "DRAW_E2E_EDITOR_CODE",
  "DRAW_E2E_AUTH_STATE_PATH",
];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else {
      const content = await readFile(path);
      for (const marker of forbidden) {
        if (content.includes(marker)) throw new Error(`Production bundle contains test-only marker ${marker} in ${path}`);
      }
    }
  }
}

await visit("dist");
console.log("Production bundle excludes E2E-only auth code, paths, and environment variables.");
