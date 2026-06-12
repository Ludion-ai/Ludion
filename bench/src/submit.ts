import type { BenchDocument } from "./schema";

/**
 * Gate 2.7 submission client. The collector URL is a build-time env
 * (decisions F-2): the committed bench/.env carries a placeholder containing
 * "<account>" until the operator deploys; while it is the placeholder the
 * Submit button degrades to Download-JSON-only — never a dead button.
 */

export function collectorUrl(): string | null {
  const url = import.meta.env.VITE_COLLECTOR_URL as string | undefined;
  if (!url || url.includes("<account>")) return null;
  return url.replace(/\/$/, "");
}

export type SubmitResult =
  | { ok: true; deduped: boolean; total_submissions: number }
  | { ok: false; code: string; message: string };

export async function submitResult(doc: BenchDocument): Promise<SubmitResult> {
  const base = collectorUrl();
  if (base === null) {
    return { ok: false, code: "not_configured", message: "collector URL not configured" };
  }
  try {
    const res = await fetch(`${base}/v1/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    const json = (await res.json()) as {
      deduped?: boolean;
      total_submissions?: number;
      error?: { code?: string; message?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        code: json.error?.code ?? `http_${res.status}`,
        message: json.error?.message ?? res.statusText,
      };
    }
    return {
      ok: true,
      deduped: json.deduped === true,
      total_submissions: json.total_submissions ?? 0,
    };
  } catch (e) {
    return { ok: false, code: "network", message: e instanceof Error ? e.message : String(e) };
  }
}
