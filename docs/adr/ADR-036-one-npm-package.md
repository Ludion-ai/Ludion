# ADR-036：npm に出すのは `ludion` の1本だけ。中の8パッケージは private のまま束ねる

日付：2026-10-03（人間の決定 2）

## 決定

- npm に出すのは `ludion` の1本だけ。
- 中身は CLI（`npx ludion`）と、サブパスの `ludion/gate/next`・`ludion/gate/node`・`ludion/gate/workers`・`ludion/diver`。
- リポジトリの中のパッケージ（`@ludion/gate-core`、`gate-node`、`gate-next`、`gate-workers`、`diver`、`scan`、`report`）は private のまま、`ludion` の tarball に束ねる。サーバー側の `@ludion/card-host` と `services/registry` は束ねない。
- 初版は人間が手で出す（npm は、存在しないパッケージに trusted publisher を設定できない）。2版目から Trusted Publishing（PUB-4 の release ワークフロー）に切り替える。

## 理由

- 名前は1つで足りる。利用者が入れるのも、npm に組織を作るのも1回で済む。
- 中の分け方は、リポジトリの都合（テスト、依存の境界）であって、利用者の都合ではない。
- 公開の道が1本なら、PUB の検査も1本で済む。

## 捨てた代替案

- **8パッケージをそのまま出す**（PUBLISH.md の旧 §0）：名前が多く、版をそろえる手間と、組織 `@ludion` の作成が要る。
- **`@ludion/gate` にサブパスをまとめる**（spec v2.0 §10.3）：組織 `@ludion` が要り、名前が2つになる。

## 見直す条件

ある利用者層が、CLI を入れずに Gate だけを入れたいと分かった時（依存の大きさが問題になった時）。

## 出典

spec v2.0.1 §10.3、§13.2、§20.2。PUB-1〜4、docs/PUBLISH.md。
