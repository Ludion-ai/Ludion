// /teach (site.md). Shows one of: closed, signed out (with or without a draft), the form, the lesson to sign, or
// the pull request it opened. Draft text is only ever set with textContent, never parsed as HTML.
import { en } from "../strings/en.ts";

const t = en.teach;
const DRAFT_KEY = "ludion:draft";

type Run = { runner: string; code: string; expect?: "pass" | "fail"; error?: string };
type Source = { url: string; quote: string };
type Evidence = { run: Run } | { source: Source };
interface Draft {
  subject: string;
  version?: string | null;
  claim: string;
  evidence: Evidence[];
  replaces?: string[];
}
interface ApiError {
  error?: string;
  message?: string;
  errors?: { path: string; message: string }[];
  url?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, on = true) => ($(id).hidden = !on);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
};
const announce = (text: string) => ($("teach-status").textContent = text);

let draft: Draft | undefined;
let login: string | undefined;

// ---- The draft: from #d= (base64url of UTF-8 JSON), else the copy saved before signing in.

function draftFromHash(): Draft | undefined | "damaged" {
  const m = /^#d=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m) return undefined;
  try {
    const b64 = m[1]!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (m[1]!.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Draft;
  } catch {
    return "damaged";
  }
}

function savedDraft(): Draft | undefined {
  try {
    const text = sessionStorage.getItem(DRAFT_KEY);
    return text ? (JSON.parse(text) as Draft) : undefined;
  } catch {
    return undefined;
  }
}

function saveDraft(d: Draft | undefined): void {
  try {
    if (d) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage blocked: the draft stays in the link.
  }
}

// ---- Showing the whole lesson before it is signed.

function renderDraft(d: Draft): void {
  $("draft-subject").textContent = d.subject;
  $("draft-version").textContent = d.version || t.noVersion;
  $("draft-claim").textContent = d.claim;
  const list = $("draft-evidence");
  list.replaceChildren();
  for (const e of d.evidence ?? []) {
    const fig = el("figure");
    if ("run" in e) {
      fig.className = "draft-run";
      fig.append(el("figcaption", t.test(e.run.runner)));
      const pre = el("pre");
      pre.tabIndex = 0;
      pre.append(el("code", e.run.code));
      fig.append(pre);
      if (e.run.expect === "fail" && e.run.error) fig.append(el("p", t.expectFail(e.run.error), "where"));
    } else {
      fig.className = "draft-source";
      fig.append(el("figcaption", t.source));
      const quote = el("blockquote");
      quote.append(el("p", e.source.quote));
      fig.append(quote);
      fig.append(el("p", e.source.url, "where"));
    }
    list.append(fig);
  }
  show("teach-draft");
}

function showError(body: ApiError | undefined, fallback = t.errors.unknown!): void {
  const box = $("teach-error");
  box.replaceChildren();
  const code = body?.error ?? "";
  box.append(t.errors[code] ?? fallback);
  if (code === "invalid_draft" && body?.errors?.length) {
    const ul = el("ul");
    for (const e of body.errors) ul.append(el("li", `${e.path}: ${e.message}`));
    box.append(ul);
  }
  show("teach-error");
}

const clearError = () => show("teach-error", false);

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(path, { credentials: "same-origin", ...init });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: undefined };
  }
}

const postJson = (path: string, data: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

// ---- Check, then Teach.

async function check(): Promise<void> {
  if (!draft) return;
  clearError();
  const submit = $<HTMLButtonElement>("teach-submit");
  const button = $<HTMLButtonElement>("teach-check");
  submit.disabled = true;
  button.disabled = true;
  button.textContent = t.checking;
  const list = $("teach-checks");
  list.replaceChildren();
  const { status, body } = await postJson("/api/check", draft);
  button.disabled = false;
  button.textContent = t.check;
  if (status === 200 && body?.ok) {
    for (const s of body.sources ?? []) list.append(el("li", t.quoteFound(new URL(s.url).host)));
    for (const e of draft.evidence) if ("run" in e && e.run.runner !== "lean") list.append(el("li", t.ciWillRun));
    submit.disabled = false;
    announce(t.signingAs(login ?? ""));
    return;
  }
  showError(body);
}

async function teach(): Promise<void> {
  if (!draft) return;
  clearError();
  const submit = $<HTMLButtonElement>("teach-submit");
  submit.disabled = true;
  const { status, body } = await postJson("/api/teach", draft);
  if (status === 201) {
    saveDraft(undefined);
    history.replaceState(null, "", "/teach");
    show("teach-sign", false);
    $("teach-pr").textContent = t.submitted(body.pr);
    show("teach-submitted");
    void poll(body.pr, body.lesson_url, body.pr_url);
    return;
  }
  showError(body);
}

async function poll(pr: number, lessonUrl: string, prUrl: string): Promise<void> {
  const line = $("teach-pr-status");
  for (;;) {
    const { status, body } = await api(`/api/pr/${pr}`);
    if (status === 200 && body.status === "verified") {
      line.replaceChildren(t.prVerified, " ");
      const a = el("a", t.openLesson);
      a.href = lessonUrl;
      line.append(a);
      return;
    }
    if (status === 200 && (body.status === "failed" || body.status === "closed")) {
      line.replaceChildren(t.prFailed, " ");
      const a = el("a", t.prChecks);
      a.href = `${prUrl}/checks`;
      line.append(a);
      return;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

// ---- The form, for a lesson written here rather than drafted by an assistant.

function evidenceItem(kind: "run" | "source", value?: Evidence): HTMLFieldSetElement {
  const n = document.querySelectorAll(".evidence-item").length + 1;
  const box = el("fieldset", undefined, "evidence-item");
  box.dataset.kind = kind;
  box.append(el("legend", kind === "run" ? t.form.testN(n) : t.form.sourceN(n)));
  const field = (label: string, control: HTMLElement, hint?: string) => {
    const id = `f-ev-${n}-${label.toLowerCase()}`;
    control.id = id;
    const l = el("label", label);
    l.htmlFor = id;
    box.append(l, control);
    if (hint) {
      const h = el("p", hint, "hint");
      h.id = `${id}-hint`;
      control.setAttribute("aria-describedby", h.id);
      box.append(h);
    }
  };
  if (kind === "run") {
    const runner = el("select");
    for (const r of ["python", "bash", "node", "lean"]) runner.append(new Option(r, r));
    const code = el("textarea", undefined, "code");
    code.rows = 6;
    code.spellcheck = false;
    if (value && "run" in value) {
      runner.value = value.run.runner;
      code.value = value.run.code;
    }
    field(t.form.runner, runner);
    field(t.form.code, code, t.form.codeHint);
  } else {
    const url = el("input");
    url.type = "url";
    const quote = el("textarea");
    quote.rows = 2;
    if (value && "source" in value) {
      url.value = value.source.url;
      quote.value = value.source.quote;
    }
    field(t.form.url, url);
    field(t.form.quote, quote, t.form.quoteHint);
  }
  const remove = el("button", t.form.remove, "button");
  remove.type = "button";
  remove.addEventListener("click", () => box.remove());
  box.append(remove);
  return box;
}

function fillForm(d: Draft | undefined): void {
  $<HTMLInputElement>("f-subject").value = d?.subject ?? "";
  $<HTMLInputElement>("f-version").value = d?.version ?? "";
  $<HTMLTextAreaElement>("f-claim").value = d?.claim ?? "";
  updateCounter();
  const list = $("f-evidence");
  list.replaceChildren();
  for (const e of d?.evidence ?? []) list.append(evidenceItem("run" in e ? "run" : "source", e));
}

function readForm(): Draft {
  const evidence: Evidence[] = [];
  for (const box of document.querySelectorAll<HTMLFieldSetElement>(".evidence-item")) {
    const [a, b] = [...box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("select, input, textarea")];
    if (box.dataset.kind === "run") evidence.push({ run: { runner: a!.value, code: b!.value } });
    else evidence.push({ source: { url: a!.value.trim(), quote: b!.value.trim() } });
  }
  const version = $<HTMLInputElement>("f-version").value.trim();
  const d: Draft = { subject: $<HTMLInputElement>("f-subject").value.trim(), claim: $<HTMLTextAreaElement>("f-claim").value.trim(), evidence };
  if (version) d.version = version;
  if (draft?.replaces?.length) d.replaces = draft.replaces;
  return d;
}

function updateCounter(): void {
  $("f-claim-count").textContent = t.form.counter([...$<HTMLTextAreaElement>("f-claim").value].length);
}

// ---- States.

function showSigned(d: Draft): void {
  draft = d;
  saveDraft(d);
  show("teach-form", false);
  renderDraft(d);
  $("teach-signing-as").textContent = t.signingAs(login!);
  $("teach-checks").replaceChildren();
  $<HTMLButtonElement>("teach-submit").disabled = true;
  show("teach-sign");
  void check();
}

function showForm(d: Draft | undefined): void {
  show("teach-draft", false);
  show("teach-sign", false);
  fillForm(d);
  show("teach-form");
}

async function start(): Promise<void> {
  const fromHash = draftFromHash();
  if (fromHash === "damaged") showError(undefined, t.errors.badDraftLink);
  const d = (fromHash !== "damaged" ? fromHash : undefined) ?? savedDraft();
  const signInError = new URLSearchParams(location.search).get("error");
  if (signInError) showError({ error: signInError });

  const { status, body } = await api("/api/session");
  if (status === 200 && body?.login) {
    login = body.login as string;
    if (d) showSigned(d);
    else showForm(undefined);
    return;
  }
  if (d) renderDraft(d);
  if (status === 401) {
    if (d) {
      saveDraft(d);
      $("teach-signin-link").textContent = t.signInToSign;
      show("teach-sources-later");
    }
    show("teach-signin");
    return;
  }
  // 503 teaching_not_open, or the API is unreachable.
  show("teach-closed");
}

$("teach-check").addEventListener("click", () => void check());
$("teach-submit").addEventListener("click", () => void teach());
$("teach-edit").addEventListener("click", () => showForm(draft));
$("f-claim").addEventListener("input", updateCounter);
$("f-add-test").addEventListener("click", () => {
  if (document.querySelectorAll(".evidence-item").length < 3) $("f-evidence").append(evidenceItem("run"));
});
$("f-add-source").addEventListener("click", () => {
  if (document.querySelectorAll(".evidence-item").length < 3) $("f-evidence").append(evidenceItem("source"));
});
$("teach-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearError();
  showSigned(readForm());
});

void start();
