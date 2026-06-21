import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";
// Single source for the mark (Gate 2.6 F-2): the operator's official vector
// overwrites assets/ludion-hex-mark.svg and propagates here with no code change.
import hexMarkUrl from "../../assets/ludion-hex-mark.svg";
import {
  Ludion,
  LudionNoFallbackConfigured,
  createStorageConfigSource,
  setConfigSource,
  writeDropinConfig,
} from "ludion-router";
import type { DecisionLog } from "ludion-router";
import { getModel, getModelPricing, listModels } from "ludion-router/registry";
import { evaluateVerdict } from "./verdict";
import type { Verdict } from "./verdict";
import { comparisonLine, deviceClassOf, fetchAggregate } from "./compare";
import { LONG_CJK_PROMPT } from "./longprompt";

/**
 * Gate 2.5: the demo IS the landing page. Zero-config local on WebGPU
 * desktops; probe card up top; the Cartesian-diver instrument as a live
 * gauge (local = float, server = sink); settings demoted to a drawer and
 * surfaced contextually only when a server route lacks an endpoint.
 * No shared key ships with this demo, ever (Gate 2 §5).
 */

const REPO = "https://github.com/Ludion-ai/Ludion";
const POLICY_TABLE_URL = `${REPO}#the-routing-policy-and-its-evidence`;
const REPORT_URL = `${REPO}/blob/main/docs/report/2026-06-browser-inference-field-notes.md`;
const REPORT_S4_URL = `${REPORT_URL}#4-iphone-11-pro-max-the-kill-ladder`;

// Spec B step 1: the demo's fallback config lives behind the router's runtime
// config seam, persisted to localStorage under "ludion.config.v1". The facade
// reads it per request, so a settings change is honored by the NEXT request
// with no location.reload(). HONEST TRADEOFF: a key in localStorage is readable
// by any script on this origin — a developer convenience for a dev tool, not
// end-user secret storage. Real secrets belong behind a server-side relay.
const configSource = createStorageConfigSource();
setConfigSource(configSource);

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const chatEl = $("#chat");
const chipsEl = $("#chips");
const inputEl = $<HTMLTextAreaElement>("#input");
const composerEl = $<HTMLFormElement>("#composer");
const sendEl = $<HTMLButtonElement>("#send");
const settingsEl = $<HTMLDialogElement>("#settings");
const instrumentEl = $("#instrument");
const instrumentLabelEl = $("#instrument-label");

$<HTMLImageElement>("#brand-mark").src = hexMarkUrl;

// --- settings drawer ---------------------------------------------------------

const cfgUrlEl = $<HTMLInputElement>("#cfg-url");
const cfgKeyEl = $<HTMLInputElement>("#cfg-key");
const cfgModelEl = $<HTMLInputElement>("#cfg-model");
const cfgModelListEl = $<HTMLDataListElement>("#cfg-model-list");
const cfgModelNoteEl = $("#cfg-model-note");

// Spec C step 2 + 2.1: the fallback model is chosen from the registry
// (predictive), not hand-typed. A native <datalist> suggests api models and
// STILL accepts any custom value (escape hatch) — self-hosted endpoints and
// registry-unknown models are first-class, not errors. Only kind:"api" is
// offered: a fallback is by definition the server-side landing spot for
// requests the device could not run locally, so a local model as the
// "fallback" would be contradictory.
//
// Step 2.1: the value the picker STORES is the entry's provider_model_id (the
// exact string the provider's API expects), not the internal canonical id, so
// selecting "Claude Sonnet 4.6" sends "claude-sonnet-4-6". Only entries whose
// provider_model_id is verified are suggested: an unverified best-guess string
// is never sent automatically (it stays reachable via the escape hatch).

// Provider -> a sensible OpenAI-compatible base URL default. Only used to
// PREFILL an empty field; a user-typed URL is never overwritten (escape hatch).
const PROVIDER_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

// The api models the picker offers: kind:"api" with a verified provider id.
// Keyed by provider_model_id (the stored value) so a chosen/typed string maps
// back to its registry entry for the baseURL prefill.
const SUGGESTED_API = listModels({ kind: "api" }).filter((m) => m.provider_model_id_verified === true);
const apiByProviderId = new Map(SUGGESTED_API.map((m) => [m.provider_model_id, m]));

function priceHint(id: string): string {
  const p = getModelPricing(id);
  if (!p) return "";
  return ` · $${p.input_per_1m}/$${p.output_per_1m} per 1M`;
}

function populateModelSuggestions(): void {
  cfgModelListEl.replaceChildren();
  for (const m of SUGGESTED_API) {
    const opt = document.createElement("option");
    // Store the provider-native string; show the friendly name in the label.
    opt.value = m.provider_model_id!;
    opt.label = `${m.display_name} · ${m.provider}${priceHint(m.id)}`;
    cfgModelListEl.appendChild(opt);
  }
}

// React to a chosen/typed model: a known provider id prefills an empty baseURL
// and clears the note; anything else is accepted as a quiet custom value (info,
// not a warning) — the registry is a convenience, never a gate.
function reflectModelChoice(): void {
  const value = cfgModelEl.value.trim();
  if (!value) {
    cfgModelNoteEl.textContent = "";
    return;
  }
  const entry = apiByProviderId.get(value) ?? getModel(value);
  if (entry) {
    cfgModelNoteEl.textContent = "";
    const def = PROVIDER_BASE_URL[entry.provider];
    if (def && !cfgUrlEl.value.trim()) cfgUrlEl.value = def;
  } else {
    cfgModelNoteEl.textContent = "custom model (not in the registry) — saved as typed.";
    console.info(`ludion: using custom fallback model "${value}" (not in the registry)`);
  }
}

function fillSettingsForm(): void {
  const fb = configSource.get()?.fallback;
  cfgUrlEl.value = fb?.baseURL ?? "";
  cfgKeyEl.value = fb?.apiKey ?? "";
  cfgModelEl.value = fb?.model ?? "";
  cfgModelNoteEl.textContent = "";
}
populateModelSuggestions();
fillSettingsForm();

cfgModelEl.addEventListener("change", reflectModelChoice);

$("#settings-toggle").addEventListener("click", () => {
  fillSettingsForm();
  settingsEl.showModal();
});
$("#cfg-close").addEventListener("click", () => settingsEl.close());
$("#cfg-save").addEventListener("click", () => {
  const baseURL = cfgUrlEl.value.trim();
  const model = cfgModelEl.value.trim();
  const apiKey = cfgKeyEl.value.trim();
  const fallback: { baseURL?: string; model?: string; apiKey?: string } = {};
  if (baseURL) fallback.baseURL = baseURL;
  if (model) fallback.model = model;
  if (apiKey) fallback.apiKey = apiKey;
  // Persist via the runtime config seam. No reload: the live config source is
  // read by the very next inference request (Spec B step 1). The picker only
  // changes how the value is CHOSEN, not how it is stored or applied.
  writeDropinConfig(Object.keys(fallback).length > 0 ? { fallback } : null);
  settingsEl.close();
});

// --- probe card ---------------------------------------------------------------

function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

function osName(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "unknown OS";
}

function classWords(osClass: string, env: string): string {
  if (env === "webview-iab") return "in-app browser";
  switch (osClass) {
    case "desktop":
      return "desktop class";
    case "android-chromium":
      return "Android (Chromium)";
    case "ios-webkit":
      return "iOS (WebKit)";
    default:
      return "unclassified";
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function ruleChip(ruleId: string, href: string): string {
  return `<a class="rule-chip" href="${href}" target="_blank" rel="noopener">rule ${ruleId}</a>`;
}

function renderProbeCard(ludion: Ludion, verdict: Verdict): void {
  const p = ludion.probe;
  $("#probe-summary").textContent = `${browserName(p.ua)} · ${osName(p.ua)} · ${classWords(p.os_class, p.env)}`;

  const caps: string[] = [`WebGPU ${p.webgpu ? "✓" : "✗"}`];
  if (p.adapter) {
    caps.push(`f16 ${p.adapter.f16 ? "✓" : "✗"}`, `maxBuffer ${gb(p.adapter.maxBufferSize)}`);
  }
  $("#probe-caps").textContent = caps.join("   ");

  // Plain words first, jargon second (spec §2).
  const v = $("#probe-verdict");
  if (verdict.target === "local") {
    const caveat = verdict.shortPromptsOnly ? " for short prompts" : "";
    v.innerHTML = `→ eligible for <strong class="t-local">LOCAL</strong> inference${caveat} (${ruleChip(verdict.rule_id, POLICY_TABLE_URL)})`;
  } else {
    let why = "";
    switch (verdict.rule_id) {
      case "R1":
        why = "in-app browsers stall local inference (we measured it) — ";
        break;
      case "R2":
        why = "no WebGPU → no local path — ";
        break;
      case "R3":
        why = `WebGPU ${p.webgpu ? "✓ — but" : "✗ and"} this device class kills LLM tabs (we measured it) — `;
        break;
      default:
        why = "unknown territory routes safe — ";
    }
    const whyLink =
      verdict.rule_id === "R3"
        ? ` · why? → <a href="${REPORT_S4_URL}" target="_blank" rel="noopener">report §4</a>`
        : "";
    v.innerHTML = `${why}routes to <strong class="t-server">SERVER</strong> (${ruleChip(verdict.rule_id, POLICY_TABLE_URL)})${whyLink}`;
  }
}

/**
 * Gate 4 ① — fetch the crowd aggregate and append a one-line comparison under the
 * verdict. Best-effort: if the endpoint is down/unconfigured the line is simply
 * omitted (the verdict already rendered), never an error (decisions F-6).
 */
async function renderComparison(ludion: Ludion, verdict: Verdict): Promise<void> {
  const p = ludion.probe;
  const aggregate = await fetchAggregate();
  const line = comparisonLine({
    deviceClass: deviceClassOf(p.env, p.os_class),
    ruleId: verdict.rule_id,
    target: verdict.target,
    aggregate,
  });
  if (line !== null) $("#probe-compare").textContent = line;
}

// --- the instrument (signature element) ---------------------------------------

function setInstrument(state: "idle" | "local" | "server"): void {
  instrumentEl.classList.remove("inst-idle", "inst-local", "inst-server");
  instrumentEl.classList.add(`inst-${state}`);
  instrumentLabelEl.textContent = state === "idle" ? "idle" : state.toUpperCase();
  if (state !== "idle") {
    // Re-trigger the SIGNAL bubble flash.
    instrumentEl.classList.remove("flash");
    void instrumentEl.getBoundingClientRect().width; // reflow
    instrumentEl.classList.add("flash");
  }
}

// --- chat ----------------------------------------------------------------------

/** Gate 2.6: no bubbles — hairline-separated blocks with a role label (F-7).
 * Returns the body element; callers stream into its textContent. */
function addBubble(cls: string, text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `msg ${cls}`;
  const role = document.createElement("span");
  role.className = "msg-role";
  role.textContent = cls.startsWith("user") ? "YOU" : "LUDION";
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  wrap.append(role, body);
  chatEl.appendChild(wrap);
  wrap.scrollIntoView({ block: "end" });
  return body;
}

function addCard(html: string, cls = ""): HTMLElement {
  const div = document.createElement("div");
  div.className = `card ${cls}`;
  div.innerHTML = html;
  chatEl.appendChild(div);
  div.scrollIntoView({ block: "end" });
  return div;
}

function fmt(n: number | null, digits = 0): string {
  return n === null ? "–" : n.toFixed(digits);
}

function addStripCard(log: DecisionLog): void {
  const target = log.target.toUpperCase();
  const tcls = log.target === "local" ? "t-local" : "t-server";
  const degraded = log.degraded ? `<span class="mono dim">degraded ${log.degraded}</span>` : "";
  addCard(
    `<span class="strip-target ${tcls}">${target}</span>
     ${ruleChip(log.rule_id, POLICY_TABLE_URL)}
     <span class="mono">ttft ${fmt(log.ttft_ms)} ms · ${fmt(log.tps, 1)} tps</span>
     ${degraded}
     <span class="mono dim">${log.policy_version} · ${log.model}</span>`,
    "decision-row",
  );
}

function addServerNeedsEndpointCard(rule_id: string): void {
  const card = addCard(
    `This request routes to a <strong class="t-server">server</strong>
     (${ruleChip(rule_id, POLICY_TABLE_URL)}). Add any OpenAI-compatible
     endpoint in settings to complete it — or try a shorter prompt locally.
     <button type="button" class="open-settings">open settings</button>`,
    "needs-endpoint",
  );
  card.querySelector(".open-settings")?.addEventListener("click", () => settingsEl.showModal());
}

// --- first-local-run download progress (spec §2: never a silent stall) --------

let loadCard: HTMLElement | null = null;
let loadBar: HTMLProgressElement | null = null;

function onLoadProgress(p: { progress: number; text: string }): void {
  if (!loadCard) {
    loadCard = addCard(
      `Downloading Llama-3.2-1B (664 MB, one-time — cached for next visits)
       <progress max="1" value="0"></progress><span class="mono dim load-text"></span>`,
      "load-card",
    );
    loadBar = loadCard.querySelector("progress");
  }
  if (loadBar) loadBar.value = p.progress;
  const t = loadCard.querySelector(".load-text");
  if (t) t.textContent = p.text;
}

function clearLoadCard(): void {
  loadCard?.remove();
  loadCard = null;
  loadBar = null;
}

// --- suggested prompt chips -----------------------------------------------------

interface Chip {
  label: string;
  prompt: string;
  display?: string;
  desktopOnly?: boolean;
}

const CHIPS: Chip[] = [
  {
    label: "Explain browser AI (~100 words)",
    prompt: "Explain how an AI model runs in a browser, in about 100 words.",
  },
  {
    label: "Haiku about deep water",
    prompt: "Write a haiku about deep water.",
  },
  {
    label: "長文を要約 — long prompt → watch it route to server",
    prompt: LONG_CJK_PROMPT,
    display: `${LONG_CJK_PROMPT.slice(0, 90)}… （約${LONG_CJK_PROMPT.length.toLocaleString()}字の長文）`,
    desktopOnly: true,
  },
];

function renderChips(ludion: Ludion, send: (content: string, display?: string) => void): void {
  for (const chip of CHIPS) {
    if (chip.desktopOnly && ludion.probe.os_class !== "desktop") continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = chip.label;
    btn.addEventListener("click", () => send(chip.prompt, chip.display));
    chipsEl.appendChild(btn);
  }
}

// --- boot -----------------------------------------------------------------------

const history: { role: "user" | "assistant"; content: string }[] = [];

async function boot(): Promise<void> {
  const ludion = await Ludion.create({
    // Local savings ledger is default-on inside the router (fed by the decision
    // sink), so no manual onDecision→ledger wiring here — the /savings page
    // reads what the sink records. Counts/metadata only, localStorage, never
    // content.
    // Zero-config by design (F-3): no create()-time fallback. The endpoint is
    // supplied at runtime through the live config source (settings drawer) and
    // read per request — so a save is honored with no reload. Until one is set,
    // server-routed requests throw the typed LudionNoFallbackConfigured, which
    // send() turns into the contextual "add an endpoint" card.
    onLocalLoadProgress: onLoadProgress,
  });

  const verdict = evaluateVerdict(ludion.probe);
  renderProbeCard(ludion, verdict);
  void renderComparison(ludion, verdict);

  const submit = (content: string, display?: string): void => {
    void send(ludion, content, display);
  };
  renderChips(ludion, submit);
  composerEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const content = inputEl.value.trim();
    if (content) submit(content);
  });
}

async function send(ludion: Ludion, content: string, display?: string): Promise<void> {
  if (sendEl.disabled) return;
  inputEl.value = "";
  sendEl.disabled = true;
  addBubble("user", display ?? content);
  history.push({ role: "user", content });

  try {
    // Plain OpenAI shape — the only Ludion-specific bit is `_ludion`.
    const stream = await ludion.chat.completions.create({
      messages: history,
      max_tokens: 256,
      stream: true,
    });
    const log = stream._ludion;

    setInstrument(log.target === "local" ? "local" : "server");
    const bubble = addBubble("assistant", "");
    let text = "";
    let first = true;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        if (first) {
          clearLoadCard();
          first = false;
        }
        text += delta;
        bubble.textContent = text;
        bubble.scrollIntoView({ block: "end" });
      }
    }
    clearLoadCard();
    history.push({ role: "assistant", content: text });
    // The log was mutated with ttft/tps on completion; degrade may have
    // flipped the effective target.
    if (log.degraded) setInstrument("server");
    addStripCard(log);
  } catch (e) {
    clearLoadCard();
    // F-3: no endpoint configured and the policy wants the server. The 0.1.1
    // router throws this at decision time — no fetch ever happened.
    if (e instanceof LudionNoFallbackConfigured) {
      setInstrument("server");
      addServerNeedsEndpointCard(e.rule_id);
      history.pop(); // request never executed
      return;
    }
    const bubble = addBubble("assistant error", "");
    bubble.textContent = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    sendEl.disabled = false;
  }
}

void boot();
