import type { BenchDocument, DeviceInfo } from "./schema";
import { SCHEMA_ID } from "./schema";
import type { PersistedState } from "./state";

/** Partial results must always be exportable, including after failures. */
export function buildDocument(state: PersistedState, device: DeviceInfo): BenchDocument {
  return {
    schema: SCHEMA_ID,
    collected_at: new Date().toISOString(),
    device: { ...device, operator_label: state.operatorLabel },
    sessions: state.sessions,
    runs: state.runs,
    operator_notes: state.operatorNotes,
  };
}

export function exportFilename(label: string): string {
  const safeLabel = (label || "unlabeled").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `ludion-bench-${safeLabel}-${ts}.json`;
}

export async function copyToClipboard(doc: BenchDocument): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
}

export function downloadJson(doc: BenchDocument): void {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(doc.device.operator_label);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Wipe Cache Storage / OPFS / IndexedDB for this origin to force cold runs.
 * localStorage (bench results/state) is intentionally preserved — model
 * artifacts never live there.
 *
 * Known limitation (spec review B-6): the browser's HTTP disk cache cannot be
 * cleared from JS. If an engine fetch hits the HTTP cache, a true cold run
 * requires manually clearing site data. The UI surfaces this note.
 */
export async function wipeOriginStorage(log: (msg: string) => void): Promise<void> {
  // Cache Storage
  if ("caches" in globalThis) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      log(`cache storage: deleted ${keys.length} cache(s)`);
    } catch (e) {
      log(`cache storage wipe failed: ${String(e)}`);
    }
  }
  // IndexedDB (indexedDB.databases() is available on Safari 14+, still gated)
  if ("indexedDB" in globalThis) {
    try {
      const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
      log(`indexeddb: deleted ${dbs.length} database(s)`);
    } catch (e) {
      log(`indexeddb wipe failed: ${String(e)}`);
    }
  }
  // OPFS
  try {
    if (navigator.storage && "getDirectory" in navigator.storage) {
      const root = await navigator.storage.getDirectory();
      const names: string[] = [];
      // entries() is an async iterator on FileSystemDirectoryHandle
      for await (const [name] of root as unknown as AsyncIterable<[string, unknown]>) {
        names.push(name);
      }
      for (const name of names) {
        await root.removeEntry(name, { recursive: true });
      }
      log(`opfs: removed ${names.length} entr(ies)`);
    }
  } catch (e) {
    log(`opfs wipe failed: ${String(e)}`);
  }
  log("wipe done. NOTE: the HTTP disk cache cannot be cleared from JS; for a guaranteed cold run, clear site data in browser settings.");
}
