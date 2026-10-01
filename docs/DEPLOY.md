# DEPLOY — プレビューから ludion.ai の本番へ

最終更新：2026-10-01 11:10 JST（Claude Code）。この文書は手順だけを書く。Claude は本番、DNS、削除に触れない。それは人間がやる。

## 0. 今の状態（ludion.ai と棚卸しは 2026-10-01 09:10 JST、プレビューとトークンは 11:05 JST）

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
- **プレビュー：https://ludion-site-preview.ludion-agents.workers.dev**（エージェント用のアカウント `Ludion Agents`。2026-10-01 11:02 にデプロイ）。
  - WEB-1 PASS：全28ページ（英日）が手元のビルドとバイト単位で一致。Lighthouse（モバイル）の4項目は全ページ 96 以上。
  - 登録フォームの通知先（`SIGNUP_WEBHOOK_URL`）は、Worker の秘密として入っている（2）。試しの送信はしていない。
  - 前のプレビュー（本番のアカウントの `ludion-site-preview`、`https://ludion-site-preview.ludion.workers.dev`）はまだ残っている。消すのは人間（5.2 の手順 5）。
- **トークン**（5）：エージェントのトークン（`~/.config/ludion/cloudflare.env`）は `Ludion Agents` にしか効かない。本番のアカウントは、読み取りでも 403（5.3）。
  - 棚卸し（1.2）とこれまでのデプロイは、本番のアカウントに効くトークンで行った。そのトークンは今は 401 を返す（失効したと見える。5.2 の手順 5）。

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
5. **TTL**：**Start Date は今日**、End Date は数日後。
   - Start Date を未来の日にすると、その日まで「有効」なのにどの API も `401 Authentication error` になる（09:00 のトークンは Start Date が 10/3 だった）。
   - 棚卸しはもう済んだ。これから作るのは 5 のエージェント用の1本だけでよい。
6. **Continue to summary** → **Create Token**。表示されたトークンを控える。
7. **アカウント ID**：ダッシュボードの左の **Workers & Pages** → 右側の **Account ID** の横のコピー。
8. 手元に1つのファイルを置く。Claude はこのファイルを読んで、棚卸しとプレビューのデプロイを行う。

   ```
   C:\Users\haya0\.config\ludion\cloudflare.env
   CLOUDFLARE_API_TOKEN=<トークン>
   CLOUDFLARE_ACCOUNT_ID=<アカウントID>
   ```

   - 2026-10-01 11:00 から、このファイルは 5.2 のエージェント用のトークンになった。本番のアカウントは読めないので、本番の棚卸しにはもう使えない（それでよい）。もう一度棚卸しが要るときは、人間がその場で読み取りだけのトークンを作り、終わったら失効させる。

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

**残すもの**：3 で作る `ludion-site`（新しい本番）。プレビューは `Ludion Agents` のアカウントにある（5.2）。本番のアカウントの `ludion-site-preview` は前のプレビューなので消してよい（5.2 の手順 5）。

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

- **資格情報**：`~/.config/ludion/cloudflare.env`（5.2 のエージェント用のトークンと、`Ludion Agents` の Account ID）。ターミナルの環境変数より優先する（`scripts/cf-env.mjs`）。
- **最初に境界を確かめる**（GET だけ）。次のどれかなら、ビルドもせずに止まる（`site/test/deploy-guard.test.mjs` で固定）。
  - アカウントが `Ludion Agents` でない。
  - トークンが、他のアカウントの Worker を読める。401 と 403 以外の答えは「届く」とみなす。
  - トークンにゾーンが見える（プレビューは workers.dev だけで、ゾーンは要らない）。
  - `Ludion Agents` に workers.dev のサブドメインがない。
  - 境界だけを見るときは `node site/deploy.mjs --check`。何もデプロイしない。
  - 試せるのは、トークンに見えるアカウントだけ。一覧に出ないアカウントは、ID を名指ししないと試せない（5.3 で一度、手で確かめた）。
- そのあと、ビルド（`site/dist`）と `wrangler deploy` を行い、URL を `site/preview.json` に書く。
- `site/deploy.mjs` は、名前が `ludion-site-preview` でなければ止まる。ルートや環境が設定にあっても止まる。
  - 本番の名前やドメインに向けることはできない。
- **登録フォームの通知先**：`~/.config/ludion/signup.env`（`SIGNUP_WEBHOOK_URL=<URL>` の1行）があれば、デプロイと一緒に Worker の秘密として入れる（`wrangler deploy --secrets-file`）。
  - ファイルは丸ごと送るので、他のキーがあれば止まる。
  - デプロイのあと、Worker の秘密の名前を読み返して確かめる。値は表示しない。
  - 無いあいだ、フォームは「送信できませんでした」（503）と答える。受け取ったふりはしない。
  - `npx wrangler secret put` を手で使わない。wrangler は `cloudflare.env` を読まないので、別の資格情報で別のアカウントに入れてしまう。
- **CI**：ワークフローの `preview` ジョブが、PR ごとと main への push ごとに、同じ `npm run deploy:preview` を回してから WEB-1 を回す（一度に1本。別の実行のビルドと取り違えない）。
  - トークンは GitHub の secret `CLOUDFLARE_PREVIEW_API_TOKEN` と `CLOUDFLARE_PREVIEW_ACCOUNT_ID`。`Ludion Agents` の Workers Scripts の編集だけのトークンを、人間が作って登録する。他のアカウントに届くトークンなら、ここでもデプロイが止まる。
  - secret が無いあいだ（フォークからの PR も）、`preview` ジョブは赤になる。
- 確かめ方：`npm run scoreboard` の WEB-1。
  - プレビューが今のビルドを配っていること（`/_build.json`）。
  - 全ページのバイトがビルドと一致すること。
  - 英日の全ページで、Lighthouse（モバイル）の4項目が95以上であること。

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

- `wrangler` のログインがまだなら、先に `npx wrangler login`。終わったら `npx wrangler logout`（5.2 の手順 6）。
- ターミナルの環境変数に `CLOUDFLARE_API_TOKEN` があると、wrangler はログインよりそちらを使う。新しい窓で行う。
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

## 5. エージェントのトークンと本番（2026-10-01 に確かめた事実と対策）

### 5.1 事実（エージェント用のアカウントに移す前）

- **Worker は分かれている。** プレビューは `ludion-site-preview`、本番は今は `ludion`、切り替えの後は `ludion-site`。
  - `npm run deploy:preview`（`site/deploy.mjs`）は `ludion-site-preview` にしか出さない。名前、ルート、環境を見て止まる（`site/test/deploy-guard.test.mjs` で固定）。
- **ただし、アカウントは1つで、トークンの権限はアカウント全体に効く。**
  - Cloudflare の Workers Scripts の権限は、アカウント単位でしか付けられない。1つの Worker に絞れない。
  - 今日デプロイに使ったトークン（ターミナルの環境変数、期限 2026-10-17）は、新しい Worker をデプロイできた。本番の `ludion` の設定も読めた。だから、**このトークンは ludion.ai を配っている Worker の中身を置き換えられる。** 切り替えの後の `ludion-site` も同じ。
  - このトークンは、ludion.ai のルートと DNS を読むことも変えることもできない（403）。名前の付け替えはできないが、中身は変えられる。
  - `deploy.mjs` の名前の検査は、私たちのスクリプトの中の約束にすぎない。トークンを持つプロセスなら、`wrangler deploy --name ludion-site` で本番を書き換えられる。
- **この機械には wrangler のログインも残っていた**（2026-09-24、`%APPDATA%\xdg.config\.wrangler\config\default.enc`）。
  - 環境変数のトークンが無いとき、wrangler はこちらを使う。範囲はトークンより広い。
  - 2026-10-01 11:05 には消えていた（ファイルが無く、`wrangler whoami` は「not authenticated」）。
- 「前からある方」のトークンは wrangler のログインではない。人間が作った API トークン（`cfut_` で始まる）で、ターミナルの環境変数から渡っている。設定ファイル、シェルのプロファイル、レジストリには無い。
  - 試して分かった権限：Workers Scripts の編集、Workers のカスタムドメインの読み取り、Pages・KV・D1・アカウントの読み取り、ゾーン `ludion.ai` の読み取り（一覧だけ）。R2、ルート、DNS は無い。自分の権限を一覧する権限（API Tokens の読み取り）も無い。

### 5.2 対策：エージェント用のアカウントを分ける（人間、15分。2026-10-01 11:00 に 1〜4 が済んだ）

エージェントが持つ資格情報で、本番に届かないようにする。安全の境界を、スクリプトの検査ではなく、渡す資格情報の範囲で引く（MISSION.md §6）。

1. **エージェント用のアカウントを作る**（お金はかからない）。
   - ダッシュボードの左上のアカウント名 → **Add account**（または **Create account**）→ 名前は `Ludion Agents`。
   - そのアカウントの **Workers & Pages** を一度開くと、`*.workers.dev` のサブドメインを決める画面が出る。決める（例：`ludion-agents`）。
   - 済み：`Ludion Agents`、サブドメインは `ludion-agents`。開くまではサブドメインが無く、プレビューに URL が付かない（`deploy.mjs` は止まる）。
2. **そのアカウントだけに効くトークンを1本作る**（1.1 の手順で、中身だけ次のとおり）。
   - Permissions：Account → **Workers Scripts** → **Edit**。これだけ。
   - Account Resources：Include → `Ludion Agents` だけ。Zone Resources は無し。
   - TTL：Start Date は今日。
   - 済み。最初の版は Account Resources に本番のアカウントも入っていて、本番の `ludion-site` と `ludion` が読めた（5.3）。作ったあとに、トークンの **Edit** で Account Resources を確かめる。直してもトークンの値は変わらない。
3. **`C:\Users\haya0\.config\ludion\cloudflare.env` を書き換える。**
   - `CLOUDFLARE_API_TOKEN` は 2 のトークン。
   - `CLOUDFLARE_ACCOUNT_ID` は `Ludion Agents` の Account ID。
   - 済み。最初は Account ID が本番のアカウントのままだった。今は `deploy.mjs` が、アカウントの名前が `Ludion Agents` でなければ止まる。
4. **Claude に「エージェント用アカウントに移した」と伝える。**
   - Claude がプレビューを新しいアカウントに出し直す。URL は `https://ludion-site-preview.<決めたサブドメイン>.workers.dev` に変わる。
   - WEB-1 は新しい URL で回る。
   - 済み：https://ludion-site-preview.ludion-agents.workers.dev （2026-10-01 11:02、WEB-1 PASS）。
5. **古いものを消す。**
   - 今の2本のトークンを失効させる。**My Profile** → **API Tokens** → それぞれの **…** → **Delete**。
     - ターミナルの「前からある方」（期限 2026-10-17）。
     - 09:00 に置いたもの（期限 2026-11-03）。
   - 本番のアカウントの `ludion-site-preview` を消す（5.1 のとおり、もう要らない）。**Workers & Pages** → `ludion-site-preview` → **Settings** → **Delete**。
   - この機械の wrangler のログインを消す：`cd site/edge && npx wrangler logout`。
   - ターミナルの環境変数からも外す：その窓を閉じる（設定ファイルやレジストリには無い）。
   - 2026-10-01 11:05 の状態：
     - ターミナルの「前からある方」は 401 を返した（失効したと見える）。続けて叩くと 429（認証の失敗が多すぎる）になるので、それ以上は試していない。
     - 09:00 に置いたものは、もうファイルに無いので確かめられない。人間がダッシュボードで確かめる。
     - wrangler のログインは消えていた（5.1）。
     - 本番のアカウントの `ludion-site-preview` は、エージェントのトークンではもう見えない。人間がダッシュボードで消す。秘密 `SIGNUP_WEBHOOK_URL` も入っているので、残すと前のプレビューのフォームからも通知が届く。
6. **本番を触るとき**（3 の切り替えなど）は、人間がその場で `npx wrangler login` し、終わったら `npx wrangler logout` する。本番に効く資格情報を、この機械に置いたままにしない。

### 5.3 境界の確認（2026-10-01、GET だけ）

エージェントのトークン（`cloudflare.env`）で、本番のアカウントの ID を名指しして読んだ。一覧に出ないアカウントも試すため。書き込みは試していない（何も壊さないため）。

| 読んだもの | Account Resources を直す前 | 直した後 |
|---|---|---|
| トークンに見えるアカウント | 2（本番、`Ludion Agents`） | 1（`Ludion Agents`） |
| 本番のアカウントの情報 | 200 | 403 |
| 本番の Worker の一覧 | 200（`ludion-site`、`ludion` など 10） | 403 |
| `ludion-site` の settings、秘密の名前、deployments、本体 | すべて 200 | すべて 403 |
| `ludion-site` の versions、service | — | 403 |
| `ludion`（今の ludion.ai）の settings、本体 | 200 | 403 |
| 本番のカスタムドメイン、workers.dev のサブドメイン | 200 | 403 |
| ゾーン（`ludion.ai`、`synteria.xyz`） | 2 つ見える | 0 |

- 対照は「直す前」の列。同じトークン、同じパスで 200 だった。だから「直した後」の 403 は、パスの誤りではなく、トークンの範囲による。
- 読み取りすら 403 なので、書き込みも通らないと見てよい。トークンの範囲（Account Resources）が `Ludion Agents` だけになっている。
- 本体（スクリプト）のダウンロードは、取れるかどうかだけを見た。中身は表示も保存もしていない。
- 見えるアカウントについての同じ確認は、`npm run deploy:preview` がデプロイのたびに繰り返す（2）。本番の ID を名指しする確認は、ID をリポジトリに置かないので、手で行った。
