# ADR-027：中立を2つのオラクルで測る。標準の参照実装は、版を固定して許す

日付：2026-09-30

## 決定

### NEUT-2（依存木にベンダーの SDK がない）

1. **何を見るか。** 対象は gate-core と Card Host の依存木全体。`package-lock.json` から Node の解決規則（近い `node_modules` が先）でたどる。辿る依存の種類：
   - dependencies
   - optionalDependencies
   - 省略可でない peerDependencies
2. **どう見るか。** 木の各パッケージを次の3通りで見る。
   - **名前とスコープ**：ベンダーの SDK、ランタイム、CLI の禁止リストに当たるか。禁止リストは広めに取る。Cloudflare、Vercel、AWS、Google、Azure、Fastly、Netlify、Akamai、Supabase、Deno Deploy などを含む。
   - **公開元**：`repository`・`homepage`・`bugs` の URL が、ベンダーの組織を指していないか。
   - **コード**：ベンダーの API エンドポイントを名指ししていないか。例：`api.cloudflare.com`、`*.workers.dev`、`*.amazonaws.com`、`*.googleapis.com`。
3. **例外。** ベンダーの組織が公開したパッケージは、標準の参照実装として **名前と版の完全一致** で載せたものだけを許す。ただし、名前の検査とエンドポイントの検査には通らなければならない。
4. **許しているもの**（すべて `cloudflare/web-bot-auth` 系のリポジトリ）：
   - `web-bot-auth@0.2.0`
   - `http-message-sig@0.3.0`
   - `jsonwebkey-thumbprint@0.1.0`
5. **版が変わったとき。** 別の版にすると FAIL する。人間が中身を見直し、`accept/neutral/deps.mjs` の `STANDARD_REFERENCE` を書き換えるまで通らない。
6. **自己テスト。** 走査器はリポジトリを見る前に、自分を試す。次のすべてを捕まえられなければ FAIL する。
   - 名前、推移的な依存、公開元、エンドポイント、peer で仕込んだベンダーの SDK
   - 許可した名前の別の版
   - 本物の lockfile の写しに注入した SDK

### NEUT-1（2つ以上の独立したランタイムで同じスイートが通る）

1. **ランタイム。** 同じスイート `packages/gate-core/test/portable/suite.mjs` を、Node、Deno、workerd の3つで一字一句変えずに走らせる。3つとも必須で、どれかが欠けたり、0件しか走らなかったりしたら FAIL。
2. **中身。** スイートが確かめるもの：
   - WG のテストベクタ
   - 主な分類
   - Staple
   - `decide()`
   - Glass の受領証
   - Card Host の media type
   - リプレイの拒否
3. **何に対して走らせるか。** `npm pack` した公開物に対して走らせる。リポジトリのリンクではない。
4. **固定したランタイム。** Deno 2.9.6、wrangler 4.144.0（workerd 1.20260926.1）。`accept/neutral/runtime/` の lockfile で固定し、OS の一時ディレクトリに入れてキャッシュする。
5. **Deno の権限。** Deno は権限なしで走らせる（`--no-prompt`、`--allow-*` なし）。gate-core がネットワーク、ファイル、環境変数に触れれば、それだけで FAIL する。
6. **workerd の条件。** workerd は `nodejs_compat` を付けて走らせる。gate-workers の README が顧客に求めている条件と同じ。

## 理由

- **web-bot-auth を許す理由。** web-bot-auth と、その下の2つを書いたのは Cloudflare の人だ。だが中身は IETF webbotauth の参照実装で、次の性質を持つ。
  - RFC 9421 と draft-ietf-webbotauth-httpsig-protocol の、プロトコルのコードだけでできている。
  - Apache-2.0。
  - Cloudflare のアカウント、サービス、エンドポイントを一切必要としない。
  - これを外すと、標準に互換であること（§8.4）と、暗号を自作しないこと（§8.11）が崩れる。
- **§8.3 が防ぎたいもの。** 防ぎたいのは「特定の網に縛られること」で、「その会社の人が書いた標準のコードを使うこと」ではない。
- **黙った例外にしない。** 例外は版ごとに固定する。名前の検査とエンドポイントの検査は例外にも効かせる。これで、同じ組織の別のパッケージや新しい版が紛れ込めば落ちる。
- **workerd を選ぶ理由。** Cloudflare の実行環境ではあるが、Node とは独立した実装で、spec §11.2 の P0 の対象でもある。顧客は自分のアカウントで動かすので、中立は保たれる。
- **Deno を加える理由。** ベンダーに依らない3つ目の実装として加えた。権限を絞って走らせられるので、「外に出ない」ことの検査も兼ねる。

## 捨てた代替案

- **web-bot-auth を名前だけで許す**：版が変われば中身も変わりうる。黙った例外になる。
- **npm の `maintainers` で判定する**：オフラインでは得られない。lockfile に基づく決定的な検査にならない。
- **Bun**：Deno で独立性は足りる。Windows と Linux の CI で固定版を配れることは Deno で確かめた。今後足すことは妨げない。
- **`nodejs_compat` なしの workerd**：gate-core は `node:crypto` の `createHash` と `randomBytes` を使っている。外すなら WebCrypto の digest に置き換える必要がある。受領証 ID の同期生成の形が変わるので、今回は見送った。

## 見直す条件

- web-bot-auth、http-message-sig、jsonwebkey-thumbprint の版を上げるとき。変更点を読み、`STANDARD_REFERENCE` を更新する。
- 参照実装がベンダーの組織から中立の組織（例：IETF の GitHub 組織）へ移ったとき。例外そのものが要らなくなる。
- gate-core から `node:crypto` を外したとき。workerd を `nodejs_compat` なしで走らせるように強める。
