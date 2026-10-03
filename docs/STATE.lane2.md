# STATE（レーン 2）

最終更新：2026-10-03（Claude Code、レーン 2。作業ツリーは `C:\Users\haya0\ludion-lane2`）

## 担当

人間の指示（2026-10-03）。もう1本のレーン（`C:\Users\haya0\ludion`）は GATE-8 → npm の公開の仕組み → `@ludion/gate-*` の公開。ぶつからないように分けている。

- **1. tracecheck.dev の計測**（最優先）：Pressure 0 の Gate を、ゾーンの Worker ルートで tracecheck.dev の前に立てる。tracecheck のコードは変えない。データは tracecheck のアカウントの中に貯め、毎朝 1 枚のレポートを出す。デプロイは人間がする（別のアカウントで、Claude の鍵は届かない）。
- **2. ローンチの文書**：README、docs のクイックスタート、/scan の「サンプルのログで試す」ボタン（`site/` の中）。
- 触らない：`packages/gate-*` の既存のコード、`scripts/`、`.github/`、`docs/STATE.md`。Gate の本体に変更が要るときは `docs/outbox/` に提案を置く。
- オラクルの追加（`accept/registry.mjs`、`docs/MISSION.md`）は、まとめて 1 回の PR にする。
- ローンチは 2026-10-13（火）22:00 JST。それまでに tracecheck.dev の 7 日分のデータが要る。

## 現在地

- `pilots/tracecheck/`：Worker、D1、毎朝の cron、テスト、手順（`DEPLOY.md`）。PR は `lane2/tracecheck-pilot`。
  - 速いテスト（`pilot.test.mjs`、`npm test` に入れた）：11 件。仕込んだ 6 つの故障をすべて捕まえた。
    - 人を記録する、ヘッダーを足す、本文を読まない、passThroughOnException を外す、レポートの日を間違える、生の User-Agent を残す。
  - workerd（`workerd.test.mjs`）：本物の `wrangler.jsonc` と束ねた Worker を `wrangler dev` で、スタブのサイトの前に立てた。人にもエージェントにも、サイトのバイトとヘッダーがそのまま返る。サイトには本文の全バイトが届く。D1 には自動化だけが入り、cron がレポートを Webhook に送る。
  - オラクル（PILOT-1）はまだ registry に入れていない。レーン 2 のオラクルをまとめる PR で入れる。

## 決めたこと

- **データは D1**（Analytics Engine ではない）。毎朝の cron がバインディングから直接読める。Analytics Engine を読むには、アカウントの API トークンを Worker の秘密に入れる必要があり、人間の手順が増える。
- **応答には一切触らない**。`fetch(request)` の Response をそのまま返し、Gate は `ctx.waitUntil` の中で後から見る。
  - そのため、エージェントへの受領証（`Ludion-Receipt`）は付かない。付けると、エージェントへの応答が変わる。計測が目的なので外した。
  - Pressure 0 以外と `report.endpoint` を持つ設定は拒否する（Gate だけが止まり、サイトは動く）。
- **記録する追加の欄**：DECLARED の運営者、SUSPECTED の兆候、署名が通らなかった理由、Signature-Agent のホスト、署名の寿命、nonce の有無。どれも固定の語、ホスト名、数だけ。
  - 寿命を残すのは GATE-8 のため。今の Gate は寿命 60 秒超の署名を SPOOFED にする（ChatGPT agent は 3600 秒だった）。GATE-8 が入る前の日の記録も、あとで読み直せる。
  - IP のハッシュは残さない。レポートが使わないし、/24 と公開の塩では逆算できる。
- ルートの Worker が Custom Domain や Pages の前に走ることは、Cloudflare の文書で確かめた（Routes の節：「Routes can fetch() Custom Domains and take precedence if configured on the same hostname」）。

## 人間待ち

- [ ] **tracecheck.dev へのデプロイ**（`pilots/tracecheck/DEPLOY.md`、15 分）。
- [ ] 手順 0 の数字 2 つ：Workers のプラン（Free か Paid か）、tracecheck.dev の 1 日のリクエスト数。
  - Free で 1 日 10 万を超えるなら、静的ファイルの経路をルートから外す（`/_astro/*` などに Worker なしのルート）か、Paid にする（お金なので人間の判断）。
- [ ] （任意）毎朝のレポートの Discord の Webhook（`REPORT_WEBHOOK_URL`）。

## 既知の問題

- GATE-8 が main に入るまで、本物の ChatGPT agent の署名は SPOOFED と記録される（`reason` は `invalid_signature`、`sig_lifetime` は 3600）。GATE-8 が入ったら、tracecheck の Worker を出し直す。
- Free の CPU（10 ms）：Gate は 1 リクエスト約 0.1 ms。毎朝のレポートは、自動化が 1 日 1 万件で約 10 ms（Node で測った値）。超えた日は、データを引いて手元の `ludion report` で作る。
- `www.tracecheck.dev` は DNS only で Vercel を向き、証明書が切れている（2026-10-03 に外から見た）。Gate は www には立たない。

## 次の一手

1. 人間がデプロイしたら、D1 に行が入っているかを一緒に確かめる。
2. ローンチの文書：README、docs のクイックスタート、/scan の「サンプルのログで試す」ボタン。
3. レーン 2 のオラクルをまとめた PR：PILOT-1（workerd）、tracecheck の 7 日分（LIVE、人間のトークンが要る）、ローンチの文書。
