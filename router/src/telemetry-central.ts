/**
 * Central decision telemetry (opt-in, default-off).
 *
 * Posture (locked, see spec): the local ledger is default-on; central collection
 * is OFF unless the developer explicitly opts in via the drop-in config:
 *
 *   telemetry: { central: true, endpoint: "https://<collector>" }, projectId: "<id>"
 *
 * With any of those missing, this consumer DROPS every event — no buffering, no
 * timer, no network. The network tab shows zero collection requests when off.
 *
 * When on, it maps each terminal `DecisionLog` to the shared content-free
 * `DecisionEvent`, batches them, and POSTs `<endpoint>/v1/decisions` off the
 * inference path (the sink already drains on a microtask) — batched, async, and
 * fail-silent, so inference latency is identical on/off/offline.
 *
 * The anonymous install id is generated client-side in localStorage; it is a
 * random per-install opaque value, never derived from content and never an
 * end-user identity.
 */
import {
  DECISION_SCHEMA_VERSION,
  MAX_BATCH_EVENTS,
  type DecisionBatch,
  type DecisionEvent,
} from "@ludion/shared";
import type { DecisionLog } from "./types";
import { getDropinConfig } from "./config";
import { registerDecisionConsumer, toDecisionEvent } from "./telemetry";

/** localStorage key for the anonymous, random per-install id. */
const INSTALL_ID_KEY = "ludion.install.v1";
/** Flush once this many events are buffered (a partial batch flushes on the timer). */
const DEFAULT_FLUSH_THRESHOLD = 20;
/** Max age of a partial batch before it is flushed. */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

type FetchLike = (input: string, init: RequestInit) => Promise<unknown>;
type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface ResolvedCentral {
  endpoint: string;
  projectId: string;
}

/** Read the live opt-in config; null = central is off (the default). */
function resolveCentral(): ResolvedCentral | null {
  const cfg = getDropinConfig();
  if (cfg?.telemetry?.central !== true) return null;
  const projectId = cfg.projectId;
  const endpoint = cfg.telemetry.endpoint;
  if (typeof projectId !== "string" || projectId.length === 0) return null;
  if (typeof endpoint !== "string" || endpoint.length === 0) return null;
  return { endpoint, projectId };
}

function decisionsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/decisions`;
}

// --- module state (single registration; reconfigurable at runtime) ----------

let registered = false;
let buffer: DecisionEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let fetchImpl: FetchLike | null = null;
let storageImpl: StorageLike | null = null;
let cachedInstallId: string | null = null;
let flushThreshold = DEFAULT_FLUSH_THRESHOLD;
let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;

function resolveFetch(): FetchLike | null {
  if (fetchImpl) return fetchImpl;
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  return typeof f === "function" ? (input, init) => f(input, init) : null;
}

function resolveStorage(): StorageLike | null {
  if (storageImpl) return storageImpl;
  try {
    return globalThis.localStorage;
  } catch {
    return null; // blocked/sandboxed origins
  }
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Anonymous, random per-install id; persisted in localStorage when available. */
function installId(): string {
  if (cachedInstallId !== null) return cachedInstallId;
  const storage = resolveStorage();
  if (storage === null) {
    cachedInstallId = randomId(); // ephemeral when storage is unavailable
    return cachedInstallId;
  }
  try {
    let id = storage.getItem(INSTALL_ID_KEY);
    if (id === null || id.length === 0) {
      id = randomId();
      storage.setItem(INSTALL_ID_KEY, id);
    }
    cachedInstallId = id;
    return id;
  } catch {
    cachedInstallId = randomId();
    return cachedInstallId;
  }
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleFlush(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, flushIntervalMs);
}

/** Send one batch. Fail-silent: a transport error drops the batch, never throws. */
async function flush(): Promise<void> {
  clearTimer();
  if (buffer.length === 0) return;
  const central = resolveCentral();
  if (central === null) {
    buffer = []; // opted back out mid-flight; drop what we held
    return;
  }
  const fetcher = resolveFetch();
  if (fetcher === null) {
    buffer = [];
    return;
  }
  const events = buffer.splice(0, MAX_BATCH_EVENTS);
  const batch: DecisionBatch = {
    schema_version: DECISION_SCHEMA_VERSION,
    projectId: central.projectId,
    install_id: installId(),
    events,
  };
  try {
    await fetcher(decisionsUrl(central.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
      keepalive: true,
    });
  } catch {
    // Telemetry is best-effort: a failed send drops the batch silently.
  }
  // A burst larger than one batch leaves a remainder; flush it too.
  if (buffer.length >= flushThreshold) void flush();
  else if (buffer.length > 0) scheduleFlush();
}

/**
 * Enable central telemetry once. Idempotent (multi-instance safe): registers a
 * single sink consumer. The consumer is a no-op while central is off, so this is
 * safe to call unconditionally from `Ludion.create`. Test hooks
 * (`fetchImpl`/`storage`/thresholds) are optional and only read on first call.
 */
export function enableCentralTelemetry(opts?: {
  fetchImpl?: FetchLike;
  storage?: StorageLike;
  flushThreshold?: number;
  flushIntervalMs?: number;
}): void {
  if (opts?.fetchImpl) fetchImpl = opts.fetchImpl;
  if (opts?.storage) storageImpl = opts.storage;
  if (opts?.flushThreshold !== undefined) flushThreshold = opts.flushThreshold;
  if (opts?.flushIntervalMs !== undefined) flushIntervalMs = opts.flushIntervalMs;
  if (registered) return;
  registered = true;
  registerDecisionConsumer((log: DecisionLog) => {
    if (resolveCentral() === null) return; // default-off: drop, no growth, no network
    buffer.push(toDecisionEvent(log));
    if (buffer.length >= flushThreshold) void flush();
    else scheduleFlush();
  });
}

/** Test-only: reset module state (the consumer is cleared by _resetTelemetry). */
export function _resetCentralTelemetry(): void {
  clearTimer();
  registered = false;
  buffer = [];
  fetchImpl = null;
  storageImpl = null;
  cachedInstallId = null;
  flushThreshold = DEFAULT_FLUSH_THRESHOLD;
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
}
