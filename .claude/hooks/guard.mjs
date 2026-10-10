// PreToolUse hook for Bash and PowerShell: refuses commands that change production or secrets, or that run a
// downloaded script. settings.json denies the plain forms; this sees the whole command, pipes included, and lets
// `wrangler deploy --dry-run` through (a deny rule can't make that exception). Exit 2 blocks the call.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const command = String(JSON.parse(input || "{}").tool_input?.command ?? "");

const RULES = [
  {
    // wrangler deploy, versions deploy/upload, rollback, delete; any spelling of wrangler (npx, node .../wrangler.js).
    test: (c) => /\bwrangler(\.js)?\b[^|;&\n]*\s(deploy|versions\s+(deploy|upload)|rollback|delete)\b/i.test(c) && !/--dry-run\b/.test(c),
    why: "Production is deployed only by .github/workflows/deploy.yml. To deploy main's newest commit: gh workflow run deploy.yml --ref main. A dry run (--dry-run) is fine.",
  },
  {
    test: (c) => /\bwrangler(\.js)?\b[^|;&\n]*\ssecret\b/i.test(c) || /\bgh\s+secret\b/i.test(c),
    why: "Secrets are set by the owner, never by Claude Code.",
  },
  {
    test: (c) => /\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force\b|\s--force-with-lease\b|\s-f\b|\s\+[^\s]+)/i.test(c),
    why: "Force pushes are not allowed. Push a new commit instead.",
  },
  {
    test: (c) => /\bgh\s+repo\s+delete\b/i.test(c),
    why: "Deleting a repository is not allowed.",
  },
  {
    test: (c) => /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|iex|Invoke-Expression|pwsh|powershell)\b/i.test(c),
    why: "Piping a download into a shell runs code nobody read. Download it, read it, then decide.",
  },
];

const hit = RULES.find((r) => r.test(command));
if (hit) {
  process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${hit.why}\n`);
  process.exit(2);
}
