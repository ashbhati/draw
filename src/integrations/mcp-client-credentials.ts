import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, writeFile, type FileHandle } from "node:fs/promises";

export type LocalMcpCredential = {
  installationId: string;
  clientIdentity?: string;
  capability?: string;
  expiresAt?: number;
};

export function localMcpCredentialPath(): string {
  return process.env.DRAW_MCP_CLIENT_CREDENTIAL_PATH ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "draw", "mcp-client-credential.json");
}

export async function readLocalMcpCredential(
  filePath = localMcpCredentialPath(),
  openFile: typeof open = open,
): Promise<LocalMcpCredential | null> {
  let handle: FileHandle | undefined;
  try {
    const flags = constants.O_RDONLY | (process.platform !== "win32" ? constants.O_NOFOLLOW : 0);
    handle = await openFile(filePath, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile() || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Draw MCP credential file permissions are too broad. Set mode 0600 or choose a private credential path.");
    }
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as LocalMcpCredential).installationId !== "string") {
      throw new Error("Draw MCP credential file is invalid. Remove it and pair this MCP host again.");
    }
    const value = parsed as LocalMcpCredential;
    if ((value.clientIdentity !== undefined && typeof value.clientIdentity !== "string") ||
      (value.capability !== undefined && (typeof value.capability !== "string" || !/^[a-f\d]{64}$/i.test(value.capability))) ||
      (value.expiresAt !== undefined && !Number.isFinite(value.expiresAt))) {
      throw new Error("Draw MCP credential file is invalid. Remove it and pair this MCP host again.");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new Error("Draw MCP credential file cannot be a symbolic link.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeLocalMcpCredential(value: LocalMcpCredential, filePath = localMcpCredentialPath()): Promise<void> {
  if (!value.installationId || ((value.clientIdentity === undefined) !== (value.capability === undefined))) {
    throw new Error("Draw MCP credential data is incomplete.");
  }
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export async function getLocalMcpIdentity(filePath = localMcpCredentialPath()): Promise<LocalMcpCredential> {
  const existing = await readLocalMcpCredential(filePath);
  if (existing) return existing;
  const created = { installationId: randomUUID() };
  await writeLocalMcpCredential(created, filePath);
  return created;
}
