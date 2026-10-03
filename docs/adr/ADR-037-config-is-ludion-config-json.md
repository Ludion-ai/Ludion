# ADR-037：設定ファイルは `ludion.config.json`。spec の方を実装に合わせる

日付：2026-10-03（人間の決定 3）

## 決定

- Gate の設定は `ludion.config.json`（Workers では変数 `LUDION` に同じ JSON）のまま（ADR-022）。
- spec v2.0 §12.7 の YAML の例（`ludion.yaml`）は、v2.0.1 で JSON の例に直した。JSON にはコメントを書かず、説明は例の下に箇条で書く。
- v2.0 で足された項目（`decisions`、`routes[].writes`、`require.purpose`）は、BLK-1、§12.1、PUR の実装で設定に足す。それまでは、知らない項目として止まる。

## 理由

- 実装と導入の README（GATE-3 の測る3行）は、すでに `ludion.config.json` で動いている。
- YAML を読むには依存が1つ増える。Gate の依存は最小にする（spec §12.9）。

## 捨てた代替案

- **`ludion.yaml` に移す**：依存が増え、ADR-022 と導入の手順を書き直すことになる。

## 見直す条件

コメントを書けないことが、導入の妨げになると分かった時。

## 出典

spec v2.0.1 §12.7。ADR-022。
