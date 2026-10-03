# Mandate の上限はサイトのもの：per_day はサイトの全 Gate で1つに数える

- 日付：2026-10-01
- 状態：採用（人間の決定。Codex の監査 #4）
- 前の決定：docs/adr/2026-10-01-mandate-v0-passkey-consent-and-site-charge.md の「per_day は Gate のプロセスごとに数える」を置き換える。

## 文脈

Codex の監査 #4 の指摘：PRS-2 は、日ごとの上限を別の Gate で超えることを成功としていた。Gate S で上限3回を使い切った直後、同じ Mandate の決済を Gate U で許していた。

- 今の main で再現した。per_day が 1 の Mandate が、同じサイトの2つの Gate で1回ずつ通る。どちらの Gate も「残り0」と答える。

## 決定（人間）

- 上限は「そのサイトの全 Gate を通して1つ」と定義する。
- 数えるのはサイト側の共有の記録で、原子的に更新する。
- Registry には支出を持たせない（不変条件8「Registry は行き先を知らない」）。
- 共有の記録が無い構成では、上限付きの Mandate を受け付けない（fail closed）。

## 実装

- **数えるのは `per_day` だけ。**
  - 1回あたりの上限（`checkout_max`）、通貨、scope は、記録がなくてもどの Gate でも確かめられる（`chargeProblem`）。
  - 「上限付きの Mandate を受け付けない」は、数える上限（`per_day`）を持つ Mandate の決済を拒否する、と読んだ（`mandate_scope`、理由 `no_shared_ledger`）。
- **ledger の契約**：`{ shared: true, charge(mandate, { at }) → Promise<{ ok, count } | { ok: false, reason }> }`。
  - 過去24時間の数を確かめ、上限なら拒み、そうでなければ記録する。これを一度に行う。
- **実装**
  - `memoryLedger()`（gate-core）：このプロセスがサイトの唯一の Gate のとき。選ぶこと自体が、その宣言になる。
  - `sqliteLedger(file)`（gate-node、`node:sqlite`、Node 22.13 以降）：1台の機械の複数プロセス。各決済は `BEGIN IMMEDIATE` のトランザクション。データベースの書き込みの鍵が、同時の決済を順に並べる。
  - それ以外（複数の機械、Workers）：サイトが同じ契約で自分のデータベースや Durable Object を渡す。
    - Workers は isolate がメモリを共有しないので、設定ファイルでは名指せない（`withLudion(handler, { mandateLedger })` だけ）。
- **設定ファイル**：`"mandate_ledger": "memory"` か `{ "sqlite": "<file>" }`。
- **`charge()` は Promise を返すようにした**（`await req.ludion.charge(...)`）。まだ公開していない API なので、互換は問わない。

## 人間の確認（2026-10-02）

- 読みは正しい。数えるのは per_day で、1回あたりの上限と通貨は記録なしでどの Gate でも効く。
- 加えて：期間の中で累計する上限（1日の合計金額など）があれば、回数と同じく記録が要る。記録が無い構成では、同じく受け付けない側に倒す。
- 実装：v0 の Gate が持てる上限は `checkout_max`、`currency`、`per_day` だけ（`LIMIT_KEYS`）。それ以外の上限を持つ Mandate の決済は、記録があってもなくても `mandate_scope`（理由 `unenforceable_limit`）で拒否する。累計の上限を足すときは、契約（ledger の `charge`）に金額を渡し、その上限を `LIMIT_KEYS` に足す。
- 今の main では、`day_total_max` を持つ Mandate の決済が通っていた（強制できない上限を黙って無視していた）。PRS-3 に足したテストが、それを落とす。

## 結果

- **PRS-3（監査の PRS-2D）**
  - 2つの Gate のプロセスが1つの SQLite を共有する。上限内はどちらでも通り、合計を1回超えるとどちらでも拒否される。
  - 12件を同時に送っても、通るのはちょうど per_day 件（5回くり返す）。
  - 記録のない Gate は拒否する。1回あたりの上限はどこでも効く。
  - Workers は1つの記録を渡せば共有し、なければ拒否する。
  - Registry は動かしていない（支出を持たない）。
- **PRS-2 の期待を裏返した**：S で使い切った Mandate は、同じサイトの U でも `per_day` で拒否される。S、U、そして shop.example を受け持つ M は、1つの記録を共有する。
- **残ること**
  - 複数の機械の参照実装（例：Postgres、Durable Object）は、まだない。契約と README だけ。
  - サイトが2つの Gate にそれぞれ `"memory"` を書くと、上限はそれぞれで数えられる。Gate からはそれを見分けられない（README に書いた）。
