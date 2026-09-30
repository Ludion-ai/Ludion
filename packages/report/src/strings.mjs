// Copy for the daily report. Restrained, factual business tone in both languages: the numbers
// carry the message. No digits in the copy itself (every number in a report is a metric), except
// the Pressure level names.

export const STRINGS = {
  ja: {
    title: "Ludion 日次レポート",
    subject: (s, n, m) => `[Ludion] ${s.site} ${s.date}：重要経路への未検証の自動化 ${n} 件、検証済みの行為 ${m} 件`,
    meta: (s) => `${s.site}・${s.date}（${s.tz}）`,
    critical: {
      title: "重要経路に触れた未検証の自動化",
      lead: "決済・ログイン・登録・アカウントの経路と、書き込み（POST・PUT・PATCH・DELETE）に届いた自動化のうち、署名を検証できなかったものです。誰のエージェントか、何を許されているか、何かあったとき誰が責任を持つのかが分からないまま応答しています。",
      unverified: "件数", allowed: "そのまま通った", friction: "既存の摩擦がかかった", denied: "拒否した",
    },
    north: {
      title: "検証済みの行為（Verified Actions）",
      lead: "Web Bot Auth の署名を Gate が検証できたリクエストです。",
      verified_actions: "検証済みの行為", verified_agents: "検証済みのエージェント（識別子の数）",
    },
    classes: {
      title: "自動化の内訳",
      events: "自動化のリクエスト（合計）",
      VERIFIED: "VERIFIED：署名を検証できた",
      UNVERIFIED: "UNVERIFIED：署名はあるが、鍵を取得できず帰属できない",
      SPOOFED: "SPOOFED：名乗った身元を証明できなかった（偽装）",
      REVOKED: "REVOKED：失効した身元",
      DECLARED: "DECLARED：User-Agent で名乗ったが、署名がない",
      SUSPECTED: "SUSPECTED：自動化の兆候がある",
    },
    decisions: { title: "Gate の判定", allow: "通した", friction: "既存の摩擦をかけた", deny: "拒否した" },
    kinds: {
      title: "何をしに来たか（経路の種類別）",
      head: ["経路の種類", "自動化", "うち検証済み", "拒否"],
      none: "この日の自動化はありませんでした。",
      names: { checkout: "決済", login: "ログイン", signup: "登録", account: "アカウント", form: "フォーム", search: "検索", api: "API", asset: "静的ファイル", browse: "閲覧", malformed: "形式不明" },
    },
    agents: { title: "検証済みのエージェント（上位）", head: ["エージェント", "行為"], none: "検証済みのエージェントはいませんでした。" },
    routes: { title: "未検証の自動化が多かった重要経路", head: ["経路（テンプレート）", "件数"], none: "ありませんでした。" },
    pressure1: {
      title: "Pressure 1 にした場合の見込み",
      lead: "いま Pressure 0 の経路に来た自動化の見込みです。Pressure 1 では、未検証の自動化にだけ、サイトに既にある摩擦（CAPTCHA など）がかかります。検証済みのエージェントは摩擦を免除され、人間の訪問は変わりません。",
      friction: "摩擦がかかるリクエスト", exempt: "摩擦が免除されるリクエスト（検証済み）",
      already: "すべての経路が、すでに Pressure 1 以上です。",
    },
    previous: {
      title: "前日との比較",
      head: ["指標", "前日", "増減"],
      events: "自動化のリクエスト", verified_actions: "検証済みの行為", critical_unverified: "重要経路に触れた未検証の自動化", spoofed: "名乗りの偽装（SPOOFED）",
      none: "前日のデータはありません。",
    },
    input: { title: "入力", skipped: "読めなかった行（数えていません）" },
    footer: "このレポートは、Gate が送ったメタデータ（時刻、経路のテンプレート、メソッド、分類、判定、検証済みエージェントの識別子）だけから作っています。IP アドレス、クエリの値、本文、クッキーは含みません。",
    link: "Gate の設定",
  },
  en: {
    title: "Ludion daily report",
    subject: (s, n, m) => `[Ludion] ${s.site} ${s.date}: ${n} unverified automated requests on critical routes, ${m} verified actions`,
    meta: (s) => `${s.site} · ${s.date} (${s.tz})`,
    critical: {
      title: "Unverified automation on critical routes",
      lead: "Automated requests to checkout, login, sign-up and account routes, and every write (POST, PUT, PATCH, DELETE), whose signature could not be verified. Each was answered without knowing whose agent it was, what it was allowed to do, or who is accountable if something goes wrong.",
      unverified: "Requests", allowed: "Let through", friction: "Met existing friction", denied: "Refused",
    },
    north: {
      title: "Verified actions",
      lead: "Requests whose Web Bot Auth signature the Gate verified.",
      verified_actions: "Verified actions", verified_agents: "Verified agents (distinct identifiers)",
    },
    classes: {
      title: "Automation by class",
      events: "Automated requests (total)",
      VERIFIED: "VERIFIED: signature verified",
      UNVERIFIED: "UNVERIFIED: signed, but the key could not be found, so not attributable",
      SPOOFED: "SPOOFED: claimed an identity it could not prove",
      REVOKED: "REVOKED: revoked identity",
      DECLARED: "DECLARED: named itself in the User-Agent, unsigned",
      SUSPECTED: "SUSPECTED: signs of automation",
    },
    decisions: { title: "What the Gate decided", allow: "Allowed", friction: "Existing friction applied", deny: "Refused" },
    kinds: {
      title: "What it came for (by route kind)",
      head: ["Route kind", "Automation", "Verified", "Refused"],
      none: "No automation on this day.",
      names: { checkout: "Checkout", login: "Login", signup: "Sign-up", account: "Account", form: "Forms", search: "Search", api: "API", asset: "Static files", browse: "Browsing", malformed: "Malformed" },
    },
    agents: { title: "Top verified agents", head: ["Agent", "Actions"], none: "No verified agents." },
    routes: { title: "Critical routes most hit by unverified automation", head: ["Route (template)", "Requests"], none: "None." },
    pressure1: {
      title: "If you move to Pressure 1",
      lead: "An estimate for automation that reached routes now at Pressure 0. At Pressure 1, only unverified automation meets the friction your site already has (a CAPTCHA, for example). Verified agents skip it, and human visits do not change.",
      friction: "Requests that would meet friction", exempt: "Requests that would skip it (verified)",
      already: "Every route is already at Pressure 1 or above.",
    },
    previous: {
      title: "Compared with the previous day",
      head: ["Metric", "Previous day", "Change"],
      events: "Automated requests", verified_actions: "Verified actions", critical_unverified: "Unverified automation on critical routes", spoofed: "Spoofed identities (SPOOFED)",
      none: "No data for the previous day.",
    },
    input: { title: "Input", skipped: "Unreadable lines (not counted)" },
    footer: "This report is built only from the metadata the Gate sent (time, route template, method, class, decision, and verified agents' identifiers). It contains no IP addresses, query values, bodies or cookies.",
    link: "Gate settings",
  },
};

export const LANGS = Object.keys(STRINGS);
