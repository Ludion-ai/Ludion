# DEPLOY — プレビューから ludion.ai の本番へ

最終更新：2026-10-01 09:10 JST（元のレーン）。この文書は手順だけを書く。Claude は本番、DNS、削除に触れない。それは人間がやる。

## 0. 今の状態（2026-10-01 09:10 JST。棚卸しは 1.2 の出力、公開の DNS と HTTP でも確かめた）

- **いまの ludion.ai は旧 Ludion。**
  - 配っているのは Worker **`ludion`** の**カスタムドメイン**（`ludion.ai` と `www.ludion.ai`、environment は production）。だから切り替えは 3 の一本道でよい。
  - 中身は「Ludion — アプリが住む場所」。React Router のアプリで、`/assets/entry.client-…js` を読む。
  - ネームサーバは `kehlani.ns.cloudflare.com` と `lennox.ns.cloudflare.com`。
  - `/e/signature_required` と `/scan` は 404。Gate の拒否が指すヘルプのページが、今は無い。
- **同じ Cloudflare アカウントに、他の製品の資源がある。**
  - `synteria.xyz` のネームサーバが ludion.ai と同じ組（kehlani / lennox）。
  - 削除リストには Ludion の資源だけを入れる（1.3）。
- **新しいサイト**：`site/`（Astro と Starlight の静的出力）と、それを配る Worker `site/edge/`。
  - `/e/<code>`、`/scan`、`/gate`、英語はルート、日本語は `/ja/`。
  - 登録フォームの受け口は `POST /api/signup`。
- **プレビュー：https://ludion-site-preview.ludion.workers.dev**（2026-10-01 09:05 にデプロイ、WEB-1 PASS）。
  - 全28ページ（英日）が手元のビルドとバイト単位で一致。Lighthouse（モバイル）の4項目は全ページ 96 以上。
  - 登録フォームの通知先（`SIGNUP_WEBHOOK_URL`）はまだ無いので、送信すると「送信できませんでした」と答える。
- **トークン**（1.1）：09:00 に置いたトークン（期限 2026-11-03）は、このアカウントのどの API も 401 だった。Account Resources にこのアカウントが入っていないと思われる。棚卸しとデプロイは、前からあるトークン（期限 2026-10-17）で行った。

## 1. 旧 Ludion の棚卸し（読むだけ）

### 1.1 トークンを作る（人間、3分）

1. Cloudflare のダッシュボードの右上 → **My Profile** → 左の **API Tokens** → **Create Token** → いちばん下の **Custom token** の **Get started**。
2. **Token name**：`ludion-preview`。
3. **Permissions**：
   - Account → **Workers Scripts** → **Edit**（プレビューのデプロイに使う）
   - Account → **Cloudflare Pages**、**Workers KV Storage**、**D1**、**Workers R2 Storage** → **Read**
   - Zone → **Workers Routes**、**DNS** → **Read**
   - DNS の **Edit** は付けない。本番の DNS は人間だけが触る。
4. **Account Resources**：Include → ludion.ai があるアカウント（`Haya0910oasis@gmail.com's Account`）。**Zone Resources**：Include → Specific zone → `ludion.ai`。
   - ここが外れていると、トークンは「有効」なのに、どの API も `401 Authentication error` になる（09:00 のトークンがそうだった）。
   - 作ったあと、**API Tokens** の一覧でそのトークンの **…** → **Edit** → Account Resources を見直せる。
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

**Cloudflare**（2026-10-01 09:03 の 1.2 の出力。アカウント `Haya0910oasis@gmail.com's Account`）：

| # | 種類 | 名前 | 作成日 | 最後の更新 | 結びついたドメイン | 消したときの影響 | 残すべきデータ・先にやること |
|---|---|---|---|---|---|---|---|
| 1 | Worker | `ludion` | 2026-09-22 | 2026-09-24 | **ludion.ai、www.ludion.ai** | 今の ludion.ai（旧アプリ）が消える。**3 の切り替えの後に消す。** Durable Object `ROOM` の保存データも一緒に消える | D1 `ludion`（#12）と R2 `ludion`（#15）を使う。GitHub の OAuth アプリ（`GITHUB_CLIENT_ID`）は GitHub 側で消す |
| 2 | Worker | `ludion-api` | 2026-08-10 | 2026-09-04 | なし | なし（どこからも配っていない）。Durable Object `LUDION_ANALYTICS_DO`、`LUDION_WATCH_DO` の保存データが消える | **秘密の失効が先**：`OPENAI_API_KEY`（OpenAI）、`RAKUTEN_ACCESS_KEY`・`RAKUTEN_APPLICATION_ID`・`RAKUTEN_AFFILIATE_ID`（楽天）を提供元で失効させる。Worker を消してもキーは生きている。署名鍵 `CTBS_DISPLAY_LEASE_PRIVATE_SEED_HEX` もここにある（取り出せないので、使っていた先の鍵を失効させる） |
| 3 | Worker | `ludion-collector` | 2026-06-12 | 2026-06-24 | なし | なし | KV `COLLECTOR_KV`（#11）と R2 `ludion-bench-submissions`（#16）を使う。**集めた提出物（人の情報かもしれない）が入っている** |
| 4 | Worker | `ludion-fallback-relay` | 2026-06-20 | 2026-06-21 | なし | なし | `PROVIDER_API_KEY` を提供元で失効させる |
| 5 | Worker | `ludion-task299-fetch-proof` | 2026-09-04 | 2026-09-04 | なし | なし | なし（平文の変数1つだけ） |
| 6 | Worker | `ludion-task300-pipeline` | 2026-09-04 | 2026-09-04 | なし | なし | なし（平文の変数1つだけ） |
| 7 | Worker | `ludion-web` | 2026-08-10 | 2026-08-18 | なし | なし | 静的ファイルだけ。ソースが git に無ければ落としておく |
| 8 | Pages | `ludion-demo` | 2026-06-11 | 2026-06-28 | `ludion-demo.pages.dev` だけ | その URL が消える | ソースが git に無ければ、最後のデプロイを落としておく |
| 9 | Pages | `ludion-bench` | 2026-06-12 | 2026-06-14 | `ludion-bench.pages.dev` だけ | その URL が消える | 同上 |
| 10 | KV | ` ludion-workspace`（名前の先頭に空白） | ? | ? | — | どの Worker も使っていない | 中身を書き出す（下の決まり） |
| 11 | KV | `COLLECTOR_KV` | ? | ? | — | `ludion-collector`（#3）が使う。#3 の後に消す | 中身を書き出す |
| 12 | D1 | `ludion` | 2026-09-22 | ? | — | `ludion`（#1）が使う。#1 の後に消す | **217 KB。書き出す**。登録者などの情報なら、残すか消すかを決める |
| 13 | D1 | `ludion-commerce-discovery` | 2026-09-03 | ? | — | `ludion-api`（#2）が使う | 147 KB。書き出す |
| 14 | D1 | `ludion-ctbs-authority` | 2026-08-28 | ? | — | `ludion-api`（#2）が使う | 25 KB。書き出す |
| 15 | R2 | `ludion` | ? | ? | — | `ludion`（#1）が `SOURCES` として使う | トークンに R2 の権限がなく、中身と大きさは未確認。ダッシュボードで見る |
| 16 | R2 | `ludion-bench-submissions` | ? | ? | — | `ludion-collector`（#3）が `SUBMISSIONS` として使う | 同上。**提出物が入っている** |

- D1 の一覧の表は「テーブル 0」と返したが、大きさは 0 ではない。一覧の数字は信用せず、書き出して中身を見る。
- `ludion.ai` の DNS とルートは、このトークンでは読めなかった。カスタムドメインは読めた（上の #1）。

**対象外**（Ludion のものではない、またはそう判断できないもの。リストに入れない）：

| 種類 | 名前 | 理由 |
|---|---|---|
| Pages | `synteria`（`synteria.xyz`） | 別の製品 |
| Worker | `chat-app-relay` | 名前もドメインも Ludion ではなく、Ludion の資源も使っていない。誰のものかは人間が判断する |

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

### 2. 旧の設定を控える（1分、戻すときに使う）

1. ダッシュボードの左の **Workers & Pages** → **`ludion`**（旧）→ **Settings** タブ → **Domains & Routes**。
2. `ludion.ai` と `www.ludion.ai` の2行が **Custom domain** として並んでいることを見る（棚卸しのとおり）。ルートの行があれば、その pattern も控える。

### 3. 旧から ludion.ai を外す（ここからサイトが数分落ちる）

1. 同じ画面（`ludion` → **Settings** → **Domains & Routes**）で、`ludion.ai` の行の右の **…** → **Remove** → 確認で **Remove**。
2. `www.ludion.ai` の行も、同じく **…** → **Remove** → **Remove**。
   - カスタムドメインを外すと、Cloudflare がその DNS のレコードも消す。
   - 外すのは1つずつ。どちらかが残っていると、4 で同じ名前を付けられない（1つの名前は1つの Worker にしか付かない）。

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

**戻し方**（何かおかしいとき、数分で戻る）：

1. **Workers & Pages** → **`ludion-site`** → **Settings** → **Domains & Routes** で、`ludion.ai` と `www.ludion.ai` を **…** → **Remove**。
2. **Workers & Pages** → **`ludion`**（旧）→ **Settings** → **Domains & Routes** → **+ Add** → **Custom domain** → `ludion.ai` → **Add domain**。`www.ludion.ai` も同じ。
3. 旧を消すのは、戻す必要がないと分かってから（6）。

### 6. 旧を消す（切り替えが済んで、1日様子を見てから）

1.3 の表の順に行う。先に秘密の失効（#2、#4、#1 の GitHub OAuth アプリ）と、データの書き出し（#10〜#16）を済ませる。済んだものだけ消す。Worker を先に消し、それが使っていた KV・D1・R2 を後に消す。

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
