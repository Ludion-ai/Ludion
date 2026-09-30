# DEPLOY — プレビューから ludion.ai の本番へ

最終更新：2026-10-01（夜勤）。この文書は手順だけを書く。夜勤は本番にも DNS にも触れていない。

## 0. 今の状態

- サイト：`site/`（Astro と Starlight の静的出力。docs/adr/ADR-040-site-stack.md）。
  - ページ：
    - `/e/<code>`（WEB-3）
    - `/scan`（WEB-4）
    - 英語はルート、日本語は `/ja/`
  - ビルド：`node site/build.mjs --out site/dist`。出力は `site/dist` の静的ファイルだけ。
- プレビュー：未デプロイ（WEB-1 は PENDING）。
  - 夜勤に渡された `CLOUDFLARE_API_TOKEN` は、今の `CLOUDFLARE_ACCOUNT_ID` のアカウントの資源を何も読めない（下の 1.1）。
  - 同じ理由で、デプロイもできない見込み。
- 本番：旧 Ludion の資源が同じアカウントに残っている（NIGHT.md §7）。中身は未確認（1.1）。

## 1. 旧 Ludion の棚卸し

### 1.1 夜勤で試したこと（2026-10-01 00:40 JST、読むだけ）

- `GET /user/tokens/verify`：トークンは有効。期限は 2026-10-17 23:59 UTC。
- 次はすべて `401 10000 Authentication error`：
  - `GET /accounts/{CLOUDFLARE_ACCOUNT_ID}/…` の Workers スクリプト、Workers のカスタムドメイン、Pages、KV、D1、R2
  - workers.dev のサブドメイン
- `GET /zones?name=ludion.ai` と `GET /accounts` は `403 9109 Invalid access token`。
- 読めない理由の仮説は次のどちらか。
  - トークンが別のアカウントに向いている。
  - 権限が Workers Scripts の編集だけで、アカウントが一致していない。
- 棚卸しは、下のスクリプトで朝に1回回せば埋まる。

### 1.2 朝にやること（人間、5分）

1. Cloudflare のダッシュボード → 右上のプロフィール → **API Tokens** → **Create Token** → **Create Custom Token**。
2. 権限（すべて Read）：
   - Account → Workers Scripts、Cloudflare Pages、Workers KV Storage、D1、Workers R2 Storage
   - Zone → Workers Routes、DNS
3. Account Resources は Ludion のアカウント、Zone Resources は `ludion.ai`。有効期限は今日中。
4. 手元で次を実行する。出力をそのまま 1.3 の表の元にする。GET だけで、何も変えない。

   ```sh
   CLOUDFLARE_API_TOKEN=<読み取りトークン> CLOUDFLARE_ACCOUNT_ID=<アカウントID> node scripts/cf-inventory.mjs
   ```

5. 夜勤のトークンのアカウント ID が合っているかも確かめる。
   - ダッシュボードの **Workers & Pages** → 右側の **Account ID**。
   - 夜勤の `CLOUDFLARE_ACCOUNT_ID` と違っていれば、それがデプロイできない原因。

### 1.3 削除リスト（1.2 の出力で埋める。朝、人間の一言で消す）

| 名前 | 種類 | 作成日 | 最後のデプロイ | 結びついたドメイン | 消したときの影響 | 残すべきデータ |
|---|---|---|---|---|---|---|
| （未取得） | | | | | | |

埋めるときの判断：

- **結びついたドメイン**に `ludion.ai` かそのサブドメインがあるもの：消す前に 3 の切り替えを済ませる。
  - 先に消すと、サイトが落ちる。
  - 旧 Pages に `ludion.ai` が付いたままで、そこへデプロイすれば本番への公開になる。夜勤は旧プロジェクトに一度もデプロイしていない。
- **KV と D1**：消す前に中身を書き出す。
  - `npx wrangler kv key list --namespace-id <id>`
  - `npx wrangler d1 export <name> --remote --output <name>.sql`
  - 登録者のメールアドレスなど、人の情報が入っていれば、残すか消すかは人間が決める。
- **Workers と Pages**：コードは git にあるか確かめる。無ければ、ダッシュボードからソースを落として保存する。

## 2. プレビュー（WEB-1。夜勤で行う）

- 置き場所：Workers の静的アセット（`*.workers.dev`）。
  - Pages ではない。STATE.md のとおり、トークンは Workers の編集だけの想定だから。
- 名前：旧の資源の名前と重ならないもの。1.3 が埋まるまでは、`ludion-site-preview` を仮に使う。
- デプロイは `npm run` のスクリプトの中からだけ行う（NIGHT.md §1）。
- 中身は `site/edge/`（WEB-8 で足した）：
  - `wrangler.json`：名前 `ludion-site-preview`、assets は `../dist`（`site/dist`）。
  - `worker.mjs`：静的ファイルに当たらないリクエストだけを受ける。`POST /api/signup`（登録フォームの受け口）と、それ以外は静的ファイル（404 ページ）へ。
  - 登録の通知先は Worker の秘密の変数 `SIGNUP_WEBHOOK_URL`（Slack か Discord の incoming webhook）。
    - 無ければ、フォームは「送信できませんでした」と答える（503）。登録は捨てない。受け取ったふりもしない。
    - 入れ方：`cd site/edge && npx wrangler secret put SIGNUP_WEBHOOK_URL`（人間待ち）。

## 3. 本番への切り替え（人間。クリック単位）

前提：プレビューの Worker（例：`ludion-site-preview`）が動いていて、WEB-1 と WEB-5 が PASS。

1. **本番の Worker を作る。** リポジトリで次を実行する。
   ```sh
   node site/build.mjs --out site/dist
   cd site/edge && npm ci && npx wrangler deploy --name ludion-site
   npx wrangler secret put SIGNUP_WEBHOOK_URL --name ludion-site
   ```
   - 設定は `site/edge/wrangler.json`。assets は `site/dist`。
   - `*.workers.dev` の URL で表示を確かめる。トップの登録フォームから1件送り、通知先に届くことも確かめる。
2. **旧から `ludion.ai` を外す。** 旧が Pages の場合：
   1. ダッシュボード → **Workers & Pages** → 旧のプロジェクト → **Custom domains** タブ。
   2. `ludion.ai`（と `www.ludion.ai`）の行の **…** → **Remove domain**。
   3. **DNS** → **Records** で、旧を指す `ludion.ai` の CNAME を消す。
   - 旧が Worker の場合：**Settings** → **Domains & Routes** で、そのドメインかルートを消す。
3. **新に `ludion.ai` を付ける。**
   1. **Workers & Pages** → `ludion-site` → **Settings** → **Domains & Routes** → **Add** → **Custom domain**。
   2. `ludion.ai` を入力して **Add domain**。
   - DNS のレコードと証明書は Cloudflare が作る。数分かかる。
   - 2 から 3 の間、サイトは数分落ちる。落としたくなければ、深夜に行う。
4. **確かめる。**
   - `curl -sI https://ludion.ai/e/signature_required` が `200`。
   - `curl -sI https://ludion.ai/ja/scan` が `200`。
   - `/scan` にログを落として、数字が出る。
   - `curl -s -X POST https://ludion.ai/api/signup -H 'content-type: application/json' -d '{"email":"x@example.com","message":"bot"}'` が `{"ok":true}` で、通知は来ない（ハニーポット）。
5. **旧を消す。** 1.3 の表の順に消す。データの書き出しが済んだものだけ。

## 4. Card Host の `*.agents.ludion.ai`（spec の `dvr-….agents.ludion.ai`）

ワイルドカードの2段目のサブドメインになる。お金の判断を含むので、実行は人間。

1. **DNS。** **DNS** → **Records** → **Add record** で、次のレコードを作る。
   - Type：`AAAA`
   - Name：`*.agents`
   - IPv6 address：`100::`
   - Proxy status：**Proxied**（オレンジの雲）
   - 行き先の実体は Worker が持つので、`100::` はダミーでよい。
2. **Worker のルート。** Workers のカスタムドメインはワイルドカードを受けない。だからルートで結ぶ。
   1. **Workers & Pages** → Card Host の Worker → **Settings** → **Domains & Routes** → **Add** → **Route**。
   2. Zone は `ludion.ai`、Route は `*.agents.ludion.ai/*`。
3. **証明書（要判断・お金）。**
   - Universal SSL が守るのは、`ludion.ai` と `*.ludion.ai`（1段目）だけ。`dvr-x.agents.ludion.ai` は守らない。
   - そのままでは、エージェントの鍵の取得が TLS エラーで落ちる。
   - 選択肢：
     - **Advanced Certificate Manager**（有料、月額）で `*.agents.ludion.ai` の証明書を発行する。**SSL/TLS** → **Edge Certificates** → **Order Advanced Certificate**。
     - 名前を1段目に寄せる：`dvr-x.ludion.ai`。この場合は spec の変更が要る。
     - Card Host を別のドメインに置く。
   - 決めるまで、Card Host は `*.workers.dev` か、利用者自身のドメインで動かす（DIV-2 はそれで PASS している）。
