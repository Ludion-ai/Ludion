import { Entelic } from "entelic-router";
import type { DecisionLog } from "entelic-router";
import "./style.css";

/**
 * Gate 1 demo chat page (spec Section 8): message box, streaming output, a
 * decision strip per response, and a settings drawer for the fallback
 * endpoint. The calling code is plain OpenAI shape — the only
 * Entelic-specific bit is reading `_entelic` (acceptance criterion 8).
 */

const SETTINGS_KEY = "entelic.demo.fallback.v1";

interface DemoSettings {
  url: string;
  apiKey: string;
  model: string;
}

function loadSettings(): DemoSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as DemoSettings;
  } catch {
    // fall through
  }
  return { url: "", apiKey: "", model: "" };
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const chatEl = $("#chat");
const inputEl = $<HTMLTextAreaElement>("#input");
const composerEl = $<HTMLFormElement>("#composer");
const sendEl = $<HTMLButtonElement>("#send");
const settingsEl = $("#settings");

// --- settings drawer ---------------------------------------------------------

const settings = loadSettings();
$<HTMLInputElement>("#cfg-url").value = settings.url;
$<HTMLInputElement>("#cfg-key").value = settings.apiKey;
$<HTMLInputElement>("#cfg-model").value = settings.model;
$("#settings-toggle").addEventListener("click", () => {
  settingsEl.hidden = !settingsEl.hidden;
});
$("#cfg-save").addEventListener("click", () => {
  const next: DemoSettings = {
    url: $<HTMLInputElement>("#cfg-url").value.trim(),
    apiKey: $<HTMLInputElement>("#cfg-key").value.trim(),
    model: $<HTMLInputElement>("#cfg-model").value.trim(),
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  location.reload();
});

// --- chat --------------------------------------------------------------------

function addBubble(cls: string, text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = `bubble ${cls}`;
  div.textContent = text;
  chatEl.appendChild(div);
  div.scrollIntoView({ block: "end" });
  return div;
}

function fmt(n: number | null, digits = 0): string {
  return n === null ? "–" : n.toFixed(digits);
}

function addDecisionStrip(log: DecisionLog): void {
  const div = document.createElement("div");
  div.className = "decision-strip";
  const parts = [
    `target=${log.target}`,
    `rule=${log.rule_id}`,
    `policy=${log.policy_version}`,
    `model=${log.model}`,
    `ttft=${fmt(log.ttft_ms)}ms`,
    `tps=${fmt(log.tps, 1)}`,
  ];
  if (log.degraded) parts.push(`degraded=${log.degraded}`);
  if (log.degraded_failed) parts.push("degraded_failed");
  if (log.error) parts.push(`error=${log.error}`);
  div.textContent = parts.join(" · ");
  chatEl.appendChild(div);
  div.scrollIntoView({ block: "end" });
}

const history: { role: "user" | "assistant"; content: string }[] = [];

async function boot(): Promise<void> {
  if (!settings.url || !settings.model) {
    settingsEl.hidden = false;
    addBubble("system", "Configure the fallback endpoint in settings first.");
  }
  const entelic = await Entelic.create({
    fallback: {
      url: settings.url,
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      model: settings.model || "unconfigured",
    },
  });

  composerEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send(entelic);
  });
}

async function send(entelic: Entelic): Promise<void> {
  const content = inputEl.value.trim();
  if (!content || sendEl.disabled) return;
  inputEl.value = "";
  sendEl.disabled = true;
  addBubble("user", content);
  history.push({ role: "user", content });

  const bubble = addBubble("assistant", "");
  try {
    // Plain OpenAI-shaped call (acceptance 8).
    const stream = await entelic.chat.completions.create({
      messages: history,
      max_tokens: 256,
      stream: true,
    });
    let text = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        bubble.textContent = text;
        bubble.scrollIntoView({ block: "end" });
      }
    }
    history.push({ role: "assistant", content: text });
    addDecisionStrip(stream._entelic);
  } catch (e) {
    bubble.classList.add("error");
    bubble.textContent = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    sendEl.disabled = false;
  }
}

void boot();
