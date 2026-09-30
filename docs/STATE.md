# STATE

最終更新：2026-09-30（Claude Code セッション 1）

## 現在地

- 段：M0（ループ）は完了。M1（STD、GATE）と M2（DIV）に着手した。
- ループの仕組みは Linux/Node 22 と Windows/Node 24 の両方で回る。
- リポジトリは https://github.com/Ludion-ai/Ludion （public）。main は保護されている：PR 必須、`loop` チェック必須、strict、enforce_admins、auto-merge 可。
  - strict なので、main が先に進んだ PR は `gh pr update-branch` しないとマージされない。
  - `loop-windows` は必須チェックではない。
- 数字は `npm run scoreboard` が正。ここには書き写さない。

## 次の一手

1. SCAN-1〜4。ブランチ `scan/oracles`（ローカルのみ、未 push）で作業中。土台は旧 `wire/seed-oracles` の c3d0b2f なので、`git rebase origin/main` してから PR を出す。創業者が今週の営業で `npx ludion scan` を使う。
2. DIV-3（DIV-2 の負の対）。DIV-2 に UNPAIRED の警告が出ている。
3. GATE-1、GATE-5、PRIV-1。
4. STD-3（独立実装との相互運用）。

## 人間待ち

- [ ] npm `ludion` と `@ludion`、PyPI `ludion` の確保（2026-09-30 時点で全て空き。匂わせ投稿の前に）
- [x] リポジトリの公開設定の判断 → public、`Ludion-ai/Ludion`（2026-09-30）
- [x] main のブランチ保護：PR 必須、`loop` チェック必須、auto-merge 許可（2026-09-30。strict と enforce_admins も付けた）
- [ ] `CLOUDFLARE_API_TOKEN`（Workers スクリプトの編集だけ。ゾーンと DNS は付けない）→ LIVE-1
- [ ] `SIGNUP_WEBHOOK_URL` → LP の登録通知
- [ ] 商標の調査（区分 9、42、45）
- [ ] 判断：nonce なしの同一署名を、同じメソッドと URL へ再送したら SPOOFED にしている（GATE-7、PR #4）。正規のリトライも弾く。これを受け入れるか、`requireNonce` を既定にするか。

## BLOCKED

（なし）

## 既知の問題

- diver の CLI が gate-core を相対パスで読んでいる。`npm pack` すると壊れる。DIV-1 が捕まえるはず。
- `ludion doctor` の時計チェックは未実装（ローカル時刻を表示するだけ）。
- LP の登録関数 `site/api/signup.js` は Vercel 形式。DNS は Cloudflare なので、置き場所は自由に選んでよい。LP は未デプロイ。
- resolver の SSRF 対策はホスト名の検査だけ。解決先 IP の検査（DNS リバインディング）は GATE-6 で。
- nonce キャッシュは容量超過で古い順に捨てる。自前の鍵で大量に送れば、被害者の nonce を追い出せる。プロセスをまたがない。GATE-7 のコーパス候補。
- 署名が 2 つあるリクエストは LabelRequired で丸ごと SPOOFED になる。他の RFC 9421 プロファイル（例：Visa TAP）との共存は STD-3 で検討する。
- DIV-2 で未カバーの部分：
  - TLS は通していない（Host ヘッダーを保ってローカルに転送）
  - web-bot-auth@0.2.0 のパーサが registry-03 に準拠しているか

## 直近のセッション

- 2026-09-30（Claude Code 1）：
  - **Windows/Node 24 の修正（#1）**：ラチェット済みの 4 件が落ちていた。原因は Node ≥23 の test reporter と、パスの区切り文字。検証器を移植可能に直し、`loop-windows` CI と `.gitattributes`（eol=lf）を追加した。
  - **配線した 4 オラクル**：
    - STD-2（#2）：不正な署名が UNVERIFIED になっていたのを SPOOFED に直した。
    - GATE-2（#3）
    - GATE-7（#4）：攻撃コーパスを 39 件作った。シードの Gate を 9 件が通っていた。穴は 4 つで、スキュー中のリプレイ、nonce なしのリプレイ、署名剥がし、ボディ未束縛。
    - DIV-2（#5）：`@ludion/card-host` を新設した。
  - scoreboard（CI）：PASS 6 → 10。ratchet は 10 件。
- 2026-09-30（チャット）：
  - gate-core、gate-node、diver（CLI：init、sign、doctor、scan）、LP、E2E を作成した。
  - WG -00 のテストベクタを通過した。
  - ループの仕組みと MISSION.md を作成した。
  - spec を v1.0.1 に更新した（辞書形式、CIMD の Card、UNVERIFIED、ADR-013〜018、Q17）。
