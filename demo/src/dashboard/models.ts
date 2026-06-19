/*
 * Models section (Workspace 2b-2a). Lists the registry — verified fallback (api)
 * models the developer can select, unverified api models held back, and the
 * on-device (local) models shown read-only. Selecting a fallback writes only
 * `fallback.model` to 2a config via PUT /api/config (the §0 ruling: the relay
 * URL becomes `fallback.baseURL` later, at paste-deploy; a provider baseURL is
 * never written client-side). Built from the 2b-1 design system.
 */
import type { ModelEntry } from "ludion-router/registry";
import type { StoredConfig } from "ludion-workspace/schema";
import { badge, card, el } from "./components";
import { fallbackModels, toStoredPayload } from "./setup";

export interface ScreenContext {
  config: StoredConfig | null;
  /** Persist the payload (PUT /api/config). Resolves to the stored shape, throws on failure. */
  save: (next: StoredConfig) => Promise<StoredConfig>;
  /** Re-render the active section (after a successful commit). */
  refresh: () => void;
}

function pageHead(): HTMLElement {
  const head = el("div", "lx-page-head");
  const left = el("div");
  left.append(el("h1", "lx-page-title", "Models"));
  left.append(
    el("p", "lx-page-sub", "Pick the fallback model your endpoint serves. On-device models route automatically."),
  );
  head.append(left);
  return head;
}

function fmtContext(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K context` : `${tokens} context`;
}

function modelRow(
  m: ModelEntry,
  opts: { selected: boolean; onSelect?: () => void; held?: boolean; readonly?: boolean },
): HTMLElement {
  const row = el("div", "lx-model-row lx-setup-row");
  const meta = el("div", "lx-model-meta");
  const name = el("div", "lx-model-name", m.display_name);
  meta.append(name);
  const facts = el("div", "lx-model-facts");
  facts.append(el("span", "lx-fact", m.provider));
  if (m.kind === "api" && m.provider_model_id) facts.append(el("span", "lx-fact lx-mono", m.provider_model_id));
  if (m.kind === "local" && m.params) facts.append(el("span", "lx-fact", m.params));
  facts.append(el("span", "lx-fact", fmtContext(m.context_length)));
  if (m.kind === "local" && m.min_memory_hint_mb) {
    facts.append(el("span", "lx-fact", `~${m.min_memory_hint_mb} MB`));
  }
  meta.append(facts);
  row.append(meta);

  const right = el("div", "lx-setup-right");
  if (m.kind === "api") {
    right.append(badge(m.provider_model_id_verified ? "verified" : "unverified"));
  } else {
    right.append(badge("on-device"));
  }
  if (opts.selected) {
    right.append(el("span", "lx-pill lx-pill-active", "Selected"));
  } else if (opts.held) {
    right.append(el("span", "lx-pill", "Withheld"));
  } else if (opts.readonly) {
    right.append(el("span", "lx-pill", "Auto"));
  } else if (opts.onSelect) {
    const btn = el("button", "lx-btn lx-btn-ghost", "Select");
    btn.type = "button";
    btn.addEventListener("click", opts.onSelect);
    right.append(btn);
  }
  row.append(right);
  return row;
}

export function renderModels(ctx: ScreenContext): HTMLElement {
  const root = el("div");
  root.append(pageHead());
  const grid = el("div", "lx-grid");

  const { selectable, unverified, local } = fallbackModels();
  const current = ctx.config?.fallback?.model;

  // --- Fallback (api) models -------------------------------------------------
  const fb = card({ kicker: "Fallback models", span: 12 });
  fb.append(el("p", "lx-card-lead", "The model server-routed requests degrade to. Selecting one writes it to your config."));
  const status = el("p", "lx-form-status");
  fb.append(status);
  const list = el("div", "lx-setup-list");

  const select = async (m: ModelEntry, btn?: HTMLButtonElement): Promise<void> => {
    status.textContent = `Saving ${m.display_name}…`;
    status.className = "lx-form-status";
    if (btn) btn.disabled = true;
    try {
      await ctx.save(toStoredPayload(ctx.config, { model: m.id }));
      ctx.refresh();
    } catch (e) {
      status.textContent = `Could not save: ${e instanceof Error ? e.message : String(e)}`;
      status.className = "lx-form-status lx-form-error";
      if (btn) btn.disabled = false;
    }
  };

  for (const m of selectable) {
    const selected = m.id === current;
    const row = modelRow(m, {
      selected,
      onSelect: selected ? undefined : () => void select(m, row.querySelector("button") as HTMLButtonElement | undefined),
    });
    list.append(row);
  }
  for (const m of unverified) {
    list.append(modelRow(m, { selected: false, held: true }));
  }
  fb.append(list);
  if (current) {
    fb.append(el("p", "lx-card-foot", `Current fallback: ${current}`));
  }
  grid.append(fb);

  // --- On-device (local) models ---------------------------------------------
  const od = card({ kicker: "On-device models", span: 12 });
  od.append(
    el("p", "lx-card-lead", "Run in the browser via WebGPU when a request is eligible. Preferring one is configured later."),
  );
  const odList = el("div", "lx-setup-list");
  for (const m of local) odList.append(modelRow(m, { selected: false, readonly: true }));
  od.append(odList);
  grid.append(od);

  root.append(grid);
  return root;
}
