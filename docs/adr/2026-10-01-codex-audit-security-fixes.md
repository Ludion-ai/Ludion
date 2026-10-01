# Codex の監査のセキュリティの4件：本文の digest、Next の SSRF、Mandate の aud、ルートの重なり

- 日付：2026-10-01
- 状態：採用
- 出所：Codex による検証器の監査（公開 main の 3cf35f9 を読み取り専用で複製）。人間が4件を最優先と判断し、8 の規則を決めた。

## 文脈

監査は、検証器が測っていない穴を4つ挙げた。どれも今の main で再現した（PR の本文に、修正前のオラクルの失敗を載せる）。

| # | 指摘 | 今の main での再現 |
|---|---|---|
| 5 | 署名が覆う `content-digest` を、届いた本文と照合していない | `{"amount":100}` に署名し、ヘッダーはそのままに `{"amount":900}` を送ると、Node・Workers・Next のどれでも VERIFIED、Pressure 2 で 200 |
| 7 | Next.js のアダプタが、鍵の発見に安全な取得関数を使っていない | ループバックに解決する名前の Signature-Agent で、内部のサービスが接続を1回受けた |
| 6 | Mandate の `aud` を、今のリクエスト先と照合していない | authorities が shop.example と admin.example の Gate で、shop.example 宛ての Mandate が admin.example の決済を通した |
| 8 | ルートが重なると先頭一致で決まる | `/**`（P0）を `/checkout`（P2）より先に書くと、`/checkout` が P0 になる |

## 決定

### 5. 本文は Content-Digest と照合する（GATE-11）

- 署名が `content-digest` を覆うとき、アダプタは本文を読み、Gate は RFC 9530 の sha-256 と sha-512 を照合する。知っているアルゴリズムは全部一致しなければならない。
- 一致しなければ SPOOFED（`content_digest`）。Pressure 2 ではアプリより前に 401 `invalid_signature`。
- 本文を確かめられないとき（上限 1 MiB を超える、Gate より先に読まれた、知らないアルゴリズムだけ、本文が渡されない）は UNVERIFIED。VERIFIED にはしない。正規の要求が再送できるよう、nonce を記録する前に照合する。
- 本文はサイトの中でハッシュするだけ。外には出さない（spec §8 の6、§11.7 は「送らない」であり、読むことは禁じていない）。
- アダプタ：
  - Node：署名が `content-digest` を覆うときだけ、アプリより先に本文を読み（paused モードで `read()`）、最後の `read()` と同じ tick で `unshift` して戻す。`'end'` は間に挟まらないので、アプリのパーサは全バイトを読む。`readable` の購読、`for await`、`pipe`、遅れて購読するものの4通りで確かめた。上限超えや時間切れでも、読んだ分は戻す。
  - Workers と Next：`request.clone()` を読む。ハンドラは元の本文を全部受け取る。
- gate-core は `bodyNeeded(desc)` と `desc.body` を契約にした。自前のアダプタも本文を渡さなければ VERIFIED にならない（fail closed）。
- Gate を body parser より前に置くことを README に書いた。後ろに置くと本文は確かめられず、署名付きの POST は VERIFIED にならない。

### 7. Node の上のアダプタは、全部同じ安全な取得関数で鍵を取る（GATE-12）

- `createSafeFetch`（名前を一度だけ解決し、全てのアドレスが公開であることを確かめ、確かめたアドレスにだけ接続する）を gate-node から `@ludion/gate-core/safe-fetch` に移した。gate-node の `./safe-fetch` は再輸出で残す。
- gate-next はこれを使う。ランタイムの素の `fetch` には戻らない。テストの差し込み口（`resolver.lookup`、`resolver.dial`）は gate-node の `config.resolver` と同じ形で、設定ファイルからは渡せない。

### 6. Mandate の `aud` は、そのリクエストの宛先（PRS-2 を強化）

- `aud` がサイトのとき、リクエストの authority と一致しなければならない。authorities を固定した Gate は、自分のものでない authority を既に SPOOFED にしている。だから、照合はリクエストの authority とだけでよい。
- 同じ Gate が別のサイトも受け持っていても、そのサイトでは Mandate は効かない（`mandate_required`、理由 `audience`）。
- `mandate.test.mjs` の「同じ Gate の別のホスト（www）宛ての Mandate を受け入れる」という期待は、この決定で裏返した。

### 8. ルートが重なったら、一番厳しいものが勝つ（PRS-4）

- 人間の決定：「重なったら一番厳しいもの（高い Pressure と多い要件）が勝つ」。
- 実装の読み：一致する全てのルートの最高の Pressure と、要件の全部を合わせる。Depth は最大、Ballast はどれかが求めれば、scope は全部（Mandate はその全部を持つこと）。
  - 一つのルートが全ての次元で一番厳しいときは、そのルートが勝つのと同じ。どれも他を支配しないとき（例：一方が Depth 2、他方が scope checkout）は、どれか一つを選ぶより厳しくなる。並べる順番には依らない。
  - この読みでよいかは人間が確かめる（違うなら差し戻す）。
- どのルートにも当たらない綴り（`routeCandidates`）は、サイトの `pressure` のまま。サイト全体の `pressure` はルートではないので、ルートで下げられる（`/public/**` を P0 にするなど）。これは今までどおり。
- 狭い低圧のルートで、広いルートに穴を開ける書き方（`/checkout/help` を P0、`/checkout/**` を P2）は効かなくなった。GATE-7 の route-evasion のテストは、これを「穴として残る」と期待していた。人間の規則に合わせて「守られる」に裏返した。緩めたのではなく、守る側に倒した変更。
- PRS-1 も強めた：守りの下限を、実装の forPath ではなく「そのままのパスに当たる全てのルートの最大」から自前で計算する（監査の指摘 9 と同じ種類の穴）。

## 結果

- 新しいオラクル：GATE-11、GATE-12、PRS-4（監査の BODY-1、GATE-6N、PRS-1O を目録の形の ID にした）。
- 強めたオラクル：PRS-2（2つのサイトの Gate）、GATE-7（攻撃の族 `body-swap` の5件、必須の族に追加）、PRS-1（下限を自前で計算）、GATE-10（ベクタに本文、100件）。
- 期待を裏返したテスト（人間の規則による）：GATE-7 の carve-out、mandate.test の別ホスト。
- 消したオラクル、緩めた閾値はない。
- 残ること：
  - Node の本文の読み取りは IncomingMessage の `complete` に頼る（他のストリームは内部の `_readableState.ended`）。HTTP/2 の互換 API と Fastify では、まだ確かめていない。
  - 本文の上限（1 MiB）は gate-node の `maxBodyBytes` で変えられる。Workers と Next は固定。設定ファイルの項目はまだない。
  - chunked で本文が0バイトのとき、Node では `'end'` が先に出る。遅れて購読するパーサが待ち続けるかもしれない（まれ）。
