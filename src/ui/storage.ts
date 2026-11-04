import { validateDrawDocument, type DrawDocument } from "../document/document";

const DATABASE_NAME = "draw-local";
const DATABASE_VERSION = 1;
const DOCUMENTS_STORE = "documents";
const CURRENT_DOCUMENT_KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Local autosave requires IndexedDB in this browser."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
        database.createObjectStore(DOCUMENTS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the Draw autosave database."));
    request.onblocked = () => reject(new Error("The Draw autosave database is blocked by another tab."));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the Draw document."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving the Draw document was cancelled."));
  });
}

/** Save the current editable scene locally; this is separate from image export. */
export async function saveCurrentDocument(document: DrawDocument): Promise<void> {
  validateDrawDocument(document);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
    transaction.objectStore(DOCUMENTS_STORE).put(document, CURRENT_DOCUMENT_KEY);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

/** Load the most recently autosaved editable scene, or null on first run. */
export async function loadCurrentDocument(): Promise<DrawDocument | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DOCUMENTS_STORE, "readonly");
    const request = transaction.objectStore(DOCUMENTS_STORE).get(CURRENT_DOCUMENT_KEY);
    const [value] = await Promise.all([
      new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not read the autosaved Draw document."));
      }),
      waitForTransaction(transaction),
    ]);
    if (value === undefined) return null;
    validateDrawDocument(value);
    return value;
  } finally {
    database.close();
  }
}
