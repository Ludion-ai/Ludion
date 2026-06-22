/**
 * Read-only policy reconciliation audit (Step 1).
 *
 * Reconciles the bundled routing policy (router/src/policy.v0.json — the single
 * source) against the measured device outcomes archived in bench/results/. It
 * reads results, derives the observed (device_class x model x prompt x
 * cache_state) -> outcome matrix, computes what policy.v0 currently decides for
 * each observed context, and emits a four-section GAP REPORT. It NEVER edits the
 * policy or any code path; the CLI (bench/scripts/policy-audit.ts) only reads
 * results and prints markdown.
 *
 * Reuse, not reinvention:
 *  - device classifiers: classifyEnv / classifyOsClass are imported from
 *    bench/src/compare.ts, themselves a cited verbatim copy of the canonical
 *    shared/src/probe.ts:62-76 (bench is deliberately independent of
 *    @ludion/shared — compare.ts:4-10). So os_class here is the SAME logic the
 *    router runs at decision time.
 *  - policy: evaluated against router/src/policy.v0.json directly (no fork). The
 *    matcher mirrors evaluatePolicy (router/src/policy.ts:88-133), base path
 *    only — privacy and strike overrides are runtime state, not policy-table
 *    coverage, so they are out of scope for a static reconciliation.
 *
 * Honest coarseness (the matrix can ONLY generalize to these axes):
 *  - device_class has 5 values (4 os_class + webview-iab). Results carry no
 *    finer routable identity: DeviceInfo (schema.ts:54-62) has `ua` but no
 *    `platform`/`maxTouchPoints`, so os_class here is UA-only — a strict subset
 *    of the runtime derivation, which also reads navigator.platform/
 *    maxTouchPoints for the iPadOS-as-desktop branch (probe.ts:70).
 *  - prompt has 2 buckets (short | long-context). policy.v0 conditions on exact
 *    token thresholds (R4 <=3000, R5 <=200), but results never record a token
 *    count, so bucket -> representative tokens is an EXPLICIT modeling choice
 *    (REPRESENTATIVE_TOKENS) and the 200-token region is itself unmeasured
 *    (policy R5 rationale). Bench runs also record no stream flag, so R5's
 *    stream:true condition cannot be verified from results at all.
 */
import policy from "../../router/src/policy.v0.json";
import { classifyEnv, classifyOsClass } from "./compare";
import type { BenchDocument, RunRow, SessionRow } from "./schema";

export interface AuditInput {
  /** Source filename, for provenance in the report. */
  file: string;
  doc: BenchDocument;
}

export type DeviceClass = "ios-webkit" | "android-chromium" | "desktop" | "other" | "webview-iab";

/** Prompt as recorded; "(none)" marks a tab-kill session that produced no runs. */
export type PromptBucket = "short" | "long-context" | "(none)";

interface CellFacts {
  env: "browser" | "webview-iab";
  os_class: string;
  webgpu: boolean;
}

/** One observed (device_class x model x prompt x cache_state) context. */
export interface Cell {
  deviceClass: DeviceClass;
  model_id: string;
  prompt: PromptBucket;
  cache_state: string;
  facts: CellFacts;
  /** Runs with error===null AND >=1 core generation metric (see isOnDeviceSuccess). */
  nSuccess: number;
  /** Runs carrying an error object. */
  nFailure: number;
  /** Sorted unique "stage:error_name" failure modes observed (heuristic, not invented). */
  failureModes: string[];
  /** A session for this (device,model,cache) had ended_at===null (tab never returned). */
  tabKill: boolean;
  /** Source files contributing to this cell. */
  files: string[];
}

export interface PolicyVerdict {
  rule_id: string;
  target: "local" | "server";
}

export interface AnnotatedCell {
  cell: Cell;
  verdict: PolicyVerdict;
}

interface RuleJson {
  rule_id: string;
  target: string;
  hw: { env?: string; webgpu?: boolean; os_class?: string };
  request: { max_est_prompt_tokens?: number; max_max_tokens?: number; stream?: boolean };
  rationale?: string;
}

const RULES = policy.rules as RuleJson[];
const DEFAULT_MAX_TOKENS = policy.default_max_tokens as number;
export const POLICY_VERSION = policy.policy_version as string;

/**
 * Bucket -> representative est_prompt_tokens. Values are the measured prompt
 * sizes cited in policy R5's rationale (short ~52 tok, long ~1213 tok). Forced
 * by the schema: results label only short|long-context, never a token count,
 * while policy.v0 gates on exact thresholds. Stated, not hidden.
 */
const REPRESENTATIVE_TOKENS: Record<string, number> = { short: 52, "long-context": 1213 };
/** Within policy default (256); satisfies R5's max_max_tokens<=256. */
const REPRESENTATIVE_MAX_TOKENS = 256;
/** Assumed: bench runs do not record a stream flag, and R5 requires stream:true. */
const REPRESENTATIVE_STREAM = true;

/**
 * On-device SUCCESS heuristic (NOT invented): the run carries no error object
 * AND reported at least one core generation metric (ttft, decode rate, or an
 * output token count). A run that errored, or that produced no metric at all, is
 * not counted as a success.
 */
export function isOnDeviceSuccess(run: RunRow): boolean {
  return (
    run.error === null &&
    (run.ttft_ms !== null || run.decode_tps !== null || run.tokens_out !== null)
  );
}

function deviceClassOf(facts: CellFacts): DeviceClass {
  return facts.env === "webview-iab" ? "webview-iab" : (facts.os_class as DeviceClass);
}

function cellKey(deviceClass: string, model_id: string, prompt: string, cache_state: string): string {
  return [deviceClass, model_id, prompt, cache_state].join("|");
}

/** Faithful mirror of evaluatePolicy's base (non-privacy) path, policy.ts:122-132. */
export function decidePolicy(f: {
  env: string;
  webgpu: boolean;
  os_class: string;
  est_prompt_tokens: number;
  max_tokens: number;
  stream: boolean;
}): PolicyVerdict {
  for (const rule of RULES) {
    if (rule.hw.env !== undefined && rule.hw.env !== f.env) continue;
    if (rule.hw.webgpu !== undefined && rule.hw.webgpu !== f.webgpu) continue;
    if (rule.hw.os_class !== undefined && rule.hw.os_class !== f.os_class) continue;
    if (
      rule.request.max_est_prompt_tokens !== undefined &&
      f.est_prompt_tokens > rule.request.max_est_prompt_tokens
    ) {
      continue;
    }
    if (
      rule.request.max_max_tokens !== undefined &&
      (f.max_tokens ?? DEFAULT_MAX_TOKENS) > rule.request.max_max_tokens
    ) {
      continue;
    }
    if (rule.request.stream !== undefined && rule.request.stream !== f.stream) continue;
    return { rule_id: rule.rule_id, target: rule.target as "local" | "server" };
  }
  // R6 is condition-free, so the bundled table always matches; "none" only for a
  // custom table without a default (routes safe to server).
  return { rule_id: "none", target: "server" };
}

function verdictFor(cell: Cell): PolicyVerdict {
  const est = REPRESENTATIVE_TOKENS[cell.prompt] ?? REPRESENTATIVE_TOKENS.short ?? 52;
  return decidePolicy({
    env: cell.facts.env,
    webgpu: cell.facts.webgpu,
    os_class: cell.facts.os_class,
    est_prompt_tokens: est,
    max_tokens: REPRESENTATIVE_MAX_TOKENS,
    stream: REPRESENTATIVE_STREAM,
  });
}

/** True when the context carries any on-device failure evidence (error run or tab-kill). */
export function hasFailureEvidence(cell: Cell): boolean {
  return cell.nFailure > 0 || cell.tabKill;
}

/** Build the observed outcome matrix from the result files. */
export function buildCells(inputs: AuditInput[]): Cell[] {
  const cells = new Map<string, Cell>();
  /** `${deviceClass}|${model_id}|${cache_state}` for sessions that never ended. */
  const killSessions = new Set<string>();

  const factsByDevice = new Map<DeviceClass, CellFacts>();

  for (const { file, doc } of inputs) {
    const ua = doc.device.ua;
    const facts: CellFacts = {
      env: classifyEnv(ua),
      os_class: classifyOsClass({ ua, platform: "", maxTouchPoints: 0 }),
      webgpu: doc.device.webgpu,
    };
    const deviceClass = deviceClassOf(facts);
    if (!factsByDevice.has(deviceClass)) factsByDevice.set(deviceClass, facts);

    for (const run of doc.runs as RunRow[]) {
      const key = cellKey(deviceClass, run.model_id, run.prompt, run.cache_state);
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          deviceClass,
          model_id: run.model_id,
          prompt: run.prompt as PromptBucket,
          cache_state: run.cache_state,
          facts,
          nSuccess: 0,
          nFailure: 0,
          failureModes: [],
          tabKill: false,
          files: [],
        };
        cells.set(key, cell);
      }
      if (!cell.files.includes(file)) cell.files.push(file);
      if (isOnDeviceSuccess(run)) {
        cell.nSuccess += 1;
      } else if (run.error !== null) {
        cell.nFailure += 1;
        const mode = `${run.error.stage}:${run.error.error_name}`;
        if (!cell.failureModes.includes(mode)) cell.failureModes.push(mode);
      } else {
        // error===null but no core metric — treat as a (non-erroring) failure to
        // produce output rather than silently dropping the row.
        cell.nFailure += 1;
        const mode = "generate:no-metric";
        if (!cell.failureModes.includes(mode)) cell.failureModes.push(mode);
      }
    }

    for (const s of doc.sessions as SessionRow[]) {
      if (s.ended_at === null) {
        killSessions.add(`${deviceClass}|${s.model_id}|${s.cache_state}`);
      }
    }
  }

  // Attach tab-kill evidence to existing run-cells; synthesize a "(none)" cell
  // for a kill session that produced no runs at all (e.g. the LINE-IAB stall).
  for (const kk of killSessions) {
    const [deviceClass, model_id, cache_state] = kk.split("|") as [DeviceClass, string, string];
    const matching = [...cells.values()].filter(
      (c) => c.deviceClass === deviceClass && c.model_id === model_id && c.cache_state === cache_state,
    );
    if (matching.length > 0) {
      for (const c of matching) c.tabKill = true;
    } else {
      const facts = factsByDevice.get(deviceClass) ?? {
        env: deviceClass === "webview-iab" ? "webview-iab" : "browser",
        os_class: deviceClass === "webview-iab" ? "other" : deviceClass,
        webgpu: true,
      };
      const key = cellKey(deviceClass, model_id, "(none)", cache_state);
      cells.set(key, {
        deviceClass,
        model_id,
        prompt: "(none)",
        cache_state,
        facts,
        nSuccess: 0,
        nFailure: 0,
        failureModes: [],
        tabKill: true,
        files: [],
      });
    }
  }

  return [...cells.values()].sort((a, b) =>
    cellKey(a.deviceClass, a.model_id, a.prompt, a.cache_state).localeCompare(
      cellKey(b.deviceClass, b.model_id, b.prompt, b.cache_state),
    ),
  );
}

export interface RuleCoverage {
  rule_id: string;
  target: string;
  /** Cells for which this rule is the first match (i.e. it actually fires). */
  firedOn: number;
  /** Among fired cells, how many show on-device success / failure evidence. */
  withSuccess: number;
  withFailure: number;
  verdict: "backed" | "not-exercised" | "contradicted" | "definitional";
  note: string;
}

const DEFINITIONAL = new Set(["R2", "R6"]);

function ruleCoverage(annotated: AnnotatedCell[]): RuleCoverage[] {
  return RULES.map((rule) => {
    const fired = annotated.filter((a) => a.verdict.rule_id === rule.rule_id);
    const withSuccess = fired.filter((a) => a.cell.nSuccess > 0).length;
    const withFailure = fired.filter((a) => hasFailureEvidence(a.cell)).length;

    let verdict: RuleCoverage["verdict"];
    let note: string;
    if (DEFINITIONAL.has(rule.rule_id)) {
      verdict = "definitional";
      note =
        rule.rule_id === "R2"
          ? "WebGPU-absence rule; no webgpu:false record exists in results/ (WebLLM is WebGPU-only). Definitional, not evidence-based."
          : "Condition-free safe default; routes unknown territory to server by design.";
    } else if (fired.length === 0) {
      verdict = "not-exercised";
      note = "No results/ context matches this rule's conditions — unsupported by any record.";
    } else if (rule.target === "server") {
      // failure-justified server rule: backed when fired cells show failure.
      verdict = withFailure > 0 ? "backed" : "contradicted";
      note =
        withFailure > 0
          ? `${withFailure}/${fired.length} fired cell(s) show on-device failure/tab-kill.`
          : `Fires on ${fired.length} cell(s) but none show on-device failure (${withSuccess} show success).`;
    } else {
      // local rule: backed when fired cells show success.
      verdict = withSuccess > 0 ? "backed" : "contradicted";
      note =
        withSuccess > 0
          ? `${withSuccess}/${fired.length} fired cell(s) show on-device success.`
          : `Fires on ${fired.length} cell(s) but none show on-device success (${withFailure} show failure).`;
    }
    return {
      rule_id: rule.rule_id,
      target: rule.target,
      firedOn: fired.length,
      withSuccess,
      withFailure,
      verdict,
      note,
    };
  });
}

export interface GapReport {
  cells: AnnotatedCell[];
  coverage: RuleCoverage[];
  /** (a) on-device failures policy.v0 does NOT route to server. */
  uncoveredFailures: AnnotatedCell[];
  /** (b) rules not backed by any results record. */
  unsupportedRules: RuleCoverage[];
  /** (c) pure on-device successes policy.v0 routes to server. */
  successesRoutedToServer: AnnotatedCell[];
  /** (d) thin (single sample) or mixed (both outcomes) contexts. */
  thinOrAmbiguous: AnnotatedCell[];
}

export function buildGapReport(inputs: AuditInput[]): GapReport {
  const annotated: AnnotatedCell[] = buildCells(inputs).map((cell) => ({
    cell,
    verdict: verdictFor(cell),
  }));
  const coverage = ruleCoverage(annotated);

  const uncoveredFailures = annotated.filter(
    (a) => hasFailureEvidence(a.cell) && a.verdict.target === "local",
  );
  const unsupportedRules = coverage.filter((c) => c.verdict === "not-exercised" || c.verdict === "contradicted");
  const successesRoutedToServer = annotated.filter(
    (a) => a.cell.nSuccess > 0 && !hasFailureEvidence(a.cell) && a.verdict.target === "server",
  );
  const thinOrAmbiguous = annotated.filter((a) => {
    const total = a.cell.nSuccess + a.cell.nFailure;
    const mixed = a.cell.nSuccess > 0 && hasFailureEvidence(a.cell);
    return total === 1 || mixed;
  });

  return {
    cells: annotated,
    coverage,
    uncoveredFailures,
    unsupportedRules,
    successesRoutedToServer,
    thinOrAmbiguous,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (pure; the CLI just prints the string).
// ---------------------------------------------------------------------------

function outcomeLabel(cell: Cell): string {
  const parts: string[] = [];
  if (cell.nSuccess > 0) parts.push(`${cell.nSuccess}✓`);
  if (cell.nFailure > 0) parts.push(`${cell.nFailure}✗`);
  if (cell.tabKill) parts.push("tab-kill");
  return parts.join(" ") || "—";
}

function cellRow(a: AnnotatedCell): string {
  const c = a.cell;
  const modes = c.failureModes.length > 0 ? c.failureModes.join(", ") : "—";
  return `| ${c.deviceClass} | \`${c.model_id}\` | ${c.prompt} | ${c.cache_state} | ${outcomeLabel(c)} | ${modes} | ${a.verdict.target} (${a.verdict.rule_id}) |`;
}

export function renderGapReport(report: GapReport, fileCount: number): string {
  const L: string[] = [];
  L.push(`# Policy reconciliation gap report — ${POLICY_VERSION}`);
  L.push("");
  L.push(
    `Read-only audit of router/src/policy.v0.json against ${fileCount} file(s) in bench/results/. ` +
      "No policy or code-path was changed.",
  );
  L.push("");
  L.push("Coarseness (the matrix generalizes only to these axes):");
  L.push("- device_class: 5 values (4 os_class + webview-iab); os_class is UA-only here (results carry no platform/maxTouchPoints).");
  L.push("- prompt: 2 buckets (short ~52 tok, long-context ~1213 tok per R5 rationale); the 200-token region is unmeasured.");
  L.push("- stream flag is not recorded by bench, so R5's stream:true condition is assumed, not verified.");
  L.push("");

  L.push("## (a) Observed on-device FAILURES not routed to server (uncovered known-failure cases)");
  L.push("");
  if (report.uncoveredFailures.length === 0) {
    L.push("_None. Every context with on-device failure evidence is routed to server by policy.v0._");
  } else {
    L.push("| device_class | model | prompt | cache | outcome | failure modes | policy decides |");
    L.push("|---|---|---|---|---|---|---|");
    for (const a of report.uncoveredFailures) L.push(cellRow(a));
  }
  L.push("");

  L.push("## (b) Policy rules NOT backed by any results record (unsupported / contradicted)");
  L.push("");
  if (report.unsupportedRules.length === 0) {
    L.push("_Every non-definitional rule is exercised and supported by at least one record._");
  } else {
    L.push("| rule | target | fired on | verdict | note |");
    L.push("|---|---|---|---|---|");
    for (const c of report.unsupportedRules) {
      L.push(`| ${c.rule_id} | ${c.target} | ${c.firedOn} cell(s) | ${c.verdict} | ${c.note} |`);
    }
  }
  L.push("");
  L.push("Full rule-coverage table (all rules):");
  L.push("");
  L.push("| rule | target | fired on | #success cells | #failure cells | verdict | note |");
  L.push("|---|---|---|---|---|---|---|");
  for (const c of report.coverage) {
    L.push(
      `| ${c.rule_id} | ${c.target} | ${c.firedOn} | ${c.withSuccess} | ${c.withFailure} | ${c.verdict} | ${c.note} |`,
    );
  }
  L.push("");

  L.push("## (c) Observed on-device SUCCESSES routed to server (savings potentially left on the table)");
  L.push("");
  L.push("_Flagged cautiously: a success in results/ does not guarantee a different device in the same class succeeds._");
  L.push("");
  if (report.successesRoutedToServer.length === 0) {
    L.push("_None. No pure-success context is routed to server._");
  } else {
    L.push("| device_class | model | prompt | cache | outcome | failure modes | policy decides |");
    L.push("|---|---|---|---|---|---|---|");
    for (const a of report.successesRoutedToServer) L.push(cellRow(a));
  }
  L.push("");

  L.push("## (d) Thin or ambiguous contexts (single sample or mixed outcomes)");
  L.push("");
  if (report.thinOrAmbiguous.length === 0) {
    L.push("_None._");
  } else {
    L.push("| device_class | model | prompt | cache | outcome | failure modes | policy decides |");
    L.push("|---|---|---|---|---|---|---|");
    for (const a of report.thinOrAmbiguous) L.push(cellRow(a));
  }
  L.push("");

  L.push("## Full observed matrix (every cell)");
  L.push("");
  L.push("| device_class | model | prompt | cache | outcome | failure modes | policy decides |");
  L.push("|---|---|---|---|---|---|---|");
  for (const a of report.cells) L.push(cellRow(a));
  L.push("");
  return L.join("\n");
}
