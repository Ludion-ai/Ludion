// LOOP-2: a full CI run — every job one push to main starts, from the first job's start to the last
// job's finish — takes at most 10 minutes, and every one of those jobs is green (a run that failed
// early proves nothing about how long a full one takes). Jobs a push does not start (the nightly
// ones: Windows, this oracle) are skipped in a push run and are not counted.
// It reads the latest completed push run on main from the GitHub API. It runs in the nightly job, not
// in a PR's own run: a PR cannot change the run main already had, and a red or slow main must never
// block the PR that fixes it.
import { execFileSync } from "node:child_process";

export const LIMIT_S = 600;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Judge one run's jobs (GitHub's job objects). */
export function judgeRun(jobs, { limitS = LIMIT_S } = {}) {
  const ran = (jobs ?? []).filter((j) => j.conclusion !== "skipped");
  if (!ran.length) return { pass: false, detail: "no job ran" };
  const problems = [];
  const unfinished = ran.filter((j) => j.status !== "completed" || !j.started_at || !j.completed_at);
  if (unfinished.length) problems.push(`not finished: ${unfinished.map((j) => j.name).join(", ")}`);
  const red = ran.filter((j) => j.status === "completed" && j.conclusion !== "success");
  if (red.length) problems.push(`not green: ${red.map((j) => `${j.name} ${j.conclusion}`).join(", ")}`);
  const done = ran.filter((j) => j.started_at && j.completed_at);
  const t = (x) => Date.parse(x);
  const start = Math.min(...done.map((j) => t(j.started_at))), end = Math.max(...done.map((j) => t(j.completed_at)));
  const wallS = done.length ? (end - start) / 1000 : NaN;
  if (!(wallS <= limitS)) problems.push(`took ${Number.isFinite(wallS) ? mmss(wallS) : "?"} (limit ${mmss(limitS)})`);
  const slowest = done.map((j) => ({ name: j.name, s: (t(j.completed_at) - t(j.started_at)) / 1000 })).sort((a, b) => b.s - a.s)[0];
  return {
    pass: problems.length === 0, wallS,
    metric: `${Number.isFinite(wallS) ? mmss(wallS) : "?"} first start → last finish over ${ran.length} jobs (limit ${mmss(limitS)})${slowest ? `; slowest ${slowest.name} ${mmss(slowest.s)}` : ""}`,
    detail: problems.join("; ") || undefined,
  };
}

function token() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try { return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim() || undefined; } catch { return undefined; }
}
function repo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`origin is not a GitHub repository: ${url}`);
  return m[1];
}

/** The latest completed push run of ci.yml on main, and the jobs of its latest attempt. */
export async function latestPushRun({ repo: r = repo(), token: tk = token(), fetch: f = fetch, workflow = "ci.yml" } = {}) {
  const get = async (p) => {
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await f(`https://api.github.com/repos/${r}${p}`, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(tk ? { authorization: `Bearer ${tk}` } : {}) } });
        if (res.ok) return await res.json();
        last = new Error(`GitHub API ${res.status} for ${p}`);
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) { last = e; }
      await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
    }
    throw last;
  };
  const runs = await get(`/actions/workflows/${workflow}/runs?branch=main&event=push&status=completed&per_page=1`);
  const run = runs.workflow_runs?.[0];
  if (!run) throw new Error(`no completed push run of ${workflow} on main`);
  const { jobs } = await get(`/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100`);
  return { run, jobs };
}

if (process.argv[1] && /ci-time\.mjs$/.test(process.argv[1])) {
  try {
    const { run, jobs } = await latestPushRun();
    const v = judgeRun(jobs);
    console.log(`# LOOP-2: ${v.metric}; run ${run.id} (${run.head_sha.slice(0, 7)}, ${run.created_at})`);
    if (!v.pass) { console.log(`FAIL: ${v.detail} — ${run.html_url}`); process.exit(1); }
  } catch (e) { console.log(`FAIL: cannot read the CI run: ${e.message}`); process.exit(1); }
}
