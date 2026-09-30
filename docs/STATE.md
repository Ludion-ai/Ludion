# STATE

最終更新：2026-09-30（Claude Code セッション 1、#32 まで）

## 現在地

- 段：M0（ループ）と M4（SCAN-1〜4、RPT-1）は完了。
  - M1：残りは STD-3、STD-4、GATE-8、PRIV-3。
  - M2：DIV-2/3/4 まで。
  - M3：REG-2/4 まで。
  - M5：PRS-1、CRY-1 まで。
- ループの仕組みは Linux/Node 22 と Windows/Node 24 の両方で回る。
- リポジトリは https://github.com/Ludion-ai/Ludion （public）。main は保護されている：PR 必須、`loop` チェック必須、strict、enforce_admins、auto-merge 可。
  - strict なので、main が先に進んだ PR は `gh pr update-branch` しないとマージされない。
  - `loop-windows` は必須チェックではない。
- 数字は `npm run scoreboard` が正。ここには書き写さない。

## 次の一手

1. 進行中（ローカルのみ。どれも `PRS-1 PASS` の main から始めた）：
   - `registry/v0`：Registry v0（`services/registry`）と REG-1、REG-3、PRIV-3
   - `neutral/runtimes`：NEUT-1、NEUT-2
   - `interop/std3-div1`：STD-3（相互運用）と DIV-1（TS と Python の Diver をクリーンなコンテナで）
2. PRS-2（Mandate v0）。
3. STD-4（datatracker の版の追随。L2）。
4. PRIV-1/2 の強化：ワークロードを既定の `createSafeFetch` 経由でも回す。ワイヤは `dial` フックで捕まえる。
- ADR の次の番号：025〜029 は上の 3 本が予約済み。その次は 030。
- 夜勤レーン（2026-10-01、`.loop/NIGHT.md`。別の作業ツリーで並走）：
  - GATE-9 と M7 Web（WEB-1〜8）を PENDING で登録した（#43）。
  - WEB-3：`site/` を Astro と Starlight にした（ADR-040）。`/e/<code>` と `/ja/e/<code>` が 9 コード × 2 言語ある。
  - WEB-4：`/scan` と `/ja/scan` にログを落とすと、CLI と同じ数字が出る（docs/adr/2026-10-01-browser-scan-shares-the-cli-core.md）。
  - WEB-6：scan はログのバイトを外に出さない。測り方は `site/test/egress.mjs`（監視）と `site/test/web6.test.mjs`。
    - サイトの PR は、`loop-windows` が緑になってから auto-merge を付ける（#45 の教訓）。
  - WEB-5：リンク切れ、コンソールエラー、許可リスト外の通信が 0（docs/adr/2026-10-01-site-links-own-origin-and-gate-page.md）。
    - リンクの規則は `site/test/links.mjs`。ファイルにも、使ったあとの DOM にも同じ規則をかける。
    - `/gate` と `/ja/gate`（Gate の入れ方）と、日本語の 404 を足した。
  - WEB-2：文面が法務の線（spec §14）を越えず、数字はすべて出所を持つ（docs/adr/2026-10-01-copy-check-legal-line-and-figure-sources.md）。
    - 規則は `site/test/copy.mjs`。新しい文面で数字を書くときは、同じブロックに、その数字を言っているリポジトリの文書（spec か MISSION.md の節）へのリンクを置く。行数はすぐ後のコードブロックが出所。
    - 保険、保証、100% の類の語は、否定を語に付けたときだけ書ける（「Ballast v0 is not insurance」）。
  - 次は NIGHT.md の優先順：WEB-8 → WEB-1（トークン待ち）→ 目録の残り → GATE-9（PHP と WordPress、Python）→ WEB-7 → LIVE-1。
  - WEB-8 の入口：
    - 受け口は既存の `site/api/signup.js`（Vercel 形式、未デプロイ）。静的サイトなので、受け口は Worker か Pages Functions にするのが自然。どこに置いても動く形にする。
    - プレビューに出せない今は、ローカルで受け口を立てて、フォームから通知のスタブまで届くことと、ハニーポットとレート制限でボットが落ちることを測る。
    - WEB-5 と WEB-6 の許可リストはサイト自身のオリジンだけ。フォームの送信先も同じオリジンに置く。scan のページからは何も送らない（WEB-6）。
  - プレビューのデプロイ（WEB-1）：今のトークンでは何も読めない（docs/DEPLOY.md 1.1）。人間待ちに書いた。
  - 新しい ADR には番号を付けない。`docs/adr/YYYY-MM-DD-<slug>.md` にする（NIGHT.md §8、両レーン共通）。

## 人間待ち

- [ ] npm `ludion` と `@ludion`、PyPI `ludion` の確保（2026-09-30 時点で全て空き。匂わせ投稿の前に）
- [x] リポジトリの公開設定の判断 → public、`Ludion-ai/Ludion`（2026-09-30）
- [x] main のブランチ保護：PR 必須、`loop` チェック必須、auto-merge 許可（2026-09-30。strict と enforce_admins も付けた）
- [ ] `CLOUDFLARE_API_TOKEN`（Workers スクリプトの編集だけ。ゾーンと DNS は付けない）→ LIVE-1
  - 2026-10-01 夜勤：渡されたトークンは有効だが、`CLOUDFLARE_ACCOUNT_ID` のアカウントでは、どの資源も 401 だった。Workers、Pages、KV、D1、R2、workers.dev のすべて。
  - アカウント ID の食い違いか権限の不足。このままでは WEB-1 のプレビューも LIVE-1 もデプロイできない。
  - 確かめ方は docs/DEPLOY.md 1.2。
- [ ] 旧 Ludion の Cloudflare 資源の棚卸し（NIGHT.md §7）：読み取りトークンで `node scripts/cf-inventory.mjs` を1回実行し、docs/DEPLOY.md 1.3 の削除リストを埋める（GET だけ）。
- [ ] 判断（お金）：Card Host の `*.agents.ludion.ai` は2段目のワイルドカードで、Universal SSL の範囲外。
  - 選択肢：Advanced Certificate Manager（有料）、名前を `dvr-….ludion.ai` に寄せる（spec の変更）、別のドメイン。
  - 詳細は docs/DEPLOY.md 4。
- [ ] `SIGNUP_WEBHOOK_URL` → LP の登録通知
- [ ] 商標の調査（区分 9、42、45）
- [ ] （任意）見込み客の了承を得た本物のアクセスログ。scan のコーパスは今は合成データだけ。本物が 1 本あれば、それが一番良い次のフィクスチャになる。`accept/fixtures/logs/` に入れる前に匿名化の方針を決める。
- [ ] 判断：fail_mode "closed" の拒否は今 `signature_required`（401）で返している。署名済みの正規エージェントには紛らわしい。専用のコード（例：503 `gate_unavailable`）を spec §10.11 に足すか（ADR-020）。
- [ ] 判断：GATE-1 は Next.js のビルド成果物の名前の変化を「一貫した改名」に限って許している（`reference/test/gate1.test.mjs` の `NORMALISATIONS`）。原因は proxy.js を足すとクライアントのチャンク名が 2 つ変わること。これを「バイト単位で一致」と読んでよいか（#25）。
- [ ] 判断：日次レポートの metadata event に `operator` を足すか。足せば DECLARED の運営者別の上位を出せる。ただし spec §11.7 の送信項目が変わる（#28）。
- [ ] 日次レポートの送信基盤：送信サービス、送信ドメイン、SPF/DKIM/DMARC、配信停止。`ludion report` は中身を作るだけで、送信はしない。
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

- `ludion doctor` の時計チェックは未実装（ローカル時刻を表示するだけ）。
- LP の登録関数 `site/api/signup.js` は Vercel 形式。DNS は Cloudflare なので、置き場所は自由に選んでよい。LP は未デプロイ。
- resolver の SSRF 対策はホスト名の検査だけ。解決先 IP の検査（DNS リバインディング）は GATE-6 で（進行中）。
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
- DIV-2 で未カバーの部分：
  - TLS は通していない（Host ヘッダーを保ってローカルに転送）
  - web-bot-auth@0.2.0 のパーサが registry-03 に準拠しているか

## 直近のセッション

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
