# STATE（レーン 2）

最終更新：2026-10-03（Claude Code、レーン 2。作業ツリーは `C:\Users\haya0\ludion-lane2`）

## 担当

人間の指示（2026-10-03）。もう1本のレーン（`C:\Users\haya0\ludion`）は GATE-8 → npm の公開の仕組み → `@ludion/gate-*` の公開。ぶつからないように分けている。

- **1. tracecheck.dev の計測**（最優先）：Pressure 0 の Gate を、ゾーンの Worker ルートで tracecheck.dev の前に立てる。tracecheck のコードは変えない。データは tracecheck のアカウントの中に貯め、毎朝 1 枚のレポートを出す。デプロイは人間がする（別のアカウントで、Claude の鍵は届かない）。
- **2. ローンチの文書**：README、docs のクイックスタート、/scan の「サンプルのログで試す」ボタン（`site/` の中）。
- 触らない：`packages/gate-*` の既存のコード、`scripts/`、`.github/`、`docs/STATE.md`。Gate の本体に変更が要るときは `docs/outbox/` に提案を置く。
- オラクルの追加（`accept/registry.mjs`、`docs/MISSION.md`）は、まとめて 1 回の PR にする。
- ローンチは 2026-10-13（火）22:00 JST。それまでに tracecheck.dev の 7 日分のデータが要る。

### PR の決まり（人間、2026-10-03 の午後から）

- 必須のチェックは `loop` だけ。`loop-windows` は待たない（Windows は夜間のジョブ。担当は 1 本目）。
- 「最新の main に追従してからマージ」は外す（人間）。マージの後の main の CI が赤なら、それを最優先で直す。
  - 2026-10-03 11:00 の時点では、API ではまだ `strict: true` だった。それまでは `gh pr update-branch` を続ける。
- 関連する変更は 1 本の PR にまとめる。1 つのレーンで同時に開く PR は 2 本まで。
- auto-merge を付けたら、CI を待たずに次の仕事に進む。結果は次の区切りで見る。

## 現在地

- **tracecheck.dev の計測**：仕組みは main に入った（#81）。デプロイは人間待ち（下）。
  - `pilots/tracecheck/`：Worker、D1、毎朝の cron、テスト、手順（`DEPLOY.md`）。
  - デプロイ用のチェックアウト `C:Usershaya0ludion-tracecheck`（`npm ci` 済み）を人間に渡した。
  - 速いテスト（`pilot.test.mjs`、`npm test`）：仕込んだ 6 つの故障をすべて捕まえた（人を記録する、ヘッダーを足す、本文を読まない、passThroughOnException を外す、レポートの日を間違える、生の User-Agent を残す）。
  - workerd：本物の `wrangler.jsonc` と束ねた Worker を `wrangler dev` で、スタブのサイトの前に立てた。サイトのバイトとヘッダーがそのまま返り、D1 には自動化だけが入り、cron がレポートを送る。
- **ローンチの文書**：
  - README（#83）：リポジトリに README がなかった。
  - /scan のサンプル（#82）：SCAN の nginx のコーパスと同じファイルを配り、ドロップと同じ道で読む。WEB-4 を強化した。
  - クイックスタート（#84）：`/quickstart` と `/ja/quickstart`。サイト（Express と Gate、受領証で DECLARED と UNKNOWN）とエージェント（init、sign、VERIFIED）。
- **オラクル**（`lane2/oracles`、#81〜#84 のマージ待ち。まとめて 1 回の PR）：
  - WEB-10（±、L1）：クイックスタートのページが書いてあるとおりに動く。ページのブロックを順に、公開セットの tarball で実行し、出力がページと一致する。エージェントの署名は、init が書いたディレクトリを持つ Gate で VERIFIED。仕込んだページの故障 3 つ（違う出力、Gate の行を消す、sign の行を変える）を捕まえた。WEB-7 は開いたまま（Next.js、Workers、FastAPI、WordPress、Python の分が残る）。
  - PILOT-1（±、L1）：パイロットの Node のテストと workerd。
  - PILOT-2（+、L2）：tracecheck.dev の直近 7 日。人間の読み取り用トークン待ち（`pilots/tracecheck/live.mjs`）。
  - ラチェットは、#82〜#84 がマージされてから、main の上で scoreboard を回して固める（WEB-1 のためにプレビューを出し直す）。

## 決めたこと

- **データは D1**（Analytics Engine ではない）。毎朝の cron がバインディングから直接読める。Analytics Engine を読むには、アカウントの API トークンを Worker の秘密に入れる必要があり、人間の手順が増える。
- **応答には一切触らない**。`fetch(request)` の Response をそのまま返し、Gate は `ctx.waitUntil` の中で後から見る。
  - そのため、エージェントへの受領証（`Ludion-Receipt`）は付かない。付けると、エージェントへの応答が変わる。計測が目的なので外した。
  - Pressure 0 以外と `report.endpoint` を持つ設定は拒否する（Gate だけが止まり、サイトは動く）。
- **記録する追加の欄**：DECLARED の運営者、SUSPECTED の兆候、署名が通らなかった理由、Signature-Agent のホスト、署名の寿命、nonce の有無。どれも固定の語、ホスト名、数だけ。
  - 寿命と nonce を残すのは GATE-8 のため。#79（案 A）で、Gate は寿命 1 時間までを、60 秒を超えるものは nonce 付きで受け入れる。本物のエージェントがどの寿命で、nonce を付けて署名してくるかを、tracecheck で見られる。
  - IP のハッシュは残さない。レポートが使わないし、/24 と公開の塩では逆算できる。
- ルートの Worker が Custom Domain や Pages の前に走ることは、Cloudflare の文書で確かめた（Routes の節：「Routes can fetch() Custom Domains and take precedence if configured on the same hostname」）。

## 人間待ち

- [ ] **tracecheck.dev へのデプロイ**（`pilots/tracecheck/DEPLOY.md`、15 分）。
- [ ] 手順 0 の数字 2 つ：Workers のプラン（Free か Paid か）、tracecheck.dev の 1 日のリクエスト数。
  - Free で 1 日 10 万を超えるなら、静的ファイルの経路をルートから外す（`/_astro/*` などに Worker なしのルート）か、Paid にする（お金なので人間の判断）。
- [ ] （任意）毎朝のレポートの Discord の Webhook（`REPORT_WEBHOOK_URL`）。
- [ ] PILOT-2 のトークン：tracecheck のアカウントで、D1 を読むだけの API トークン（`TRACECHECK_D1_READ_TOKEN`）、Account ID（`TRACECHECK_ACCOUNT_ID`）、D1 の ID（`TRACECHECK_D1_ID`。`npx wrangler d1 info ludion-tracecheck`）。ローンチの前に 7 日分を確かめる。
- [ ] `SECURITY.md` を読む（会社の約束が入っている。前からある文で、レーン 2 は変えていない）。
  - `docs/THREATS.md` を指しているが、そのファイルはない。
  - `security@ludion.ai` で「24 時間以内に返事」と約束している。`privacy@ludion.ai` と同じく、メールが届く設定がまだない。
  - 「72 時間以内に事後報告」「Gate が 1,000 を超えたらバグ報奨金」。

## 既知の問題

- Free の CPU（10 ms）：Gate は 1 リクエスト約 0.1 ms。毎朝のレポートは、自動化が 1 日 1 万件で約 10 ms（Node で測った値）。超えた日は、データを引いて手元の `ludion report` で作る。
- `www.tracecheck.dev` は DNS only で Vercel を向き、証明書が切れている（2026-10-03 に外から見た）。Gate は www には立たない。

## 次の一手

1. 人間がデプロイしたら、D1 に行が入っているかを一緒に確かめる（手順 5 の結果をもらう）。
2. #82 と #84 は auto-merge 済み（#83 はマージ済み）。
3. `lane2/oracles` を main に合わせ、プレビューを出し直し、scoreboard を回し、`npm run ratchet`（WEB-10、PILOT-1）を入れて PR にする。
4. 対のない正のオラクルに負を足す（STATE.md の「次の一手」2）のうち、レーン 2 の範囲のもの：WEB-4（ブラウザ版 scan）。
