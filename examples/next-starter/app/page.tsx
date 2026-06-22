"use client";

import { useEffect, useRef, useState } from "react";
import type { Ludion as LudionInstance, DecisionLog } from "ludion-router";

// ONE bounded, low-risk task: polish a short piece of text. Small inputs, short
// outputs — the kind of work a 1B on-device model handles well, and a good fit
// for routing to the browser instead of paying a cloud provider for it.
const SYSTEM_PROMPT =
  "Rewrite the user's text to be clearer and more concise. " +
  "Keep the meaning and tone. Reply with ONLY the rewritten text, nothing else.";
const SAMPLE_INPUT =
  "i just wanted to quickly reach out and see if maybe you had a chance to take " +
  "a look at the thing i sent over the other day, no worries if not!";

type Counter = { total: number; browser: number; server: number };

// Plain-language routing explanation, DERIVED from rule_id + degraded + error.
// There is no `reason` field on the decision log — this is the honest mapping.
function explainLocal(log: DecisionLog): string {
  if (log.error) {
    return `Started on-device but the local run errored (${log.error}).`;
  }
  if (log.degraded === "local→server") {
    return `Started on-device, then fell back to the server (rule ${log.rule_id}).`;
  }
  if (log.target === "local") {
    return `Ran in your browser (rule ${log.rule_id}): a short prompt on a WebGPU-capable device — exactly what the policy keeps on-device.`;
  }
  return `The policy routed this to a server (rule ${log.rule_id}).`;
}

export default function Home() {
  const ludionRef = useRef<LudionInstance | null>(null);
  // Captured from the same dynamic import so we can identify the typed
  // "routed to server but no fallback" error without holding the whole module.
  const noFallbackRef = useRef<(new (...a: never[]) => Error) | null>(null);

  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [input, setInput] = useState(SAMPLE_INPUT);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const [log, setLog] = useState<DecisionLog | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [counter, setCounter] = useState<Counter>({ total: 0, browser: 0, server: 0 });

  useEffect(() => {
    let cancelled = false;
    // Ludion probes WebGPU, so it must be created in the browser.
    void import("ludion-router").then(async ({ Ludion, LudionNoFallbackConfigured }) => {
      // LOCAL-FIRST: no fallback at first run. An absent fallback means
      // local-only mode (supported since 0.1.1) — this runs entirely on-device
      // with zero relay setup and no .env. To complete server-routed requests
      // too, see the OPTIONAL "add server fallback" step in the README and
      // uncomment the block below (and the app/api/chat relay + .env.local):
      //
      //   fallback: { url: "/api/chat", model: "gpt-4o-mini" },
      const ludion = await Ludion.create({
        onLocalLoadProgress: (p) => setProgress(p.progress < 1 ? p.text : null),
      });
      if (cancelled) return;
      ludionRef.current = ludion;
      noFallbackRef.current = LudionNoFallbackConfigured;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function rewrite(e: React.FormEvent) {
    e.preventDefault();
    const ludion = ludionRef.current;
    const content = input.trim();
    if (!ludion || busy || !content) return;
    setBusy(true);
    setOutput("");
    setLog(null);
    setWhy(null);
    try {
      const stream = await ludion.chat.completions.create({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        max_tokens: 200,
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? "";
        setOutput(text);
      }
      const decision = stream._ludion; // the per-request decision log
      setLog(decision);
      setWhy(explainLocal(decision));
      const routedServer = decision.target === "server" || decision.degraded === "local→server";
      setCounter((c) => ({
        total: c.total + 1,
        browser: c.browser + (routedServer ? 0 : 1),
        server: c.server + (routedServer ? 1 : 0),
      }));
    } catch (err) {
      const NoFallback = noFallbackRef.current;
      if (NoFallback && err instanceof NoFallback) {
        // Local-only mode: the policy wanted a server (long prompt, no WebGPU,
        // unsupported browser…) and no fallback is configured. The request
        // never executed — adding the optional fallback completes it.
        const ruleId = (err as Error & { rule_id?: string }).rule_id ?? "?";
        setWhy(
          `The policy routed this to a server (rule ${ruleId}) — typically a long prompt, ` +
            `no WebGPU, or an unsupported browser. No server fallback is configured (that's ` +
            `the optional production step in the README), so this request didn't run.`,
        );
        setCounter((c) => ({ ...c, total: c.total + 1, server: c.server + 1 }));
      } else {
        setOutput(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: 24, lineHeight: 1.5 }}>
      <h1 style={{ marginBottom: 4 }}>Ludion next-starter — polish text on-device</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        {ready ? "Ready — runs in your browser, no server or API key." : "Probing device…"}
        {progress ? ` ${progress}` : ""}
      </p>

      <form onSubmit={rewrite}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!ready || busy}
          rows={3}
          style={{ width: "100%", padding: 8, boxSizing: "border-box", fontFamily: "inherit" }}
          placeholder="Paste a sentence to polish…"
        />
        <button disabled={!ready || busy} style={{ marginTop: 8, padding: "6px 14px" }}>
          {busy ? "Rewriting…" : "Rewrite"}
        </button>
      </form>

      {output && (
        <p style={{ background: "#f5f5f5", padding: 12, borderRadius: 6, whiteSpace: "pre-wrap" }}>
          {output}
        </p>
      )}

      {log && (
        <p style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>
          {log.target} · {log.rule_id} · {log.policy_version}
          {log.ttft_ms != null ? ` · ttft ${Math.round(log.ttft_ms)}ms` : ""}
          {log.tps != null ? ` · ${log.tps.toFixed(1)} tps` : ""}
        </p>
      )}

      {why && (
        <div style={{ borderLeft: "3px solid #ccc", padding: "4px 12px", color: "#444" }}>
          <strong>Why did this run here?</strong>
          <br />
          {why}
        </div>
      )}

      {counter.total > 0 && (
        <p style={{ fontSize: 13, color: "#444", marginTop: 16 }}>
          Total requests: {counter.total} · Browser-routed: {counter.browser} · Server fallback:{" "}
          {counter.server} · <strong>Server calls avoided: {counter.browser}</strong>
        </p>
      )}
    </main>
  );
}
