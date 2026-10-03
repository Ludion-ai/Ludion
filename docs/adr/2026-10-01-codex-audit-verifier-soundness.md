# Codex の監査の検証器の健全性：ベース、ラチェットの SKIP、STD-1、GATE-10、Actions、対

- 日付：2026-10-01
- 状態：採用
- 出所：Codex による検証器の監査（指摘 1、2、3、9、10）と、人間の判断（2 の規則、WEB-1 の専用ジョブ、対の意味、追加オラクルの採用）。

## 文脈

| # | 指摘 | 今の main での再現 |
|---|---|---|
| 1 | ベースブランチを読めないと、ラチェットが空になって通る | `scoreboard --base <無い ref>` が終了 0、退行 0 |
| 2 | ラチェット済みのオラクルの SKIP が退行にならない | WEB-1 は CI にトークンがなく SKIP のまま緑 |
| 3 | STD-1 は「WG のベクタが Gate を通る」を測っていない | ライブラリを寿命上限 1e12 で直接呼ぶだけ。名前のフィルタは拇印のテストだけでも通る |
| 9 | GATE-10 の期待値の一部を、検査対象の Gate の答えから作っている。raw は本物のアダプタを通らない | 書き出しが Gate の答えを reference として書く。raw はアダプタの模型を通る |
| 10 | Actions が SHA で固定されず、permissions もない | ci.yml の `@v4` と、permissions の欠如 |

## 決定

### 1. ベースは先に読み、読めなければ止める（LOOP-3）

- `scripts/ratchet.mjs` の `readBase(ref)`：ratchet と registry の ID を読む。次のどれかなら例外。
  - 読めない。
  - JSON でない。
  - `passed` が ID の列でない、または空。
  - registry に ID がない。
  - ratchet に registry にない ID がある。
- scoreboard はこれを最初に呼び、失敗なら終了 2。オラクルは一つも回さない。
- オラクルが起こした scoreboard（`LUDION_NESTED_SCOREBOARD`）は、オラクルを回さない（再帰しない）。

### 2. ラチェット済みは PASS だけ（LOOP-4）

- 人間の規則：ラチェット済みのオラクルは、PASS 以外をすべて退行にする。
- 例外は3つだけ。
  - RETIRED（MISSION.md の退役の条件を満たしたもの）。
  - ELSEWHERE（ワークフローに実在する別の CI ジョブで回るもの）。
  - `--fast` でまだ一度も回っていない UNRUN（何も分かっていない）。
- SKIP は例外にしない。だから、ラチェット済みのオラクルは `needs`（人の入力）を持てない。LOOP-4 がこれを確かめる。
- `--job <name>`：そのジョブのオラクルだけを回す。他は ELSEWHERE。
  - 名指されたジョブがワークフローに無ければ退行。
  - `--job` の実行は、キャッシュ（`--fast` が読む）もラチェットも書かない。
- WEB-1：`needs` を外し、`job: "preview"` にした。
  - CI の `preview` ジョブが、このチェックアウトのサイトをプレビューに出してから回す。プレビューは、エージェント用アカウント `Ludion Agents` の Worker。
  - トークンは GitHub の secret `CLOUDFLARE_PREVIEW_API_TOKEN` と `CLOUDFLARE_PREVIEW_ACCOUNT_ID`（人間が作って登録する）。
  - デプロイは他のアカウントに届くトークンを拒む（DEPLOY.md §2）。
  - 手元では、最後に出したプレビューに対して回る。
- 人間が secret を登録し、`preview` を必須のチェックにするまで、WEB-1 は CI で強制されない（`loop` では ELSEWHERE）。今までも SKIP で強制されていなかったので、緩めてはいない。

### 3. STD-1 は暗号、Gate の経路は STD-5

- STD-1 を、測っているものに合わせて定義し直した。WG のベクタ（E.2.1 と E.2.2）が、Gate と同じライブラリと鍵の発見で、暗号として検証できること（寿命は問わない。ベクタの寿命は §10.4 の60秒を超える）。E.2.2 の暗号のテストを足した。
- STD-5（監査の STD-1G）：同じ鍵・ラベル・成分・tag で、created を今、寿命60秒で署名し直したものが、実際の Gate（inspect と gate-node の HTTP）で VERIFIED になる。対は STD-2（寿命超過は拒否）。
- 2026-10-02、人間が STD-1 の定義の直しを承認した。STD-5 は STD-2 と対にしてラチェットした（#70）。
- `nodeTest` に `requires` を足した。名前で指定したテストが全部実行されて通らなければ FAIL。STD-1 と STD-5 に使う。拒否の側の数え方の穴（フィルタが別のテストだけに当たる）を塞ぐ。

### 9. 期待値は Gate から作らない。raw は本物のアダプタを通す（GATE-10、GATE-7）

- 各攻撃（`accept/attacks/*.json`）に `classes` を足した。その攻撃が受けるべき spec §10.8 の分類で、レビューしたもの。
  - GATE-7 の実行器は、`classes` がない攻撃と、分類が外れた攻撃を落とす。
  - 書き出しは、Gate の答えが `classes` の外なら止まる。
  - ベクタの拒否のステップは全部 `classes` を持つ。GATE-7 の分はコーパスと一致する。
  - 今の Gate の答えから初期値を取ったが、全件を spec §10.8 と照らして確かめた（ADR の付表は PR に）。以後、書き出しで黙って変わることはない。
- GATE-10 は、raw のステップ（104件）を本物の `@ludion/gate-node` のミドルウェアに通し、記録した答え（分類、判定、エラー、アプリに届いたか）と一致することを求める。
  - 可搬の実行器（Deno、workerd 用）は模型のままだが、模型と本物が食い違えば GATE-10 が落ちる。

### 10. Actions は SHA で固定し、権限は読むだけ

- `actions/checkout` と `actions/setup-node` を、今 `@v4` が指す v4.4.0 のコミットに固定した（コメントに版を書く）。
- ワークフロー全体の `permissions: contents: read`。

### 対の意味（人間の項目 4、LOOP-5）

- 対は同じ性質の裏表。両側の registry の `property` が同じで、相手は − か ±。MISSION.md の ± と 対 の列は registry と一致する。
- 組み直し：
  - GATE-4 の相手を GATE-6 から GATE-5 に変えた。どちらも「Gate が足す遅延」を測る（通常の p99 と、壊れたときの上限）。
- 解いた対：いずれも性質が別だった。
  - GATE-3 と GATE-5。
  - SCAN-1、SCAN-4 と SCAN-3。
  - SCAN-2 と SCAN-3。
  - RPT-1 と PRIV-1。
  - LIVE-1 と GATE-5。
  - LIVE-3 と PRIV-1。
  - WEB-4 と WEB-6。
  - WEB-7 と WEB-2。
- 種類を変えた：SCAN-2 と RPT-1 を ±。正解と完全に一致することは、多すぎも少なすぎも落とす。
- 対のない正のオラクル（GATE-3、SCAN-1、SCAN-4、WEB-4、ほかに PENDING の LIVE-1、LIVE-3、WEB-7）は、PASS しても scoreboard が「対がない（まだ信用できない）」と出す。それぞれの負のオラクルは今後の課題（バックログに見える）。

### 追加オラクルの ID（人間：目録の形に合わせて採用）

| 監査の案 | ID |
|---|---|
| META-BASE | LOOP-3 |
| META-RATCHET | LOOP-4 |
| STD-1G | STD-5 |
| PRS-2D | PRS-3（Mandate の上限の PR） |
| BODY-1 | GATE-11（#69） |
| GATE-6N | GATE-12（#69） |
| PRS-1O | PRS-4（#69） |

## 結果

- 消したオラクル、緩めた閾値はない。
- 定義を直した：STD-1（測っていたものに合わせ、元の主張は STD-5 が実際の Gate で測る）。
- 人間に要ること：
  - secret の登録。
  - `preview` を必須のチェックにする。
