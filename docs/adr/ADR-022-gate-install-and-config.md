# ADR-022：Gate の設定は ludion.config.json（Workers は `LUDION` var）1 個、導入は 1〜3 行

日付：2026-09-30

## 決定

1. **設定ファイルは 1 個。形は spec §11.4 のまま、書式は JSON。**
   - Node（Express など）と Next.js：`ludion.config.json` を `package.json` の隣に置く。別の場所なら `$LUDION_CONFIG`。
   - Workers：実行時にファイルを読めない。`wrangler.toml` の `[vars.LUDION]` に同じキーを書く。TOML の表でも JSON 文字列でもよい。
   - 変換は `@ludion/gate-core/config` の `gateConfig()` がやる。実行環境に依存しない。
2. **知らないキーは起動時のエラー。** `"presure": 2` が黙って Pressure 0 になるのが一番危ない。
3. **Glass 受領証の鍵は秘密情報からだけ受け取る。** Node と Next.js は `$LUDION_SITE_KEY`、Workers は secret の `LUDION_SITE_KEY`。
   - 設定ファイルには書かせない。REG-4 がリポジトリで捕まえる。
   - 鍵が無ければ起動時に一時鍵を作る。受領証はそのプロセスが生きている間だけ検証できる。60 秒で入るための既定。
4. **`report.endpoint` を足す。** 分類イベント（メタデータだけ、§11.7）を JSON で POST する。Gate は待たない。Workers では `ctx.waitUntil` に渡す。
5. **導入の行数：**

   | 環境 | 導入 | 変わる行 |
   |---|---|---|
   | Express | `import { ludion } from "@ludion/gate-node";` と `app.use(await ludion());` | 2 行 |
   | Next.js 16 | 新しいファイル `proxy.js`：`export { proxy } from "@ludion/gate-next";` | 1 行 |
   | Workers | import と、既定の export を `withLudion({ … })` で包む | 3 行 |

   Workers は `nodejs_compat` が要る。gate-core が受領証の ID と IP のハッシュに `node:crypto` を使うため。
6. **設定が壊れているとき：**
   - Next.js と Workers：素通しにして、エラーを 1 回だけログに出す。サイトは止めない。この 2 つは最初のリクエストで初めて設定を読むので、それより前に止める機会が無い。
   - Node：`await ludion()` が起動時に失敗する。導入した直後の端末か、デプロイの起動確認で、その場で見える。黙って Gate 無しで動くより良い。

## 理由

- **YAML にしない。** spec の例は `ludion.yaml` だが、YAML を読むには依存が 1 個要る。§11.10 は依存を最小にすると決めている。JSON なら Node、Next.js、Workers のどこでも依存なしで読める。
- **`ludion.json` にしない。** Diver の身元ファイルが `ludion.json` で、Session の秘密鍵が入っている。同じ名前は事故のもとになる。
- **Next.js は `proxy.js` にする。** Next.js 16 は middleware を proxy に改名し、Node.js ランタイムで動かす。だから `fs` と `node:crypto` がそのまま使える。
- **Workers は wrapper にする。** 既存の `export default { fetch }` を包むだけで済む。`scheduled` など他のハンドラも残る。

## 分かったこと（GATE-1）

- **config の redirects は Gate を通らない。** Next.js の `next.config.js` の `redirects()` は proxy より前に走る（Next.js の順序）。そこで返るリクエストを Gate は見られない。
  - 人間への影響は無い。
  - 自動化の分類から漏れる。レポートの件数に響くなら、将来 `redirects()` を proxy の中へ移す案内を書く。
- **Next.js のクライアント chunk の名前が変わる。** Gate を入れると、内容ハッシュ付きのクライアント chunk が 2 個、名前を変える。Turbopack でも webpack でも起きる。
  - 原因：バンドラがビルド全体でモジュールに番号を振る。Gate のサーバ専用モジュールが増えると、クライアント側のモジュール ID が 1 個ずれる。
  - コードは同じ。GATE-1 は chunk を 1 個ずつ両方のサーバから取り、次の 2 つの違いしか無いことを確かめている：
    - 名前の一貫した付け替え
    - minify された局所変数名（1〜2 文字）
  - 空の proxy や、`next/server` だけの proxy では起きない。
  - 利用者側の影響：Gate を入れたデプロイで、ブラウザがその 2 個を 1 回取り直す。普通のデプロイと同じ。

## 捨てた代替案

- **Next.js を `next.config.js` に `withLudion()` を足す形にする。** proxy が必要なのは変わらない。行数だけ増える。
- **Workers の設定を別ファイル（`ludion.config.json` を import）にする。** 設定ファイルが 2 個（`wrangler.toml` とそれ）になり、GATE-3 の「1 個以内」を破る。
- **サイトの鍵を設定ファイルに書く。** 秘密鍵がリポジトリに入る。

## 見直す条件

- YAML を求める声が大きいとき。依存なしの読み込みが要るので、書式の一部だけを受ける方式を検討する。
- Next.js の proxy の順序や実行環境が変わったとき。
- Glass の受領証をエージェントと共有し始めたとき。一時鍵を既定のままにしてよいかを見直す。
