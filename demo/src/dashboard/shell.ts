/*
 * The dashboard shell (Workspace 2b-1): top bar, left nav, the hash router and
 * its outlet, and the auth-gated mount. Only Overview is a real screen; the
 * other sections render in-system stub placeholders that 2b-2 fills. The shell
 * is built so 2b-2 drops sections into SECTIONS + the router with no rework.
 */
import type { StoredConfig } from "ludion-workspace/schema";
import { PRESET_PRICING, PricingStore } from "ludion-router/savings";
import { el, hexMark, icon } from "./components";
import {
  DOGFOOD_PROJECT,
  fetchProjectAggregate,
  probeRelay,
  putConfig,
  readRelaySetupProvider,
  readRelayToken,
  syncDropinConfig,
  writeRelaySetupProvider,
  type Identity,
} from "./data";
import { generateRelayToken, relayDeployed, type ProbeOutcome } from "./setup";
import { projectOverviewData } from "./project";
import { PROJECT_SUBTITLE, renderProjectOverview } from "./project-overview";
import { renderModels } from "./models";
import { renderRelay } from "./relay";
import { renderQuickstart } from "./quickstart";

interface NavSection {
  id: string;
  label: string;
}

const SECTIONS: NavSection[] = [
  { id: "quickstart", label: "Quickstart" },
  { id: "overview", label: "Overview" },
  { id: "routing", label: "Routing" },
  { id: "models", label: "Models" },
  { id: "relay", label: "Relay" },
  { id: "decisions", label: "Decisions" },
  { id: "savings", label: "Savings" },
  { id: "devices", label: "Devices" },
  { id: "settings", label: "Settings" },
];

/** What each not-yet-built section says (2b-2b replaces these). */
const STUB_COPY: Record<string, string> = {
  routing: "The routing table and per-rule breakdown land here in 2b-2b.",
  decisions: "The full decision-log explorer arrives in 2b-2b.",
  savings: "The savings deep-dive (reskinned to this system) arrives in 2b-2.",
  devices: "Per-device capability and routing arrive in 2b-2.",
  settings: "Workspace settings and config editing arrive in 2b-2.",
};

export interface ShellOptions {
  root: HTMLElement;
  identity: Identity;
  config: StoredConfig | null;
}

function initials(login: string): string {
  return login.slice(0, 2).toUpperCase() || "?";
}

function currentSection(fallbackId: string): string {
  const h = location.hash.replace(/^#/, "");
  return SECTIONS.some((s) => s.id === h) ? h : fallbackId;
}

/**
 * Log out via the existing same-origin `POST /auth/logout` (Pages adapter →
 * ludion-workspace handler). The backend clears the httpOnly session cookie
 * (Max-Age=0) and 302-redirects to `/`; fetch follows that redirect, so the
 * cookie is cleared by the time this resolves. We then navigate to `/` to land
 * on the public page logged out. Throws on a failed request so the caller can
 * surface it without faking success.
 */
async function postLogout(): Promise<void> {
  const res = await fetch("/auth/logout", { method: "POST" });
  if (!res.ok && !res.redirected) throw new Error(`logout ${res.status}`);
}

function topbar(identity: Identity): HTMLElement {
  const bar = el("header", "lx-topbar");

  const brand = el("div", "lx-brand");
  brand.append(hexMark());
  brand.append(el("span", "lx-brand-word", "Ludion"));
  bar.append(brand);

  const search = el("div", "lx-search");
  search.append(icon("search", "lx-ic"));
  const input = el("input");
  input.type = "search";
  input.placeholder = "Search";
  input.setAttribute("aria-label", "Search (coming soon)");
  search.append(input);
  bar.append(search);

  const right = el("div", "lx-topbar-right");
  const env = el("span", "lx-env", "Production");
  env.setAttribute("aria-disabled", "true");
  right.append(env);

  // Account menu: the avatar triggers a tiny popover whose only action is logout
  // (wired to the existing endpoint). Kept minimal — not a full account menu.
  const account = el("div", "lx-account");
  const avatar = el("button", "lx-avatar", initials(identity.login));
  avatar.type = "button";
  avatar.title = identity.login;
  avatar.setAttribute("aria-label", `Account: ${identity.login}`);
  avatar.setAttribute("aria-haspopup", "menu");
  avatar.setAttribute("aria-expanded", "false");

  const menu = el("div", "lx-account-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  menu.append(el("p", "lx-account-who", identity.login));
  const logoutBtn = el("button", "lx-account-item", "Log out");
  logoutBtn.type = "button";
  logoutBtn.setAttribute("role", "menuitem");
  const err = el("p", "lx-account-error");
  err.hidden = true;
  menu.append(logoutBtn, err);

  const setOpen = (open: boolean): void => {
    menu.hidden = !open;
    avatar.setAttribute("aria-expanded", String(open));
  };
  avatar.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  logoutBtn.addEventListener("click", () => {
    logoutBtn.disabled = true;
    err.hidden = true;
    void (async () => {
      try {
        await postLogout();
        window.location.assign("/");
      } catch {
        // Keep the user where they are; surface the failure, allow a retry.
        err.textContent = "Logout failed. Try again.";
        err.hidden = false;
        logoutBtn.disabled = false;
      }
    })();
  });

  account.append(avatar, menu);
  right.append(account);
  bar.append(right);

  return bar;
}

function sidebar(onNavigate: () => void): { aside: HTMLElement; setActive: (id: string) => void } {
  const aside = el("aside", "lx-sidebar");
  const nav = el("nav", "lx-nav");
  nav.setAttribute("aria-label", "Sections");
  const items = new Map<string, HTMLAnchorElement>();
  for (const section of SECTIONS) {
    const a = el("a", "lx-nav-item");
    a.href = `#${section.id}`;
    a.append(icon(section.id));
    a.append(el("span", undefined, section.label));
    a.addEventListener("click", () => onNavigate());
    items.set(section.id, a);
    nav.append(a);
  }
  aside.append(nav);
  aside.append(el("div", "lx-nav-spacer"));

  const ws = el("div", "lx-ws");
  ws.append(el("span", "lx-ws-badge", "L"));
  ws.append(el("span", undefined, "Workspace"));
  aside.append(ws);

  const setActive = (id: string): void => {
    for (const [key, a] of items) a.classList.toggle("is-active", key === id);
  };
  return { aside, setActive };
}

function renderStub(id: string, label: string): HTMLElement {
  const wrap = el("div", "lx-stub");
  wrap.append(el("p", "lx-stub-title", label));
  wrap.append(el("p", "lx-stub-sub", STUB_COPY[id] ?? "Coming soon."));
  return wrap;
}

export function mountShell(opts: ShellOptions): void {
  const app = el("div", "lx-app");
  app.append(topbar(opts.identity));

  const body = el("div", "lx-body");
  const outlet = el("main", "lx-outlet");
  outlet.id = "lx-outlet";

  const { aside, setActive } = sidebar(() => {
    /* hashchange drives the render; nothing to do on click itself. */
  });
  body.append(aside);
  body.append(outlet);
  app.append(body);

  opts.root.replaceChildren(app);

  // Mutable setup state: config is re-read from the server on each successful
  // write; the relay token is client-only (held in ludion.config.v1).
  let config = opts.config;
  let token = readRelayToken();
  let relayProvider = readRelaySetupProvider();
  // Ephemeral: the last auto-verify probe result, so a re-render (which the save
  // path triggers) keeps the inline "Relay connected" / error line visible.
  let lastProbe: ProbeOutcome | null = null;

  // Persist a non-secret config and mirror the assembled client config (with the
  // client-only token) into localStorage. The token never enters this PUT.
  const save = async (next: StoredConfig): Promise<StoredConfig> => {
    config = await putConfig(next);
    syncDropinConfig(config, token);
    return config;
  };
  const setToken = (next: string): void => {
    token = next;
    syncDropinConfig(config, token);
  };
  // Client-only: record the provider the relay was set up for so a later
  // fallback switch can warn (§4.2). Never enters the server PUT.
  const setRelayProvider = (next: string): void => {
    relayProvider = next;
    writeRelaySetupProvider(next);
  };
  const setLastProbe = (next: ProbeOutcome | null): void => {
    lastProbe = next;
  };

  const render = (): void => {
    // A dev who has not set up a relay lands on Quickstart (the integration
    // path they need first); once a relay exists, Overview is the default.
    const id = currentSection(relayDeployed(config) ? "overview" : "quickstart");
    setActive(id);
    if (id === "quickstart") {
      outlet.replaceChildren(renderQuickstart({ config, token }));
    } else if (id === "overview") {
      // Overview is the project aggregate, one view: the collector's content-free
      // per-project rollup (the developer's data), priced with the same basis the
      // local view uses. The local-ledger "this device" view is not shown here.
      outlet.replaceChildren(
        renderProjectOverview({
          fetch: () => fetchProjectAggregate(DOGFOOD_PROJECT.collectorUrl, DOGFOOD_PROJECT.projectId),
          toData: (agg) =>
            projectOverviewData(
              agg,
              new PricingStore().resolveBasis(PRESET_PRICING),
              config,
              PROJECT_SUBTITLE,
            ),
        }),
      );
    } else if (id === "models") {
      outlet.replaceChildren(renderModels({ config, save, refresh: render }));
    } else if (id === "relay") {
      // §2.4 — auto-generate the relay token on first relay render so it is
      // pre-filled with no discrete "Generate" click. Regenerate stays explicit.
      if (token === null) setToken(generateRelayToken());
      outlet.replaceChildren(
        renderRelay({
          config,
          token,
          relayProvider,
          lastProbe,
          save,
          setToken,
          setRelayProvider,
          probe: probeRelay,
          setLastProbe,
          refresh: render,
        }),
      );
    } else {
      const label = SECTIONS.find((s) => s.id === id)?.label ?? id;
      outlet.replaceChildren(renderStub(id, label));
    }
    outlet.scrollTo?.(0, 0);
  };

  window.addEventListener("hashchange", render);
  render();
}
