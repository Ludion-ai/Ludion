# DEPLOY — プレビューから ludion.ai の本番へ

最終更新：2026-10-01 朝（元のレーン）。この文書は手順だけを書く。Claude は本番、DNS、削除に触れない。それは人間がやる。

## 0. 今の状態（2026-10-01 08:50 JST、公開の DNS と HTTP で確かめた）

- **いまの ludion.ai は旧 Ludion。**
  - 中身は「Ludion — アプリが住む場所」。React Router のアプリで、`/assets/entry.client-…js` を読む。
  - 配っているのは Cloudflare（`Server: cloudflare`）。ネームサーバは `kehlani.ns.cloudflare.com` と `lennox.ns.cloudflare.com`。
  - `/e/signature_required` と `/scan` は 404。Gate の拒否が指すヘルプのページが、今は無い。
  - `www.ludion.ai` も同じものを返す。
- **同じ Cloudflare アカウントに、他の製品の資源がある。**
  - `synteria.xyz` のネームサーバが ludion.ai と同じ組（kehlani / lennox）。
  - 削除リストには Ludion の資源だけを入れる（1.3）。
- **新しいサイト**：`site/`（Astro と Starlight の静的出力）と、それを配る Worker `site/edge/`。
  - `/e/<code>`、`/scan`、`/gate`、英語はルート、日本語は `/ja/`。
  - 登録フォームの受け口は `POST /api/signup`。
- **プレビュー**：`ludion-site-preview.<アカウントのサブドメイン>.workers.dev`。
  - デプロイは `npm run deploy:preview`（2）。Cloudflare のトークン待ち。

## 1. 旧 Ludion の棚卸し（読むだけ）

### 1.1 トークンを作る（人間、3分）

1. Cloudflare のダッシュボードの右上 → **My Profile** → 左の **API Tokens** → **Create Token** → いちばん下の **Custom token** の **Get started**。
2. **Token name**：`ludion-preview`。
3. **Permissions**：
   - Account → **Workers Scripts** → **Edit**（プレビューのデプロイに使う）
   - Account → **Cloudflare Pages**、**Workers KV Storage**、**D1**、**Workers R2 Storage** → **Read**
   - Zone → **Workers Routes**、**DNS** → **Read**
   - DNS の **Edit** は付けない。本番の DNS は人間だけが触る。
4. **Account Resources**：Include → ludion.ai があるアカウント。**Zone Resources**：Include → Specific zone → `ludion.ai`。
5. **TTL**：今日から数日。
6. **Continue to summary** → **Create Token**。表示されたトークンを控える。
7. **アカウント ID**：ダッシュボードの左の **Workers & Pages** → 右側の **Account ID** の横のコピー。
8. 手元に1つのファイルを置く。Claude はこのファイルを読んで、棚卸しとプレビューのデプロイを行う。

   ```
   C:\Users\haya0\.config\ludion\cloudflare.env
   CLOUDFLARE_API_TOKEN=<トークン>
   CLOUDFLARE_ACCOUNT_ID=<アカウントID>
   ```

### 1.2 棚卸しを回す（Claude、GET だけ）

```sh
node scripts/cf-inventory.mjs
```

- 出力には、Workers、カスタムドメイン、ルート、Pages、KV、D1、R2、`ludion.ai` の DNS の一覧が出る。
- 最後に2つの表が出る。振り分けの規則は `scripts/cf-classify.mjs`（`--self-test` で確かめられる）。
  - **Ludion の資源**：名前に `ludion` がある、`ludion.ai` を配っている、Ludion の Worker が結びつけている KV・D1・R2。
  - **対象外**：それ以外。`synteria` を含む名前は、`ludion` を含んでいても対象外。
- 読めない節は「not readable with this token」と出る。黙って飛ばさない。

### 1.3 削除リスト（Ludion の資源だけ）

**Cloudflare**（1.2 の出力で埋める）：

| 種類 | 名前 | 作成日 | 最後の更新 | 結びついたドメイン | 消したときの影響 | 残すべきデータ |
|---|---|---|---|---|---|---|
| （棚卸し待ち） | | | | | | |

**Vercel**（2026-10-01 に読み取りで確かめた。チーム `usercode_X's projects`）：

| 種類 | 名前 | 作成日 | 最後のデプロイ | 結びついたドメイン | 消したときの影響 | 残すべきデータ |
|---|---|---|---|---|---|---|
| Project | `ludion-synthetic-mvp-preview` | 2026-08-04 | なし（0件） | `ludion-synthetic-mvp-preview.vercel.app` だけ | なし（空のプロジェクト） | なし |

- 同じチームのドメイン `lumest.net`、`tracecheck.dev`、`lattice-protocol.com`、`synteria.xyz` は Ludion のものではない。リストに入れない。
- ludion.ai は Vercel には載っていない。

**残すもの**：`ludion-site-preview`（新しいプレビュー）と、3 で作る `ludion-site`（新しい本番）。

**消す前の決まり**：

- `ludion.ai` や `www.ludion.ai` に結びついているものは、3 の切り替えが済んでから消す。先に消すと、サイトが落ちる。
- KV と D1 は、消す前に中身を書き出す。
  - `npx wrangler kv key list --namespace-id <id> > <名前>.keys.json`
  - `npx wrangler d1 export <名前> --remote --output <名前>.sql`
  - 登録者のメールアドレスなど、人の情報が入っていれば、残すか消すかは人間が決める。
- Workers と Pages は、ソースが git にあるか確かめる。無ければ、ダッシュボードの **Deployments** から最後のものを落として保存する。

## 2. プレビュー（Claude が行う）

```sh
npm run deploy:preview
```

- ビルド（`site/dist`）と `wrangler deploy` を行い、URL を `site/preview.json` に書く。
- `site/deploy.mjs` は、名前が `ludion-site-preview` でなければ止まる。ルートや環境が設定にあっても止まる。
  - 本番の名前やドメインに向けることはできない。
- 確かめ方：`npm run scoreboard` の WEB-1。
  - プレビューが今のビルドを配っていること（`/_build.json`）。
  - 全ページのバイトがビルドと一致すること。
  - 英日の全ページで、Lighthouse（モバイル）の4項目が95以上であること。
- 登録フォームの通知先（任意）：`cd site/edge && npx wrangler secret put SIGNUP_WEBHOOK_URL --name ludion-site-preview`。
  - 無いあいだ、フォームは「送信できませんでした」（503）と答える。受け取ったふりはしない。

## 3. 本番への切り替え（人間。クリック単位）

前提：WEB-1 が PASS で、プレビューの URL で表示を確かめたこと。所要時間は15分。サイトが落ちるのは、手順 4 から 5 の間の数分だけ。

### 1. 本番の Worker を作る（手元で）

```sh
git switch main && git pull && npm ci
node site/build.mjs --out site/dist
cd site/edge && npm ci
npx wrangler deploy --name ludion-site
npx wrangler secret put SIGNUP_WEBHOOK_URL --name ludion-site
```

- `wrangler` のログインがまだなら、先に `npx wrangler login`。
- 出力の `https://ludion-site.<サブドメイン>.workers.dev` を開き、トップ、`/ja`、`/scan`、`/e/signature_required` が出ることを見る。

### 2. 旧が何で ludion.ai を配っているかを見る

1. ダッシュボードの左の **Workers & Pages** を開く。
2. 1.3 の表で「結びついたドメイン」に `ludion.ai` がある行を探す。種類によって、次の 3 の手順が変わる。
   - **Worker（カスタムドメイン）**：3-A
   - **Worker（ルート `ludion.ai/*`）**：3-B
   - **Pages**：3-C

### 3. 旧から ludion.ai を外す

**3-A. Worker のカスタムドメイン**

1. **Workers & Pages** → 旧の Worker → **Settings** タブ → **Domains & Routes**。
2. `ludion.ai` の行の右の **…** → **Remove** → 確認で **Remove**。
3. `www.ludion.ai` の行があれば、同じく **Remove**。
   - カスタムドメインを外すと、Cloudflare がその DNS のレコードも消す。

**3-B. Worker のルート**

1. **Workers & Pages** → 旧の Worker → **Settings** → **Domains & Routes**。
2. `ludion.ai/*`（と `www.ludion.ai/*`）の行の **…** → **Remove**。
3. 左のドメインの一覧で **ludion.ai** → **DNS** → **Records**。
4. Name が `ludion.ai`（`@`）と `www` の行（A、AAAA、CNAME）の **Edit** → **Delete** → 確認で **Delete**。

**3-C. Pages**

1. **Workers & Pages** → 旧の Pages のプロジェクト → **Custom domains** タブ。
2. `ludion.ai` の行の **…** → **Remove domain** → 確認。`www.ludion.ai` も同じ。
3. **ludion.ai** → **DNS** → **Records** で、`*.pages.dev` を指している `ludion.ai` と `www` の CNAME を **Edit** → **Delete**。

### 4. 新に ludion.ai を付ける

1. **Workers & Pages** → **ludion-site** → **Settings** → **Domains & Routes** → **+ Add** → **Custom domain**。
2. `ludion.ai` と入れて **Add domain**。
   - 「既に DNS のレコードがある」と言われたら、3 のレコードが残っている。消してからやり直す。
3. もう一度 **+ Add** → **Custom domain** → `www.ludion.ai` → **Add domain**。
4. 両方の行の状態が **Active** になるまで待つ（数分）。証明書と DNS のレコードは Cloudflare が作る。

### 5. 確かめる

```sh
curl -sI https://ludion.ai/                        # 200
curl -sI https://ludion.ai/e/signature_required    # 200（旧では 404 だった）
curl -sI https://ludion.ai/ja/scan                 # 200
curl -s https://ludion.ai/_build.json              # {"site":"…"}：新しいサイトが配られている
```

- ブラウザで `https://ludion.ai/scan` を開き、アクセスログを落として数字が出ることを見る。
- 登録フォームから1件送り、通知先に届くことを見る。

**戻し方**（何かおかしいとき）：`ludion-site` の **Domains & Routes** から `ludion.ai` を **Remove** し、3 で外したものを元に戻す。

- カスタムドメインなら **Add** → **Custom domain**。
- ルートなら **Add** → **Route**。
- Pages なら **Custom domains** → **Set up a custom domain**。

### 6. 旧を消す（切り替えが済んで、1日様子を見てから）

1.3 の表の上から順に行う。データの書き出しが済んだものだけ消す。

- **Worker**：**Workers & Pages** → その Worker → **Settings** → いちばん下の **Delete** → 名前を入れて **Delete**。
- **Pages**：そのプロジェクト → **Settings** → いちばん下の **Delete project** → 名前を入れて **Delete**。
- **KV**：左の **Storage & Databases** → **KV** → その namespace の **…** → **Delete**。
- **D1**：**Storage & Databases** → **D1 SQL Database** → そのデータベース → **Settings** → **Delete**。
- **R2**：**R2 Object Storage** → そのバケット → **Settings** → **Delete bucket**（中身を空にしてから）。
- **Vercel の `ludion-synthetic-mvp-preview`**：Vercel のダッシュボード → そのプロジェクト → **Settings** → いちばん下の **Delete Project** → 名前を入れて **Delete**。

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
