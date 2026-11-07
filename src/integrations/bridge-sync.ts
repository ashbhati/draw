import type { DrawDocument } from "../document/document";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Serialize whole-document writes using the active per-tab editor secret. */
export function createBridgeSynchronizer(clientId: string, getEditorSecret: () => string | null, request: FetchLike = fetch) {
  let queue = Promise.resolve();

  const sync = (document: DrawDocument): Promise<void> => {
    const current = queue.then(async () => {
      const editorSecret = getEditorSecret();
      if (!editorSecret) throw new Error("Connect this Draw editor session before syncing with MCP.");
      const response = await request("/__draw/api/document", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-draw-editor-secret": editorSecret },
        body: JSON.stringify({ clientId, document }),
      });
      if (response.status === 401) throw new Error("Draw editor authentication expired. Reconnect MCP from the active Draw tab.");
      if (!response.ok) throw new Error(`Draw bridge rejected document sync (HTTP ${response.status}).`);
    });
    queue = current.catch(() => undefined);
    return current;
  };

  return sync;
}
