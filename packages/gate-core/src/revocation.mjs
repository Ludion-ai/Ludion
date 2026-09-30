// Revocation (spec §10.10): the Registry's revocation stream, as a Gate consumes it.
//
//   Normal:    Staples live at most an hour, so a revoked Diver fades from the world on its own.
//   Emergency: the Registry publishes each revocation on GET /v0/revocations/stream (SSE); a
//              subscribed Gate applies it within seconds (REG-3: ≤ 60 s).
//
// Every entry is a compact JWS signed by a pinned Registry key (typ "ludion-revocation+jwt"), so
// whoever sits between the Registry and the Gate can delay entries but never forge one.
// The subscription is one GET that carries no Diver, no visitor and no path: the Gate learns the
// whole list and asks nothing about who it is looking at (PRIV-3).
//
// Off the hot path: classify() only reads the in-memory list. A dead Registry, a broken stream or
// a bad entry never reaches a request (REG-1, GATE-5). Runtime-neutral: fetch, ReadableStream,
// TextDecoder and timers only.

export const REVOCATION_TYP = "ludion-revocation+jwt";

/**
 * The revoked identities a Gate knows. An entry revokes a whole Diver (`sub`), the Signature-Agent
 * origin it registered (`agent`), and the session keys the Registry had approved (`jkt`); an entry
 * with `scope: "keys"` revokes only its `jkt`.
 */
export function createRevocationList() {
  const subs = new Map(), jkts = new Map(), agents = new Map();
  let lastSeq = 0, count = 0;
  return {
    /** @param {{ seq: number, sub: string, jkt?: string[], agent?: string, scope?: string, reason?: string, iat?: number }} e */
    add(e) {
      if (!e || typeof e.sub !== "string") return false;
      const entry = { seq: e.seq, sub: e.sub, reason: e.reason ?? "revoked", iat: e.iat, scope: e.scope === "keys" ? "keys" : "diver" };
      if (entry.scope === "diver") {
        subs.set(e.sub, entry);
        if (typeof e.agent === "string") { try { agents.set(new URL(e.agent).origin, entry); } catch { /* not a URL: ignore */ } }
      }
      for (const k of Array.isArray(e.jkt) ? e.jkt : []) if (typeof k === "string") jkts.set(k, entry);
      if (Number.isInteger(e.seq) && e.seq > lastSeq) lastSeq = e.seq;
      count++;
      return true;
    },
    /**
     * @param {{ sub?: string, jkt?: string, identifier?: string }} who
     *   sub: the Staple's subject; jkt: the request's keyid; identifier: the resolved key-set URL
     * @returns {object|undefined} the matching entry
     */
    match({ sub, jkt, identifier } = {}) {
      if (sub && subs.has(sub)) return subs.get(sub);
      if (jkt && jkts.has(jkt)) return jkts.get(jkt);
      if (identifier) { try { const o = new URL(identifier).origin; if (agents.has(o)) return agents.get(o); } catch { /* ignore */ } }
      return undefined;
    },
    get lastSeq() { return lastSeq; },
    get size() { return count; },
  };
}

/** Parse an SSE byte stream into events: { id, event, data, retry }. */
async function* sseEvents(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ev = { data: [] };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === "\r" && buf[i + 1] === "\n" ? i + 2 : i + 1);
        if (line === "") {
          if (ev.data.length || ev.retry !== undefined) yield { ...ev, data: ev.data.join("\n") };
          ev = { data: [] };
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat
        const c = line.indexOf(":");
        const field = c < 0 ? line : line.slice(0, c);
        const val = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (field === "data") ev.data.push(val);
        else if (field === "id") ev.id = val;
        else if (field === "event") ev.event = val;
        else if (field === "retry" && /^\d+$/.test(val)) ev.retry = Number(val);
      }
      if (buf.length > 65536) throw new Error("revocation stream: line too long");
    }
  } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
}

/**
 * Subscribe a Gate to the Registry's revocation stream, with reconnects that resume from the last
 * entry seen (Last-Event-ID and ?since=). Never throws; failures land in `status`.
 * @param {{ url: string, fetch?: typeof fetch, list: ReturnType<typeof createRevocationList>,
 *           verify: (compact: string) => Promise<object>, retryMs?: number, maxRetryMs?: number,
 *           onEntry?: (entry: object) => void }} o
 */
export function subscribeRevocations(o) {
  const url = new URL(o.url);
  const doFetch = o.fetch ?? globalThis.fetch;
  const status = { state: "connecting", connects: 0, entries: 0, rejected: 0, lastError: undefined, lastEventAt: undefined };
  let retryMs = o.retryMs ?? 2000;
  const maxRetryMs = o.maxRetryMs ?? 30_000;
  let stopped = false, timer, ac, failures = 0;

  async function apply(data) {
    let payload;
    try { payload = await o.verify(data.trim()); }
    catch (e) { status.rejected++; status.lastError = `entry rejected: ${e?.message ?? e}`; return; }
    if (o.list.add(payload)) { status.entries++; status.lastEventAt = Date.now(); o.onEntry?.(payload); }
  }

  async function connect() {
    if (stopped) return;
    status.state = "connecting";
    ac = new AbortController();
    try {
      const u = new URL(url);
      if (o.list.lastSeq) u.searchParams.set("since", String(o.list.lastSeq));
      const res = await doFetch(u.href, {
        headers: { accept: "text/event-stream", ...(o.list.lastSeq ? { "last-event-id": String(o.list.lastSeq) } : {}) },
        signal: ac.signal, redirect: "manual",
      });
      if (res.status !== 200 || !res.body) throw new Error(`revocation stream returned ${res.status}`);
      status.state = "open"; status.connects++; failures = 0;
      for await (const ev of sseEvents(res.body)) {
        if (stopped) break;
        if (ev.retry !== undefined) retryMs = Math.min(Math.max(ev.retry, 100), maxRetryMs);
        if ((ev.event ?? "message") === "revocation" && ev.data) await apply(ev.data);
      }
      if (!stopped) throw new Error("revocation stream closed");
    } catch (e) {
      if (stopped) return;
      status.state = "retrying"; status.lastError = String(e?.message ?? e);
      failures++;
      const delay = Math.min(retryMs * 2 ** Math.min(failures - 1, 4), maxRetryMs);
      timer = setTimeout(connect, delay);
      timer.unref?.();
    }
  }

  connect();
  return {
    status,
    stop() { stopped = true; status.state = "stopped"; clearTimeout(timer); try { ac?.abort(); } catch { /* ignore */ } },
  };
}
