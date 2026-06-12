"use client";

import { useEffect, useRef, useState } from "react";
import type { Ludion as LudionInstance } from "ludion-router";

// The model your relay's provider should run for server-routed requests.
const SERVER_MODEL = "gpt-4o-mini";

type Msg = { role: "user" | "assistant"; content: string };

export default function Home() {
  const ludionRef = useRef<LudionInstance | null>(null);
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [decision, setDecision] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Ludion probes WebGPU, so it must be created in the browser.
    void import("ludion-router").then(async ({ Ludion }) => {
      const ludion = await Ludion.create({
        // Same-origin relay (app/api/chat/route.ts) — key stays server-side.
        fallback: { url: "/api/chat", model: SERVER_MODEL },
        onLocalLoadProgress: (p) => setProgress(p.progress < 1 ? p.text : null),
      });
      if (cancelled) return;
      ludionRef.current = ludion;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const ludion = ludionRef.current;
    const content = input.trim();
    if (!ludion || busy || !content) return;
    const next: Msg[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const stream = await ludion.chat.completions.create({
        messages: next,
        max_tokens: 256,
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? "";
        setMessages([...next, { role: "assistant", content: text }]);
      }
      const log = stream._ludion; // the per-request decision log
      setDecision(`${log.target} · ${log.rule_id} · ${log.policy_version}`);
    } catch (err) {
      setMessages([...next, { role: "assistant", content: String(err) }]);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
      <h1>Ludion next-starter</h1>
      <p style={{ color: "#666" }}>
        {ready ? "Ready — ask something." : "Probing device…"}
        {progress ? ` ${progress}` : ""}
      </p>
      {messages.map((m, i) => (
        <p key={i}>
          <strong>{m.role === "user" ? "you" : "ludion"}:</strong> {m.content}
        </p>
      ))}
      {decision && (
        <p style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{decision}</p>
      )}
      <form onSubmit={send} style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!ready || busy}
          style={{ flex: 1, padding: 8 }}
          placeholder="Say something"
        />
        <button disabled={!ready || busy}>Send</button>
      </form>
    </main>
  );
}
