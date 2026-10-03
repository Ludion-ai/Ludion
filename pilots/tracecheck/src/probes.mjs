// Requests that hunt for secrets and admin pages: /.env, /.git/config, /wp-login.php and the like.
// A site's route template keeps only route words (/.env becomes /:param), so the pilot names them
// here instead: each request path is matched against a fixed list, and only the list's own label is
// ever kept, never the path that was sent. Labels are stable: old rows keep reading the same.
//
// kind: "secret" (credentials, keys, config, repositories, backups), "admin" (login and admin
// pages, panels), "exploit" (known vulnerable endpoints, scripts a static site does not have).

/** Exact paths (lowercased) from common scanner word lists, each its own label. */
const EXACT = {
  secret: [
    "/.env", "/.env.local", "/.env.production", "/.env.prod", "/.env.dev", "/.env.development", "/.env.staging", "/.env.backup", "/.env.bak",
    "/.env.old", "/.env.save", "/.env.example",
    "/.git/config", "/.git/head", "/.git/index", "/.git/logs/head", "/.git/", "/.git", "/.git-credentials", "/.gitconfig",
    "/.svn/entries", "/.svn/wc.db", "/.hg/hgrc", "/.bzr/branch-format",
    "/.aws/credentials", "/.aws/config", "/.ssh/id_rsa", "/.ssh/id_ed25519", "/.ssh/authorized_keys", "/.docker/config.json", "/.kube/config",
    "/.npmrc", "/.pypirc", "/.netrc", "/.htpasswd", "/.htaccess", "/.ds_store", "/.vscode/sftp.json", "/.idea/workspace.xml", "/.bash_history",
    "/.dockerenv", "/docker-compose.yml", "/docker-compose.yaml", "/dockerfile",
    "/config.json", "/config.js", "/config.yml", "/config.yaml", "/config.php", "/config.inc.php", "/configuration.php", "/settings.py",
    "/appsettings.json", "/web.config", "/database.yml", "/credentials.json", "/secrets.json", "/secrets.yml", "/application.properties",
    "/wp-config.php", "/wp-config.php.bak", "/wp-config.bak", "/wp-config.php.old", "/wp-config.php~",
    "/server.key", "/private.key", "/id_rsa", "/backup.zip", "/backup.sql", "/backup.tar.gz", "/db.sql", "/dump.sql", "/database.sql",
    "/site.zip", "/www.zip", "/sftp-config.json", "/phpinfo.php", "/info.php",
  ],
  admin: [
    "/wp-login.php", "/wp-admin/", "/wp-admin", "/wp-admin/install.php", "/wp-admin/setup-config.php", "/xmlrpc.php",
    "/wp-includes/wlwmanifest.xml", "/wp-json/wp/v2/users",
    "/phpmyadmin/", "/phpmyadmin", "/pma/", "/myadmin/", "/adminer.php", "/admin", "/admin/", "/administrator/", "/admin.php",
    "/login.php", "/user/login", "/manager/html", "/server-status", "/server-info", "/console", "/actuator", "/actuator/env",
    "/actuator/health", "/_profiler/phpinfo", "/telescope/requests", "/debug/default/view", "/owa/", "/ecp/", "/autodiscover/autodiscover.xml",
    "/solr/admin/info/system", "/jenkins/login", "/grafana/login",
  ],
  exploit: [
    "/vendor/phpunit/phpunit/src/util/php/eval-stdin.php", "/cgi-bin/", "/cgi-bin/luci", "/boaform/admin/formlogin", "/hnap1/", "/hnap1",
    "/shell.php", "/cmd.php", "/alfa.php", "/wso.php", "/test.php", "/php.php", "/xleet.php", "/ups.php", "/api/v1/pods",
    "/etc/passwd", "/remote/fgt_lang", "/global-protect/login.esp", "/vpn/index.html",
  ],
};

/** Variants not on the list, by family. Each pattern sees the lowercased path; its label is fixed. */
const FAMILIES = [
  [/(^|\/)\.env([._-][\w.-]*)?$/, "…/.env*", "secret"],
  [/(^|\/)\.git(\/|$)/, "…/.git/*", "secret"],
  [/(^|\/)\.(svn|hg|bzr)(\/|$)/, "…/.svn, .hg, .bzr", "secret"],
  [/(^|\/)\.(aws|ssh|docker|kube|azure|gcloud|config)\//, "…/.aws, .ssh, .docker … /*", "secret"],
  [/(^|\/)(wp-config|configuration|config|settings|secrets?|credentials?|database|db|appsettings|parameters|local\.settings)\.(json|ya?ml|ini|xml|php|js|py|toml|conf|properties)([._~-][\w.~-]*)?$/, "config files (config.*, secrets.* …)", "secret"],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk)$/, "keys (*.pem, *.key …)", "secret"],
  [/\.(sql|sqlite|db|bak|old|orig|save|swp|backup|tar|tgz|tar\.gz|zip|rar|7z)$/, "backups and dumps (*.sql, *.bak, *.zip …)", "secret"],
  [/(^|\/)(wp-admin|wp-includes|wp-content|wp-json|wp-login|xmlrpc)/, "WordPress (other)", "admin"],
  [/(^|\/)(phpmyadmin|pma|myadmin|mysqladmin|adminer)/, "database admin (other)", "admin"],
  [/(^|\/)(actuator|manager\/html|jmx-console|web-console)/, "Java admin (other)", "admin"],
  [/\.(php\d?|phtml|asp|aspx|jsp|cgi)$/, "scripts (*.php, *.asp, *.jsp …)", "exploit"],
  [/(^|\/)(cgi-bin|boaform|hnap1)\//, "routers and CGI (other)", "exploit"],
  [/(\.\.\/|%2e%2e|\/etc\/passwd|\/proc\/self)/, "path traversal", "exploit"],
];

export const KINDS = ["secret", "admin", "exploit"];
const kindOfExact = new Map(Object.entries(EXACT).flatMap(([kind, paths]) => paths.map((p) => [p, kind])));
const kindOfLabel = new Map([...kindOfExact, ...FAMILIES.map(([, label, kind]) => [label, kind])]);

/** The kind a stored label belongs to ("secret", "admin", "exploit"), or null. */
export const probeKind = (label) => kindOfLabel.get(label) ?? null;

/**
 * The probe a request path is, as a label from the list above, or null.
 * @param {string} pathname   the URL's path (percent-encoded as sent)
 */
export function probeOf(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  const sent = pathname.toLowerCase();
  let p = sent;
  try { p = decodeURIComponent(sent); } catch { /* malformed escapes: match it as sent */ }
  p = p.replace(/\/{2,}/g, "/");
  if (kindOfExact.has(p)) return p;
  for (const [re, label] of FAMILIES) if (re.test(p) || re.test(sent)) return label;
  return null;
}
