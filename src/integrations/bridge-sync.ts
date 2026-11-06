import type { DrawDocument } from "../document/document";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Register one bridge client per page and serialize whole-document writes. */
export function createBridgeSynchronizer(clientId: string, request: FetchLike = fetch) {
  let registration: Promise<void> | null = null;
  let queue = Promise.resolve();

  const sync = (document: DrawDocument): Promise<void> => {
    const current = queue.then(async () => {
      if (!registration) {
        registration = (async () => {
          const response = await request("/__draw/api/client", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ clientId }),
          });
          if (!response.ok) throw new Error(`Draw bridge rejected client registration (HTTP ${response.status}).`);
        })();
        void registration.catch(() => { registration = null; });
      }
      await registration;
      const response = await request("/__draw/api/document", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, document }),
      });
      if (!response.ok) throw new Error(`Draw bridge rejected document sync (HTTP ${response.status}).`);
    });
    queue = current.catch(() => undefined);
    return current;
  };

  return sync;
}
