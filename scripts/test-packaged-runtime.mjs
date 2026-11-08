import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this release check through npm so npm_execpath is available.");
const root = await mkdtemp(join(tmpdir(), "draw-release-package-"));
const packageDirectory = join(root, "package");
const installDirectory = join(root, "install");
await mkdir(packageDirectory);
const npmEnv = { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(root, "npm-cache") };

function runNpm(args, env = process.env) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: projectRoot, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed with exit code ${result.status}.`);
}

try {
  runNpm(["pack", "--pack-destination", packageDirectory], npmEnv);
  const tarball = join(packageDirectory, (await readdir(packageDirectory)).find((file) => file.endsWith(".tgz")) ?? "");
  runNpm(["install", "--prefix", installDirectory, tarball], npmEnv);
  const packageBin = join(installDirectory, "node_modules", "@ashbhati", "draw", "bin", "draw.js");
  runNpm(["run", "test:e2e:package"], { ...npmEnv, DRAW_PACKAGE_BIN: packageBin });
} finally {
  await rm(root, { recursive: true, force: true });
}
