# tracecheck.dev に Gate を入れる（人間がやる）

tracecheck.dev の前に、Pressure 0 の Gate を Worker として置く。tracecheck のコードと設定は変えない。足すのは、同じ Cloudflare アカウントの中の Worker 1つ（`ludion-gate-tracecheck`）、そのルート `tracecheck.dev/*`、D1 1つ（`ludion-tracecheck`）、毎朝の cron だけ。

所要時間は 15 分ほど。

## 0. 先に確かめること（ダッシュボード、3 分）

tracecheck.dev のアカウントでダッシュボードを開く。

1. **DNS**：`tracecheck.dev`（apex）のレコードが「Proxied」（オレンジの雲）になっていること。2026-10-03 に外から見たときは Proxied だった（Cloudflare の IP が返った）。
   - `www.tracecheck.dev` は DNS only で Vercel を向いており、証明書が切れている。Gate は www には立たない。今回はそのままでよい。
2. **既存のルート**：tracecheck.dev のゾーン → 「Workers Routes」に、`tracecheck.dev/*` と重なるルートが無いこと。
   - **あれば、そこで止めて Claude に知らせる。** tracecheck 自身がルートの Worker で動いている場合、同じパターンのルートは2つ持てない。
   - tracecheck が Pages、Custom Domain の Worker、外部のオリジンのどれでも、ルートの Worker が先に走る。`fetch(request)` はそのまま tracecheck に届く。
3. **数字を2つ控える**（Claude に渡す）：
   - Workers のプラン（Free か Paid か）。
   - tracecheck.dev の 1 日のリクエスト数（ゾーンの Analytics、直近 7 日）。
   - Free のとき、アカウント全体で 1 日 10 万リクエストまで。超えると、その日（UTC）の残りは Worker を通らない（手順 4 の設定で、サイトはそのまま動く）。計測はその間止まる。

## 1. ターミナル（2 分）

**新しい** PowerShell の窓を開く。前の窓は、別のアカウントのトークンが環境変数に残っていることがある。

```powershell
Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
cd <このリポジトリのチェックアウト>
npm ci
cd pilots\tracecheck
npm ci
```

- ルートの `npm ci` は `@ludion/gate-core` と `@ludion/report` のため。Worker はそれらを束ねて上げる。
- 中身は Claude が用意したチェックアウトでよい。そのときは `npm ci` も済んでいる。

## 2. ログイン（2 分）

```powershell
npx wrangler login
npx wrangler whoami
```

- ブラウザで、**tracecheck.dev を持っているアカウント**のユーザーで許可する。
- `whoami` の一覧に、そのアカウントがあることを確かめる。アカウントが複数あるときは、デプロイのときに選ぶように聞かれる。tracecheck.dev のあるアカウントを選ぶ。
- Ludion Agents のトークンは、このアカウントに届かない。届かないのが正しい。

## 3. デプロイ（3 分）

```powershell
npx wrangler deploy
```

- 初回は D1 の `ludion-tracecheck` を作る（`Creating new D1 Database "ludion-tracecheck"`）。
  - 作った ID を `wrangler.jsonc` に書き戻すことがある。その変更は残しても捨ててもよい。次のデプロイも同じ D1 を使う。
- 最後に次の 2 行が出れば成功。
  - `tracecheck.dev/* (zone name: tracecheck.dev)`
  - `schedule: 0 22 * * *`
- 表もテーブルも、最初のリクエストで Worker が作る。マイグレーションの手順は要らない。

## 4. ルートを「Fail open」にする（ダッシュボード、1 分）

tracecheck.dev のゾーン → Workers Routes → `tracecheck.dev/*` → Edit → **Request limit failure mode** を **Fail open (proceed)** にして保存する。

- Free の 1 日の上限を超えたとき、Fail closed だと訪問者に 1027 のエラーページが出る。Fail open なら、Worker を飛ばしてサイトがそのまま出る。
- Paid では効かない設定だが、そのまま Fail open にしておく。

## 5. 確かめる（3 分）

```powershell
curl.exe -sI https://tracecheck.dev/
curl.exe -s -o NUL -A "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" https://tracecheck.dev/
npx wrangler d1 execute ludion-tracecheck --remote --command "SELECT datetime(ts, 'unixepoch') AS t, class, operator, token, route FROM events ORDER BY ts DESC LIMIT 5"
```

- 1 行目：今までと同じ 200 と同じヘッダー。`Ludion-` で始まるヘッダーは付かない（付かないのが正しい）。
- 3 行目：`DECLARED | OpenAI | GPTBot | /` の行がある。2 行目の自分のリクエスト。
  - 人のアクセス（ブラウザ）は記録されない。行が増えるのは自動化だけ。
- 動きを見たいとき：`npx wrangler tail ludion-gate-tracecheck`。不具合は `[ludion pilot] …` の行で出る。

## 6. 毎朝のレポートの届け先（任意、3 分）

レポートは毎朝 7:00（日本時間）に D1 に保存される。チャンネルに届けるなら：

1. Discord のチャンネル → 設定 → 連携サービス → ウェブフック → 新しいウェブフック → URL をコピー。
   - 登録フォームの通知とは別のチャンネルがよい。
   - Slack の Incoming Webhook でもよい。Slack には本文だけが届き、HTML は付かない。
2. 秘密として入れる。

   ```powershell
   npx wrangler secret put REPORT_WEBHOOK_URL
   ```

   聞かれたら URL を貼る。

届くもの：

- 件名の 1 行。
- 内訳。名乗った運営者、自動化の兆候、署名してきたエージェント、検証できなかった署名の理由。
- 日本語の日次レポート（HTML）の添付。

保存されたレポートを読むとき：

```powershell
npx wrangler d1 execute ludion-tracecheck --remote --command "SELECT date, subject FROM reports WHERE lang = 'ja' ORDER BY date DESC LIMIT 7"
```

## 戻し方

- **すぐ外す**：ダッシュボードで `tracecheck.dev/*` のルートを消す。すぐにサイトへ直接届くようになる。
- **全部消す**：`npx wrangler delete`（Worker）と `npx wrangler d1 delete ludion-tracecheck`（データ）。

## 費用と上限（Free のとき）

| 資源 | 上限 | 超えたら |
|---|---|---|
| Workers のリクエスト | 1 日 10 万（アカウント全体） | Fail open で Worker を飛ばす。サイトは動く。計測はその日（UTC）の残りが抜ける |
| Workers の CPU | 1 リクエスト 10 ms | Gate は 1 リクエスト約 0.1 ms、isolate の最初の 1 回は約 3 ms（Node で測った値）。cron のレポートは、自動化が 1 日 1 万件で約 10 ms（同じく Node）。超えたら、レポートは手元で作る（データは D1 に残る） |
| D1 の書き込み | 1 日 10 万行 | 自動化 1 件で 2 行（行と索引）。超えた分は記録されない。サイトは動く |
| D1 の容量 | 5 GB | 1 件 200 バイトほど。90 日で消える |

いずれも、超えたときに困るのは計測だけ。サイトには届かない。Paid（月 5 ドル）にするかは人間の判断。
