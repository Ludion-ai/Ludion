# ADR-025：Registry v0 ── 声明は Root、Staple は Session 鍵、失効は署名付きの放送

日付：2026-09-30

## 決定

`services/registry` に Registry v0 を置く。Fetch API だけで書き（Node、workerd、Deno、Bun で同じコード）、Node の起動口は `bin/registry.mjs`。

### 1. Root は「声明」にだけ署名する

登録、Session 鍵の承認、失効は、Root で署名した JWS（EdDSA）で Registry に渡す。

| 声明 | typ |
|---|---|
| 登録 | `ludion-register+jwt` |
| 鍵の承認 | `ludion-keys+jwt` |
| 失効 | `ludion-revoke+jwt` |

- **HTTP リクエストには署名しない。** spec §10.3「Root はリクエストに使わない」をそのまま守る。
- **署名の場所。** `packages/diver/src/keys.mjs` の `signRootStatement` で行う（CRY-1 の許可リストの中、node:crypto）。
- **Registry 側の検証。** `@ludion/gate-core/staple` の `verifyJws` で行う。
- **鮮度。** 声明の `iat` は、今から±5分以内でなければ拒否する。盗み見た声明を後で再生できない。
- **承認は古いものに戻せない。** 鍵の承認は `ts`（ミリ秒）で順序づける。前回以下の `ts` は 409 で拒否する。
- **Root は Session 鍵として承認しない。** 400 で拒否する。

### 2. Staple の発行は、承認済みの Session 鍵の RFC 9421 署名で認証する

`POST /v0/divers/{id}/staple` は、サイトへのリクエストと同じ Web Bot Auth の署名で認証する。

- **署名の対象。** `@method`、`@path`、`@authority`、`content-digest` を必須にする。
- **本文の照合。** Registry は本文の SHA-256 を自分で照合する。Gate は本文を読まないが、Registry は読む。
- **authority の固定。** `--origin` を与えると、別の authority 向けの署名は拒否する（ADR-023 と同じ考え方）。
- **束縛。** Staple の `cnf.jkt` は承認済みの鍵だけで、求めた鍵を必ず含む。
- **寿命。** 最長1時間（spec §10.5）。
- **Depth。** D1 は「鍵の登録＋連絡先の確認＋Ballast v0 の約束」。連絡先の確認（メールの往復）はまだないので、既定は D0。
  - `--dev-verified-contacts` は開発用で、全員を確認済みとみなす。
  - `confirmContact()` はプロセス内の運営用。
- **Ballast。** 登録時の3つの約束（spec §14）が揃えば `active`（tier b0）。

### 3. 失効は Registry の鍵で署名した「放送」

`POST /v0/revocations`（Root の声明）で失効を受け付ける。Registry 自身の判断（濫用、約束違反）はプロセス内の `revoke()` で行う。

- **形。** 失効の1件は、Registry の鍵で署名した JWS（`ludion-revocation+jwt`）にする。
- **中身。** 通し番号 `seq`、`sub`、承認済みの `jkt` の全部、登録した Signature-Agent の origin、理由。
- **配り方。**
  - `GET /v0/revocations?since=N`
  - `GET /v0/revocations/stream`（SSE。`Last-Event-ID` と `?since=` で再開する）
- **Gate 側の検証。** Gate はピン留めした Registry の鍵で1件ずつ検証する。途中の誰かは遅らせられても、偽造はできない。
- **Staple と取り違えない。** Staple の検証器は `typ` が違うものを Staple として受け付けない。
- **Gate 側の実装。** `@ludion/gate-core/revocation`（`createRevocationList`、`subscribeRevocations`）。
  - 設定は `createGate({ revocations: { url } })`。
  - classify は手元のリストを読むだけ。鍵、Signature-Agent、Staple の `sub` のどれかが載っていれば REVOKED。
- **購読の中身。** 誰についても尋ねない1本の GET。リストの全部を受け取り、訪問者を一人も名指ししない（PRIV-3）。
- **再接続。** Registry の `retry:` から始め、指数的に待つ（上限30秒）。最後の `seq` から再開する。

### 4. 購読しない Gate には「Staple が REVOKED と言う」

失効した Diver にも、承認済みの鍵で求められれば Staple を出す。ただし中身は `revoked: true`、`depth: 0`、`ballast: suspended`。

- **正直なエージェント。** Registry の最新の答えを運ぶので、どの Gate でも REVOKED になる（spec §10.8 の `st.revoked`）。
- **盗んだ鍵の持ち主。** 失効前の Staple を期限まで使える（最長1時間）。その後は、どの手を使っても standing に届かない。
  - 古い Staple は `staple_expired`。
  - 新しい Staple は REVOKED。
  - Staple なしなら depth 0。
- **REG-3 の「購読していない Gate には Staple の寿命で REVOKED」の読み。** 「寿命のうちに standing を失い、Registry の答えを運べば REVOKED」と読み、テストはこの形で固定した。

### 5. Registry は行き先を知らない

どの API もサイト、URL、パスを受け取らない。Staple はどのサイトでも同じで、取り直しはタイマーで行う（期限の半分）。リクエストをきっかけにしない（`createStapleKeeper`）。

- **持つもの。**
  - Diver の公開の身元
  - 承認済みの公開鍵
  - 失効
  - Staple の発行数（数だけで、中身は持たない。spec §13.3）
- **Diver ごとの状態照会の API は作らない。** Gate がそれを訪問者ごとに引けば、行き先が Registry に漏れるから。

## 理由

- **Root の役目。** spec §10.3 は Root の役目を「Session 鍵の承認、Card の署名」とし、リクエストには使わないとしている。声明の JWS なら、HTTP 署名の検証器（Gate）が Root の署名に出会うことが構造上ない。
- **Staple の認証。** Session 鍵の RFC 9421 署名で認証すれば、Diver の SDK は新しい署名の仕組みを持たずに済む。サイトに送るのと同じ署名器を使える。
- **失効に署名する理由。** 「登記所も破られる前提」（不変条件10）。失効を注入できれば、任意の Diver を落とす DoS になる。
- **購読を全件の放送にする理由。** 「Registry は行き先を知らない」（不変条件8）を、Gate 側でも崩さないため。

## 捨てた代替案

- **Root で Registry への HTTP リクエストに署名する。** 「Root は署名しない」（DIV-3）と紛らわしい。検証器が Root の署名に出会う経路が生まれる。
- **失効した Diver には Staple を出さない（403）。** 購読しない Gate で REVOKED を見せる手段がなくなる。
- **Gate が必要な時に Diver ごとの状態を尋ねる（OCSP 型）。** ホットパスに入り（REG-1 違反）、行き先が漏れる（PRIV-3 違反）。
- **失効を署名しない。** 経路上の誰でも失効を注入できる。

## 見直す条件

- **連絡先の確認を入れるとき。** メールの往復を入れたら、`--dev-verified-contacts` を消す。
- **Registry の鍵の保管。** 本番の Registry の鍵は人間が HSM で作って持つ。このコードは本番の鍵を作らない。`bin/registry.mjs` は `--key` なしでは起動しない。`--dev-ephemeral-key` はメモリだけの鍵。
- **状態の持ち方。**
  - 今は JSON ファイル1つ（`--state`）か、メモリ。
  - 複数台にするなら、次が要る。
    - 保管先
    - 失効の通し番号の一意性
    - 放送の相互接続
- **失効のリストの保持。** 今は全件を持ち続ける。量が増えたら「最後の Staple の寿命＋余裕」を過ぎた項目を切る。Staple なしの depth 0 の照合は Signature-Agent と jkt で続けられる。
- **Mandate（PRS-2）の発行を足すとき。** 同じ声明と放送の形に乗せる。
