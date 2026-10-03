# STATE

最終更新：2026-10-03（Claude Code、1本目のレーン。GATE-8 の案 A #79 のあと、CI の分割と夜間のジョブ、LOOP-2 の配線）

## 現在地

- 段：M4（SCAN-1〜4、RPT-1）は完了。
  - M0：LOOP-2（CI を10分以内）だけが残り。
  - M1：残りは STD-3、GATE-9（GATE-8 は案 A で PASS）。
  - M2：DIV-2/3/4 と PUB-1/2/3 まで（DIV-1 が残り）。
  - M3：REG-2/4 まで。
  - M5：PRS-1〜4、NEUT-1/2、CRY-1 まで。
- 2026-10-03 から、レーンは2本（人間の指示）。ぶつからないように担当を分けている。
  - **1本目**（このファイル、作業ツリー `C:\Users\haya0\ludion`）：GATE-8 → CI を10分以内（B1、LOOP-2）と夜間のジョブ → npm の公開の仕組み → `@ludion/gate-*` の公開。夜間のジョブ（Windows）の面倒も見る。
  - **2本目**（`docs/STATE.lane2.md`、作業ツリー `C:\Users\haya0\ludion-lane2`）：tracecheck.dev の計測、ローンチの文書（README、クイックスタート、/scan のサンプル）。
  - プレビューは1つを2本で共有する。どちらかが出し直すと、もう片方の手元の WEB-1 は「古い」で落ちる。
  - 夜勤（`C:\Users\haya0\ludion-night`、`.loop/NIGHT.md`）は 2026-10-01 08:48 に終わった。もう動かない。
- **サイト**：プレビュー https://ludion-site-preview.ludion-agents.workers.dev （エージェント用のアカウント `Ludion Agents`、WEB-1 PASS）。本番（ludion.ai）への切り替えは人間（docs/DEPLOY.md §3）。
  - **Claude はプレビュー以外にデプロイしない**（2026-10-01、人間の決定）。本番への最初のデプロイ、ludion.ai の付け替え、DNS、旧資源の削除は人間がやる。
  - エージェントのトークン（`~/.config/ludion/cloudflare.env`）は `Ludion Agents` にしか効かない。本番のアカウントは読み取りでも 403（DEPLOY.md §5.3）。
  - `npm run deploy:preview` は、デプロイの前に毎回この境界を確かめ、外れていれば止まる（DEPLOY.md §2）。
- ループの仕組みは Linux/Node 22 と Windows/Node 24 の両方で回る。Windows は夜間（03:00 JST）だけ。
- リポジトリは https://github.com/Ludion-ai/Ludion （public）。main は保護されている：PR 必須、`loop` チェック必須、enforce_admins、auto-merge 可。strict は 2026-10-03 に人間が外した（main に追従しなくてもマージされる）。
  - push と PR の CI：`loop-shard (1/4)`〜`(4/4)`（`loop` のオラクルを4つに分けて並列）、`loop`（必須。分割を統合して、ベースのラチェットで判定）、`preview`（プレビューに出してから WEB-1。人間が secret を登録するまで赤。人間待ち）。
  - 夜間（schedule と手動の workflow_dispatch）：`nightly-windows`（同じ `loop` を Windows/Node 24 で）、`nightly`（LOOP-2：main の最新の push の実行を測る）。
  - ラチェット済みのオラクルは PASS 以外すべて退行（LOOP-4）。読めないベースは止まる（LOOP-3）。
- 数字は `npm run scoreboard` が正。ここには書き写さない。

## 次の一手

次のセッションは、この順に進める。

1. **LOOP-2**（CI のフル実行が10分以内）：分割と夜間のジョブを入れた（下の「直近のセッション」）。新しい構成の push の実行は 4:14（6ジョブ）で、FAIL の理由は `preview` が赤いことだけ。残りは2つ。
   - 分割の重み（`scripts/shard-weights.json`）を、CI の実測（`node scripts/shard.mjs --weights shard-*.json`）に置き換える。
   - `preview` ジョブ：WEB-1 だけで手元 9 分（28ページ × Lighthouse 3回）。secret が入ると LOOP-2 を越える。測り方の決めは人間待ち。
2. **npm の公開の仕組み**：release ワークフローと PUB-4 を入れた（直近のセッション）。次は `@ludion/gate-*` の公開の準備（人間が最初の版を出すときに詰まらないように、PUBLISH.md の手順を1本道にする）。
3. ~~対のない正のオラクルに負のオラクル~~：済み（SCAN-5、SCAN-6、GATE-13、WEB-10。#88 と次の PR）。UNPAIRED は0。
4. **揺れの見張り**：WEB-1 と WEB-9 は Lighthouse を各ページ3回の中央値で測るようにした（閾値は95のまま）。GATE-1 の失敗は揺れではなく、共有のキャッシュの壊れだった（直した）。CI でまた赤くなったら、#74 の詳細で原因を見て、測り方を直す。
5. 目録の残り（人間待ちでないもの）：WEB-7（ドキュメントをテストに）、PRIV-1/2 の強化（既定の `createSafeFetch` 経由でも回す）、Mandate の共有の記録の複数の機械の参照実装（Durable Object か DB）。
6. 棚上げ（ブランチに残してある。再開は人間の判断）：
   - **B1** は 2026-10-03 に人間の指示で再開し、CI の分割として入れた。PR #63（下書き）は閉じた。プロセス内の並列（`--jobs`）とプロセスツリーの kill は入れていない（理由は「直近のセッション」）。
   - **A と B2**（ラチェットのファイル化、CI の分割）：`fast-loop-shelf`。A は deny ルール（PR #60）を人間が当てるまで入れない。
   - **fail-closed**（`--base` が読めないときに通さない）：#70 の LOOP-3 で入った。`fast-loop-failclosed` はもう要らない。
   - **STD-3 と DIV-1**（`interop/std3-div1`）：CI に setup-python を足す差分の了承待ち。
   - GATE-9 は道具（PHP か `@php-wasm/node`）待ち。

### いつもの決まり

- **待ち時間を減らす決まり**（人間、2026-10-03）：
  1. 必須は `loop` だけ。Windows は待たない（夜間のジョブ。担当は1本目）。
  2. strict は外した。マージの後の main の CI が赤になったら、それを最優先で直す（ラチェットが守る）。夜間のジョブの赤も同じ。
  3. PR はまとめる。関連する変更は1本にし、1つのレーンで同時に開く PR は2本まで。
  4. auto-merge を付けたら、CI を待たずに次の仕事に進む。結果は次の区切りで見る（`gh pr checks`、main の `gh run list --branch main`、夜間の `gh run list --event schedule`）。

- **プレビューのデプロイ**：`npm run deploy:preview` だけ。ホームの差し替えなどの回避策は要らない（2026-10-01 11:00 にやめた）。
  - 資格情報は `~/.config/ludion/cloudflare.env`（`Ludion Agents` のトークンと Account ID）。登録フォームの通知先は `~/.config/ludion/signup.env` から、デプロイと一緒に入る。
  - `npx wrangler secret put` を手で使わない。wrangler は `cloudflare.env` を読まないので、ターミナルの別の資格情報で別のアカウントに入れてしまう。
  - Claude はプレビュー（`ludion-site-preview`）以外にデプロイしない。本番、ludion.ai の付け替え、DNS、削除は人間。
- **WEB-1 の注意**：WEB-1 はラチェット済み。サイト（`site/` の下のファイル。`site/deploy.mjs` も含む）を変えたら、プレビューを出し直すまで、手元の scoreboard では WEB-1 が「古い」で落ちる。CI では `preview` ジョブがデプロイしてから回す（`loop` では ELSEWHERE）。
  - プレビューは1つなので、別のブランチのビルドで出したあとは、手元の WEB-1 が落ちる。PR の前に、そのブランチで出し直してから scoreboard を回す。
- GATE-7 に攻撃を足すときは、JSON に `classes`（spec §10.8 の分類）を書く。

- 新しい ADR には番号を付けない。`docs/adr/YYYY-MM-DD-<slug>.md` にする。
- GATE-7 に攻撃を足したら `node accept/conformance/export.mjs` を回す（GATE-10）。STD-2 にテストを足したときも同じ。
- 同じ作業ツリーで、複数のセッションを動かさない（2026-10-01 朝の事故）。
- 揺れるオラクルは、壊れているのと同じ扱い（人間の決定、2026-10-02）。赤を無視する癖を作るから。閾値は下げず、測り方（中央値、単独で回す、Windows で回さない、共有の状態を壊さない）を直す。
- オラクルどうしで共有する状態（参照アプリのキャッシュなど）を、別のオラクルが書き換えたまま去らない。使う側は、使う前に中身が完全かを確かめる。
- 秘密のファイルはリポジトリの外（`~/.config/ludion/`）に置く。`*.env` は `.gitignore` にある。

## 人間待ち

- [ ] **判断（LOOP-2 と `preview` ジョブ）**：WEB-1 は手元で 9 分（28ページ × Lighthouse 3回、プレビューの URL へ）。secret が入ると、`preview` ジョブだけで LOOP-2 の10分を越える。Lighthouse を同じ機械で並べると揺れるので、分けるなら別のランナー。ただしプレビューは1つの Worker なので、デプロイとその検査を、複数のジョブにまたがって1つの鍵で守る必要がある。
  - 案 B（推す）：`preview` は main への push の後だけで回し、WEB-1 の Lighthouse を3つのランナーに分ける（ワークフロー単位の鍵）。プレビューはいつも main を見せる。PR では、同じ成果物を workerd で測る WEB-9 が守る。決まり2（マージ後の赤は最優先）と同じ形。「secret が入ったら `preview` を PR の必須チェックにする」の予定は取り下げになる。
  - 案 A：PR でも回し、同じく分ける。両レーンの PR がプレビューの鍵を待ち合い、その待ちが main の LOOP-2 に入る日がある（揺れる）。
  - どちらにしても、LOOP-2 が PASS するのは secret が入ってから。

- [ ] **CI の `preview` ジョブの secret**（人間がトークンを作って登録すると決めた）：`CLOUDFLARE_PREVIEW_API_TOKEN`（`Ludion Agents` の Workers Scripts の編集だけ）と `CLOUDFLARE_PREVIEW_ACCOUNT_ID`。登録したら、`preview` を main の必須チェックに足す。それまで `preview` は赤で、WEB-1 は CI で強制されない（前も SKIP で強制されていなかった）。
- [x] 確認（#69、2026-10-02 に人間が確認）：ルートの重なりの読み。「一番厳しいものが勝つ」を、一致する全てのルートの最高の Pressure と、要件の全部を合わせる（Depth は最大、Ballast、scope は全部）と読んだ。一つを選ぶより厳しくなる場合がある。この読みで正しい（Pressure と Depth は最大、Ballast はどれかが求めれば必須、scope は全部）。
- [x] 確認（#71、2026-10-02 に人間が確認）：「上限付きの Mandate を受け付けない」を、数える上限（`per_day`）のある Mandate の決済を拒否する、と読んだ。`checkout_max` と通貨は記録なしでどの Gate でも効く。正しい。加えて、期間の中で累計する上限（1日の合計金額など）も記録が要り、無ければ拒否。v0 が強制できない上限は、記録があっても拒否する（`unenforceable_limit`、PRS-3）。
- [x] Codex の検証器の監査（10件）：全部採用。#69（5、6、7、8）、#70（1、2、3、9、10、対の意味）、#71（4）、#73 と #76（4 の実装の CI で見つけたバグ）。追加のオラクル案7件も採用（LOOP-3、LOOP-4、STD-5、PRS-3、GATE-11、GATE-12、PRS-4）。
- [x] 判断（GATE-8）：2026-10-01 朝、人間が案 A を条件付きで承認した。2026-10-03 に入れた（条件 a：2件の nonce は別々、条件 b：1時間の nonce の攻撃2つを GATE-7 に足して PASS。docs/adr/2026-10-01-real-chatgpt-agent-signs-for-an-hour.md の「実施」）。
- [x] **エージェント用の Cloudflare アカウントへ移す**（DEPLOY.md §5.2 の 1〜4）：2026-10-01 11:00。プレビューは https://ludion-site-preview.ludion-agents.workers.dev 、WEB-1 PASS。境界は §5.3。
- [ ] **移したあとの後始末**（DEPLOY.md §5.2 の手順 5、人間）：
  - 本番のアカウントの `ludion-site-preview`（前のプレビュー）を消す。通知先の秘密が入っているので、残すとそのフォームからも通知が届く。エージェントのトークンではもう見えない。
  - 古いトークン 2 本の失効を、ダッシュボードで確かめる。ターミナルの「前からある方」は 11:05 に 401 を返した（失効したと見える）。09:00 に置いたものは確かめられない。
  - Claude を起動したターミナルの窓を閉じる（環境変数に古いトークンの値が残っている）。
  - wrangler のログインは 11:05 に消えていた。済み。
- [ ] **`privacy@ludion.ai` でメールが届くようにする**（Cloudflare の Email Routing、人間がやる）。登録フォームの告知が、削除の宛先として案内している。
- [ ] **ludion.ai を新しいサイトに切り替える**（docs/DEPLOY.md §3、15分、クリック単位）。旧は Worker `ludion` のカスタムドメイン。`ludion-site` を作って付け替える。
- [ ] **旧資源の削除**（docs/DEPLOY.md §1.3、Ludion の16件だけ）。消す前に：
  - 提供元で秘密を失効させる：`ludion-api` の OpenAI と楽天のキー、`ludion-fallback-relay` の `PROVIDER_API_KEY`、`ludion` の GitHub OAuth アプリ。Worker を消してもキーは生きている。
  - D1 3つ、KV 2つ、R2 2つの中身を書き出す。提出物や登録者の情報なら、残すか消すかを決める。
  - `chat-app-relay`（Worker）は Ludion のものか判断できなかった。リストに入れていない。
- [ ] **npm の publish**（docs/PUBLISH.md、人間が 2026-10-01 にやると言った）
  - **`ludion` だけを先に出せる**（#75、PUB-3）：tarball が CLI のコードを同梱し、`@ludion/*` が npm に一つもなくても入る。組織 `@ludion` も要らない。手順は PUBLISH.md §0.5。
  - `@ludion/gate-*` は、セキュリティの4件（#69）が入ったので出せる状態。出すかは人間の判断。出すときは先に組織 `ludion` を作り、表の順に出す。
  - **2版目からは release ワークフロー**（PUB-4、PUBLISH.md §6）：最初の版を手で出したあと、パッケージごとに trusted publisher を設定し、GitHub に environment `npm`（承認者＝人間、Prevent self-review、main だけ）を作る。手順は §6.1。
  - 注意：Claude の `gh` は人間と同じアカウント `Ludion-ai`。environment の承認の関所は、同じアカウントのトークンからは区別できない。切り離すなら、Claude に別のアカウントか、Actions の承認ができない細かいトークンを渡す（PUBLISH.md §6.1）。
- [ ] **main のブランチ保護の strict**：2026-10-03 に外したと聞いたが、API では `required_status_checks.strict: true` のまま（#86 が BEHIND で auto-merge されずに止まり、`gh pr update-branch` で通した）。ルールセットは無い。外すのは人間（設定は触らない）。
- [ ] npm `ludion` と `@ludion`、PyPI `ludion` の確保（2026-09-30 時点で全て空き。匂わせ投稿の前に）
- [x] リポジトリの公開設定の判断 → public、`Ludion-ai/Ludion`（2026-09-30）
- [x] main のブランチ保護：PR 必須、`loop` チェック必須、auto-merge 許可（2026-09-30。strict と enforce_admins も付けた）
- [x] `CLOUDFLARE_API_TOKEN`：2026-10-01 朝、前からあるトークンが通るようになった。プレビューのデプロイ（WEB-1）に使った。LIVE-1（canary）はまだ。
- [x] 旧 Ludion の Cloudflare 資源の棚卸し：2026-10-01 09:03、`node scripts/cf-inventory.mjs`（GET だけ）。結果は docs/DEPLOY.md §1.3。
- [ ] 判断（お金）：Card Host の `*.agents.ludion.ai` は2段目のワイルドカードで、Universal SSL の範囲外。
  - 選択肢：Advanced Certificate Manager（有料）、名前を `dvr-….ludion.ai` に寄せる（spec の変更）、別のドメイン。
  - 詳細は docs/DEPLOY.md 4。
- [ ] `SIGNUP_WEBHOOK_URL` → LP の登録通知（Discord の incoming webhook）
  - プレビューには入っている（`~/.config/ludion/signup.env` から、デプロイと一緒に。DEPLOY.md §2）。試しの送信はしていない。
  - 本番の `ludion-site` には、人間が DEPLOY.md §3 の手順 1 で入れる。
  - 無いあいだ、デプロイしたフォームは「送信できませんでした」と答える（503）。受け取ったふりはしない。
- [ ] 判断：WEB-8 は「プレビューで送信すると」を、プレビューに出す成果物（`site/edge`）を手元の workerd（`wrangler dev`）で動かして測った。通知先はスタブ。
  - プレビューは出ている。ただ、通知先は本物の Discord なので、検査から送ると人に届く。
  - これを PASS と読んでよいか。だめなら、プレビューが出たあとに同じ検査をプレビューの URL に向ける。そのためには、プレビュー用の webhook（観測できる通知先）が要る。
- [x] 登録フォームの文面：2026-10-01 に人間が承認した（保存は「先行登録のご案内が終わるまでか、削除のご依頼を受けるまで」、削除の宛先は privacy@ludion.ai）。
- [ ] （以下は承認前のメモ）登録フォームの文面を読む（`site/src/signup/strings.mjs`、トップの「先行登録」の節）。
  - 「入力された内容は Ludion のチームに届き、Ludion についてのご連絡に使います」は、個人情報の利用目的の表示にあたる。会社としての約束になる。
  - プライバシーポリシーはまだない（spec §21）。
- [ ] 商標の調査（区分 9、42、45）
- [ ] （任意）見込み客の了承を得た本物のアクセスログ。scan のコーパスは今は合成データだけ。本物が 1 本あれば、それが一番良い次のフィクスチャになる。`accept/fixtures/logs/` に入れる前に匿名化の方針を決める。
- [ ] 判断：fail_mode "closed" の拒否は今 `signature_required`（401）で返している。署名済みの正規エージェントには紛らわしい。専用のコード（例：503 `gate_unavailable`）を spec §10.11 に足すか（ADR-020）。
- [ ] 判断：GATE-1 は Next.js のビルド成果物の名前の変化を「一貫した改名」に限って許している（`reference/test/gate1.test.mjs` の `NORMALISATIONS`）。原因は proxy.js を足すとクライアントのチャンク名が 2 つ変わること。これを「バイト単位で一致」と読んでよいか（#25）。
- [ ] 判断：日次レポートの metadata event に `operator` を足すか。足せば DECLARED の運営者別の上位を出せる。ただし spec §11.7 の送信項目が変わる（#28）。
- [ ] 日次レポートの送信基盤：送信サービス、送信ドメイン、SPF/DKIM/DMARC、配信停止。`ludion report` は中身を作るだけで、送信はしない。
- [ ] GATE-9 の PHP と WordPress を進めるための道具（どちらか）：
  - この機械に PHP（ext-sodium 付き）を入れる。夜勤の権限では `php` を実行できなかった。
  - あるいは、テストだけで使う依存として `@php-wasm/node`（WordPress Playground の PHP を WebAssembly にしたもの。GPL-2.0-or-later、Automattic）を足してよいか。夜勤の権限では新しいパッケージの `npm install` ができなかった。これがあれば、Linux と Windows の CI で同じ PHP と本物の WordPress を回せる。
  - GATE-9 はさらに STD-3 の相互運用表を要る（元のレーンの `interop/std3-div1` が人間の了承待ち）。
- [ ] 判断：STD-4 は、新しい版が出たら issue の文面を出力に載せるだけで、GitHub に issue は立てない（公開リポジトリへの書き込みなので）。CI から自動で立ててよいか。
- [ ] 判断（Mandate v0、docs/adr/2026-10-01-mandate-v0-passkey-consent-and-site-charge.md）：
  - 上限超え（金額、通貨、日ごとの回数）は、新しいコードを足さずに `mandate_scope`（spec §10.11「委任の範囲外」）で返し、理由は `reason` に入れた。専用のコード（例：`mandate_limit`）が要るなら spec §10.11 の変更になる。
  - 同意のときだけ、Registry は Principal からサイト（`aud`）を聞く。持つのはハッシュ、発行者、Diver、期限だけ。不変条件8「Registry は行き先を知らない」の読みとして、これでよいか。
  - カテゴリの Mandate（`cat:ecommerce`）は、サイトの自己申告で効き、同じ仮名がそのカテゴリのサイトすべてに見える。v0 に残すか、サイト限定にするか。
- [ ] 判断：nonce なしの同一署名を、同じメソッドと URL へ再送したら SPOOFED にしている（GATE-7、PR #4）。正規のリトライも弾く。これを受け入れるか、`requireNonce` を既定にするか。
- [ ] 本番公開の前に：`/e/<code>` の文面（`site/src/content/docs/e/`、`ja/e/`）を読む。会社としての約束が 2 つ入っている。
  - 失効と Depth の引き下げには理由を示し、異議を聞く（spec §8.12）。
  - Ballast v0 は保険ではない（spec §14）。
  - `rate_limited` は spec §10.11 にあるが、Gate v0 は返さない。ページにもそう書いた。
  - WEB-2 で文面を直した。読んで、よければそのまま、だめなら ADR（2026-10-01-copy-check-legal-line-and-figure-sources）に書いて差し戻す。
    - Depth の表の D3 は「保険付きの Ballast（パートナー経由で）」だった。§14 の線にかかるので「Ballast v1（Ludion はまだ提供していません）」にした。spec §13.4 の D3 の定義は変えていない。
    - トップの「一行で入る」（spec §3 の三行の文言）は、測った値（GATE-3：3行以内）に合わせて「コード3行以内で入る」にした。spec §3 も直すかは人間の判断。
    - 「3分で検証済みになる」は測った値ではなく目標（DIV-1 は PENDING）と書いた。DIV-1 が PASS したら「目標」を外せる。
  - `/gate` と `/ja/gate`（Gate の入れ方、`site/src/content/docs/gate.mdx`、`ja/gate.mdx`）も読む。
    - 中身はアダプタの README の Install の写し。新しい約束は足していない。
    - `npm install @ludion/gate-*` は、npm の `@ludion` を確保して publish するまで動かない。
    - scan の CLI、日次レポート、Gate の User-Agent が、すでに `https://ludion.ai/gate` を配っている。

## BLOCKED

（なし）

## 既知の問題

- GATE-8（案 A）：Gate は寿命1時間まで受け入れ、60秒を超える署名には nonce を求める。本物の ChatGPT agent の2件は nonce が別々だったが、同じ1時間の窓で同じ署名を使い回すかは未確認。使い回すなら、2回目以降はリプレイ（SPOOFED）になる。LIVE-2 で連続した本物の要求を取れたら確かめる。nonce キャッシュはプロセスごとなので、複数のインスタンスでは1時間のうちに別のインスタンスへ送り直せる（前は90秒）。
- `ludion doctor` の時計チェックは未実装（ローカル時刻を表示するだけ）。
- 署名された本文（GATE-11）：Node の読み取りは IncomingMessage の `complete`（他のストリームは内部の `_readableState.ended`）に頼る。HTTP/2 の互換 API と Fastify では確かめていない。chunked で0バイトの本文は、Node では `'end'` が先に出る。本文の上限 1 MiB は gate-node だけ変えられる。
- WEB-9 が CI でときどき落ちた（2026-10-01：Windows で3回、Linux で1回）。原因の監査項目は取れていない。各ページ3回の中央値に変えた（閾値は95のまま）。それでも落ちたら、#74 の詳細で原因を見る。
- GATE-1 は、2026-10-02 には毎回落ちていた：GATE-3 が共有の Next.js のキャッシュの `.next` を時計の中で建て直し、途中で止まったまま「準備済み」の印だけが残った。`prepare()` が使う前にビルドを確かめて建て直し、GATE-3 も去る前に建て直すようにした（`reference/test/harness.test.mjs` に降ろした）。
- プレビューのデプロイの境界の確認（`site/deploy.mjs`）が試せるのは、トークンに見えるアカウントだけ。一覧に出ないのに届くアカウントがあっても気づけない。本番の ID を名指しする確認は、2026-10-01 に手で一度だけ行った（DEPLOY.md §5.3）。書き込みは試していない。
- 登録フォームの受け口（`site/edge/signup.mjs`）のレート制限はメモリ内で、インスタンス（isolate）ごと。拠点や isolate に散った連打は、それぞれの枠で数えられる。分散した総当たりはハニーポット頼み。
- 登録フォームは JS がないと送れない（ボタンが押せない）。`<form action>` を置くと WEB-5 のリンクの規則に掛かるため。
- 鍵の発見の SSRF 対策：Node の上のアダプタ（gate-node、gate-next）は、解決先の全アドレスを確かめて固定する（GATE-6、GATE-12）。gate-core を直接使うコードと Deno は、ホスト名の検査だけ（既定の fetch）。Workers はランタイムの fetch。
- Session の秘密鍵は v0 の CLI では `ludion.json` に平文で置いている（spec はメモリのみ）。Root は封をした（ADR-019）が、KMS や OS のキーチェーンのバックエンドはまだない。
- §11.6「P0〜1 では初回の鍵取得を待たない」は未実装。今は timeoutMs の範囲で待つ。
- sink の promise は溜まり続ける。背圧がない。
- 受領証の経路は、まだ `templatePath` のまま（metadata と scan は `publicTemplatePath`）。
- `authorities` を設定していない Gate は、P2〜3 で VERIFIED を Gate の故障として扱い、fail_mode に従う（既定は closed、ADR-023）。導入の README に書いた。LIVE-3 で unpinned の VERIFIED をどう数えるかは未決。
- nonce キャッシュを独立した多数の署名者で埋めると、その間は新しい署名が VERIFIED にならない（DoS であって、すり抜けではない）。
- 設定が壊れているときの挙動がランタイムで違う：Next.js と Workers は素通し、Node は起動時に止まる（ADR-022）。
- Next.js の `redirects()` は proxy より前に走る。Gate はそこで答えたリクエストを見ない。
- nonce キャッシュは容量超過で古い順に捨てる。自前の鍵で大量に送れば、被害者の nonce を追い出せる。プロセスをまたがない。GATE-7 のコーパス候補。
- 署名が 2 つあるリクエストは LabelRequired で丸ごと SPOOFED になる。他の RFC 9421 プロファイル（例：Visa TAP）との共存は STD-3 で検討する。
- scan で未カバーの部分：
  - 公開 IP レンジによる名乗りの偽装（SPOOFED）の検出。レンジ一覧を同梱する必要がある。
  - SCAN-4 は nginx 形式でしか測っていない。JSON 形式（Cloudflare、Vercel、Caddy、Fastly）の速さは未計測。CI は 24.4s、上限は 60s。
  - 経路の語彙は英語だけ。日本語の経路語は `:param` になる。
  - 前提を置いた形式がある：ALB の UA の引用符のエスケープ、IIS の `+`。詳細は `accept/fixtures/logs/README.md`。
- ブラウザ版 scan（WEB-4）で未カバーの部分：
  - 末尾をゼロで埋めた gzip は、CLI（zlib）は読めるが、ブラウザでは読めない。
  - 末尾にゴミのある gzip では、CLI もブラウザも止まる（`incorrect header check`）。
- WEB-5 で未カバーの部分：
  - 見ているのは Chromium だけ。Firefox と Safari のコンソールエラーは見ていない。
  - 外向きのリンクは、ネットワークがなければ「未確認」になり、落ちない。要約に数が出る。今は datatracker の 1 本だけ。
  - 見ているのは静的ホストと同じ規則で配ったサイト（`serve.mjs`）。プレビューや本番のホストの設定（リダイレクト、ヘッダー）は WEB-1 で。
- WEB-6 で未カバーの部分：
  - ヘッドレス Chromium（shell）は preconnect と dns-prefetch を実行しない。NetLog で確かめた。プロキシがあってもなくても、名前の解決が起きない。
    - そのため、リソースヒントはネットワークではなく DOM で見ている（MutationObserver）。HTTP の `Link:` ヘッダーで来るヒントは見ていない。今のサイトは出していない。
  - WebRTC と WebTransport（UDP）は、プロキシもリクエストイベントも見えない。配信したコードがその名前を含まないことで縛っている。名前を隠したコードはすり抜ける。
  - 見ているのは Chromium だけ。Firefox と Safari では回していない。
- WEB-2 で未カバーの部分：
  - 語の一覧と単位の一覧は有限。一覧にない言い換え（「万一のときは全額お支払い」）や、一覧にない名詞を数える数（「3 regions」）はすり抜ける。
  - 出所として認めるのはリポジトリの文書だけ。外部の文書（datatracker など）は、中身をオフラインで確かめられないので認めていない。
  - 日次レポートのメール（`ludion report`）の文面は見ていない。
- `loop-windows` で GATE-3 が一度、29 分の上限まで固まって落ちた（#52 の初回、2026-10-01）。再実行では数秒で通った。変更とは無関係のフレーク。原因は未調査（ログは「no test matched」だけ）。また起きたら、参照アプリのどのプロセスが残っているかを取る。
- STD-4 は、datatracker が読めないと落ちる（3 回まで試す）。CI の再実行で済む。
- `loop-windows` で NEUT-1 が一度落ちた（#59 の初回、2026-10-01）。Node、Deno、workerd はすべて 109/109 を報告したあとで、詳細は `}` だけ。再実行では通った。
  - 見立て：wrangler dev の停止（`server.stop()`）が投げた例外が、トップレベルまで抜けた。確かめてはいない。
  - また起きたら、`accept/neutral/runtimes.mjs` の出力全体を取る。#74 から、scoreboard は FAIL や Error の行を優先して見せる。
- Mandate v0（PRS-2）で未カバーの部分：
  - 同意ページ（ludion.ai）はまだない。PRS-2 のパスキーはソフトウェアの認証器（WebAuthn と同じバイト列を作る）。本物のブラウザ（Chromium の仮想認証器）では、まだ通していない。
  - 発行した Mandate をエージェントに渡す道は決めていない。
  - `charge()` を呼べるのは Node（`req.ludion.charge`）と Workers（`ludion(request).charge`）。Next.js にはまだ道がない（proxy とルートのハンドラが別の場所で動く）。
  - `per_day` はサイトの共有の記録で数える（#71、PRS-3）。参照実装は1台の機械まで（メモリ、SQLite）。複数の機械や Workers は、サイトが同じ契約で自分の DB か Durable Object を渡す（README だけで、参照実装はない）。2つの Gate にそれぞれ `"memory"` を書くと、それぞれで数えてしまう（Gate からは見分けられない）。
  - 購読していない Gate への取り消しは、Staple の `mrev`（最大 32 件）で届く。それより多く取り消した Diver では、古いものが Staple から落ちる（その分は Mandate の期限まで）。
  - Principal の仮名の鍵は Registry の状態ファイルに平文。パスキーの attestation は見ていない。
- DIV-2 で未カバーの部分：
  - TLS は通していない（Host ヘッダーを保ってローカルに転送）
  - web-bot-auth@0.2.0 のパーサが registry-03 に準拠しているか

## 直近のセッション

- 2026-10-03 午後（Claude Code、1本目）：人間の「待ち時間を減らす」決まり1〜4と、B1 の再開、LOOP-2。
  - **CI の分割**（B1 の移植。#63 は #59 の上にあり、#61〜#85 の scoreboard と食い違うので、rebase せずに持ってきた）：
    - `--job loop --shard i/n --out f`：ジョブのオラクルを、記録した時間の長い順に4つへ振り分け、自分の分だけを1つずつ回して書き出す。判定はしない。
    - `--job loop --merge f…`：何も回さない。ジョブの全オラクルがちょうど1回ずつ、同じコミット（`git rev-parse HEAD`）と同じ検証器（registry、MISSION.md、scoreboard、ratchet、分割の指紋）から戻ったかを確かめ、欠け・重複・食い違いは退行にする。あとはいつものラチェット。
    - 必須の `loop` は統合のジョブ（`if: always()`。落ちた分割は「欠け」として名指しで落ちる。skip は緑に数えられるので使わない）。
    - これを LOOP-4 の速いテスト（`accept/loop/shard.test.mjs`）に入れた：本物の registry の分割を本物の scoreboard で統合し、1つ欠けたオラクル、届かなかった分割、別のコミットを、それぞれ退行で落とす。
    - プロセス内の並列（B1 の `--jobs`）は入れなかった：B1 の実測で 302 秒 → 258 秒と小さく、Lighthouse や遅延のオラクルを同じ機械で並べると揺れる。プロセスツリーの kill も、Windows が夜間に移ったので後回し。
  - **Windows は夜間**（`nightly-windows`、03:00 JST と手動）。PR と push では回らない。
  - **LOOP-2 を配線した**（`accept/loop/ci-time.mjs`、夜間の `nightly` ジョブ）：main の最新の完了した push の実行で、skip でない全ジョブが緑、かつ最初の開始から最後の完了まで10分以内。PR の実行では測らない（PR は main の過去の実行を変えられないし、遅い main がその直しの PR を止めてはいけない）。
    - MISSION.md の LOOP-2 の文から「Windows も含む」を外した（人間の指示で Windows を push から外したため）。代わりに「全ジョブが緑」を足した。
    - 今の main（#85）では FAIL：16:41（Windows を含む旧構成）、`preview` が赤（secret 待ち）。
    - #86 の CI：`loop` の道は 11:50 → 4:30（分割 4:21、2:28、2:40、3:10、統合 6 秒）。一番長い分割は WEB-9 だけの1本（239 秒）。オラクルは分割をまたがないので、これより縮めるなら WEB-9 自体を分ける。
  - **npm の公開の仕組み**（PUB-4、`scripts/release.mjs`、`.github/workflows/release.yml`、PUBLISH.md §6）：
    - 手動の起動だけ、main だけ、environment `npm` で人間が承認、npm の trusted publishing（OIDC。npm のトークンはどこにも無い。provenance が付く）、PUB-1〜3 のあと、公開セットの順。
    - npm にある版は飛ばす。npm がまだ知らないパッケージは拒否する（npm は存在しないパッケージに trusted publisher を設定できないので、最初の版は人間が手で出す）。最初の失敗で残りを止める。既定は dry run。
    - PUB-4 は、偽の npm で順番・飛ばし・拒否・停止を、仕込んだワークフロー11本で関所（手動、main、environment、権限、秘密、式の注入、SHA 固定、PUB の順番）を確かめる。他のワークフローは公開も OIDC の発行もできない。
    - 手元の dry run（本物の npm）：`ludion` と `@ludion/gate-core` は「npm がまだ知らない」で拒否された（正しい。まだ何も出ていない）。
  - **夜間のジョブを手動で一度回した**（run 37120599286）：`nightly-windows` は PASS 53 / FAIL 0。`nightly` の LOOP-2 は、その時点で完了していた古い構成の実行（Windows 込み 18:11）を測って FAIL。
  - **対のない正のオラクルに、同じ性質の負のオラクル**（LOOP-5 の UNPAIRED が 0 に）：
    - SCAN-5（−、parse-rate、SCAN-1 の対）：全形式で記録の3%を壊した写しで、壊した行だけがちょうど未パース、分母は減らず、全ファイルが99%未満。Vercel は requestId の最初の行だけを取るので、1行だけのリクエストを壊す（双子が代わりに通るのは正しい）。
    - SCAN-6（−、scan-throughput、SCAN-4 の対）：SCAN-4 の計測（`--cli` を足した）が、半分しか数えない、分類しない、遅い、報告なし、非ゼロ終了の偽の CLI を落とす。
    - GATE-13（−、install-effort、GATE-3 の対）：GATE-3 の測りを関数に出し（`reference/gate3-measure.mjs`、条件は同じ）、仕込んだ導入7つとイベント6つを捕まえる。上限を10行に緩める突然変異で落ちる。
    - WEB-10（−、browser-scan、WEB-4 の対）：ページに断層を仕込む（ワーカーの報告、描いた表、ページのエラー）。9つとも捕まる。
    - WEB-4 を強化した：印字した JSON と見出しだけでなく、人が読む分類の表とファイルの表も CLI と比べる。WEB-10 の表の仕込みは、前の WEB-4 では通っていた。
  - ラチェット：59 件（+GATE-13、PUB-4、SCAN-5、SCAN-6、WEB-10）。scoreboard（ローカル）：PASS 59 / FAIL 1（LOOP-2：`preview` が赤）/ PENDING 7。

- 2026-10-02〜10-03（Claude Code）：人間の確認への対応と GATE-8。
  - #78：揺れるオラクルを、閾値を下げずに安定させた。
    - GATE-1：揺れではなく、GATE-3 が共有の Next.js のキャッシュを壊したまま去ったのが原因。毎回落ちていた。`prepare()` が使う前に確かめて建て直す。
    - WEB-1、WEB-9：Lighthouse を各ページ3回の中央値で判定。
    - Mandate：強制できない上限（累計など）を持つ Mandate は拒否（PRS-3）。
  - GATE-8 の案 A（#79）：寿命1時間まで（60秒超は nonce 必須）。本物の2件が VERIFIED に。
    - 条件 b の攻撃を GATE-7 に足した（1時間の nonce で記憶を満杯にしても、追い出さず、満杯なら VERIFIED にしない）。
    - scoreboard（ローカル）：PASS 54 / FAIL 0 / PENDING 8。FAIL は 0 になった。
  - #80：#79 の `loop-windows` で落ちた2つを、揺れとして流さずに直した。
    - PRS-3：製品のバグ。SQLite の `busy_timeout` は同期で待つので、ロック待ちの決済1つがプロセス全体を最大10秒止め、他のリクエストが Gate の故障になっていた。`busy_timeout = 0` にして、待ちは非同期の再試行でする。先に main で落ちる速いテスト（`ledger.test.mjs`、待つ間のイベントループの隙間 < 200ms）を足してから直した。
    - WEB-6：検査器の側。テスト用プロキシの accept の待ち行列が浅く、Windows で `ERR_PROXY_CONNECTION_FAILED`。待ち行列を深くし、断られたナビゲーションは3回まで試して数を要約に出す（漏れの判定は変えていない）。
    - #80 の `loop-windows` は、PRS-3、WEB-6、GATE-1、WEB-9 がすべて PASS（WEB-9 の中央値の最低は 100）。
  - #79 のあとのプレビューの出し直しで、サイトのビルドが Windows のファイルの掴み（`EPERM`、出力の rename）で落ちた。`site/test/build.test.mjs` に降ろしてから、掴まれていればコピーするように直した。プレビューは出し直して WEB-1 PASS。scoreboard（ローカル）：PASS 54 / FAIL 0 / PENDING 8。

- 2026-10-01 夜〜10-02（Claude Code）：Codex の検証器の監査（10件）と、人間の項目1〜6。全部採用し、先に今の main で落ちるオラクルを足してから直した。
  - **#69 セキュリティの4件**：
    - 本文の digest（GATE-11、GATE-7 の `body-swap`）：署名が覆う Content-Digest を、届いた本文と照合する。Node、Workers、Next の実アダプタで。
    - Next の SSRF（GATE-12）：安全な取得関数を `@ludion/gate-core/safe-fetch` に移し、gate-next も使う。
    - Mandate の aud（PRS-2 を強化）：今のリクエスト先と照合する。
    - ルートの重なり（PRS-4、PRS-1 を強化）：一番厳しいものが勝つ。
    - 人間の規則で裏返した期待：GATE-7 の carve-out と、mandate.test の別ホスト。
  - **#70 検証器の健全性**：
    - LOOP-3（読めないベースは止まる）。
    - LOOP-4（ラチェット済みは PASS だけ。WEB-1 は `preview` ジョブへ）。
    - STD-1 の測り方と STD-5。
    - 攻撃の `classes` の宣言と、GATE-10 の raw を本物の gate-node に通す。
    - Actions の SHA 固定と `permissions`。
    - LOOP-5（対は同じ性質の裏表）。
  - **#71 Mandate の上限はサイトのもの**（PRS-3）：共有の原子的な記録。記録がなければ数える上限は拒否。
    - #73 と #76：CI の `loop-windows` で、SQLite の記録を多くのプロセスが同時に開くと `database is locked` で落ちる製品のバグが出た。速いテストに降ろしてから直した（2回目で Windows の CI も緑）。
  - **#72 Discord の通知**：`flags: 4`（埋め込みを出さない）と Slack の unfurl オフ（WEB-8 を強化）。
  - **#74**：赤いオラクルが、落ちたテストの名前とエラーを CI のログに出す（WEB-9 の揺れの診断のため）。
  - **#75 npm の `ludion` だけを先に**（PUB-3）：tarball が CLI のコードを `lib/` に同梱する（prepack で組み、postpack で消す）。
  - 教訓：
    - Bash のヒアドキュメントはバックスラッシュを潰す。正規表現を含む編集は Write か Edit で（メモリに書いた）。
    - プレビューは1つなので、別のブランチで出すと手元の WEB-1 が落ちる。
  - scoreboard（ローカル、#75 のブランチ）：PASS 53 / FAIL 1（GATE-8）/ PENDING 8。ラチェットは 44 → 53（GATE-11、GATE-12、PRS-4、LOOP-3、LOOP-4、LOOP-5、STD-5、PRS-3、PUB-3）。

- 2026-10-01 11:00（Claude Code）：プレビューをエージェント用のアカウント `Ludion Agents` へ移した（人間の指示 3 つ）。
  - **境界**：最初に渡されたトークンは、本番のアカウントにも届いていた。
    - 本番の `ludion-site` と `ludion` の settings、秘密の名前、deployments、本体が、すべて 200 で読めた。ゾーン `ludion.ai` と `synteria.xyz` も見えた。
    - `cloudflare.env` の Account ID は本番のままで、`Ludion Agents` には workers.dev のサブドメインがなかった。
    - デプロイせずに人間に返した。人間が Account Resources を `Ludion Agents` だけにし、Account ID を直し、サブドメイン `ludion-agents` を作った。
    - 直した後：本番のアカウントの ID を名指しした GET が、すべて 403 になった（DEPLOY.md §5.3）。
  - **デプロイの前の検査**（`site/deploy.mjs`、`site/test/deploy-guard.test.mjs`）：次のどれかなら、ビルドもせずに止まる。`node site/deploy.mjs --check` は境界だけを見る。
    - アカウントが `Ludion Agents` でない。
    - 他のアカウントの Worker が読める。
    - ゾーンが見える。
    - サブドメインがない。
    - 最初のトークンの形を、速いテストに負のケースとして入れた。4 つの突然変異を 4 つとも捕まえた。実際の API でも、直す前は拒否し（exit 2）、直した後は通った。
  - **プレビュー**：https://ludion-site-preview.ludion-agents.workers.dev 。ホームの差し替えなしの `npm run deploy:preview` で出した。
    - 登録フォームの通知先は `signup.env` から `--secrets-file` で入れ、Worker の秘密の名前を読み返して確かめた。試しの送信はしていない。
    - WEB-1 PASS：全28ページがバイト単位で一致、Lighthouse の最低は 96。
  - 前のプレビュー（本番のアカウント）の削除と古いトークンの失効の確認は、人間待ちに書いた。

- 2026-10-01 昼（Claude Code、セッションの終わり）：
  - #65（トップの文面、/scan の次の一歩、登録フォームの告知、DEPLOY.md §5、デプロイのガードのテスト）と #66（プレビューの記録）をマージした。
  - プレビューを main のビルドで出し直した。WEB-1 PASS（全28ページがバイト単位で一致、Lighthouse は全ページ 100）。
  - 登録フォームの通知先（Discord の webhook）を、プレビューの Worker にだけ秘密の変数として入れた。試しの送信はしていない。
  - main の scoreboard（ローカル）：PASS 44 / FAIL 1（GATE-8）/ PENDING 8。CI では WEB-1 が SKIP なので PASS 43。
- 2026-10-01 昼（Claude Code）：トップページの文面を人間が承認した。
  - 一番上に三つの問い（誰の代理か、何を許されているか、壊したら誰が払うか）と、具体的な一文。導線は /scan の1本だけ。
  - Gate errors は末尾の「開発者の方へ」に移した。「3行以内」は Gate の入れ方へリンクし、出所（MISSION.md）を小さく添えた（WEB-2 のため）。
  - タイトルは「Ludion — …」（「Ludion | Ludion」を直した）。
  - /scan から `npx ludion scan` を外した（npm に公開するまで）。結果の下に次の一歩（先行登録、Gate を入れる）を置いた。
  - 登録フォームの告知に、保存期間と削除の宛先（privacy@ludion.ai）を足した。
  - /e/<code> の `npx ludion init` は残す（WEB-3。npm の公開で動くようになる）。
  - DEPLOY.md §5：エージェントのトークンは本番の Worker も書き換えられる。対策はエージェント用のアカウント（人間がやる）。ガードは `site/test/deploy-guard.test.mjs` で固定した。
- 2026-10-01 朝（Claude Code、1本のレーン）：今日の spec「ludion.ai を新しいサイトにして、ブラウザ版 scan を誰でも使えるようにする」。
  - **プレビュー**：https://ludion-site-preview.ludion.workers.dev 。`npm run deploy:preview`（`site/deploy.mjs`）はプレビューの名前にしか出さない。
    - WEB-1 PASS：プレビューがこのチェックアウトのビルドを配り（`/_build.json`）、全28ページが手元のビルドとバイト単位で一致し、Lighthouse（モバイル）の4項目が全ページで95以上。トークンが要るので CI では SKIP。
    - WEB-9（新設）：同じ基準を CI で。デプロイと同じ成果物を workerd で動かし、テンプレートごとに英日で Lighthouse を当てる。
    - WEB-4 は同じ成果物で PASS（200 MiB を 1.8 秒）。プレビューはそれとバイト単位で同じ。
  - **DEPLOY.md**：棚卸しで、旧 ludion.ai は Worker `ludion` のカスタムドメインと分かった。切り替えは一本道（§3）。削除リストは Ludion の16件（§1.3）。振り分けは `scripts/cf-classify.mjs`（自己テスト付き）。
  - **npm の公開準備**：無印の `ludion`（`npx ludion`）を足し、全パッケージに `files`、LICENSE、README、`publishConfig` を付けた。
    - PUB-1：8パッケージを tarball だけでクリーンな環境に入れ、CLI（scan、report、init、sign）と3つのアダプタで VERIFIED まで動く。
    - PUB-2：tarball には宣言したものしか入らない（テスト、ベンチ、鍵、`.env` が0件）。
    - 手順は docs/PUBLISH.md。publish は人間。
  - **B1** は `loop-windows` で後退したので棚上げした（PR #63 は下書き）。上の「次の一手」2。
  - **事故と教訓**：
    - 同じレーンのバックグラウンドのセッションが同時に起動し、同じブランチにコミットしていた（08:36〜08:49）。人間がこちらを残した。複数のセッションを同じ作業ツリーで動かさない。
    - トークンのファイルがリポジトリの直下に置かれた。中身を読まずに `~/.config/ludion/` へ移し、`.gitignore` に `*.env` を足した。
  - scoreboard（ローカル）：PASS 40 → 44（WEB-1、WEB-9、PUB-1、PUB-2）。ラチェットは 44 件。FAIL は GATE-8 だけ（main と同じ、ラチェット外）。

- 2026-10-01（夜勤 9）：
  - GATE-8 を配線した。本物の署名付きリクエストを見つけた（docs/adr/2026-10-01-real-chatgpt-agent-signs-for-an-hour.md）。
    - 要求：ChatGPT agent が送ったもの 2 件。
      - 2025-08-04、simonwillison.net へ。運営者が自分のログを同じ日に記事で公開していた。Wayback に同じ日の保存版があり、ヘッダーは今日の記事とバイト単位で同じ。
      - 2025-08-11、api.seatgeek.com へ。SeatGeek の技術者が、検証器を作るときに使った本物の要求の署名を公開していた（2025-08-26）。
    - 鍵：chatgpt.com のディレクトリの Wayback の保存（2025-10-07）。keyid は JWK の拇印と一致する。今日のディレクトリからは消えている（回転）。
    - テスト（`accept/gate8/gate8.test.mjs`）：
      - 出所：保存したバイトが Wayback の CDX のダイジェストと一致する。
      - 本物：署名の土台を Gate とは別に組んで検証が通る。1 か所変えると落ちる。今日のディレクトリでは通らない。
      - Gate：既定の Gate が、着いた時刻の時計と当時のディレクトリで、VERIFIED（chatgpt.com のディレクトリ、keyid）にし、Pressure 2 で通すこと。
      - 対：改ざん、リプレイ、期限後、別サイト、今日のディレクトリは VERIFIED にならず、拒否される。
    - 結果：Gate は 2 件とも SPOOFED。理由は寿命（3600 秒 > spec §10.4 の 60 秒）だけ。鍵の発見（文字列形式の Signature-Agent）は通る。
    - 上限を 3600 秒にした実験（コミットしていない）では、本物の 2 件が VERIFIED になった。落ちたのは STD-2 と GATE-7 の 1 件ずつ。緩めるのは人間の判断なので、今夜は緩めない。
    - 公開された捕獲は 3 件とも寿命 3600 秒だった（2025-08-01 の Castle のブログは nonce が伏せてあり、検証できない）。
  - 2 周目：案 A（上限 3600 秒、60 秒超は nonce 必須）を、ローカルの提案ブランチ `proposal/gate8-lifetime` に実装した。main には出していない。
    - 手元で PASS 41 / FAIL 0 / PENDING 9。
    - WG 自身のテストベクタ E.2.2（寿命 3600 秒）も、今の Gate は SPOOFED にしていた。
  - #59 の初回で、`loop-windows` の NEUT-1 が落ちた。3 つのランタイムはすべて 109/109 を報告したあとで、詳細は `}` だけ。落ちたジョブだけを再実行したら通った（既知の問題に書いた）。
  - Cloudflare のトークンは、今夜は `Invalid access token`（9109）になった。前回は「有効だが 401」だった。WEB-1 と LIVE-1 は止まったまま。
  - この機械には PHP、Python（Microsoft Store のスタブだけ）、Go、Docker、uv がない。GATE-9 は止まったまま。
- 2026-10-01（夜勤 8、6 周目）：
  - GATE-7 のコーパスに Mandate の攻撃の族 `mandate-swap` を足した（4 件。必須の族にも入れた）。
    - 被害者の Diver の Mandate を、自分の署名と Staple の下で運ぶ。
    - 署名が覆っていない Mandate を付ける。
    - 本物の Mandate の上限を書き換える。
    - Staple を Mandate として渡す。
  - 最初の実行で、今夜の PRS-2（#52）のバグを捕まえた：Mandate が不正で SPOOFED になっても、先に読んだ Staple の立場（Diver、Depth）を結果が持ったままだった。
    - 速いテスト（`mandate.test.mjs`）に降ろしてから直した。SPOOFED は Staple の何も持たない。
  - GATE-10 の vectors.json を書き出し直した。4 ケースが増えただけ（差分は追加のみ）：95 ケース、555 ステップ。

- 2026-10-01（夜勤 8、5 周目）：
  - 設定ファイル（`ludion.config.json`、Workers の `LUDION`）に `registry` を足した。Registry の公開鍵、issuer、失効のストリーム。あわせて `categories` も足した。
    - これまで、ファイルで設定した Gate（Node の `ludion()`、Workers、Next.js）は Registry の鍵を持てず、Staple も Mandate も読めなかった。
    - 秘密鍵を書くと、はっきり拒否する。
  - Workers：`ludion(request)` で、その要求の Gate の結果が取れる。`charge()` もここから呼ぶ。
  - gate-core の resolver の既定の fetch を、読み込み時ではなく呼ぶときに引くようにした。後から入れた fetch（テストや polyfill）が効く。
  - PRS-2 を強くした：同じ Mandate を、ファイルの設定だけの Workers のサイト（本物の `withLudion`）でも試す。上限内は通り、上限超え、Mandate なし、別の Diver のものは拒否。15 件通り、21 件拒否。
  - 教訓：ブランチを切る前に `git fetch` する。この周は一度、#56 の前の main から切っていた（コミット前に気づいて rebase した）。

- 2026-10-01（夜勤 8、4 周目）：
  - GATE-10 を強くした：STD-2 の否定のテスト 12 件を vectors.json に足した。
    - `accept/conformance/std2.mjs` が STD-2 の各テストを、題をそのまま名前にして写す。`std2.test.mjs` は変えていない。
    - 拒否のステップには、spec §10.8 の分類（`classes`）を付けた。鍵ディレクトリにない keyid は UNVERIFIED、検証に失敗したものは SPOOFED。他の言語の Gate にも課す。
    - GATE-10 は、STD-2 のテストの題とケースが1対1であることを求める。
    - 91 ケース、547 ステップ。TypeScript の Gate は全件に通る（Node、Deno、workerd）。
    - 検査が噛むこと：分類を違えた拒否、別のメンバーに帰属した control を、どちらも落とす。
  - scoreboard（ローカル、コミットしてから）：PASS 40 / FAIL 0 / PENDING 10 のまま（強化なので行は増えない）。NEUT-1 は 93 → 105 件。

- 2026-10-01（夜勤 8、3 周目）：
  - GATE-10 を目録に足し、PASS にした：適合スイートがデータになっている（docs/adr/2026-10-01-conformance-suite-as-data.md）。
    - GATE-7 の攻撃の生成器を `accept/attacks/families.mjs` に切り出した。`run.mjs` は今までどおり（76 件、0 問題）。
    - `accept/conformance/export.mjs` が、全攻撃と WG のベクタを `vectors.json` に書き出す：79 ケース、508 ステップ、約 600 KiB。鍵と nonce はケースの id から決まり、書き出しはバイト単位で再現する。
    - リクエストは3種類：`core`（RFC 9421 のメッセージ）、`raw`（Node が受け取る生のリクエスト。アダプタの規則ごと）、`signature`（署名だけ）。
    - TypeScript の Gate は、ファイルだけを読んで全件に通り、参照の答えと完全に一致する：Node（GATE-10）、Deno と workerd（NEUT-1。14 → 93 件）。
    - 検査が噛むこと：攻撃を control にする、参照を変える、文書やディレクトリを消す、攻撃を守られていない経路へ動かす、WG のベクタを1バイト変える、改ざんしていない双子、別の識別子。すべて落ちる。
  - WG のベクタは、Gate を通すと寿命（数十年）で SPOOFED になる（spec §10.4）。署名だけの段と、Gate の段に分けた。
  - scoreboard（ローカル、コミットしてから）：PASS 39 → 40、目録 49 → 50、PENDING 10、FAIL 0。ラチェットは GATE-10 を足した。NEUT-1 は 14 → 93 件。

- 2026-10-01（夜勤 8、2 周目）：
  - STD-4：ドラフトの版の追随（docs/adr/2026-10-01-draft-pins-tracked-against-datatracker.md）。
    - 版は `accept/std4/pins.json` の1か所：httpsig-protocol -00、registry -03。
    - datatracker：最新なら通る。新しい版や後継（`Replaced` をたどる）が出たら 7 日は通り、issue の文面（変更、iddiff、期限）を出力する。過ぎたら落ちる。読めなければ落ちる。
    - リポジトリ：Web Bot Auth のドラフトの版つきの参照 12 件が、すべて留めた版と一致する。
    - 検査器の失敗の道は、偽の datatracker でオフラインに確かめる（`accept/std4/drafts.test.mjs`、`npm test` に入れた）。仕込んだ 6 つの故障をすべて捕まえた。
  - GATE-9（PHP と WordPress）は、夜勤の権限で道具が入らず着手できなかった（`php` の実行も、新しいパッケージの `npm install` も不可）。人間待ちに書いた。
  - #52 の `loop-windows` の初回で GATE-3 が固まった。再実行で通った（既知の問題に書いた）。
  - scoreboard（ローカル）：PASS 38 → 39、PENDING 11 → 10、FAIL 0。ラチェットは STD-4 を足した。
  - #53 のあと、CI で STD-4 が落ちた（Linux と Windows）。main の CI も赤になった。
    - 原因：リポジトリの走査が、検査器自身のテストの例（わざと合わない版の名前）を読んだ。手元ではそのファイルがまだ追加前で、`git ls-files` に出なかった。
    - #53 自体が緑でマージされたのは、CI がベースブランチのラチェットを読むため（STD-4 はまだ入っていなかった）。
    - 直し方：`accept/std4/` は読まない。まだ追加していない新しいファイルも読む（手元で CI と同じものを見る）。速いテストに降ろした。
    - 教訓：新しいオラクルは、コミットしてから `npm run ratchet` を回す。PR の CI のログで、その行が PASS かを見てからマージする。

- 2026-10-01（夜勤 8）：
  - PRS-2：Mandate v0（docs/adr/2026-10-01-mandate-v0-passkey-consent-and-site-charge.md）。
    - Registry：`POST /v0/principals`（パスキーの公開鍵）、`POST /v0/mandates`（同意）、`POST /v0/mandates/{jti}/revoke`（取り消し）。
      - 同意は「要求の JSON 文字列」への WebAuthn のアサーション。challenge はその SHA-256。origin、rpId、UP と UV、signCount、±5分、一度きりを見る。
      - ES256（DER）と EdDSA。暗号は `@ludion/gate-core/staple` に足した（CRY-1 の許可リストは広げていない）。
      - Principal の仮名はサイトごと（HMAC）。Mandate はハッシュだけを持つ。
    - Gate：`Ludion-Mandate` を読む（`@ludion/gate-core/mandate`）。
      - 持っていない委任（偽造、別の Diver のもの）は SPOOFED。
      - 別のサイト、期限切れ、取り消し済み、Staple なしは「Mandate なし」で `mandate_required`。
    - 支払い：サイトが金額を知った場所で `req.ludion.charge({ amount, currency })`。上限、通貨、24 時間の回数。人間には効かない。
    - 取り消しは、放送（購読している Gate、数十ミリ秒）と、Staple の `mrev`（それ以外の Gate、Staple の寿命以内）で届く。
    - 失効リストは、知らない `scope` の項目で Diver を落とさなくなった。
  - PRS-2 の中身：本物の Node Gate を3つ（購読する、しない、別サイト）と、ソフトウェアのパスキーを2つ（ES256 で数える、EdDSA で数えない）。
    - 通るもの：14 件。拒否するもの：18 件。同意の攻撃 13 種類は何も発行しない。
    - 仕込んだ 22 の故障（上限、通貨、日ごとの回数、aud、sub、期限、取り消し、mrev、Staple なし、偽造、人間への適用、署名、challenge、origin、rpId、UV、一度きり、他人の取り消し、鍵の差し替え、放送、limits の省略）を、22 とも捕まえた。
  - 速いテスト `packages/gate-core/test/mandate.test.mjs`（9 件）を `npm test` に入れた。
  - `/e/mandate_required` と `/e/mandate_scope`（英日）に、Mandate が効かない場合と上限の場合を書き足した。
  - gate-core の設定は、`require.scope` を v0 の語彙に限った（打ち間違いで経路が閉じない）。
  - scoreboard（ローカル）：PASS 37 → 38、PENDING 12 → 11、FAIL 0。ラチェットは PRS-2 を足した。

- 2026-10-01（夜勤 7）：
  - WEB-8：登録フォーム。人の送信は通知まで届き、ボットは落ちる（docs/adr/2026-10-01-signup-endpoint-on-the-site-worker.md）。
    - 受け口：Web 標準の `handleSignup(Request) → Response`（`site/edge/signup.mjs`、依存なし）。サイトの Worker（`site/edge/worker.mjs`）と Vercel のアダプタが同じ関数を呼ぶ。
    - ボット：ハニーポット（人と同じ応答で捨てる）と、レート制限（クライアントごと 10 分で 5 回、全体 100 回、`429` と `Retry-After`）。
    - 通知：`SIGNUP_WEBHOOK_URL` が 2xx を返したときだけ「受け付けました」と答える。ログには何も書かない。
    - 測り方：プレビューに出す成果物（本物の `wrangler.json` と Worker とビルドした dist）を `wrangler dev`（workerd）で動かす。通知先はスタブ。
      - 人：`/` と `/ja` で Chromium がフォームを送る。ページの通信は自分のオリジンへの POST 1本だけで、通知にはその人が1件だけ届く。
      - ボット：ハニーポットを埋めたもの（ブラウザ、JSON、フォーム形式）は通知に届かない。1 クライアントの 10 件は 5 件だけ通り、残りは 429。別のクライアントは通る。止められたページはそれを英日で言う。
      - 受け口に仕込んだ4つの故障を、すべて狙いの規則で捕まえた：ハニーポットの無視、制限なし、空の鍵の制限、通知せずに ok。
    - 速いテスト `site/test/signup.test.mjs` を `npm test` に入れた（11 件）。
    - WEB-2 を強化した：フォームがスクリプトで書く文言（送信中、受け付けた、など英日 26 個）も法務の線にかける。
  - scoreboard（ローカル）：PASS 36 → 37、PENDING 13 → 12、FAIL 0。ラチェットは WEB-8 を足した。

- 2026-10-01（夜勤 6）：
  - WEB-2：法務の線を越える文面が 0、数字は全部出所付き（docs/adr/2026-10-01-copy-check-legal-line-and-figure-sources.md）。
    - 法務の線：保険、支払いの保証、絶対の安全の語を英日で持つ。否定がその語に付いているときだけ通す。
      - 読むもの：全ページの本文、title、description、alt とラベル、コード、scan の文言、コピーされるレポート。
    - 数字：単位の付いた数、大きい数、比較の語の付いた数を「数量」とし、RFC 9421 や HTTP 403 のような名前と分ける。
      - 数量は同じブロックに、その数字を言っているリポジトリの文書へのリンクを持つ。行数はすぐ後のコードブロックの行数と一致する。
      - 見出しの数字は節の中で、title と description の数字はページの中で、出所付きで現れればよい。
    - 仕込んだ 21 の文面（保険、支払いの保証、100% 安全、離れた否定、description の主張、alt、出所のない数字、リンク先が言っていない数字、合わない行数など）をすべて狙いの規則で捕まえた。否定や出所付きの数字など 5 つの対照は、どれも指摘にならない。
  - 最初の実行で 118 件を捕まえた。
    - 法務の線：Depth の表の D3「an insured Ballast, offered through partners」「保険付きの Ballast（パートナー経由で）」（英日）。
    - 誇張：トップの「一行で入る」。測った値は3行以内。
    - 出所なし：「3分で検証済み」（目標なのに測った値のように書いていた）、spec の数字（60秒、±30秒、1時間、24時間、90日）。
    - 数字でない数：「2 つの公開ファイル」「1つの忙しいエージェント」など。
    - 直し方は ADR の「決定 5」に書いた。
    - 速いテスト `site/test/copy.test.mjs` に降ろし、`npm test` に入れた。
  - scoreboard（ローカル）：PASS 35 → 36、PENDING 14 → 13、FAIL 0。ラチェットは WEB-2 を足した。

- 2026-10-01（夜勤 5）：
  - WEB-5：リンク切れ 0、コンソールエラー 0、許可リスト外の通信 0（docs/adr/2026-10-01-site-links-own-origin-and-gate-page.md）。
    - 許可リストはサイト自身のオリジンだけ。第三者は 0。
    - 静的：ビルドした全ページ、CSS の `url()`、スクリプトに書かれたサイトの URL、サイトマップを `site/test/links.mjs` で引く。
    - 実地：全ページをデスクトップとモバイルで、WEB-6 の監視の後ろの Chromium で開いて使う。
      - 使うもの：テーマ、モバイルのメニューと目次、検索（英日）、言語の切り替え、scan とコピー、深い 404。
      - 使ったあとの DOM のリンクも、同じ規則で引く。
    - 外向きのリンクはネットワークで確かめる。404 と 410 だけが「切れている」。
    - 仕込んだ 12 の壊れ方を、すべて狙いの規則で捕まえた。
      - 仕込んだもの：死んだリンク、死んだフラグメント、他サイトのフォント、console.error、throw、ない画像、ないフォント、スクリプトが足す死んだリンク、外への fetch、死んだ言語の選択肢、コピーの死んだ URL、リポジトリにないパス。
  - 最初の実行で、本物の切れたリンクを 3 つ捕まえた。
    - 404 ページの `hreflang="ja"` と言語の切り替えが `/ja/404` を指していた。そのページはなかった。→ 日本語の 404 を足した。
    - scan のコピー、日次レポート、Gate の User-Agent が `https://ludion.ai/gate` を配っていた。そのページはなかった。→ `/gate` と `/ja/gate` を足した。
    - scan の「Gate の入れ方（GitHub）」は、README のないリポジトリのルートを指していた。→ `/gate` を指すようにした。
    - 速いテスト `site/test/links.test.mjs` に降ろし、`npm test` に入れた。コードが配る `https://ludion.ai/` の URL に英日のページがあること、各言語に 404 があること。
  - scoreboard（ローカル）：PASS 34 → 35、PENDING 15 → 14、FAIL 0。ラチェットは WEB-5 を足した。

- 2026-10-01（夜勤 3、4）：
  - WEB-6：scan の間、ログのバイトは1つも外に出ない。
    - 監視 `site/test/egress.mjs`：
      - Chromium の唯一の出口をプロキシにした（ループバックも含む）。プロキシはビルドしたサイトを自分のオリジンで配り、他はすべて断って記録する。
      - `judge` は記録だけを読む。通してよいのは、サイトのオリジンにある出荷済みのファイルへの GET か HEAD だけ。クエリ、ボディ、カナリアのどれもあってはいけない。
      - カナリアは、そのまま、hex、base64 と base64url（3つのずれ）、gzip の中まで探す。
    - ログは2つ使った。どの行にもカナリアを入れたログ（経路、クエリ、UA、Referer）と、ファイル名に入れたログ。
      - `/scan` と `/ja/scan` に、平文と gzip で落とす。
      - 見るのは送信だけではない。ページ、コピーしたテキスト、保存した JSON、Cookie、すべてのストレージにも、ログが残ってはいけない。
    - 監視が噛むことを確かめた。ページと Worker に仕込んだ 14 の漏れを、すべて狙いの規則で捕まえた。
      - 仕込んだ漏れ：fetch、画像、beacon、WebSocket、同じオリジンのクエリ、ファイル名に化けた GET、localStorage、pagehide、DOM、コピー、ダウンロード、WebTransport、WebRTC、preconnect。
    - 速いテスト `site/test/egress.test.mjs` に規則を降ろし、`npm test` に入れた。
  - 夜勤 3 は PR の前で止まっていた。夜勤 4 は、作業ツリーに残っていた差分を拾って出した。
  - scoreboard（ローカル）：PASS 33 → 34、FAIL 1 → 0。ラチェットは WEB-6 を足した。

- 2026-10-01（夜勤 2）：
  - 旧 Ludion の棚卸し（NIGHT.md §7）：渡されたトークンでは、アカウントの資源が1つも読めなかった。
    - 読むだけのスクリプト `scripts/cf-inventory.mjs` を足した。
    - `docs/DEPLOY.md` を書いた。棚卸しのやり方、削除リストの枠、本番への切り替え手順、`*.agents.ludion.ai` の証明書の問題。
  - WEB-4（docs/adr/2026-10-01-browser-scan-shares-the-cli-core.md）：
    - `@ludion/scan` の解析と集計を `core.mjs` に分けた。ブラウザはそれを Web Worker でそのまま動かす。
    - `/scan` と `/ja/scan` を足し、トップから導線を張った。
    - ヘッドレス Chromium で、全フィクスチャ、コーパスの一括、英日のページを CLI の `--json` とフィールド単位で突き合わせた。
    - 200 MiB を 1.9 秒で読んだ。
  - 現実のバグを1つ捕まえた：Chromium の `DecompressionStream` は、連結された gzip（`cat a.gz b.gz`）を途中で拒む。
    - 直し方：gzip のメンバーの境目を、その前までが1つの完全なメンバーとして展開できるかで確かめ、メンバーごとに展開する。
    - 偽の境目（無圧縮のデータの中のヘッダーのバイト列）もケースに入れた。
  - 突然変異で落ちることを確かめた。並べ替え、gzip の展開、見出しの数字、境目の検証。
  - scoreboard（ローカル）：PASS 32 → 33。ラチェットは WEB-4 を足した。
  - #45 のマージ後、`loop-windows` で WEB-3 と WEB-4 が落ちた。`loop-windows` は必須チェックではないので、#45 は Linux が緑の時点で自動でマージされていた。
    - 原因：Astro はビルドの途中の資産を `site/.astro` から出力先へ rename で移す。Windows のランナーでは、リポジトリが D:、一時ディレクトリが C: にあり、ドライブをまたぐ rename は失敗する（EXDEV）。
    - 使い捨ての下書き PR（#46、マージしない）で、ランナー上のエラーを取った。
    - 直し方：Astro には `site/.astro/out/` の中にだけビルドさせ、できたものを出力先へ移す。rename できなければコピーする。
    - 速いテスト `site/test/build.test.mjs` に降ろし、`npm test` に入れた。
    - 教訓：サイトの PR は `loop-windows` が緑になるまで auto-merge を付けない。

- 2026-10-01（夜勤 1）：
  - GATE-9 と M7 Web（WEB-1〜8）を目録と registry に PENDING で登録した（#43）。ID の衝突はなし。LOOP-1 は PASS のまま、目録は 39 → 49 件。
  - WEB-3（Astro と Starlight、ADR-040）：
    - コードの一覧は手で書かない。次の2つから読む。
      - Gate：`decide()` を全入力の形で回した結果と、アダプタのリテラル
      - spec §10.11 の表
    - gate-core に `ERRORS` を足した。
    - サイトを実際にビルドし、静的ホストと同じ規則で配る。Gate の Link ヘッダーの URL を叩く。
    - 検査：英日のページ、4つの節、3分の道のコマンド。日本語のページは未翻訳のフォールバックでないこと。
    - 突然変異で落ちることを確かめた。ja を1枚消す、en を1枚消す、`decide()` に未知のコードを足す。

- 2026-09-30（Claude Code 1）：
  - **Windows/Node 24 の修正（#1）**：ラチェット済みの 4 件が落ちていた。原因は Node ≥23 の test reporter と、パスの区切り文字。検証器を移植可能に直し、`loop-windows` CI と `.gitattributes`（eol=lf）を追加した。
  - **配線した 4 オラクル**：
    - STD-2（#2）：不正な署名が UNVERIFIED になっていたのを SPOOFED に直した。
    - GATE-2（#3）
    - GATE-7（#4）：攻撃コーパスを 39 件作った。シードの Gate を 9 件が通っていた。穴は 4 つで、スキュー中のリプレイ、nonce なしのリプレイ、署名剥がし、ボディ未束縛。
    - DIV-2（#5）：`@ludion/card-host` を新設した。
  - scoreboard（CI）：PASS 6 → 10。ratchet は 10 件。
  - **scan（#7〜#10）**：`@ludion/scan` を新設し、`ludion scan` の中身にした。
    - 9 形式をフラグなしで自動判定する。パース率は全体で 99.67%。
    - 正解と完全に一致する。重要経路に触れた未検証の自動化も数える。
    - 識別子は一切出さず、外向きの通信は 0。
    - 1 GiB を CI で 24.4s（ローカルは 11.9s）。
    - SCAN-3 が最初の実行でユーザー名の漏れを捕まえた。直し方：外に見せる経路は既知の語だけ残し、他は `:param`。
    - diver の CLI が相対パスで gate-core を読む問題も直した。
  - scoreboard（CI）：PASS 10 → 14。ratchet は 14 件。
  - **検証器の強化**：
    - CRY-1 の禁止パターンを広げた（#12）。node:crypto の暗号、KDF、署名、destructured subtle、@noble など。
    - SEED-2 の 1/256 の揺れを直した（#13）。
  - **diver（#14〜#16）**：
    - DIV-3：Root の秘密鍵が平文で保存されていた。scrypt と AES-256-GCM で封をした（ADR-019）。Card Host と resolver は `ludion.root_kid` を除外する。
    - DIV-4：`ludion rotate`（2 段階）を足した。
    - REG-4：鍵スキャナを作った。git の全履歴、作業ツリー、npm pack を見る。許可リストは RFC 9421 のテスト鍵 1 件だけで、拇印で照合する。
  - **Gate（#17〜#19）**：
    - GATE-5：timeoutMs を入れた。fail_mode は Gate の故障にだけ効き、鍵の発見の失敗は UNVERIFIED（ADR-020、tarpit 対策）。直したバグ：
      - 壊れた Host で P2 をすり抜けられた
      - resolver や sink が止まると、リクエストも止まった
      - 時計の故障が SPOOFED になっていた
      - 真値を返す verify() が VERIFIED になっていた
      - 壊れた Registry 鍵で起動時に落ちた
    - PRIV-1：漏れを 2 つ見つけて直した。country ヘッダーがそのまま出ていたのと、経路に文字だけの値が出ていたこと。
    - PRIV-2：send_metadata false のとき、外に出るのは鍵の発見だけ。
  - scoreboard（CI）：PASS 14 → 20。ratchet は 20 件。
  - **Gate の穴（#21〜#23、#29〜#31）**：GATE-7 のコーパスは 39 → 76 件になった。
    - 経路のすり抜け：大文字、末尾スラッシュ、絶対形式、`/checkout` の基底パスが通っていた。本物の Express で確かめた（ADR-021）。
    - SSRF：名前の解決先 IP を見ていなかった。GATE-6 を足し、既定を `createSafeFetch` にした。
    - 別サイトのリプレイ：Host を偽ると別サイトの P2 で VERIFIED になった。`authorities` を足した（ADR-023）。
    - nonce キャッシュの追い出しでリプレイが通った。有効な nonce は追い出さない。
  - GATE-4：CI で p99 0.73ms。
  - **参照アプリ（#24〜#26）**：Express、Next.js、Workers。`@ludion/gate-next` と `@ludion/gate-workers`、`ludion.config.json` を足した（ADR-022）。
    - GATE-1：署名のないブラウザには、Gate の有無で同じバイトが返る。
    - GATE-3：導入はアプリ側 1〜3 行、最初のイベントまで 0.2〜3.6 秒。
  - **レポート（#27、#28）**：`ludion report` を足した。日本語と英語、HTML とテキスト。数字は正解と一致し、メールにそのまま載せられる。
  - PRS-1（#32）：10 万件のランダムな判定。
  - scoreboard（CI）：PASS 20 → 26。ratchet は 26 件。
- 2026-09-30（チャット）：
  - gate-core、gate-node、diver（CLI：init、sign、doctor、scan）、LP、E2E を作成した。
  - WG -00 のテストベクタを通過した。
  - ループの仕組みと MISSION.md を作成した。
  - spec を v1.0.1 に更新した（辞書形式、CIMD の Card、UNVERIFIED、ADR-013〜018、Q17）。
