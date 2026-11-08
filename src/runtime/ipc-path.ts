const UNIX_SOCKET_PATH_BYTES = { darwin: 103, linux: 107 } as const;

export function validateUnixSocketPath(socketPath: string, platform = process.platform): void {
  const limit = platform in UNIX_SOCKET_PATH_BYTES
    ? UNIX_SOCKET_PATH_BYTES[platform as keyof typeof UNIX_SOCKET_PATH_BYTES]
    : undefined;
  if (limit === undefined) throw new Error(`Draw's packaged MCP runtime does not support Unix sockets on ${platform}.`);
  if (Buffer.byteLength(socketPath, "utf8") > limit) {
    throw new Error(`Draw IPC socket path is too long for ${platform}. Set DRAW_RUNTIME_DIR to a shorter per-user directory path and restart Draw.`);
  }
}
