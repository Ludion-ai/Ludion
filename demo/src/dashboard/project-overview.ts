/*
 * The Overview screen is the PROJECT aggregate, one view (no scope toggle). It
 * shows the collector's content-free per-project rollup (by projectId), which is
 * the developer's actual data. The local-ledger "this device" view is NOT shown
 * here — in the hosted /app at ludion.ai it would reflect ludion.ai's own local
 * ledger, not the developer's app (a different origin). Its home is the future
 * embeddable dashboard. The local-ledger WRITE path (router sink) is untouched.
 *
 * Four states, cleanly separated:
 *  - loading       → while the collector fetch is in flight;
 *  - data          → renderOverview with the mapped aggregate;
 *  - empty         → 200 with no decisions yet (or telemetry not configured): a
 *                    clean opt-in prompt, NOT an error and NOT a wall of zeros;
 *  - fetch failure → collector unreachable / non-2xx.
 */
import { el } from "./components";
import { overviewPageHead, renderOverview, type OverviewData } from "./overview";
import { isEmptyAggregate, type ProjectAggregate } from "./project";

export const PROJECT_SUBTITLE =
  "Aggregate across all users of this project, from opted-in telemetry. Content is never collected.";

export interface ProjectOverviewOptions {
  /** Fetch the per-project aggregate from the collector. */
  fetch: () => Promise<ProjectAggregate>;
  /** Map a non-empty aggregate to OverviewData (prices Cost saved, etc.). */
  toData: (agg: ProjectAggregate) => OverviewData;
}

/** A full-panel state under the Overview header (loading / empty / error). */
function stateView(body: HTMLElement): HTMLElement {
  const root = el("div");
  root.append(overviewPageHead(PROJECT_SUBTITLE));
  root.append(body);
  return root;
}

function notice(title: string, sub: string, cta?: HTMLElement): HTMLElement {
  const wrap = el("div", "lx-ov-notice");
  wrap.append(el("p", "lx-ov-notice-title", title));
  wrap.append(el("p", "lx-ov-notice-sub", sub));
  if (cta) wrap.append(cta);
  return wrap;
}

function loadingView(): HTMLElement {
  return stateView(
    notice("Loading project aggregate…", "Reading this project's opted-in telemetry from the collector."),
  );
}

function emptyView(): HTMLElement {
  const cta = el("a", "lx-btn lx-btn-primary", "See telemetry setup");
  cta.setAttribute("href", "#quickstart");
  return stateView(
    notice(
      "No project data yet",
      "Enable opt-in telemetry in your app to start collecting routing decisions. Content is never collected — only anonymized metadata.",
      cta,
    ),
  );
}

function errorView(): HTMLElement {
  return stateView(
    notice(
      "Could not load the project aggregate",
      "The collector was unreachable or returned an error. Reload to retry.",
    ),
  );
}

export function renderProjectOverview(opts: ProjectOverviewOptions): HTMLElement {
  const root = el("div");
  const slot = el("div");
  slot.replaceChildren(loadingView());
  root.append(slot);

  opts
    .fetch()
    .then((agg) => {
      slot.replaceChildren(isEmptyAggregate(agg) ? emptyView() : renderOverview(opts.toData(agg)));
    })
    .catch(() => {
      slot.replaceChildren(errorView());
    });

  return root;
}
