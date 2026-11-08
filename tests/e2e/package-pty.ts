function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildPackagePtyArgs(command: string, args: string[], platform = process.platform): string[] {
  if (platform === "darwin") return ["-q", "/dev/null", command, ...args];
  if (platform === "linux") {
    const commandLine = [command, ...args].map(quoteForPosixShell).join(" ");
    return ["-q", "-c", commandLine, "/dev/null"];
  }
  throw new Error(`The Draw package PTY test supports macOS and Linux, not ${platform}.`);
}
