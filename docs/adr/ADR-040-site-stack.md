# ADR-040：サイトは Astro と Starlight の静的出力にする。独立した npm プロジェクトとして `site/` に置く

日付：2026-10-01（夜勤）

## 決定

1. **生成器。** `site/` を Astro 7 と Starlight 0.42 で作る。出力は静的な HTML と CSS と少しの JS だけ。サーバーは要らない。
2. **言語。** 英語をルート（`/e/<code>`）、日本語を `/ja/`（`/ja/e/<code>`）に置く。Gate の拒否は `https://ludion.ai/e/<code>` にリンクしている（spec §10.11）。その URL は言語を持たないので、国際的な既定の英語をそこに置き、`hreflang` と言語切替で日本語へ渡す。
3. **URL の形。** `build.format: "preserve"`、`trailingSlash: "never"`。`/e/signature_required` は `e/signature_required.html` になる。Cloudflare Pages、Vercel の cleanUrls、nginx の try_files は、これをリダイレクトなしで返す。Gate のリンクが1回で着く。
   - Starlight は、この形式では canonical、hreflang、og:url に `.html` を付けてしまう。ルートミドルウェア（`site/src/route-data.mjs`）で外している。
4. **置き場所。** `site/` はルートの workspace に入れない。専用の `package-lock.json` を持たせる。
   - Astro の依存は約270個ある。workspace に入れると、すべての CI ジョブの `npm ci` が遅くなる。参照アプリ（ADR-022）と同じ扱い。
   - `site/build.mjs` の動き：
     - `site/node_modules` は lockfile が変わったときだけ入れ直す。
     - ビルドは内容のハッシュごとに、OS の一時ディレクトリへ1回だけ行う。
     - 並列の scoreboard が同じ出力を奪い合わないよう、ロックを取る。
   - `site/serve.mjs` は、静的ホストと同じ解決規則で出力を配る。`/x` を `x.html` へ、見つからなければ `404.html` を 404 で返す。WEB-3 以降のオラクルはこれに対して HTTP で確かめる。
5. **外への通信。** 第三者への通信はしない。
   - 旧 LP の下書き（`site/index.html`）は Google Fonts を読んでいる。WEB-1 で移すときに外す。
   - ビルド時は `ASTRO_TELEMETRY_DISABLED=1` で Astro のテレメトリを止める。
   - 検索は Pagefind で、ビルド時に索引を作り、同じオリジンから配る。

## 理由（NIGHT.md §2 の4つの物差し）

1. **オラクルの数字。**
   - WEB-3 は、Gate の全エラーコードについて、英語と日本語のページを実 URL で確かめる。
   - Starlight は i18n の経路、未翻訳の検出、サイドバー、検索、アクセシブルな既定の UI を最初から持つ。自前で書く部分が文面だけになる。
   - Lighthouse（WEB-1）は、JS の少ない静的ページで最も高くなる。Starlight の既定のページは、ほぼ JS なしで出る。
2. **顧客が動かす場所で動くか。** 出力は静的ファイルなので、どこにでも置ける。
3. **供給網。**
   - 依存は多いが、サイトの中だけに閉じる。顧客に配る Gate と Diver の依存木には入らない。
   - lockfile で固定し、`npm ci` で入れる。
   - 暗号は使わない。
4. **中立。**
   - 特定のホスティングの機能（エッジ関数、画像最適化の API）は使わない。
   - プレビューは `*.pages.dev` に置く。ただし出力は Vercel、Netlify、nginx でも同じように動く。

## 捨てた代替案

- **Node の自前の静的生成器（依存0）**
  - 利点：依存が0。
  - 捨てた理由：
    - i18n の経路、未翻訳のフォールバック、サイドバー、検索、コードブロックのハイライトを全部自前で持つことになる。
    - WEB-7（ドキュメントをテストにする）で Markdown の処理も要る。
    - 文面より道具に時間を使う。
- **Next.js の静的書き出し**
  - 捨てた理由：
    - クライアント JS が多く、Lighthouse の Performance で不利。
    - 参照アプリで既に Next.js を回しており、ビルドが重いことを知っている（GATE-1）。
- **Hugo**
  - 利点：速く、依存がバイナリ1つ。
  - 捨てた理由：
    - Go のバイナリを CI とローカルの両方で固定して配る必要がある。
    - WEB-4 のブラウザ版 scan は `@ludion/scan` の JS をそのまま束ねたい。Vite を持つ Astro のほうが素直。
- **Eleventy**
  - 利点：軽い。
  - 捨てた理由：ドキュメント用のテーマがなく、i18n とアクセシビリティを自前で作ることになる。
- **root workspace に入れる**
  - 捨てた理由：すべての `npm ci` が遅くなる。LOOP-2（CI を10分以内）に逆らう。

## 見直す条件

- WEB-1 の Lighthouse が Starlight の既定の UI のせいで95を割るとき。LP だけを Starlight の外の Astro ページにする。
- Astro か Starlight のメジャー版が上がるとき。WEB-3 と WEB-5 が壊れていないか確かめてから上げる。
- Starlight が `preserve` の形式で canonical を正しく出すようになったとき。`route-data.mjs` を消す。
