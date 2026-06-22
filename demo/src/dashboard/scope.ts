/*
 * The Overview scope toggle (Workspace): switch the EXISTING Overview cards
 * between two alternative views — "This device" (the local SavingsLedger) and
 * "Project" (the central collector's content-free per-project aggregate). The
 * two are alternative views, never summed: they are different scopes (this
 * device vs all users of the project).
 *
 * This owns a small piece of view state (the selected scope) outside the hash
 * router and re-renders only the Overview outlet content. The "Project" view is
 * async (a collector fetch), so it shows a loading state then swaps in the cards;
 * a stale fetch (the user toggled away and back) is ignored via a request token.
 */
import { el } from "./components";
import { renderOverview, type OverviewData } from "./overview";

export type Scope = "device" | "project";

const PROJECT_SUBTITLE =
  "Aggregate across all users of this project, from opted-in telemetry. Content is never collected.";

export interface ScopedOverviewOptions {
  /** Build the this-device OverviewData (local ledger). Synchronous. */
  readLocal: () => OverviewData;
  /** Fetch + map the project-scope OverviewData (collector aggregate). Async. */
  fetchProject: () => Promise<OverviewData>;
}

function notice(title: string, sub: string): HTMLElement {
  const wrap = el("div", "lx-scope-notice");
  wrap.append(el("p", "lx-scope-notice-title", title));
  wrap.append(el("p", "lx-scope-notice-sub", sub));
  return wrap;
}

export function renderOverviewScoped(opts: ScopedOverviewOptions): HTMLElement {
  const root = el("div", "lx-scoped");
  let scope: Scope = "device";
  let fetchToken = 0;

  const buttons = new Map<Scope, HTMLButtonElement>();
  const bar = el("div", "lx-scope");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Data scope");
  bar.append(el("span", "lx-scope-label", "Scope"));
  for (const [s, label] of [
    ["device", "This device"],
    ["project", "Project"],
  ] as const) {
    const b = el("button", "lx-scope-btn", label);
    b.type = "button";
    b.addEventListener("click", () => select(s));
    buttons.set(s, b);
    bar.append(b);
  }

  const slot = el("div", "lx-scope-slot");

  const setActive = (): void => {
    for (const [s, b] of buttons) {
      const on = s === scope;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };

  const fillDevice = (): void => {
    slot.replaceChildren(renderOverview(opts.readLocal()));
  };

  const fillProject = (): void => {
    slot.replaceChildren(
      notice("Loading project aggregate…", "Reading this project's opted-in telemetry from the collector."),
    );
    const mine = ++fetchToken;
    opts
      .fetchProject()
      .then((data) => {
        if (mine !== fetchToken) return; // a later toggle superseded this fetch
        slot.replaceChildren(renderOverview(data));
      })
      .catch(() => {
        if (mine !== fetchToken) return;
        slot.replaceChildren(
          notice(
            "Could not load the project aggregate",
            "The collector was unreachable or returned an error. Switch back to This device, or retry.",
          ),
        );
      });
  };

  function select(next: Scope): void {
    if (next === scope) return;
    scope = next;
    setActive();
    if (scope === "device") fillDevice();
    else fillProject();
  }

  setActive();
  fillDevice();
  root.append(bar, slot);
  return root;
}

export { PROJECT_SUBTITLE };
