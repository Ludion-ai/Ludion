/*
 * Relay section + config assembly (Workspace 2b-2a, Gates 6-C / 6-C-2) — the
 * friction-killer, stripped to the floor. The flow is one-click: a "Deploy to
 * Cloudflare" button stands the relay up in the dev's own account, Cloudflare
 * prompts for the provider key + relay token + upstream + origins, and the dev
 * pastes the Worker URL back. Paste-back self-verifies (§2.1): the workspace
 * probes the relay end to end and reports a precise status. The relay token is
 * auto-minted client-side (§2.4) and lives only in ludion.config.v1 — never sent
 * server-ward. The proven CLI path is kept behind a disclosure.
 */
import { getModel } from "ludion-router/registry";
import { card, copyBlock, el } from "./components";
import type { ScreenContext } from "./models";
import type { ProbeOutcome } from "./setup";
import {
  DEPLOY_BUTTON_URL,
  IMPORT_LINE,
  PLAYGROUND_ORIGIN,
  TEMPLATE_DEFAULT_UPSTREAM,
  WALKTHROUGH_URL,
  allowedOriginsSuggestion,
  assembleDropinConfig,
  deploySteps,
  describeProbe,
  generateRelayToken,
  isProbableWorkerUrl,
  relayBaseUrl,
  relayDeployed,
  relayProviderMismatch,
  toStoredPayload,
  upstreamGuidance,
  upstreamMatchesDefault,
  wranglerVars,
} from "./setup";

export interface RelayContext extends ScreenContext {
  /** The client-only relay token (held in ludion.config.v1). Auto-minted. */
  token: string | null;
  /** Persist a freshly generated token client-side (never sent server-ward). */
  setToken: (token: string) => void;
  /** Provider the relay was set up for (client-only). Drives the §4.2 warning. */
  relayProvider: string | null;
  /** Record the provider at relay-setup time (client-only, never server-ward). */
  setRelayProvider: (provider: string) => void;
  /** The last auto-verify probe result (ephemeral shell state), or null. */
  lastProbe: ProbeOutcome | null;
  /** Run the §2.1 auto-verify probes against a deployed relay. */
  probe: (relayUrl: string, token: string, probeModel: string) => Promise<ProbeOutcome>;
  /** Stash the latest probe result so a re-render keeps the status line. */
  setLastProbe: (outcome: ProbeOutcome | null) => void;
}

/** The provider of the currently selected fallback model, or null. */
function currentProvider(ctx: RelayContext): string | null {
  return getModel(ctx.config?.fallback?.model ?? "")?.provider ?? null;
}

/** The upstream model id the probe should ask the relay to forward. */
function probeModelId(ctx: RelayContext): string {
  const m = getModel(ctx.config?.fallback?.model ?? "");
  return m?.provider_model_id ?? m?.id ?? "";
}

/** Save the relay URL, record the provider, then self-verify end to end (§2.1). */
async function saveAndProbe(ctx: RelayContext, url: string): Promise<void> {
  await ctx.save(toStoredPayload(ctx.config, { relayUrl: url, baseURL: url }));
  const provider = currentProvider(ctx);
  if (provider !== null) ctx.setRelayProvider(provider);
  ctx.setLastProbe(await ctx.probe(url, ctx.token ?? "", probeModelId(ctx)));
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

  // §2.1 — the live connection status from the last auto-verify probe.
  if (ctx.lastProbe) {
    const msg = describeProbe(ctx.lastProbe);
    c.append(el("p", `lx-form-status ${msg.ok ? "lx-form-ok" : "lx-form-error"}`, msg.text));
  }

  // §2.6 — re-run the full on-device→relay probe on demand once deployed.
  if (deployed) {
    const status = el("p", "lx-form-status");
    const test = el("button", "lx-btn lx-btn-ghost", "Test fallback");
    test.type = "button";
    test.addEventListener("click", () => {
      const url = relayBaseUrl(ctx.config);
      if (!url) return;
      status.textContent = "Testing the relay end to end…";
      status.className = "lx-form-status";
      test.disabled = true;
      void (async () => {
        ctx.setLastProbe(await ctx.probe(url, ctx.token ?? "", probeModelId(ctx)));
        ctx.refresh();
      })();
    });
    c.append(test);
    c.append(status);
  }

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

  // §2.5 — tight three-step guide, scannable before the controls.
  c.append(el("p", "lx-form-label", "Three steps"));
  const guide = el("ol", "lx-deploy-steps");
  guide.append(el("li", "lx-deploy-step", "Deploy to Cloudflare (button below)."));
  guide.append(el("li", "lx-deploy-step", "In Cloudflare, enter your provider key and paste the relay token."));
  guide.append(el("li", "lx-deploy-step", "Paste the deployed Worker URL back here — it verifies itself."));
  c.append(guide);

  // §2.5 — reframe the detour as protection, plainly.
  c.append(
    el(
      "p",
      "lx-card-lead",
      "Your provider key is stored in your own Cloudflare and never reaches Ludion's servers. The relay deploys into your account; Cloudflare prompts you for the values below.",
    ),
  );

  const deploy = el("a", "lx-btn lx-btn-primary", "Deploy to Cloudflare");
  deploy.setAttribute("href", DEPLOY_BUTTON_URL);
  deploy.setAttribute("target", "_blank");
  deploy.setAttribute("rel", "noopener noreferrer");
  c.append(deploy);

  // §2.2 — no-account path, conservative copy (post-signup continuation is not
  // doc-confirmed, so we do not promise the exact screen sequence).
  c.append(
    el(
      "p",
      "lx-note",
      "No Cloudflare account? You can sign in or sign up with your GitHub account on the Cloudflare login page. Since the deploy already uses GitHub, you almost certainly have it.",
    ),
  );

  // §2.4 — token is auto-generated by the shell; shown pre-filled, regenerate
  // stays explicit (with the existing break-on-redeploy warning).
  c.append(el("p", "lx-form-label", "Relay token"));
  c.append(copyBlock(ctx.token ?? "", { inline: true, label: "relay token" }));
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

  c.append(el("p", "lx-form-label", "What Cloudflare will ask for"));
  const ul = el("ul", "lx-note-list");
  ul.append(
    el("li", undefined, "PROVIDER_API_KEY — your own provider API key. You enter it into Cloudflare; it never reaches Ludion."),
  );
  ul.append(el("li", undefined, "RELAY_TOKEN — paste the token above."));

  // §2.3 — the template default upstream is OpenAI's. Only tell the dev to
  // change UPSTREAM_BASE_URL when their provider differs from that default.
  const up = upstreamGuidance(model);
  const upLi = el("li");
  if (upstreamMatchesDefault(model)) {
    upLi.append(
      document.createTextNode(
        `UPSTREAM_BASE_URL — already correct for ${model.display_name} (${model.provider}); leave the default (${TEMPLATE_DEFAULT_UPSTREAM}).`,
      ),
    );
  } else if (up.url) {
    upLi.append(document.createTextNode(`UPSTREAM_BASE_URL — change it for ${model.display_name} (${model.provider}) to: `));
    upLi.append(copyBlock(up.url, { inline: true, label: "upstream base URL" }));
    if (up.note) upLi.append(el("span", "lx-deploy-note", up.note));
  } else {
    upLi.append(document.createTextNode(`UPSTREAM_BASE_URL — ${up.note}`));
  }
  ul.append(upLi);

  // §2.3 — origin cannot be known by Ludion. Lead with the dev's OWN origin
  // requirement (without it every browser call dies on CORS); the playground
  // origin only matters when testing from this workspace.
  const orLi = el("li");
  orLi.append(
    document.createTextNode(
      `ALLOWED_ORIGINS — the origins YOUR app calls the relay from. Add your own dev and production origins (e.g. http://localhost:5173 for a Vite dev server), comma-separated, no trailing slash — without your origin, every browser call dies on CORS. The playground (${PLAYGROUND_ORIGIN}) only matters if you also test from here: `,
    ),
  );
  orLi.append(copyBlock(allowedOriginsSuggestion(location.origin), { inline: true, label: "allowed origins" }));
  ul.append(orLi);
  c.append(ul);

  return c;
}

function pasteCard(ctx: RelayContext): HTMLElement {
  const c = card({ kicker: "Paste deploy", span: 12 });
  c.append(
    el(
      "p",
      "lx-card-lead",
      "After the deploy finishes, paste the Worker URL. The workspace points your config at it and verifies it end to end.",
    ),
  );
  const form = el("div", "lx-form-row");
  const input = el("input", "lx-input");
  input.type = "url";
  input.placeholder = "https://ludion-fallback-relay.<account>.workers.dev";
  input.value = ctx.config?.relayUrl ?? "";
  input.setAttribute("aria-label", "Deployed Worker URL");
  const btn = el("button", "lx-btn lx-btn-primary", "Save and verify");
  btn.type = "button";
  const status = el("p", "lx-form-status");

  const save = async (): Promise<void> => {
    const url = input.value.trim();
    // §2.1 — validate the URL shape before saving or probing.
    if (!isProbableWorkerUrl(url)) {
      ctx.setLastProbe({ kind: "invalid_url" });
      status.textContent = "Enter the deployed Worker URL. It must start with https://.";
      status.className = "lx-form-status lx-form-error";
      return;
    }
    status.textContent = "Saving and verifying…";
    status.className = "lx-form-status";
    btn.disabled = true;
    try {
      await saveAndProbe(ctx, url);
      // The probe result renders in statusCard after refresh.
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
  if (!base) missing.push("a deployed relay URL");
  if (!model) missing.push("a fallback model");
  if (!ctx.token) missing.push("a relay token");

  // Until a relay URL exists, do NOT render a config: a lone
  // { fallback: { apiKey } } reads as a leaked provider key sitting in the
  // browser, when it is only the not-yet-usable relay token. Show what's needed.
  if (!base) {
    c.append(
      el(
        "p",
        "lx-card-lead",
        "Your drop-in ludion.config.v1 assembles here once the relay is set up. Deploy a relay and pick a fallback model above; the full config — your relay URL plus your client-side relay token — then appears ready to copy.",
      ),
    );
    c.append(
      el(
        "p",
        "lx-note",
        "The relay token is a low-value, client-visible gate token (not your provider key) — it lives in your browser config by design and only authenticates to your relay.",
      ),
    );
    c.append(el("p", "lx-note", `Still needed for a working setup: ${missing.join(", ")}.`));
    c.append(el("p", "lx-form-label", "One import line"));
    c.append(copyBlock(IMPORT_LINE, { inline: true, label: "import line" }));
    return c;
  }

  const assembled = assembleDropinConfig(ctx.config, ctx.token);
  c.append(
    el(
      "p",
      "lx-card-lead",
      "Your client ludion.config.v1. The apiKey field holds your relay token — a low-value, client-visible token that only authenticates to your relay. Your provider key is NOT here; it stays in the Worker secret.",
    ),
  );
  c.append(copyBlock(JSON.stringify(assembled, null, 2), { label: "config" }));
  c.append(el("p", "lx-form-label", "One import line"));
  c.append(copyBlock(IMPORT_LINE, { inline: true, label: "import line" }));
  // §5 — clarify the two config paths so an external app doesn't try to "drop in"
  // a config it can never read. This JSON is the workspace-origin localStorage
  // path; integrating your own app passes the values as constructor args in code.
  const routeNote = el("p", "lx-note");
  routeNote.append(
    document.createTextNode(
      "This ludion.config.v1 is read from this workspace's browser storage (the ludion.ai origin). Your own app runs on a different origin and can't read it — pass these values directly in code instead: new OpenAI({ baseURL: <relay>, apiKey: <relay token> }). Full walkthrough: ",
    ),
  );
  const routeLink = el("a");
  routeLink.href = WALKTHROUGH_URL;
  routeLink.target = "_blank";
  routeLink.rel = "noopener noreferrer";
  routeLink.textContent = "Integrate into your own app";
  routeNote.append(routeLink);
  routeNote.append(document.createTextNode("."));
  c.append(routeNote);
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
