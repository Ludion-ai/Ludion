// PUB-4 (±): the npm set leaves this repository one way only — the release workflow, started by hand
// on main, approved at the `npm` environment, publishing through npm's trusted publishing (OIDC; no
// npm token anywhere), in the set's order, after PUB-1..3 passed on the same commit.
//   + the driver (scripts/release.mjs) publishes in order, skips what npm already has, and a dry run
//     sends nothing;
//   − it refuses a package npm has never seen (first version by hand), stops at the first failure,
//     and refuses to publish outside the release workflow on main, without OIDC, with any npm token,
//     or with an npm too old for trusted publishing; no other workflow can publish or mint OIDC
//     tokens, and the release workflow keeps its guards (checked on planted workflows first).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SET, ROOT } from "./set.mjs";
import { plan, refusals, oneVersion, publishAll, WORKFLOW, MIN_NPM } from "../../scripts/release.mjs";

const manifestOf = (dir) => ({ name: dir === "ludion" ? "ludion" : `@ludion/${dir}`, version: "0.0.2" });
/** A fake npm: `seen` maps a name to its versions on npm (absent: never published); `breaks` fails a publish. */
function fakeNpm({ seen = {}, breaks = [], viewDown = [] } = {}) {
  const calls = [];
  const npm = (args, cwd) => {
    calls.push({ args, cwd: path.relative(ROOT, cwd).split(path.sep).join("/") });
    if (args[0] === "view") {
      if (viewDown.includes(args[1])) return { code: 1, out: "npm error code ETIMEDOUT" };
      return args[1] in seen ? { code: 0, out: JSON.stringify(seen[args[1]]) } : { code: 1, out: `npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${args[1]}` };
    }
    if (args[0] === "publish") {
      const dir = path.basename(cwd);
      return breaks.includes(dir) ? { code: 1, out: "npm error code E403\nnpm error 403 Forbidden" } : { code: 0, out: `+ ${manifestOf(dir).name}@0.0.2` };
    }
    throw new Error(`unexpected npm ${args.join(" ")}`);
  };
  return { npm, calls, publishes: () => calls.filter((c) => c.args[0] === "publish") };
}
const allSeen = (extra = {}) => Object.fromEntries(SET.map((d) => [manifestOf(d).name, ["0.0.1"]]).concat(Object.entries(extra)));

test("PUB-4: packages go out in the set's order; a version npm already has is skipped", () => {
  const f = fakeNpm({ seen: allSeen({ "@ludion/scan": ["0.0.1", "0.0.2"] }) });
  const { ok, rows } = publishAll(plan("all"), { npm: f.npm, manifestOf });
  assert.equal(ok, true);
  assert.deepEqual(rows.map((r) => r.dir), SET);
  assert.equal(rows.find((r) => r.dir === "scan").action, "skipped");
  assert.deepEqual(f.publishes().map((c) => c.cwd), SET.filter((d) => d !== "scan").map((d) => `packages/${d}`));
  assert.ok(f.publishes().every((c) => c.args.join(" ") === "publish --access public"), "a real run never passes --dry-run, a token or a tag");
  assert.deepEqual(plan("gate-node,gate-core"), ["gate-core", "gate-node"], "a subset keeps the set's order");
});

test("PUB-4: a package npm has never seen is refused (its first version is published by hand), and a real run stops there", () => {
  const seen = allSeen(); delete seen["@ludion/report"];
  const f = fakeNpm({ seen });
  const { ok, rows } = publishAll(plan("all"), { npm: f.npm, manifestOf });
  assert.equal(ok, false);
  assert.deepEqual(rows.map((r) => `${r.dir} ${r.action}`), ["gate-core published", "scan published", "report refused"]);
  assert.match(rows.at(-1).detail, /publish its first version by hand/);
  assert.deepEqual(f.publishes().map((c) => c.cwd), ["packages/gate-core", "packages/scan"], "nothing after the refusal is sent");
});

test("PUB-4: the first failure stops the rest (later packages depend on earlier ones), and so does npm being unreachable", () => {
  const f = fakeNpm({ seen: allSeen(), breaks: ["diver"] });
  const r = publishAll(plan("all"), { npm: f.npm, manifestOf });
  assert.equal(r.ok, false);
  assert.deepEqual(r.rows.map((x) => x.action), ["published", "published", "published", "failed"]);
  assert.equal(f.publishes().length, 4);
  const down = fakeNpm({ seen: allSeen(), viewDown: ["@ludion/gate-core"] });
  const r2 = publishAll(plan("all"), { npm: down.npm, manifestOf });
  assert.equal(r2.ok, false);
  assert.equal(down.publishes().length, 0, "npm view failing is not read as 'not published yet'");
});

test("PUB-4: a dry run sends nothing and looks at every package, refused ones included", () => {
  const seen = allSeen(); delete seen.ludion;
  const f = fakeNpm({ seen, breaks: ["gate-next"] });
  const { ok, rows } = publishAll(plan("all"), { npm: f.npm, manifestOf, dryRun: true });
  assert.equal(ok, false, "a dry run still says what a real run would stop at");
  assert.deepEqual(rows.map((r) => r.dir), SET);
  assert.ok(f.publishes().every((c) => c.args.includes("--dry-run")), "every publish call is a dry run");
});

const GOOD_ENV = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: `Ludion-ai/Ludion/${WORKFLOW}@refs/heads/main`,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/x", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", GITHUB_TOKEN: "ghs_x", PATH: "/usr/bin",
};
test("PUB-4: a real publish is refused outside the release workflow on main, without OIDC, with any npm token, or with an old npm", () => {
  const npmInfo = { npmVersion: "11.6.2", npmToken: "undefined" };
  assert.deepEqual(refusals(GOOD_ENV, npmInfo), [], "control: the release workflow on main with OIDC and no token");
  const cases = [
    [{ GITHUB_ACTIONS: undefined }, /not in GitHub Actions/],
    [{ GITHUB_REF: "refs/heads/feature" }, /not on main/],
    [{ GITHUB_REF: "refs/tags/v1" }, /not on main/],
    [{ GITHUB_WORKFLOW_REF: "Ludion-ai/Ludion/.github/workflows/ci.yml@refs/heads/main" }, /not the release workflow/],
    [{ GITHUB_WORKFLOW_REF: `Ludion-ai/Ludion/${WORKFLOW}@refs/pull/9/merge` }, /not the release workflow/],
    [{ ACTIONS_ID_TOKEN_REQUEST_URL: undefined }, /no OIDC token/],
    [{ NODE_AUTH_TOKEN: "npm_abc" }, /npm token is in the environment \(NODE_AUTH_TOKEN\)/],
    [{ NPM_TOKEN: "npm_abc" }, /NPM_TOKEN/],
    [{ npm_config__authToken: "npm_abc" }, /npm_config__authToken/],
  ];
  for (const [over, why] of cases) {
    const env = { ...GOOD_ENV, ...over };
    for (const k of Object.keys(over)) if (over[k] === undefined) delete env[k];
    const r = refusals(env, npmInfo);
    assert.ok(r.some((x) => why.test(x)), `${JSON.stringify(over)} → ${JSON.stringify(r)}`);
  }
  assert.ok(refusals(GOOD_ENV, { npmVersion: "11.6.2", npmToken: "npm_abc" }).some((x) => /config holds an auth token/.test(x)));
  assert.ok(refusals(GOOD_ENV, { npmVersion: "11.5.0", npmToken: "undefined" }).some((x) => /older than 11\.5\.1/.test(x)));
  assert.deepEqual(refusals(GOOD_ENV, { npmVersion: "11.5.1", npmToken: "" }), []);
  assert.deepEqual(MIN_NPM, [11, 5, 1]);
});

test("PUB-4: only packages of the set, and one version across it", () => {
  assert.throws(() => plan("gate-core,card-host"), /not in the publish set: card-host/);
  assert.throws(() => plan(","), /no package named/);
  assert.deepEqual(plan("all"), SET);
  assert.equal(oneVersion([{ name: "a", version: "1.0.0" }, { name: "b", version: "1.0.0" }]), "1.0.0");
  assert.throws(() => oneVersion([{ name: "a", version: "1.0.0" }, { name: "b", version: "1.0.1" }]), /bump them together/);
  const real = SET.map((d) => JSON.parse(fs.readFileSync(path.join(ROOT, "packages", d, "package.json"), "utf8")));
  assert.doesNotThrow(() => oneVersion(real), "the repository's set carries one version");
});

// ── the workflows ─────────────────────────────────────────────────────────────────────────────
/** Problems with the release workflow's text. */
export function releaseProblems(y) {
  const out = [];
  const on = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(y)?.[1] ?? "";
  if (!/^\s+workflow_dispatch:/m.test(on) || /^\s+(push|pull_request|pull_request_target|schedule|workflow_run|release|repository_dispatch):/m.test(on)) out.push("not started by hand only");
  if (!/^\s+if: github\.ref == 'refs\/heads\/main'$/m.test(y)) out.push("not limited to main");
  if (!/^\s+environment: npm$/m.test(y)) out.push("not held at the npm environment");
  const top = /^permissions:\n((?:[ \t]+.*\n)*)/m.exec(y)?.[1] ?? "";
  if (/id-token/.test(top) || !/contents: read/.test(top)) out.push("workflow-wide permissions are more than contents: read");
  if (!/^\s+id-token: write$/m.test(y)) out.push("the job cannot mint an OIDC token");
  if (/secrets\./.test(y)) out.push("uses a secret");
  if (/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|registry-url/.test(y)) out.push("configures an npm token");
  for (const m of y.matchAll(/^\s+run: (.*)$/gm)) if (/\$\{\{/.test(m[1])) out.push(`expression inside a run line: ${m[1].trim()}`);
  for (const m of y.matchAll(/uses: ([^\s@]+)@([^\s#]+)/g)) if (!/^[0-9a-f]{40}$/.test(m[2])) out.push(`action not pinned to a commit: ${m[1]}@${m[2]}`);
  const pub = y.indexOf("accept/publish/pub3.test.mjs"), rel = y.indexOf("scripts/release.mjs");
  if (!/--test-name-pattern="\^PUB-\[123\]:"/.test(y) || pub < 0) out.push("PUB-1..3 do not run first");
  if (rel < 0) out.push("does not publish through scripts/release.mjs");
  else if (pub > rel) out.push("publishes before PUB-1..3 run");
  if (/npm publish/.test(y)) out.push("calls npm publish directly");
  return out;
}

const real = fs.readFileSync(path.join(ROOT, WORKFLOW), "utf8");
test("PUB-4: the workflow checker catches what it must (planted workflows)", () => {
  assert.deepEqual(releaseProblems(real), [], "control: the repository's release workflow");
  const planted = [
    [real.replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:"), /not started by hand only/],
    [real.replace("    if: github.ref == 'refs/heads/main'\n", ""), /not limited to main/],
    [real.replace("    environment: npm\n", ""), /not held at the npm environment/],
    [real.replace("permissions:\n  contents: read\njobs:", "permissions:\n  contents: read\n  id-token: write\njobs:"), /workflow-wide permissions/],
    [real.replace("      id-token: write\n", ""), /cannot mint an OIDC token/],
    [real.replace("PACKAGES: ${{ inputs.packages }}", "PACKAGES: ${{ inputs.packages }}\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}"), /uses a secret/],
    [real.replace("with: { node-version: 24 }", "with: { node-version: 24, registry-url: 'https://registry.npmjs.org' }"), /configures an npm token/],
    [real.replace('--only "$PACKAGES"', '--only "${{ inputs.packages }}"'), /expression inside a run line/],
    [real.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v4"), /not pinned to a commit: actions\/checkout@v4/],
    [real.replace('--test-name-pattern="^PUB-[123]:"', '--test-name-pattern="^PUB-2:"'), /PUB-1\.\.3 do not run first/],
    [real.replace("node scripts/release.mjs", "cd packages/gate-core && npm publish"), /does not publish through scripts\/release\.mjs|calls npm publish directly/],
  ];
  for (const [y, why] of planted) {
    assert.notEqual(y, real, `the plant did not apply for ${why}`);
    assert.ok(releaseProblems(y).some((p) => why.test(p)), `${why} → ${JSON.stringify(releaseProblems(y))}`);
  }
});

test("PUB-4: no other workflow can publish to npm or mint an OIDC token", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.includes("release.yml") && files.includes("ci.yml"), files.join(", "));
  for (const f of files) {
    if (`.github/workflows/${f}` === WORKFLOW) continue;
    const y = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(y, /npm publish|scripts\/release\.mjs/, `${f} publishes`);
    assert.doesNotMatch(y, /id-token:\s*write/, `${f} can mint an OIDC token`);
  }
  console.log(`PUB-4: ${SET.length} packages in order, OIDC only, from main by hand; ${files.length} workflows checked`);
});
