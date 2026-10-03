# PUBLISH — npm への公開（最初の版は人間が OTP を入れて、2版目からは人間が release ワークフローを起動して）

Claude Code は publish しない。ここにある手順は、人間がなぞるためのもの。最初の版は §0〜§4、2版目からは §6。
公開の前提は、PUB-1〜4 が PASS していること（`npm run scoreboard` で確かめる）。

- **PUB-1**：tarball だけから、クリーンな環境に入れて動く。
- **PUB-2**：tarball に余計なものが入っていない。

## 0. 公開するもの：`ludion` の1本だけ（ADR-036）

- npm に出すのは `ludion` だけ。中身は CLI（`npx ludion`）と、サブパスの `ludion/diver`、`ludion/gate/node`、`ludion/gate/next`（と、Next.js なしで読める `ludion/gate/next/core`）、`ludion/gate/workers`。
- リポジトリの中のパッケージ（`@ludion/gate-core`、`gate-node`、`gate-next`、`gate-workers`、`diver`、`scan`、`report`）は private のまま。`npm publish` の `prepack` で、`packages/ludion/build.mjs` がそれらを `lib/` に写して束ねる（`postpack` で消す。リポジトリには残らない）。
- 束ねるパッケージの一覧は `packages/ludion/vendored.mjs` の1か所。
- 依存は第三者のもの（`web-bot-auth`、`http-message-sig`、`jsonwebkey-thumbprint`）だけ。`next` は任意の peer（`ludion/gate/next` を使う時だけ、アプリの Next.js を使う）。
- 組織 `@ludion` は要らない（無印の名前なので）。
- 検査：PUB-1（tarball だけで CLI と3つの Gate が VERIFIED まで動く）、PUB-2（tarball に余計なものがない。`ludion` 以外は private）、PUB-3（`@ludion/*` が npm に1つもなくても入る）、PUB-4（2版目からの公開の道）。

## 1. 最初に一度だけ（人間）

1. npm にログインする：`npm login`。2段階認証が有効なアカウントで行う。
   - 2025-10 から、npm では新しい TOTP（認証アプリの6桁）を設定できない。セキュリティキー（WebAuthn）なら、`npm publish` が出す URL をブラウザで開いて認証する。TOTP のままなら `--otp=<6桁>` を付ける。
2. **名前が空いているか確かめる**：`npm view ludion` が `E404` なら空いている（2026-09-30 の時点では空いていた）。

## 2. 公開する直前に（手元で、数分）

```sh
git switch main && git pull && npm ci
npm run scoreboard                       # PUB-1〜4 が PASS、ラチェットの後退なし
cd packages/ludion && npm publish --dry-run
```

- `Tarball Contents` に、`bin/`、`lib/@ludion/…`（束ねた7つ）、`README.md`、`LICENSE`、`package.json` だけが並ぶことを確かめる。
- `test/` や `bench/` が見えたら止める。PUB-2 が落ちているはず。

## 3. 初版を出す（人間）

```sh
cd packages/ludion && npm publish        # TOTP なら --otp=<6桁>。セキュリティキーなら、出てくる URL をブラウザで開く
```

- 出したものは二度と出せない（同じ版は再公開できない）。
- 2版目からは §6 の release ワークフローで出す（trusted publishing）。

## 4. 公開したあとに確かめる（人間、1分）

リポジトリの外の空のディレクトリで確かめる。

```sh
mkdir /tmp/ludion-check && cd /tmp/ludion-check
npx --yes ludion@0.0.1 scan <手元の access.log>
npm init -y && npm install ludion@0.0.1
node --input-type=module -e 'await import("ludion/gate/node"); await import("ludion/gate/workers"); await import("ludion/diver"); console.log("ok")'
```

- `npx ludion` が数字を出し、`ok` が出れば公開は完了。
- 気になる点が見つかったら、`npm deprecate` で「使わないで」の印を付ける。`npm unpublish` は72時間を過ぎると使えないので、慌てて消さない。

## 5. 公開しないもの・注意

- `LUDION_ROOT_PASSPHRASE`、`ludion.json`、鍵のファイルは、どの tarball にも入らない。PUB-2 と REG-4 が検査している。
- npm のトークンは CI に置かない。`ludion` の最初の版は、人間の手元から出す（§3）。2版目からは §6 の release ワークフローで出せる。そのワークフローも、人間が起動して承認したときだけ動き、トークンを持たない（OIDC）。
- Claude は publish しない（本物の release ワークフローも起動しない。dry run だけ）。

## 6. 2版目から：release ワークフロー（trusted publishing）

`.github/workflows/release.yml` が、GitHub Actions から npm の trusted publishing（OIDC）で出す。npm のトークンはどこにも無い。npm は出した版に provenance（どのリポジトリのどのワークフローで作られたか）を自動で付ける。PUB-4 がこの道の形を検査している。

- 起動は手動（Actions → release → Run workflow）だけ。main からだけ。
- 公開の前に、同じコミットで PUB-1〜3 を回す。落ちたら何も出さない。
- 出す順は §0 の表の順。npm にすでにある版は飛ばす。最初の失敗で残りを止める。
- 既定は dry run（何も送らない）。本番は `dry_run` のチェックを外して起動する。
- npm がまだ知らないパッケージは拒否する。npm は、存在しないパッケージに trusted publisher を設定できないため。最初の版は §3 のとおり手で出す。

### 6.1 最初に一度だけ（人間、数分）

1. **最初の版を手で出す**（§3）。
2. **GitHub に environment `npm` を作る**：リポジトリの Settings → Environments → New environment → `npm`。
   - Required reviewers に自分を入れる。ワークフローは承認まで止まる。
   - 「Prevent self-review」を有効にする（起動した人は自分で承認できない）。
   - Deployment branches は `main` だけにする。
   - environment を作る前に起動すると、GitHub は保護のない `npm` を自動で作ってしまう。先に作る。
   - 注意：この機械の `gh`（Claude が使う）は、2026-10-03 時点で人間と同じアカウント `Ludion-ai` でログインしている。承認の関所は、同じアカウントのトークンからは区別できない。関所を Claude から切り離すには、Claude に別のアカウントか、Actions の承認ができない細かいトークンを渡す。
3. **npm で、`ludion` に trusted publisher を設定する**：npmjs.com のパッケージ → Settings → Trusted Publisher → GitHub Actions。
   - Organization or user: `Ludion-ai`
   - Repository: `Ludion`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
4. **トークンでの公開を止める**：同じ Settings の Publishing access で「Require two-factor authentication and disallow tokens」を選ぶ（npm の推奨）。

### 6.2 版を出すたびに

1. `packages/ludion/package.json` の版を上げる。PR にして main に入れる。
2. Actions → release → Run workflow。`packages` は `all`（`ludion` だけ）。まず `dry_run` のまま回す。
3. 結果を見て、`dry_run` を外してもう一度起動し、environment `npm` の承認を押す。
4. §4 のとおり確かめる。npmjs.com の各版に「Provenance」が出ていれば、このワークフローから出たもの。
