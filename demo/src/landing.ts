import "@fontsource/ibm-plex-mono/400.css";
// Reuse the workspace design system verbatim (spec §4): tokens + primitives, so
// the landing and the workspace read as one product. landing.css adds only the
// public page's layout on top of those tokens.
import "./dashboard.css";
import "./landing.css";
import { card, copyBlock, el, hexMark } from "./dashboard/components";
import { IMPORT_LINE } from "./dashboard/setup";

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
const CONTACT_URL = `${REPO}/issues/new`;

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
  right.append(navLink("How it works", "#how"));
  right.append(navLink("Use cases", "#use-cases"));
  right.append(navLink("Demo", "/demo"));
  const gh = el("a", "ld-nav-icon");
  (gh as HTMLAnchorElement).href = REPO;
  (gh as HTMLAnchorElement).target = "_blank";
  (gh as HTMLAnchorElement).rel = "noopener";
  gh.setAttribute("aria-label", "GitHub");
  gh.append(githubMark());
  right.append(gh);
  right.append(ctaLink("Workspace", "/app", true));

  bar.append(brand, right);
  return bar;
}

// --- hero -------------------------------------------------------------------

function buildHero(): HTMLElement {
  const s = el("section", "ld-section ld-hero");
  s.append(el("p", "ld-eyebrow lx-mono", "AI apps are overpaying for cloud inference."));
  s.append(el("h1", "ld-h1", "Stop paying cloud prices for browser-sized AI tasks."));
  s.append(
    el(
      "p",
      "ld-sub",
      "Ludion routes cheap, low-risk LLM calls to WebLLM in the user's browser, with your server kept as fallback for slow devices, long prompts, unsupported browsers, and local failures.",
    ),
  );
  s.append(
    el(
      "p",
      "ld-attack",
      "The waste is not the hard prompts. It is sending every rewrite, tag, title, and short classification to the server by default.",
    ),
  );
  s.append(el("p", "ld-support", "Browser when safe. Server when needed. Measured every time."));

  const ctas = el("div", "ld-cta-row");
  ctas.append(ctaLink("Try the demo", "/demo", true));
  ctas.append(ctaLink("View GitHub", REPO));
  ctas.append(ctaLink("Get integration help", CONTACT_URL));
  s.append(ctas);

  const heroGrid = el("div", "ld-hero-grid");
  heroGrid.append(buildRoutingDiagram());
  s.append(heroGrid);
  return s;
}

function buildRoutingDiagram(): HTMLElement {
  const panel = el("section", "ld-route-diagram");
  panel.append(el("span", "lx-kicker", "The safety layer"));
  const flow = el("div", "ld-flow");
  flow.append(flowNode("LLM request"));
  flow.append(flowArrow());
  flow.append(flowNode("Ludion"));
  flow.append(flowArrow());
  const split = el("div", "ld-flow-split");
  split.append(
    flowBranch("Browser WebLLM", "short prompt, low-risk task, known-good device"),
    flowBranch("Server fallback", "iOS, in-app browser, long prompt, unknown device, local failure, high-risk task"),
  );
  flow.append(split);
  panel.append(flow);
  return panel;
}

function buildProblem(): HTMLElement {
  const c = card({ kicker: "The problem" });
  c.classList.add("ld-problem");
  c.append(
    el(
      "h2",
      "ld-h2",
      "The default path is economically wrong.",
    ),
  );
  c.append(
    el(
      "p",
      "ld-lead",
      "Most AI apps send every request to the cloud, even when the task is short, cheap, private, and browser-sized.",
    ),
  );
  c.append(
    el(
      "p",
      "ld-lead",
      "But browser inference cannot be assumed. WebGPU support is not enough. Devices differ, in-app browsers break, prompt length matters, and local failure must not break the user experience.",
    ),
  );
  return c;
}

function flowNode(text: string): HTMLElement {
  return el("div", "ld-flow-node lx-mono", text);
}

function flowArrow(): HTMLElement {
  return el("div", "ld-flow-arrow", "->");
}

function flowBranch(title: string, body: string): HTMLElement {
  const b = el("div", "ld-flow-branch");
  b.append(el("strong", undefined, title));
  b.append(el("span", undefined, body));
  return b;
}

// --- capability checks lie (measured proof under the hero) ------------------

const TINY_PROMPT = "Say hello in one short sentence.";

/**
 * The page's core, measured claim: a browser reporting WebGPU support is not
 * the same as successfully running a small model. Part A lets the visitor run
 * it on their own device (lazy — the engine is fetched only on click, never in
 * the initial bundle, mirroring startDemo below). Part B is three real device
 * runs from bench/results/; every number carries its source path in a comment.
 */
function buildCapabilityCheck(): HTMLElement {
  const s = el("section", "ld-section ld-capability");
  s.id = "capability";
  s.append(el("h2", "ld-h2", "\u201cWebGPU supported\u201d is not \u201cthe model runs.\u201d"));
  s.append(
    el(
      "p",
      "ld-lead",
      "Every device below reported WebGPU support. Only one of them actually ran a small model cleanly. Capability flags lie \u2014 so Ludion measures the real run instead of trusting the flag.",
    ),
  );

  // Part A — the visitor runs it on their own device.
  const live = el("div", "ld-cap-live");
  const hasGpu =
    typeof navigator !== "undefined" &&
    "gpu" in navigator &&
    Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
  live.append(el("p", "ld-cap-report lx-mono", `Your browser reports: WebGPU ${hasGpu ? "\u2705" : "\u274c"}`));
  live.append(
    el(
      "p",
      "ld-cap-hint",
      hasGpu
        ? "That flag only says the API exists. It does not say a model will load, run, or finish. See for yourself:"
        : "No WebGPU here \u2014 Ludion would route this to your server fallback. On a WebGPU device, the question is whether it actually runs:",
    ),
  );
  const run = el("button", "lx-btn lx-btn-primary ld-cap-run", "Run a tiny model in your browser \u2192");
  run.type = "button";
  live.append(run);
  const stage = el("div", "ld-stage");
  live.append(stage);
  run.addEventListener("click", () => {
    run.disabled = true;
    void runTinyModel(stage, run);
  });
  s.append(live);

  // Part B — three measured device runs, every number from bench/results/.
  s.append(buildMeasuredComparison());
  return s;
}

async function runTinyModel(stage: HTMLElement, run: HTMLButtonElement): Promise<void> {
  stage.replaceChildren();
  const status = el("p", "ld-demo-status lx-mono", "loading the router (model is fetched only on this click)\u2026");
  stage.append(status);

  // Lazy: the same on-demand WebLLM integration startDemo uses (dynamic
  // import of ludion-router) — the engine never enters the initial bundle.
  let mod: typeof import("ludion-router");
  try {
    mod = await import("ludion-router");
  } catch (e) {
    status.textContent = `could not load the demo: ${e instanceof Error ? e.message : String(e)}`;
    run.disabled = false;
    return;
  }

  const progress = el("div", "ld-progress");
  const out = el("p", "ld-cap-out");
  stage.append(progress, out);

  try {
    // No config source installed (same as startDemo): a server-routed device
    // throws LudionNoFallbackConfigured — handled honestly below.
    const ludion = await mod.Ludion.create({
      onLocalLoadProgress: (p) => {
        progress.replaceChildren();
        const pct = Math.round((p.progress ?? 0) * 100);
        progress.append(el("p", "lx-mono ld-progress-text", `${p.text || "downloading model"} \u2014 ${pct}%`));
        const bar = el("div", "ld-bar");
        const fill = el("div", "ld-bar-fill");
        fill.style.width = `${pct}%`;
        bar.append(fill);
        progress.append(bar);
      },
    });
    status.textContent = "running\u2026";
    const startedAt = performance.now();
    let ttftMs: number | null = null;
    const stream = await ludion.chat.completions.create({
      messages: [{ role: "user", content: TINY_PROMPT }],
      max_tokens: 32,
      stream: true,
    });
    let text = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        if (ttftMs === null) ttftMs = performance.now() - startedAt;
        text += delta;
        out.textContent = text;
      }
    }
    progress.replaceChildren();
    status.textContent =
      ttftMs === null
        ? "the model loaded but produced no tokens on your device."
        : `\u2705 ran on your device \u2014 first token in ${Math.round(ttftMs)} ms.`;
  } catch (e) {
    progress.replaceChildren();
    if (e instanceof mod.LudionNoFallbackConfigured) {
      status.textContent =
        "your browser reports WebGPU, but the router did not run this locally on your device \u2014 it would route to your server fallback. That gap is the point.";
    } else {
      status.textContent = `stalled / failed on your device: ${
        e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }`;
    }
  } finally {
    run.disabled = false;
  }
}

function buildMeasuredComparison(): HTMLElement {
  const wrap = el("div", "ld-cap-measured");
  wrap.append(el("span", "lx-kicker ld-cap-measured-title", "Three real devices \u2014 all reported WebGPU \u2705"));

  const rows: Array<{ device: string; outcome: string }> = [
    {
      device: "Desktop Chrome",
      // desktop-chrome-20260610T102824.json $.runs[20].ttft_ms = 44
      // (webllm Llama-3.2-1B, short prompt; sibling runs[18]=41, runs[19]=45 ms)
      outcome: "ran clean \u2014 first token in 44 ms",
    },
    {
      device: "iPhone 11 Pro Max (Safari)",
      // iphone-11-pro-max-20260610T112313.json $.runs[0].error.error_name = "probable_oom_tab_kill"
      // iphone-11-pro-max-20260610T111359.json $.runs[0].error.error_message = "Load failed"
      // no run on this device produced a ttft_ms (NOT FOUND) — never a token
      outcome: "tab killed mid-run \u2014 never produced a single token",
    },
    {
      device: "Pixel 8a (Chrome)",
      // pixel-8a-20260610T125416.json $.runs[3].ttft_ms = 77153  (= ~77 s)
      // pixel-8a-20260610T125416.json $.runs[3].error = null → counts as "success" (no latency gate)
      outcome: "\u201csucceeded\u201d \u2014 but first token took 77 s (reported success, unusable)",
    },
  ];

  const list = el("div", "ld-cap-rows");
  for (const r of rows) {
    const row = el("div", "ld-cap-row");
    row.append(el("span", "ld-cap-device", r.device));
    row.append(el("span", "ld-cap-reported lx-mono", "WebGPU \u2705"));
    row.append(el("span", "ld-cap-outcome", r.outcome));
    list.append(row);
  }
  wrap.append(list);

  // LINE in-app browser case as a one-line caption (not a 4th row):
  // pixel-8a-line-iab-20260610T124347.json $.runs = [] (no run); $.operator_notes
  // documents it reported webgpu:true then stalled mid-download.
  wrap.append(
    el(
      "p",
      "ld-cap-caption",
      "Also measured: the LINE in-app browser on the same Pixel 8a reported WebGPU \u2705 too \u2014 then stalled mid-download and never ran. Every number above is a measured run in bench/results/.",
    ),
  );
  return wrap;
}

// --- live on-device demo (the proof) ----------------------------------------

const DEFAULT_PROMPT = "Write a haiku about deep water.";

function buildDemo(): HTMLElement {
  const c = card({ kicker: "Live, on-device, no login" });
  c.classList.add("ld-demo");
  c.id = "demo";
  c.append(el("h2", "ld-h2", "Try the local side of the router"));
  c.append(
    el(
      "p",
      "ld-lead",
      "This demo attempts a browser-side run only. In a real app, Ludion keeps your server endpoint configured as fallback for devices and requests that should not run locally.",
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
    // No manual onDecision→ledger fill: the router's default-on local ledger
    // (fed by the decision sink) records every decision into the same
    // localStorage store this `ledger` reads from below.
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

// --- routing split ----------------------------------------------------------

const BROWSER_TASKS = [
  "rewrite",
  "tag generation",
  "intent classification",
  "query rewrite",
  "short summary",
  "title generation",
  "draft helper",
];

const SERVER_TASKS = [
  "long documents",
  "complex RAG",
  "paid high-quality answers",
  "regulated/high-risk tasks",
  "unsupported browsers",
  "unknown devices",
  "failed local warmup",
];

function buildRoutedWork(): HTMLElement {
  const s = el("section", "ld-section ld-routed-work");
  s.id = "use-cases";
  s.append(el("h2", "ld-h2", "Move the cheap calls first."));
  s.append(
    el(
      "p",
      "ld-lead",
      "Ludion is not trying to move the whole AI app into the browser. It moves the cheap, low-risk calls first and leaves the rest on your server path.",
    ),
  );
  const grid = el("div", "ld-split-grid");
  grid.append(taskColumn("Browser", BROWSER_TASKS), taskColumn("Server", SERVER_TASKS));
  s.append(grid);
  return s;
}

function taskColumn(title: string, items: string[]): HTMLElement {
  const col = el("section", "ld-task-col");
  col.append(el("h3", "ld-h3", title));
  const list = el("ul", "ld-task-list");
  for (const item of items) list.append(el("li", undefined, item));
  col.append(list);
  return col;
}

// --- how it works -----------------------------------------------------------

function buildHowItWorks(): HTMLElement {
  const s = el("section", "ld-section ld-how");
  s.id = "how";
  s.append(el("h2", "ld-h2", "How it works"));
  const steps: Array<[string, Node]> = [
    ["1", textWithCode("Keep your existing server endpoint as fallback.", IMPORT_LINE)],
    ["2", el("span", undefined, "Ludion checks the browser, prompt size, privacy hints, and policy before choosing a target.")],
    ["3", el("span", undefined, "Known-good lightweight work can run in WebLLM. Unsupported, slow, long, or risky requests stay on server inference.")],
    ["4", el("span", undefined, "Every request gets a decision log so you can measure local hit rate, fallback rate, failures, latency, and server calls avoided.")],
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

// --- WebLLM value -----------------------------------------------------------

function buildWhyNotWebLLM(): HTMLElement {
  const c = card({ kicker: "Why Ludion" });
  c.classList.add("ld-webllm");
  c.append(el("h2", "ld-h2", "Why not just use WebLLM directly?"));
  const list = el("ul", "ld-check-list");
  for (const item of [
    "WebGPU support is not the same as successful inference.",
    "Some browsers report capability but still fail or stall.",
    "Prompt length can turn a viable device into a bad local target.",
    "You need fallback behavior when local inference is slow or unsupported.",
    "You need logs to know whether local routing is actually saving server calls.",
  ]) {
    list.append(el("li", undefined, item));
  }
  c.append(list);
  return c;
}

// --- integration ------------------------------------------------------------

const INTEGRATION_SNIPPET = `import { Ludion } from "ludion-router";

const ludion = await Ludion.create({
  fallback: {
    url: "/api/chat",
    model: "your-server-model",
  },
});

const stream = await ludion.chat.completions.create({
  messages,
  max_tokens: 256,
  stream: true,
});

console.log(stream._ludion);
// { target, rule_id, policy_version, ttft_ms, tps, ... }`;

function buildIntegration(): HTMLElement {
  const c = card({ kicker: "Integration" });
  c.classList.add("ld-integration");
  c.append(el("h2", "ld-h2", "One API, with your server path still there"));
  c.append(
    el(
      "p",
      "ld-lead",
      "Start by routing one lightweight call. Ludion can choose browser inference when policy says it is safe, while the app keeps the current server endpoint for everything else.",
    ),
  );
  c.append(copyBlock(INTEGRATION_SNIPPET, { label: "server fallback snippet" }));
  return c;
}

function buildDecisionLog(): HTMLElement {
  const c = card({ kicker: "Decision log" });
  c.classList.add("ld-decision-log");
  c.append(el("h2", "ld-h2", "Know where each request ran"));
  c.append(
    el(
      "p",
      "ld-lead",
      "Every response carries a local decision log, so you can measure local hit rate, fallback rate, latency, and server calls avoided without guessing.",
    ),
  );
  c.append(
    copyBlock(
      `{
  "target": "local",
  "rule_id": "R4",
  "policy_version": "v0-20260610",
  "ttft_ms": 820,
  "tps": 148
}`,
      { label: "example _ludion" },
    ),
  );
  return c;
}

// --- adoption ---------------------------------------------------------------

function buildStartSmall(): HTMLElement {
  const s = el("section", "ld-section ld-start-small");
  s.append(el("h2", "ld-h2", "Start with one low-risk call"));
  s.append(el("p", "ld-lead", "You do not need to move your whole AI app to the browser."));
  const grid = el("div", "ld-start-grid");
  const calls = taskColumn("Good first calls", [
    "rewrite",
    "classify",
    "tags",
    "title generation",
    "short summary",
    "query rewrite",
  ]);
  const measure = taskColumn("Measure before claiming savings", [
    "local hit rate",
    "fallback rate",
    "latency",
    "local failures",
    "server calls avoided",
  ]);
  grid.append(calls, measure);
  s.append(grid);
  s.append(
    el(
      "p",
      "ld-lead",
      "Keep your current server path as fallback, then measure what can safely move.",
    ),
  );
  return s;
}

function buildSupportCta(): HTMLElement {
  const c = card({ kicker: "First-adopter support" });
  c.classList.add("ld-support-cta");
  c.append(el("h2", "ld-h2", "Want to try it in a real app?"));
  c.append(
    el(
      "p",
      "ld-lead",
      "Send a repo or product. I'll look for one lightweight LLM call that may not need to hit your server every time. If it makes sense, I'm happy to make the first integration pass myself and keep your existing server path as fallback.",
    ),
  );
  c.append(ctaLink("Send a repo", CONTACT_URL, true));
  return c;
}

// --- footer -----------------------------------------------------------------

function buildFooter(): HTMLElement {
  const f = el("footer", "ld-footer");
  const brand = el("div", "ld-foot-brand");
  brand.append(hexMark(), el("span", "lx-brand-word", "Ludion"));
  f.append(brand);
  f.append(el("p", "ld-foot-tag", "Stop paying cloud prices for browser-sized AI tasks."));
  const links = el("nav", "ld-foot-links");
  links.append(navLink("View GitHub", REPO, { external: true }));
  links.append(navLink("Try the demo", "/demo"));
  links.append(navLink("Docs", DOCS_URL, { external: true }));
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
  main.append(buildCapabilityCheck());
  main.append(buildProblem());
  main.append(buildRoutedWork());
  main.append(buildHowItWorks());
  main.append(buildWhyNotWebLLM());
  main.append(buildIntegration());
  main.append(buildDecisionLog());
  main.append(buildStartSmall());
  main.append(buildSupportCta());
  main.append(buildDemo());
  root.append(main);
  root.append(buildFooter());
}

mount();
