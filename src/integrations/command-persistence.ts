import type { DrawDocument } from "../document/document";

type Persist = (document: DrawDocument) => Promise<void>;

/** Keep applied MCP edits successful while exposing any durability warning. */
export async function persistAppliedDocument(
  document: DrawDocument,
  saveLocally: Persist,
  syncWithBridge: Persist,
): Promise<string | undefined> {
  const failures: string[] = [];
  try {
    await saveLocally(document);
  } catch (error) {
    failures.push(`local autosave failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await syncWithBridge(document);
  } catch (error) {
    failures.push(`MCP bridge sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures.length ? `The edit was applied, but ${failures.join("; ")}. Save the .draw file to preserve it.` : undefined;
}
