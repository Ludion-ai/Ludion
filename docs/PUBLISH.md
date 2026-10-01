# PUBLISH — npm への公開（人間が OTP を入れて行う）

Claude Code は publish しない。ここにある手順は、人間がなぞるためのもの。
公開の前提は、PUB-1 と PUB-2 が PASS していること（`npm run scoreboard` で確かめる）。

- **PUB-1**：tarball だけから、クリーンな環境に入れて動く。
- **PUB-2**：tarball に余計なものが入っていない。

## 0. 公開するもの（`accept/publish/set.mjs` の順）

| 順 | パッケージ | 中身 |
|---|---|---|
| 1 | `@ludion/gate-core` | Gate の中核（ランタイム中立） |
| 2 | `@ludion/scan` | `ludion scan` のエンジン |
| 3 | `@ludion/report` | `ludion report` のエンジン |
| 4 | `@ludion/diver` | 鍵、Card、署名、CLI の本体 |
| 5 | `ludion` | `npx ludion` の名前（中身は `@ludion/diver` の CLI） |
| 6 | `@ludion/gate-node` | Node / Express |
| 7 | `@ludion/gate-next` | Next.js（`proxy.js`） |
| 8 | `@ludion/gate-workers` | Cloudflare Workers |

- 順番の理由：内部の依存は、依存される側を先に出す。この順に出せば、途中で `npm install` が失敗しない。
- 版はすべて `0.0.1`。上げる場合は8つとも同じ版にし、内部依存の版も合わせる。PUB-2 が食い違いを落とす。
- `@ludion/card-host` と `@ludion/registry` は今回は出さない（顧客が入れるものではない）。

## 1. 最初に一度だけ（人間）

1. npm にログインする：`npm login`。2段階認証が有効なアカウントで行う。
2. **スコープ `@ludion` の組織を作る。**
   1. https://www.npmjs.com/org/create を開く。
   2. 組織名は `ludion`。プランは無料（公開パッケージだけ）を選ぶ。
   - 組織が無いと、`@ludion/*` の publish は `E404` か `E403` で落ちる。
3. **名前が空いているか確かめる。**
   - `npm view ludion` と `npm view @ludion/gate-core` が `E404` なら空いている。
   - 2026-09-30 の時点では、どちらも空いていた（STATE.md の人間待ち）。

## 2. 公開する直前に（手元で、数分）

```sh
git switch main && git pull
npm ci
npm run scoreboard          # PUB-1 と PUB-2 が PASS、ラチェットの後退なし
```

中身の最終確認として、何も送らずに一覧だけ見る。

```sh
for p in gate-core scan report diver ludion gate-node gate-next gate-workers; do (cd packages/$p && npm publish --dry-run); done
```

- 各パッケージの `Tarball Contents` に、`src/`・`bin/`・`index.mjs` などの宣言したもの、`README.md`、`LICENSE`、`package.json` だけが並ぶことを確かめる。
- `test/` や `bench/` が見えたら止める。PUB-2 が落ちているはず。

## 3. 公開する（人間、OTP を入れる）

`<OTP>` は認証アプリの6桁。1つずつ、表の順で実行する。

```sh
cd packages/gate-core    && npm publish --otp=<OTP> && cd ../..
cd packages/scan         && npm publish --otp=<OTP> && cd ../..
cd packages/report       && npm publish --otp=<OTP> && cd ../..
cd packages/diver        && npm publish --otp=<OTP> && cd ../..
cd packages/ludion       && npm publish --otp=<OTP> && cd ../..
cd packages/gate-node    && npm publish --otp=<OTP> && cd ../..
cd packages/gate-next    && npm publish --otp=<OTP> && cd ../..
cd packages/gate-workers && npm publish --otp=<OTP> && cd ../..
```

- スコープ付きのものは、`package.json` の `publishConfig.access` が `public` なので、`--access public` は要らない。
- OTP は30秒で切れる。途中で切れたら、そのパッケージから新しい OTP でやり直す。出したものは二度と出せない（同じ版は再公開できない）。

## 4. 公開したあとに確かめる（人間、1分）

リポジトリの外の空のディレクトリで確かめる。

```sh
mkdir /tmp/ludion-check && cd /tmp/ludion-check
npx --yes ludion@0.0.1 scan <手元の access.log>
npm init -y && npm install @ludion/gate-node@0.0.1 @ludion/gate-workers@0.0.1 @ludion/gate-next@0.0.1
```

- `npx ludion` が数字を出し、各パッケージが入れば公開は完了。
- 気になる点が見つかったら、`npm deprecate` で「使わないで」の印を付ける。`npm unpublish` は72時間を過ぎると使えないので、慌てて消さない。

## 5. 公開しないもの・注意

- `LUDION_ROOT_PASSPHRASE`、`ludion.json`、鍵のファイルは、どの tarball にも入らない。PUB-2 と REG-4 が検査している。
- CI からは publish しない（トークンを CI に置かない）。公開は人間の手元からだけ行う。
