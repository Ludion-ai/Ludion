# ブラウザ版 scan は CLI と同じコアを Web Worker で動かし、ヘッドレス Chromium で CLI と突き合わせる

日付：2026-10-01（夜勤）

## 決定

1. **コアを分けた。** `@ludion/scan` の解析と集計を `packages/scan/src/core.mjs` に移した。
   - 中身：`batchLines`（行の分割）、`parseBatches`（形式の判定と解析）、`createScan`（レポートの組み立て）、`maskName`（ファイル名の伏せ字）。
   - `node:*` を読まない。
   - CLI 側（`lines.mjs`）に残したのは、バイトの読み方だけ。fs、zlib、StringDecoder。
   - ブラウザ側（`web.mjs`）はその双子で、File の stream、`DecompressionStream`、`TextDecoderStream` を使う。
   - 同じ行の列が同じコアに入るので、数字が食い違う場所は「バイトを文字列にするところ」だけになる。
2. **Web Worker で回す。** `/scan` と `/ja/scan` は、落とされた File を Worker に渡す。
   - Worker が CLI と同じレポートのオブジェクトを返し、ページはそれを `textContent` だけで描く。
   - レポートは、そのまま `#scan-json` に出す。形は `ludion scan --json` と同じ。
3. **サイトは `packages/` を直接束ねる。** `site/astro.config.mjs` の Vite の alias で、次の 2 つを指す。
   - `@ludion/scan/web`
   - gate-core のブラウザで動く 2 つのモジュール（`agents`、`route`）
   - `site/build.mjs` のハッシュにもこれらを入れた。scan のコードが変わればサイトを作り直す。
4. **測り方（WEB-4）。**
   - `site/test/web4.test.mjs` で、ビルドした本物のサイトを静的ホストと同じ規則で配る。
   - ヘッドレス Chromium で、次をすべて CLI の `--json` とフィールド単位で突き合わせる。
     - SCAN のフィクスチャ 10 本を 1 本ずつ
     - 全部をまとめて（逆順に落とす。並べ替えも CLI と同じか確かめるため）
     - 英語と日本語のページ
   - 200 MiB の nginx ログは、全行が数えられ、分類が書いたとおりであることを確かめる。そのうえで 30 秒以内。
   - ブラウザ：
     - playwright-core をサイトの lockfile で固定した（1.63.0）。
     - それが指すヘッドレスの Chromium は、初回に Playwright のキャッシュへ入れる（`site/test/browser.mjs`）。
   - 突然変異で落ちることを確かめた。並べ替えを外す、gzip の展開を外す、見出しの数字を別の値にする。

## 理由（NIGHT.md §2 の4つの物差し）

1. **オラクルの数字。**
   - 手元で 200 MiB を 1.8 秒（113 MB/s）。上限の 30 秒に対して十分な余裕がある。
   - フィクスチャの全件で CLI と一致した。
2. **顧客が動かす場所で動くか。** 使うのはブラウザの標準の API だけ。
   - `DecompressionStream`、`TextDecoderStream`、Module Worker。
   - 対応：Chrome 80 以降、Firefox 113 以降、Safari 16.4 以降。
   - `ReadableStream` の async iterator は Safari で新しいので使わず、reader で読む。
3. **供給網。**
   - scan に依存は足していない。gzip は WebAssembly の zlib を同梱せず、ブラウザ組み込みの `DecompressionStream` を使う。
   - playwright-core は検証にだけ使う。サイトの出力にも顧客に配るパッケージにも入らない。
4. **中立。** 出力は静的ファイルだけ。どのホストでも同じに動く。

## 捨てた代替案

- **ブラウザ用に解析を書き直す**
  - 捨てた理由：数字が食い違う場所が増える。「CLI と同じ数字」を保つには同じコードを動かすのが一番安い。
- **メインスレッドで解析する**
  - 捨てた理由：200 MB の間、ページが固まる。Worker なら進み具合を出せる。
- **WebAssembly の zlib（pako や fflate）を同梱する**
  - 捨てた理由：ブラウザ組み込みで足りる。依存を増やさない。
- **システムの Chrome や Edge で測る（`channel`）**
  - 捨てた理由：CI と手元で版が揃わない。playwright-core の版で固定したビルドを使う。
- **`@playwright/test` を使う**
  - 捨てた理由：既存のオラクルは `node:test` で回っていて、scoreboard もその TAP を読む。必要なのはブラウザの操作だけなので、playwright-core で足りる。

## 見直す条件

- DecompressionStream が、連結された gzip（複数のメンバー）の途中で止まる例が見つかったとき。今のフィクスチャでは CLI と一致している。
- WEB-6 で、ページ読み込みの後に Worker のスクリプトを取りに行くことが問題になったとき。今は同じオリジンから取る。
