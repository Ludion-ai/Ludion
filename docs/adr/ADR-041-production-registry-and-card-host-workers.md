# ADR-041：本番の名簿と Card Host は、本番アカウントの Workers を2つに分ける。v0 の署名鍵は Workers の秘密

日付：2026-10-03（人間の決定 6）

## 決定

- 本番の名簿（Registry）と Card Host は、本番の Cloudflare アカウントの Workers を2つに分ける。
  - `registry.ludion.ai`：名簿。登録、Staple と Mandate の発行、失効。
  - `*.agents.ludion.ai`：Card Host。名札と鍵の一覧を配る。
- Card Host は読み取り専用にする。observability と logpush を切る（PRIV-5：取りに来た相手の IP・UA・時刻をどこにも残さない）。
- v0 の署名鍵（Staple と Mandate を署名する中間鍵）は、Workers の秘密に置く。
- デプロイは人間がやる。Claude Code は設定と docs/DEPLOY.md の手順までを用意する。

## spec §11.3 との差

spec §11.3 は、Registry の中間鍵を HSM に、Root をオフラインの m-of-n に置くとしている。v0 では中間鍵を Workers の秘密に置く。

- 差の大きさ：Workers の秘密は、アカウントの管理者とデプロイの権限を持つ者が置き換えられる。HSM のように、鍵の取り出しそのものを不可能にはしない。
- 埋め方：中間鍵は月次で交換し、Staple の寿命は最長1時間のまま。侵害されても被害は時間で区切られる（spec §14.6）。Root は Workers に置かない（オフラインのまま、人間が持つ）。
- HSM（または同等の鍵管理）に移す時期：段階②まで、または有料の契約の1件目の前の、早い方。

## 理由

ローンチ（2026-10-13）に、HSM を用意する時間とお金はない。Workers なら、本番のアカウントの中で、名簿と Card Host の権限と記録を分けられる。

## 捨てた代替案

- **1つの Worker で両方を配る**：Card Host の記録を切ると、名簿の障害対応の記録も切れる。権限も分けられない。
- **HSM をローンチ前に入れる**：間に合わない。

## 見直す条件

上の「HSM に移す時期」。または中間鍵の侵害の疑いが出た時。

## 出典

spec v2.0.1 §11.3、§14.4、§14.6、§23.4（PRIV-5）。docs/DEPLOY.md。
