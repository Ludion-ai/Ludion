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
  - 次は NIGHT.md の優先順：WEB-3（`/e/<code>`）→ WEB-4 と WEB-6（ブラウザ版 scan）→ WEB-1/2/5/8 → 目録の残り → GATE-9（PHP と WordPress、Python）→ WEB-7 → LIVE-1。
  - 夜勤レーンの ADR は 040〜049 を使う（昼のレーンの 030〜 と衝突させないため）。

## 人間待ち

- [ ] npm `ludion` と `@ludion`、PyPI `ludion` の確保（2026-09-30 時点で全て空き。匂わせ投稿の前に）
- [x] リポジトリの公開設定の判断 → public、`Ludion-ai/Ludion`（2026-09-30）
- [x] main のブランチ保護：PR 必須、`loop` チェック必須、auto-merge 許可（2026-09-30。strict と enforce_admins も付けた）
- [ ] `CLOUDFLARE_API_TOKEN`（Workers スクリプトの編集だけ。ゾーンと DNS は付けない）→ LIVE-1
- [ ] `SIGNUP_WEBHOOK_URL` → LP の登録通知
- [ ] 商標の調査（区分 9、42、45）
- [ ] （任意）見込み客の了承を得た本物のアクセスログ。scan のコーパスは今は合成データだけ。本物が 1 本あれば、それが一番良い次のフィクスチャになる。`accept/fixtures/logs/` に入れる前に匿名化の方針を決める。
- [ ] 判断：fail_mode "closed" の拒否は今 `signature_required`（401）で返している。署名済みの正規エージェントには紛らわしい。専用のコード（例：503 `gate_unavailable`）を spec §10.11 に足すか（ADR-020）。
- [ ] 判断：GATE-1 は Next.js のビルド成果物の名前の変化を「一貫した改名」に限って許している（`reference/test/gate1.test.mjs` の `NORMALISATIONS`）。原因は proxy.js を足すとクライアントのチャンク名が 2 つ変わること。これを「バイト単位で一致」と読んでよいか（#25）。
- [ ] 判断：日次レポートの metadata event に `operator` を足すか。足せば DECLARED の運営者別の上位を出せる。ただし spec §11.7 の送信項目が変わる（#28）。
- [ ] 日次レポートの送信基盤：送信サービス、送信ドメイン、SPF/DKIM/DMARC、配信停止。`ludion report` は中身を作るだけで、送信はしない。
- [ ] 判断：nonce なしの同一署名を、同じメソッドと URL へ再送したら SPOOFED にしている（GATE-7、PR #4）。正規のリトライも弾く。これを受け入れるか、`requireNonce` を既定にするか。

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
- DIV-2 で未カバーの部分：
  - TLS は通していない（Host ヘッダーを保ってローカルに転送）
  - web-bot-auth@0.2.0 のパーサが registry-03 に準拠しているか

## 直近のセッション

- 2026-10-01（夜勤 1）：GATE-9 と M7 Web（WEB-1〜8）を目録と registry に PENDING で登録した（#43）。ID の衝突はなし。LOOP-1 は PASS のまま、目録は 39 → 49 件。

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
