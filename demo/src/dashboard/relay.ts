/*
 * Relay section + config assembly (Workspace 2b-2a) — the friction-killer.
 * Status derives from config.relayUrl. Generate fills the canonical Worker's
 * wrangler [vars] with the chosen provider upstream + this origin, lists the
 * deploy steps, and mints a client-only RELAY_TOKEN. Paste-deploy: the dev
 * deploys to their own Cloudflare account, pastes the Worker URL, and the
 * workspace writes relayUrl + fallback.baseURL (=relay) to 2a config. The
 * assembled client `ludion.config.v1` then carries the token client-side only.
 */
import { getModel } from "ludion-router/registry";
import { card, copyBlock, el } from "./components";
import type { ScreenContext } from "./models";
import {
  IMPORT_LINE,
  assembleDropinConfig,
  deploySteps,
  generateRelayToken,
  relayBaseUrl,
  relayDeployed,
  toStoredPayload,
  upstreamFor,
  wranglerVars,
} from "./setup";

export interface RelayContext extends ScreenContext {
  /** The client-only relay token (held in ludion.config.v1), or null. */
  token: string | null;
  /** Persist a freshly generated token client-side (never sent server-ward). */
  setToken: (token: string) => void;
}

function pageHead(): HTMLElement {
  const head = el("div", "lx-page-head");
  const left = el("div");
  left.append(el("h1", "lx-page-title", "Relay"));
  left.append(
    el("p", "lx-page-sub", "Keep your provider key server-side. Deploy a relay, paste its URL, drop in the config."),
  );
  head.append(left);
  return head;
}

function statusCard(ctx: RelayContext): HTMLElement {
  const c = card({ kicker: "Status", span: 12 });
  const deployed = relayDeployed(ctx.config);
  const row = el("div", "lx-status-row");
  row.append(el("span", `lx-pill ${deployed ? "lx-pill-active" : ""}`, deployed ? "Deployed" : "Not deployed"));
  if (deployed) {
    row.append(el("span", "lx-mono lx-status-url", relayBaseUrl(ctx.config) ?? ""));
  } else {
    row.append(el("span", "lx-card-lead", "No relay yet. Generate one below, deploy it, then paste its URL."));
  }
  c.append(row);
  return c;
}

function generateCard(ctx: RelayContext): HTMLElement {
  const c = card({ kicker: "Generate relay", span: 12 });
  const model = getModel(ctx.config?.fallback?.model ?? "");
  if (!model) {
    c.append(
      el("p", "lx-card-lead", "Pick a fallback model first — its provider sets the relay's upstream endpoint."),
    );
    const link = el("a", "lx-btn lx-btn-ghost", "Go to Models");
    link.setAttribute("href", "#models");
    c.append(link);
    return c;
  }
  const upstream = upstreamFor(model);
  if (!upstream) {
    c.append(el("p", "lx-form-status lx-form-error", `No known OpenAI-compatible upstream for provider "${model.provider}".`));
    return c;
  }

  c.append(
    el(
      "p",
      "lx-card-lead",
      `Upstream for ${model.display_name} (${model.provider}). Deploy the canonical Worker at relays/cloudflare-worker/ with these values.`,
    ),
  );
  if (!upstream.verified) {
    c.append(
      el(
        "p",
        "lx-note",
        "Confirm this upstream: point UPSTREAM_BASE_URL at the provider's OpenAI-compatible endpoint, not its native API.",
      ),
    );
  }

  c.append(el("p", "lx-form-label", "1. Paste into wrangler.toml"));
  c.append(copyBlock(wranglerVars(upstream.url, location.origin), { label: "wrangler vars" }));

  c.append(el("p", "lx-form-label", "2. Deploy from relays/cloudflare-worker/"));
  const steps = el("ol", "lx-deploy-steps");
  for (const s of deploySteps()) {
    const li = el("li", "lx-deploy-step");
    li.append(copyBlock(s.cmd, { inline: true, label: "command" }));
    li.append(el("span", "lx-deploy-note", s.note));
    steps.append(li);
  }
  c.append(steps);

  c.append(el("p", "lx-form-label", "3. Relay token (client-side only)"));
  if (ctx.token) {
    c.append(copyBlock(ctx.token, { inline: true, label: "relay token" }));
    c.append(
      el("p", "lx-note", "Set this as the RELAY_TOKEN secret above. It lives in your browser config only — never sent to Ludion."),
    );
    const regen = el("button", "lx-btn lx-btn-ghost", "Regenerate token");
    regen.type = "button";
    regen.addEventListener("click", () => {
      ctx.setToken(generateRelayToken());
      ctx.refresh();
    });
    c.append(regen);
  } else {
    const gen = el("button", "lx-btn lx-btn-primary", "Generate token");
    gen.type = "button";
    gen.addEventListener("click", () => {
      ctx.setToken(generateRelayToken());
      ctx.refresh();
    });
    c.append(gen);
  }
  return c;
}

function pasteCard(ctx: RelayContext): HTMLElement {
  const c = card({ kicker: "Paste deploy", span: 12 });
  c.append(el("p", "lx-card-lead", "After wrangler deploy, paste the Worker URL. The workspace points your config at it."));
  const form = el("div", "lx-form-row");
  const input = el("input", "lx-input");
  input.type = "url";
  input.placeholder = "https://ludion-fallback-relay.<account>.workers.dev";
  input.value = ctx.config?.relayUrl ?? "";
  input.setAttribute("aria-label", "Deployed Worker URL");
  const btn = el("button", "lx-btn lx-btn-primary", "Save relay URL");
  btn.type = "button";
  const status = el("p", "lx-form-status");

  const save = async (): Promise<void> => {
    const url = input.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      status.textContent = "Enter an http(s) URL.";
      status.className = "lx-form-status lx-form-error";
      return;
    }
    status.textContent = "Saving…";
    status.className = "lx-form-status";
    btn.disabled = true;
    try {
      await ctx.save(toStoredPayload(ctx.config, { relayUrl: url, baseURL: url }));
      ctx.refresh();
    } catch (e) {
      status.textContent = `Could not save: ${e instanceof Error ? e.message : String(e)}`;
      status.className = "lx-form-status lx-form-error";
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", () => void save());

  form.append(input, btn);
  c.append(form);
  c.append(status);
  return c;
}

function securityCard(): HTMLElement {
  const c = card({ kicker: "What the relay protects", span: 12 });
  const ul = el("ul", "lx-note-list");
  ul.append(
    el(
      "li",
      undefined,
      "Your provider key stays in the Worker secret and never reaches the browser. That is the real win: a leaked provider key grants full account access, and the relay puts it out of reach.",
    ),
  );
  ul.append(
    el(
      "li",
      undefined,
      "The relay token is client-visible (view-source, network tab). It only lets someone spend through your relay, and is rotatable. CORS does not stop a non-browser caller.",
    ),
  );
  ul.append(
    el(
      "li",
      undefined,
      "For production add a rate limit and/or your own per-user auth in front of the relay. Treat the token as a low-value gate, not custody.",
    ),
  );
  c.append(ul);
  return c;
}

function assemblyCard(ctx: RelayContext): HTMLElement {
  const c = card({ kicker: "Drop-in config", span: 12 });
  const model = ctx.config?.fallback?.model;
  const base = relayBaseUrl(ctx.config);
  const missing: string[] = [];
  if (!model) missing.push("a fallback model");
  if (!base) missing.push("a deployed relay URL");
  if (!ctx.token) missing.push("a relay token");

  const assembled = assembleDropinConfig(ctx.config, ctx.token);
  c.append(el("p", "lx-card-lead", "Your client ludion.config.v1 — server fields plus the client-only token. The token lives here, never on a Ludion server."));
  c.append(copyBlock(JSON.stringify(assembled, null, 2), { label: "config" }));
  c.append(el("p", "lx-form-label", "One import line"));
  c.append(copyBlock(IMPORT_LINE, { inline: true, label: "import line" }));
  if (missing.length > 0) {
    c.append(el("p", "lx-note", `Still needed for a working setup: ${missing.join(", ")}.`));
  } else {
    c.append(el("p", "lx-note", "Complete — drop this config in and change your import line to start routing."));
  }
  return c;
}

export function renderRelay(ctx: RelayContext): HTMLElement {
  const root = el("div");
  root.append(pageHead());
  const grid = el("div", "lx-grid");
  grid.append(statusCard(ctx));
  grid.append(generateCard(ctx));
  grid.append(pasteCard(ctx));
  grid.append(securityCard());
  grid.append(assemblyCard(ctx));
  root.append(grid);
  return root;
}
