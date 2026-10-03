#!/usr/bin/env node
// Publish the npm set (accept/publish/set.mjs) the one way it may leave this repository (PUB-4):
// from GitHub Actions' release workflow on main, through npm's trusted publishing (OIDC: no npm
// token exists anywhere; npm attaches provenance), in the set's order, after PUB-1..3 passed.
// A human starts the workflow and approves its `npm` environment; Claude never runs it for real.
//
//   node scripts/release.mjs --only all|<dir>[,<dir>…] [--dry-run]
//
// Per package, in the set's order: a version npm already has is skipped; a package npm has never
// seen is refused (npm can only trust a publisher for a package that exists: its first version is
// published by hand, docs/PUBLISH.md §6); otherwise `npm publish`. The first failure stops the rest
// (later packages depend on earlier ones). --dry-run sends nothing and goes through every package.
import { SET, manifest, npm as runNpm } from "../accept/publish/set.mjs";
import path from "node:path";
import { ROOT } from "../accept/publish/set.mjs";

export const MIN_NPM = [11, 5, 1]; // trusted publishing (docs.npmjs.com/trusted-publishers)
export const WORKFLOW = ".github/workflows/release.yml";
const TOKEN_ENV = /^(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$|_auth(token)?$|^npm_config_.*_auth/i;

/** Which packages, in the set's order. Unknown names are refused, never ignored. */
export function plan(only) {
  const want = !only || only === "all" ? SET : String(only).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = want.filter((d) => !SET.includes(d));
  if (unknown.length) throw new Error(`not in the publish set: ${unknown.join(", ")} (the set: ${SET.join(", ")})`);
  if (!want.length) throw new Error("no package named");
  return SET.filter((d) => want.includes(d));
}

const ver = (s) => String(s).trim().split(".").map((x) => parseInt(x, 10) || 0);
const atLeast = (have, min) => { for (let i = 0; i < 3; i++) { if ((have[i] ?? 0) !== min[i]) return (have[i] ?? 0) > min[i]; } return true; };

/**
 * Why this process must not publish for real (empty: it may). A dry run is held only to the token
 * rule's warning, not to these.
 * @param {Record<string,string|undefined>} env  @param {{ npmVersion: string, npmToken?: string }} npmInfo
 */
export function refusals(env, { npmVersion, npmToken }) {
  const out = [];
  if (env.GITHUB_ACTIONS !== "true") out.push("not in GitHub Actions: publishing runs only in the release workflow");
  if (env.GITHUB_REF !== "refs/heads/main") out.push(`not on main (${env.GITHUB_REF ?? "no ref"})`);
  if (!String(env.GITHUB_WORKFLOW_REF ?? "").includes(`/${WORKFLOW}@refs/heads/main`)) out.push(`not the release workflow on main (${env.GITHUB_WORKFLOW_REF ?? "none"})`);
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) out.push("no OIDC token available (the job needs `id-token: write`)");
  const tokens = Object.keys(env).filter((k) => TOKEN_ENV.test(k) && env[k]);
  if (tokens.length) out.push(`an npm token is in the environment (${tokens.join(", ")}): publishing goes through OIDC only`);
  if (npmToken && npmToken !== "undefined") out.push("npm's config holds an auth token for registry.npmjs.org: publishing goes through OIDC only");
  if (!atLeast(ver(npmVersion), MIN_NPM)) out.push(`npm ${npmVersion} is older than ${MIN_NPM.join(".")} (trusted publishing)`);
  return out;
}

/** Every package of the set carries one version (they are published together). */
export function oneVersion(manifests) {
  const vs = [...new Set(manifests.map((m) => m.version))];
  if (vs.length !== 1) throw new Error(`the set carries ${vs.length} versions (${manifests.map((m) => `${m.name}@${m.version}`).join(", ")}): bump them together`);
  return vs[0];
}

/**
 * Publish `dirs` in order. `npm(args, cwd)` returns { code, out }.
 * @returns {{ ok: boolean, rows: { dir: string, name: string, version: string, action: string, detail?: string }[] }}
 */
export function publishAll(dirs, { npm, manifestOf, dryRun = false }) {
  const rows = [];
  for (const dir of dirs) {
    const m = manifestOf(dir), row = { dir, name: m.name, version: m.version };
    const seen = npm(["view", m.name, "versions", "--json"], ROOT);
    if (seen.code !== 0) {
      if (/E404|404 Not Found|is not in this registry/i.test(seen.out)) {
        rows.push({ ...row, action: "refused", detail: "npm has never seen this package: publish its first version by hand, then trust this workflow (docs/PUBLISH.md §6)" });
        if (dryRun) continue;
        return { ok: false, rows };
      }
      rows.push({ ...row, action: "failed", detail: `npm view: ${seen.out.trim().split("\n").slice(-2).join(" ")}` });
      return { ok: false, rows };
    }
    let versions = [];
    try { versions = [].concat(JSON.parse(seen.out || "[]")); } catch { /* treated as none */ }
    if (versions.includes(m.version)) { rows.push({ ...row, action: "skipped", detail: "this version is already on npm" }); continue; }
    const r = npm(["publish", "--access", "public", ...(dryRun ? ["--dry-run"] : [])], path.join(ROOT, "packages", dir));
    if (r.code !== 0) {
      rows.push({ ...row, action: "failed", detail: r.out.trim().split("\n").slice(-3).join(" ") });
      if (dryRun) continue;
      return { ok: false, rows };
    }
    rows.push({ ...row, action: dryRun ? "would publish" : "published" });
  }
  return { ok: rows.every((r) => ["published", "would publish", "skipped"].includes(r.action)), rows };
}

function npmResult(args, cwd) {
  try { return { code: 0, out: runNpm(args, cwd) }; } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message) }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, "scripts", "release.mjs")) {
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const dryRun = argv.includes("--dry-run");
  let dirs;
  try { dirs = plan(val("--only")); oneVersion(SET.map(manifest)); } catch (e) { console.error(`release: ${e.message}`); process.exit(2); }
  const npmVersion = npmResult(["--version"], ROOT).out.trim();
  const npmToken = npmResult(["config", "get", "//registry.npmjs.org/:_authToken"], ROOT).out.trim();
  const no = refusals(process.env, { npmVersion, npmToken });
  if (no.length && !dryRun) { for (const r of no) console.error(`release: refused: ${r}`); process.exit(2); }
  if (no.length) for (const r of no) console.error(`release: (dry run; a real run would refuse) ${r}`);
  const { ok, rows } = publishAll(dirs, { npm: npmResult, manifestOf: manifest, dryRun });
  for (const r of rows) console.log(`${r.action.padEnd(13)} ${r.name}@${r.version}${r.detail ? `  — ${r.detail}` : ""}`);
  console.log(`${dryRun ? "dry run: nothing was sent" : ok ? "released" : "stopped"} (${rows.length} of ${dirs.length} packages looked at)`);
  process.exit(ok ? 0 : 1);
}
