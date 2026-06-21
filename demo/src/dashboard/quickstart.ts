/*
 * Quickstart section (Workspace /app) — the personalized in-app integration
 * path. A logged-in dev sees their exact, copy-ready drop-in code, generated
 * live from their stored config (fallback model, relay URL, relay token), so
 * they never have to leave for /docs to learn how to wire Ludion into their app.
 *
 * This is a read-only view: it shapes the real `ludion-router/openai` API into a
 * runnable snippet (see integrationSnippet in setup.ts). It handles the no-relay
 * state by showing the real on-device-only snippet, not a broken fallback one.
 */
import { card, copyBlock, el } from "./components";
import type { StoredConfig } from "ludion-workspace/schema";
import { integrationSnippet } from "./setup";

export interface QuickstartContext {
  config: StoredConfig | null;
  /** The client-only relay token (held in ludion.config.v1), or null. */
  token: string | null;
}

function pageHead(): HTMLElement {
  const head = el("div", "lx-page-head");
  const left = el("div");
  left.append(el("h1", "lx-page-title", "Quickstart"));
  left.append(
    el(
      "p",
      "lx-page-sub",
      "Drop Ludion into your app. Models run on the user's device first, and fall back to the API only when a request can't run on-device.",
    ),
  );
  head.append(left);
  return head;
}

function dropinCard(snippet: ReturnType<typeof integrationSnippet>): HTMLElement {
  const c = card({ kicker: "1. Drop it in", span: 12 });
  const row = el("div", "lx-status-row");
  row.append(
    el(
      "span",
      `lx-pill ${snippet.hasRelay ? "lx-pill-active" : ""}`,
      snippet.hasRelay ? "On-device + relay fallback" : "On-device only",
    ),
  );
  c.append(row);
  c.append(
    el(
      "p",
      "lx-card-lead",
      snippet.hasRelay
        ? "Your config is baked in — copy this into your app and the integration runs."
        : "No relay yet, so this runs on-device only. Copy it to start; add a relay below for API fallback.",
    ),
  );
  c.append(copyBlock(snippet.dropin, { label: "drop-in code" }));
  return c;
}

function usageCard(snippet: ReturnType<typeof integrationSnippet>): HTMLElement {
  const c = card({ kicker: "2. Call it", span: 12 });
  c.append(el("p", "lx-card-lead", "A chat completion looks exactly like the OpenAI SDK."));
  c.append(copyBlock(snippet.usage, { label: "usage example" }));
  return c;
}

function notesCard(hasRelay: boolean): HTMLElement {
  const c = card({ kicker: "Notes", span: 12 });
  const ul = el("ul", "lx-note-list");
  ul.append(el("li", undefined, "On-device runs automatically — there is nothing to configure for it."));
  const fallbackLi = el("li");
  if (hasRelay) {
    fallbackLi.append(document.createTextNode("Fallback goes through the relay you set up ("));
  } else {
    fallbackLi.append(document.createTextNode("To add API fallback, deploy a relay ("));
  }
  const link = el("a");
  link.href = "#relay";
  link.textContent = "Relay";
  fallbackLi.append(link);
  fallbackLi.append(document.createTextNode(")."));
  ul.append(fallbackLi);
  ul.append(
    el(
      "li",
      undefined,
      "Your provider key never touches Ludion. It stays in your relay; the token in the snippet only authenticates to that relay and is client-side by design.",
    ),
  );
  c.append(ul);
  return c;
}

export function renderQuickstart(ctx: QuickstartContext): HTMLElement {
  const snippet = integrationSnippet(ctx.config, ctx.token);
  const root = el("div");
  root.append(pageHead());
  const grid = el("div", "lx-grid");
  grid.append(dropinCard(snippet));
  grid.append(usageCard(snippet));
  grid.append(notesCard(snippet.hasRelay));
  root.append(grid);
  return root;
}
