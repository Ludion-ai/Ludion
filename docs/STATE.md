# STATE

最終更新：2026-09-30（チャットでシードを作成。Claude Code への引き継ぎ）

## 現在地

- 段：M0（ループ）。シードは緑。ループの仕組み（scoreboard、ratchet、CI、フック）は動く。
- 数字は `npm run scoreboard` が正。ここには書き写さない。

## 次の一手

1. リポジトリを作って push する（キックオフの指示に従う）。
2. SEED-1 と SEED-2 が既にカバーしている部分を目録の ID に配線する：STD-2、GATE-2、GATE-7、DIV-2。
3. SCAN-1〜4。創業者が今週の営業で `npx ludion scan` を使う。
4. GATE-1、GATE-5、PRIV-1。

## 人間待ち

- [ ] npm `ludion` と `@ludion`、PyPI `ludion` の確保（2026-09-30 時点で全て空き。匂わせ投稿の前に）
- [ ] リポジトリの公開設定の判断（public なら GitHub Free でもブランチ保護が使え、Actions も無料）
- [ ] main のブランチ保護：PR 必須、`loop` チェック必須、auto-merge 許可
- [ ] `CLOUDFLARE_API_TOKEN`（Workers スクリプトの編集だけ。ゾーンと DNS は付けない）→ LIVE-1
- [ ] `SIGNUP_WEBHOOK_URL` → LP の登録通知
- [ ] 商標の調査（区分 9、42、45）

## BLOCKED

（なし）

## 既知の問題（シード）

- diver の CLI が gate-core を相対パスで読んでいる。`npm pack` すると壊れる。DIV-1 が捕まえるはず。
- `ludion doctor` の時計チェックは未実装（ローカル時刻を表示するだけ）。
- LP の登録関数 `site/api/signup.js` は Vercel 形式。DNS は Cloudflare なので、置き場所は自由に選んでよい。LP は未デプロイ。
- resolver の SSRF 対策はホスト名の検査だけ。解決先 IP の検査（DNS リバインディング）は GATE-6 で。

## 直近のセッション

- 2026-09-30（チャット）：gate-core、gate-node、diver（CLI：init、sign、doctor、scan）、LP、E2E を作成。WG -00 のテストベクタを通過。ループの仕組みと MISSION.md を作成。spec を v1.0.1 に更新（辞書形式、CIMD の Card、UNVERIFIED、ADR-013〜018、Q17）。
