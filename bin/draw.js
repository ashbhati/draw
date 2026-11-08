#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/runtime/cli.ts", import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx/esm", entry, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.once("error", (error) => {
  console.error(`Could not start Draw: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
