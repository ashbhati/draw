export function readConfiguredPairingSecret(env: NodeJS.ProcessEnv = process.env): string {
  const pairingSecret = env.DRAW_MCP_PAIRING_SECRET;
  if (!pairingSecret || !/^[a-f\d]{64}$/i.test(pairingSecret)) {
    throw new Error("Set DRAW_MCP_PAIRING_SECRET in the MCP host's protected secret configuration using the secret displayed in Draw's MCP clients dialog.");
  }
  return pairingSecret;
}
