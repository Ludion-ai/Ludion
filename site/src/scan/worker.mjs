// The scan runs here, off the page's main thread: the CLI's own parser and counter
// (@ludion/scan, core.mjs) fed by the File API. In: { files }. Out: progress, then the report.
// Nothing leaves: this worker has no fetch, no import at run time, and posts only to its page.
import { scanFiles } from "@ludion/scan/web";

self.onmessage = async ({ data }) => {
  const files = data.files ?? [];
  const total = files.reduce((n, f) => n + f.size, 0);
  const t0 = performance.now();
  let bytes = 0, last = 0;
  const onBytes = (n) => {
    bytes += n;
    const now = performance.now();
    if (now - last > 100) { last = now; self.postMessage({ type: "progress", bytes, total }); }
  };
  try {
    const report = await scanFiles(files, { onBytes });
    self.postMessage({ type: "done", report, bytes: total, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e?.message ?? e) });
  }
};
