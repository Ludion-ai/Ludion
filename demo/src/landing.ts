import "@fontsource/ibm-plex-mono/400.css";
// Reuse the workspace design system verbatim (spec §4): tokens + primitives, so
// the landing and the workspace read as one product. landing.css adds only the
// public page's layout on top of those tokens.
import "./dashboard.css";
import "./landing.css";
import { card, copyBlock, el, hexMark } from "./dashboard/components";
import { IMPORT_LINE } from "./dashboard/setup";
import type { DecisionLog } from "ludion-router";

/*
 * The public, login-free landing (ludion.ai/). It makes NO auth call and sets
 * NO session (spec §6): the only network traffic is static assets, plus the
 * model weights pulled from the CDN when the visitor clicks "run a model in
 * your browser". The in-page demo deliberately installs NO config source, so a
 * request the policy routes to server throws LudionNoFallbackConfigured at
 * decision time — no fetch, and the playground's same-origin stored config is
 * never read. On-device runs stay on-device.
 */

const REPO = "https://github.com/Ludion-ai/Ludion";
const DOCS_URL = `${REPO}#readme`;
const NPM_URL = "https://www.npmjs.com/package/ludion-router";

/** GitHub mark — monochrome, inherits currentColor. */
function githubMark(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "ld-gh");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("fill", "currentColor");
  p.setAttribute(
    "d",
    "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z",
  );
  svg.append(p);
  return svg;
}

function navLink(label: string, href: string, opts: { external?: boolean } = {}): HTMLAnchorElement {
  const a = el("a", "ld-nav-link", label);
  a.href = href;
  if (opts.external) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  return a;
}

function ctaLink(label: string, href: string, primary = false): HTMLAnchorElement {
  const a = el("a", `lx-btn${primary ? " lx-btn-primary" : ""}`, label);
  a.href = href;
  return a;
}

// --- nav --------------------------------------------------------------------

function buildNav(): HTMLElement {
  const bar = el("header", "lx-topbar ld-nav");
  const brand = el("a", "lx-brand ld-brand");
  (brand as HTMLAnchorElement).href = "/";
  brand.append(hexMark(), el("span", "lx-brand-word", "Ludion"));

  const right = el("nav", "lx-topbar-right ld-nav-right");
  right.append(navLink("Docs", DOCS_URL, { external: true }));
  right.append(navLink("Blog", "/blog"));
  const gh = el("a", "ld-nav-icon");
  (gh as HTMLAnchorElement).href = REPO;
  (gh as HTMLAnchorElement).target = "_blank";
  (gh as HTMLAnchorElement).rel = "noopener";
  gh.setAttribute("aria-label", "GitHub");
  gh.append(githubMark());
  right.append(gh);
  right.append(ctaLink("Open workspace", "/app", true));

  bar.append(brand, right);
  return bar;
}

// --- hero -------------------------------------------------------------------

function buildHero(): HTMLElement {
  const s = el("section", "ld-section ld-hero");
  s.append(el("h1", "ld-h1", "Run language models in the browser. Hit the API only when you have to."));
  s.append(
    el(
      "p",
      "ld-sub",
      "Ludion is a drop-in OpenAI-compatible router. Swap one import and requests run on the user's device when the hardware can handle it, and fall back to your API when it can't. Fewer API calls, and prompts that stay on the device.",
    ),
  );

  // The centerpiece: the import line as a copyable code card (spec §3).
  const focal = el("div", "ld-import");
  focal.append(copyBlock(IMPORT_LINE, { inline: true, label: "import line" }));
  s.append(focal);

  const ctas = el("div", "ld-cta-row");
  ctas.append(ctaLink("Open workspace", "/app", true));
  ctas.append(ctaLink("Read the docs", DOCS_URL));
  s.append(ctas);
  return s;
}

// --- live on-device demo (the proof) ----------------------------------------

const DEFAULT_PROMPT = "Write a haiku about deep water.";

function buildDemo(): HTMLElement {
  const c = card({ kicker: "Live, on-device, no login" });
  c.classList.add("ld-demo");
  c.append(el("h2", "ld-h2", "Watch it run in your browser"));
  c.append(
    el(
      "p",
      "ld-lead",
      "This runs a small model on your device. No login, no API key, no prompt leaves the browser. The weights download from the CDN on click, so nothing loads until you ask for it.",
    ),
  );

  const run = el("button", "lx-btn lx-btn-primary ld-run", "Run a model in your browser");
  run.type = "button";
  c.append(run);

  const stage = el("div", "ld-stage");
  c.append(stage);

  run.addEventListener("click", () => {
    run.disabled = true;
    void startDemo(stage, run);
  });
  return c;
}

interface LedgerLike {
  record(log: DecisionLog): void;
  summary(): { local_count: number; server_count: number; total_requests: number };
}

async function startDemo(stage: HTMLElement, run: HTMLButtonElement): Promise<void> {
  stage.replaceChildren();
  const status = el("p", "ld-demo-status lx-mono", "loading the router…");
  stage.append(status);

  // Lazy: the engine code and the savings ledger are pulled only now, on the
  // explicit click — they never enter the initial landing bundle (spec §3).
  let mod: typeof import("ludion-router");
  let SavingsLedger: typeof import("ludion-router/savings").SavingsLedger;
  try {
    [mod, { SavingsLedger }] = await Promise.all([import("ludion-router"), import("ludion-router/savings")]);
  } catch (e) {
    status.textContent = `could not load the demo: ${e instanceof Error ? e.message : String(e)}`;
    run.disabled = false;
    return;
  }

  const ledger: LedgerLike = new SavingsLedger();
  const transcript = el("div", "ld-transcript");
  const progress = el("div", "ld-progress");
  const ledgerOut = el("p", "ld-ledger lx-mono");

  // No config source is installed: a server-routed request throws
  // LudionNoFallbackConfigured at decision time (no fetch). On-device only.
  const ludion = await mod.Ludion.create({
    onDecision: (log) => ledger.record(log),
    onLocalLoadProgress: (p) => {
      progress.replaceChildren();
      const pct = Math.round((p.progress ?? 0) * 100);
      progress.append(el("p", "lx-mono ld-progress-text", `${p.text || "downloading model"} — ${pct}%`));
      const bar = el("div", "ld-bar");
      const fill = el("div", "ld-bar-fill");
      fill.style.width = `${pct}%`;
      bar.append(fill);
      progress.append(bar);
    },
  });

  status.remove();
  stage.append(transcript, progress, ledgerOut);

  const form = el("form", "ld-composer");
  const input = el("input", "ld-input") as HTMLInputElement;
  input.type = "text";
  input.value = DEFAULT_PROMPT;
  input.setAttribute("aria-label", "message");
  const send = el("button", "lx-btn lx-btn-primary ld-send", "Send") as HTMLButtonElement;
  send.type = "submit";
  form.append(input, send);
  stage.append(form);

  const history: Array<{ role: "user" | "assistant"; content: string }> = [];

  const submit = async (content: string): Promise<void> => {
    if (send.disabled || !content) return;
    send.disabled = true;
    input.value = "";
    addMsg(transcript, "you", content);
    history.push({ role: "user", content });
    const reply = addMsg(transcript, "ludion", "");
    try {
      const stream = await ludion.chat.completions.create({ messages: history, max_tokens: 200, stream: true });
      const log = stream._ludion;
      let text = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          text += delta;
          reply.textContent = text;
        }
      }
      progress.replaceChildren();
      history.push({ role: "assistant", content: text });
      if (log.target === "local") {
        addFact(transcript, "this request ran on your device. 0 API calls.");
      }
      renderLedger(ledgerOut, ledger);
    } catch (e) {
      progress.replaceChildren();
      reply.remove();
      history.pop();
      if (e instanceof mod.LudionNoFallbackConfigured) {
        // Honest mechanical fact: the policy routed this device to server, and
        // because the landing configures no fallback, nothing was sent.
        renderServerRoute(transcript);
      } else {
        addFact(transcript, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    } finally {
      send.disabled = false;
    }
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void submit(input.value.trim());
  });
  void submit(DEFAULT_PROMPT);
}

function addMsg(transcript: HTMLElement, who: "you" | "ludion", text: string): HTMLElement {
  const row = el("div", `ld-msg ld-msg-${who}`);
  row.append(el("span", "ld-msg-role", who === "you" ? "YOU" : "LUDION"));
  const body = el("div", "ld-msg-body", text);
  row.append(body);
  transcript.append(row);
  row.scrollIntoView({ block: "end" });
  return body;
}

function addFact(transcript: HTMLElement, text: string): void {
  const f = el("p", "ld-fact lx-mono", text);
  transcript.append(f);
  f.scrollIntoView({ block: "end" });
}

function renderServerRoute(transcript: HTMLElement): void {
  const f = el("p", "ld-fact lx-mono");
  f.append(
    document.createTextNode(
      "your device routes this request to server. the landing configures no fallback, so nothing was sent — 0 network calls. on a WebGPU-capable device this runs on-device. ",
    ),
  );
  const a = el("a", "ld-inline-link", "see the full playground");
  a.href = "/demo";
  f.append(a);
  transcript.append(f);
  f.scrollIntoView({ block: "end" });
}

function renderLedger(out: HTMLElement, ledger: LedgerLike): void {
  const s = ledger.summary();
  out.textContent = `this browser, this session: ${s.local_count} on-device · ${s.local_count} API calls avoided`;
}

// --- how it works -----------------------------------------------------------

function buildHowItWorks(): HTMLElement {
  const s = el("section", "ld-section ld-how");
  s.append(el("h2", "ld-h2", "How it works"));
  const steps: Array<[string, Node]> = [
    ["1", textWithCode("Swap your OpenAI import for Ludion's.", IMPORT_LINE)],
    ["2", el("span", undefined, "Ludion probes the device and runs the model on-device when it can.")],
    ["3", el("span", undefined, "When it can't, it falls back through your relay to your API.")],
  ];
  const list = el("ol", "ld-steps");
  for (const [n, body] of steps) {
    const li = el("li", "ld-step");
    li.append(el("span", "ld-step-n lx-mono", n));
    const wrap = el("div", "ld-step-body");
    wrap.append(body);
    li.append(wrap);
    list.append(li);
  }
  s.append(list);
  return s;
}

function textWithCode(text: string, code: string): Node {
  const wrap = el("div");
  wrap.append(el("p", "ld-step-text", text));
  wrap.append(el("code", "ld-inline-code lx-mono", code));
  return wrap;
}

// --- savings (mechanism) ----------------------------------------------------

function buildSavings(): HTMLElement {
  const c = card({ kicker: "Savings" });
  c.classList.add("ld-savings");
  c.append(el("h2", "ld-h2", "Every on-device request is an API call you do not pay for"));
  c.append(
    el(
      "p",
      "ld-lead",
      "On-device inference is the cost-reduction engine: a request the device serves locally never reaches your provider, so it never bills. Run the demo above and the reading is this browser's own count — nothing aggregated, nothing invented.",
    ),
  );
  return c;
}

// --- quickstart -------------------------------------------------------------

const CONFIG_SHAPE = `{
  "config_version": 1,
  "fallback": {
    "baseURL": "https://your-relay.your-workers.dev",
    "model": "gpt-4o-mini",
    "apiKey": "<your relay token>"
  }
}`;

function buildQuickstart(): HTMLElement {
  const c = card({ kicker: "Quickstart" });
  c.classList.add("ld-quickstart");
  c.append(el("h2", "ld-h2", "The copy-paste path"));
  c.append(el("p", "ld-lead", "One import, plus a ludion.config.v1 with your relay as the fallback baseURL."));
  c.append(copyBlock(IMPORT_LINE, { inline: true, label: "import line" }));
  c.append(copyBlock(CONFIG_SHAPE, { label: "config" }));
  const note = el("p", "ld-note");
  note.append(document.createTextNode("the workspace generates this for you, relay included. "));
  const a = el("a", "ld-inline-link", "Open workspace");
  a.href = "/app";
  note.append(a);
  c.append(note);
  return c;
}

// --- footer -----------------------------------------------------------------

function buildFooter(): HTMLElement {
  const f = el("footer", "ld-footer");
  const brand = el("div", "ld-foot-brand");
  brand.append(hexMark(), el("span", "lx-brand-word", "Ludion"));
  f.append(brand);
  f.append(el("p", "ld-foot-tag", "run language models in the browser. hit the API only when you have to."));
  const links = el("nav", "ld-foot-links");
  links.append(navLink("Docs", DOCS_URL, { external: true }));
  links.append(navLink("Blog", "/blog"));
  links.append(navLink("GitHub", REPO, { external: true }));
  links.append(navLink("npm", NPM_URL, { external: true }));
  f.append(links);
  return f;
}

// --- mount ------------------------------------------------------------------

function mount(): void {
  const root = document.querySelector("#ld-root");
  if (!root) throw new Error("missing #ld-root");
  root.append(buildNav());
  const main = el("main", "ld-main");
  main.append(buildHero());
  main.append(buildDemo());
  main.append(buildHowItWorks());
  main.append(buildSavings());
  main.append(buildQuickstart());
  root.append(main);
  root.append(buildFooter());
}

mount();
