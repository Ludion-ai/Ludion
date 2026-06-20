/*
 * Relay section + config assembly (Workspace 2b-2a, Gate 6-C) — the
 * friction-killer. The primary flow is now one-click: a "Deploy to Cloudflare"
 * button stands the relay up in the dev's own account, Cloudflare prompts for the
 * provider key + relay token + upstream + origins, and the dev pastes the Worker
 * URL back. Status derives from config.relayUrl. The relay token is minted
 * client-side and lives only in ludion.config.v1 — never sent server-ward. The
 * proven CLI path is kept behind a disclosure. Paste-deploy writes relayUrl +
 * fallback.baseURL (=relay) to 2a config.
 */
import { getModel } from "ludion-router/registry";
import { card, copyBlock, el } from "./components";
import type { ScreenContext } from "./models";
import {
  DEPLOY_BUTTON_URL,
  IMPORT_LINE,
  allowedOriginsSuggestion,
  assembleDropinConfig,
  deploySteps,
  generateRelayToken,
  relayBaseUrl,
  relayDeployed,
  relayProviderMismatch,
  toStoredPayload,
  upstreamGuidance,
  wranglerVars,
} from "./setup";

export interface RelayContext extends ScreenContext {
  /** The client-only relay token (held in ludion.config.v1), or null. */
  token: string | null;
  /** Persist a freshly generated token client-side (never sent server-ward). */
  setToken: (token: string) => void;
  /** Provider the relay was set up for (client-only). Drives the §4.2 warning. */
  relayProvider: string | null;
  /** Record the provider at relay-setup time (client-only, never server-ward). */
  setRelayProvider: (provider: string) => void;
}

/** The provider of the currently selected fallback model, or null. */
function currentProvider(ctx: RelayContext): string | null {
  return getModel(ctx.config?.fallback?.model ?? "")?.provider ?? null;
}

function pageHead(): HTMLElement {
  const head = el("div", "lx-page-head");
  const left = el("div");
  left.append(el("h1", "lx-page-title", "Relay"));
  left.append(
    el(
      "p",
      "lx-page-sub",
      "Keep your provider key server-side. Deploy a relay in one click, paste its URL, drop in the config.",
    ),
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
    row.append(el("span", "lx-card-lead", "No relay yet. Deploy one below, then paste its URL."));
  }
  c.append(row);

  // §4.2 — non-blocking warning when the fallback provider drifted from the one
  // the relay was set up for. The relay's UPSTREAM_BASE_URL is now stale.
  if (deployed && relayProviderMismatch(ctx.relayProvider, currentProvider(ctx))) {
    c.append(
      el(
        "p",
        "lx-form-status lx-form-error",
        `Your fallback provider changed (relay set up for ${ctx.relayProvider}, now ${currentProvider(ctx)}). Redeploy the relay or update its UPSTREAM_BASE_URL, or the fallback will fail silently.`,
      ),
    );
  }
  return c;
}

function deployCard(ctx: RelayContext): HTMLElement {
  const c = card({ kicker: "Deploy relay", span: 12 });
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

  c.append(
    el(
      "p",
      "lx-card-lead",
      "Click Deploy to Cloudflare. The relay deploys into your own account, and Cloudflare prompts you for the values below. Your provider key goes into Cloudflare, never to Ludion.",
    ),
  );

  const deploy = el("a", "lx-btn lx-btn-primary", "Deploy to Cloudflare");
  deploy.setAttribute("href", DEPLOY_BUTTON_URL);
  deploy.setAttribute("target", "_blank");
  deploy.setAttribute("rel", "noopener noreferrer");
  c.append(deploy);

  c.append(el("p", "lx-form-label", "Relay token"));
  if (ctx.token) {
    c.append(copyBlock(ctx.token, { inline: true, label: "relay token" }));
    c.append(
      el(
        "p",
        "lx-note",
        "Paste this as RELAY_TOKEN in the deploy prompt. It must match exactly, or the relay returns 401 and the fallback fails silently. It lives in your browser config only — never sent to Ludion.",
      ),
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

  c.append(el("p", "lx-form-label", "What Cloudflare will ask for"));
  const ul = el("ul", "lx-note-list");
  ul.append(
    el("li", undefined, "PROVIDER_API_KEY — your own provider API key. You enter it into Cloudflare; it never reaches Ludion."),
  );
  ul.append(el("li", undefined, "RELAY_TOKEN — paste the token above."));

  const up = upstreamGuidance(model);
  const upLi = el("li");
  if (up.url) {
    upLi.append(document.createTextNode(`UPSTREAM_BASE_URL — for ${model.display_name} (${model.provider}): `));
    upLi.append(copyBlock(up.url, { inline: true, label: "upstream base URL" }));
    if (up.note) upLi.append(el("span", "lx-deploy-note", up.note));
  } else {
    upLi.append(document.createTextNode(`UPSTREAM_BASE_URL — ${up.note}`));
  }
  ul.append(upLi);

  const orLi = el("li");
  orLi.append(document.createTextNode("ALLOWED_ORIGINS — your app's origin. To test from this playground too: "));
  orLi.append(copyBlock(allowedOriginsSuggestion(location.origin), { inline: true, label: "allowed origins" }));
  ul.append(orLi);
  c.append(ul);

  return c;
}

function pasteCard(ctx: RelayContext): HTMLElement {
  const c = card({ kicker: "Paste deploy", span: 12 });
  c.append(
    el("p", "lx-card-lead", "After the deploy finishes, paste the Worker URL. The workspace points your config at it."),
  );
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
      // Record the provider this relay was set up for (§4.2), client-side only.
      const provider = currentProvider(ctx);
      if (provider !== null) ctx.setRelayProvider(provider);
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
      "The template ships rate limiting on by default. For production add your own per-user auth in front of the relay. Treat the token as a low-value gate, not custody.",
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
  c.append(
    el(
      "p",
      "lx-card-lead",
      "Your client ludion.config.v1 — server fields plus the client-only token. The token lives here, never on a Ludion server.",
    ),
  );
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

function cliCard(ctx: RelayContext): HTMLElement {
  const c = card({ kicker: "Prefer the CLI?", span: 12 });
  const details = el("details", "lx-details");
  const summary = document.createElement("summary");
  summary.className = "lx-summary";
  summary.textContent = "Deploy from a terminal instead";
  details.append(summary);

  const model = getModel(ctx.config?.fallback?.model ?? "");
  const upstreamUrl = (model ? upstreamGuidance(model).url : null) ?? "https://your-provider.example/v1";

  details.append(el("p", "lx-form-label", "1. Paste into wrangler.toml"));
  details.append(copyBlock(wranglerVars(upstreamUrl, location.origin), { label: "wrangler vars" }));

  details.append(el("p", "lx-form-label", "2. Deploy from the relay template repo"));
  const steps = el("ol", "lx-deploy-steps");
  for (const s of deploySteps()) {
    const li = el("li", "lx-deploy-step");
    li.append(copyBlock(s.cmd, { inline: true, label: "command" }));
    li.append(el("span", "lx-deploy-note", s.note));
    steps.append(li);
  }
  details.append(steps);
  c.append(details);
  return c;
}

export function renderRelay(ctx: RelayContext): HTMLElement {
  const root = el("div");
  root.append(pageHead());
  const grid = el("div", "lx-grid");
  grid.append(statusCard(ctx));
  grid.append(deployCard(ctx));
  grid.append(pasteCard(ctx));
  grid.append(securityCard());
  grid.append(assemblyCard(ctx));
  grid.append(cliCard(ctx));
  root.append(grid);
  return root;
}
