# Mandate v0 ── パスキーの同意で Registry が発行し、Gate が読み、金額はサイトが渡す

日付：2026-10-01

## 決定

Mandate（spec §10.6）を、Registry の発行から Gate の判定まで通す。オラクルは PRS-2。

### 1. Principal とパスキー

- `POST /v0/principals`：ブラウザが登録時に渡す公開鍵をそのまま受け取る。
  - `getPublicKey()` の SubjectPublicKeyInfo と、`getPublicKeyAlgorithm()`（ES256 は -7、EdDSA は -8）。
  - CBOR の attestationObject は読まない。v0 は attestation を求めない。
- 登録済みの credential id に別の鍵を登録し直すことはできない（409）。
- Principal ごとに仮名の鍵 `k` を Registry が作る。
  - `prn = "pw-" + base32(HMAC-SHA-256(k, aud))`（spec §10.2）。
  - 同じ Principal でも、サイトが違えば仮名が違う。

### 2. 同意は「その要求のバイト列」への署名

- 同意ページは、要求（`typ: "ludion-mandate-request"`、`sub`、`aud`、`scope`、`limits`、`exp`、`iat`、`nonce`）を JSON の文字列で作る。
- その SHA-256 を WebAuthn の challenge にする。Registry には、文字列とアサーションをそのまま送る。
- Registry が確かめること（WebAuthn L3 §7.2）：
  - clientData：`type` が `webauthn.get`、challenge が要求の文字列のハッシュ、`origin` が同意ページ（既定 `https://ludion.ai`）、cross-origin でない。
  - authenticatorData：rpIdHash が `ludion.ai`、UP と UV が立っている。signCount が進んでいる（数える認証器なら）。
  - 署名：authenticatorData ‖ SHA-256(clientDataJSON) に対して、登録した鍵で。ES256 は DER で届くので r‖s に直して検証する。
- 鮮度と一度きり：
  - 要求の `iat` は今から±5分以内。
  - challenge は一度しか使えない。一度使ったものは、`iat` がまだ通る間（10分）覚えておく。
  - 数える認証器（signCount）は、カウンタでも再送を止める。数えない認証器（同期パスキーは 0 のまま）では、一度きりの challenge だけが再送を止める。PRS-2 は両方で確かめた。
- 取り消し（`POST /v0/mandates/{jti}/revoke`）も同じ形の同意で、`typ: "ludion-mandate-revoke"`。発行した Principal のパスキーでなければ 403。

### 3. Mandate の中身と制限

- JWS（EdDSA、`typ: "ludion-mandate+jwt"`）を Registry の鍵で署名する。
- 中身：`iss`、`sub`（Diver）、`prn`、`aud`、`scope`、`limits`、`iat`、`exp`、`jti`。
- `aud`：サイトのオリジン（`https://shop.example`）か、カテゴリ（`cat:ecommerce`）。
- `scope`：v0 の語彙（`read`、`account`、`post`、`reserve`、`checkout`、`delete`）だけ。
- 寿命：既定 24 時間、最長 7 日。
- `checkout` を含む Mandate は `limits` を必ず持つ。
  - `checkout_max`：支払い1件の上限。通貨の最小単位の整数（JPY は円、USD はセント）。
  - `currency`：ISO 4217。
  - `per_day`：任意。直近 24 時間の回数。
  - 上限のない決済の委任は、不変条件9（委任の範囲外は通さない）を守れないので、発行しない。

### 4. Gate での読み方

`Ludion-Mandate` は署名の対象でなければならない。これは以前から validate で強制している。

| 状況 | 扱い |
|---|---|
| Registry の鍵で署名されていない、typ が違う、iss が違う、形が壊れている、寿命が7日を超える、未来の iat、上限のない checkout | SPOOFED（`invalid_mandate`）。持っていない委任を名乗っている |
| 別の Diver の Mandate（`sub` が Staple の `sub` と違う） | SPOOFED。Staple の差し替えと同じ |
| Staple がない | Mandate なし（`no_staple`）。誰への委任かは、リクエストの鍵に結ばれた Staple の `sub` で決まる |
| 別のサイト、宣言していないカテゴリ | Mandate なし（`audience`） |
| 期限切れ（±30秒） | Mandate なし（`expired`） |
| 取り消し済み | Mandate なし（`revoked`） |

- 「Mandate なし」は、`decide()` で `mandate_required` になる。
- `aud` のホストは、サイトの `authorities`（ADR-023）のどれかであればよい。pin していない Gate では、リクエストの authority と同じであること。
- カテゴリは `createGate({ categories: ["ecommerce"] })` でサイトが宣言する。
- Registry の鍵を持たない Gate は Mandate を読めない。これは Staple と同じく Gate の故障で、fail_mode に従う（`mandate_required` も「証明できない立場」に入れた）。

### 5. 金額はサイトが渡す：`gate.charge(result, { amount, currency })`

- Gate は本文を読まない（spec §11.7）。カートの合計を知っているのはサイトだけ。
- だから上限の判定は、サイトが金額を知った場所で呼ぶ。
  - Node：`req.ludion.charge({ amount, currency })`。
  - `ok` でなければ、返ってきた `status` と `headers`（`Ludion-Error: mandate_scope` と help の Link）で答える。
- 効くのは `decide()` が Mandate を求める場所と同じ。つまり、自動化で、Pressure 2 以上で、`require.scope` のある経路。
  - それ以外（人間は必ず）は `{ ok: true, enforced: false }`。人間の経路は変わらない。PRS-1 の性質（拒否は Pressure 2 以上の該当経路だけ）もそのまま。
- 上限を超えたら `mandate_scope`（spec §10.11「委任の範囲外」）。
  - 理由は `reason` で分かる：`over_limit`、`currency`、`per_day`、`bad_amount`、`scope`。
  - 新しいエラーコードは足していない。WEB-3 のページはそのまま使える。文面には上限の場合を書き足した。
- 回数は Gate のプロセスごとに数える（`createMandateLedger`）。
  - 24 時間以内の数は消さない。
  - 満杯なら、新しい Mandate の支払いを断る（`ledger_full`）。数えられない支払いを通さないためで、nonce キャッシュと同じ考え方。
- `charge()` は投げない。

### 6. 取り消しは2つの道で届く

- 購読している Gate：失効の放送に `scope: "mandate"`、`mdt: [jti]` の項目を載せる。PRS-2 では数十ミリ秒で届いた。
- 購読していない Gate：Staple の `mrev` に、その Diver の取り消し済みでまだ有効な Mandate を載せる（最大 32 件）。
  - 正直なエージェントは期限の半分で Staple を取り直すので、Staple の寿命（1時間）以内に、どの Gate でも取り消しが効く。ADR-025 §4 の失効と同じ読み。
- 放送の項目で Diver を落とさないようにした。
  - Gate の失効リストは、知らない `scope` の項目を無視する。以前は `keys` 以外をすべて Diver 全体の失効として扱っていた。新しい Registry が古い Gate で Diver を丸ごと落とす事故を防ぐ。
  - `seq` は進めるので、ストリームは正しく再開する。

### 7. Registry が持つもの

- Mandate は、ハッシュ、発行した Principal、Diver、期限だけを持つ（spec §13.3「mandates（ハッシュのみ）」）。サイト、scope、上限は持たない。
- PRS-2 は、Registry の状態に `shop.example`、`other.example`、`cat:ecommerce`、`checkout_max` の文字列が無いことも確かめている。
- `aud` を Registry が見るのは、Principal が同意する一度だけ。Diver の動き（Staple の取得など）では、今までどおり行き先を一切受け取らない（PRIV-3 は変わらない）。

## 理由

- **challenge を要求のハッシュにする。** Registry にチャレンジの状態を持たせずに、「このバイト列に同意した」を示せる。一度きりの記録は、鮮度の窓（10分）の間だけで済む。
- **上限はサイトが知った場所で見る。** エージェントが金額を名乗るヘッダーは、サイトの実際のカートと一致する保証がない。サイトの数字だけが真実。
- **Mandate を Staple で帰属させる。** Mandate は Diver に出るが、リクエストは Session 鍵で署名される。Session 鍵と Diver を結ぶ証明は、`cnf.jkt` を持つ Staple しかない。Mandate にも `cnf` を持たせると、鍵の回転のたびに Mandate を取り直すことになる。
- **暗号は許可リストの中に置く。** WebAuthn の署名検証、SPKI の読み込み、HMAC は、`@ludion/gate-core/staple`（CRY-1 の許可リストにすでにある）に足した。CRY-1 の許可リストは広げていない。

## 捨てた代替案

- **エージェントが金額を宣言するヘッダー（`Ludion-Amount`）。** サイトの本当の合計と照合する手段がない。ずれたときの責任も曖昧になる。
- **上限を超えたときの新しいエラーコード（`mandate_limit`）。** 開発者には分かりやすい。しかし spec §10.11 の変更、英日の新しいページ、WEB-2 の文面の検査が要る。v0 は `mandate_scope` と `reason` で足りる。
- **Registry が challenge を発行して覚える。** 往復が1回増え、状態も増える。要求のハッシュなら、同じ安全性で往復が要らない。
- **attestation の検証。** v0 では誰がどの認証器を使ったかを問わない。パスキーを持つ者が Principal である。attestationObject を読むには CBOR が要る。
- **Chromium の仮想認証器で本物の同意ページを動かす。** PRS-2 の範囲では、ソフトウェアの認証器が WebAuthn と同じバイト列（ES256 の DER を含む）を作れば足りる。同意ページを作るときに、そちらで測る。

## 見直す条件

- **同意ページ（ludion.ai）を作るとき。**
  - Chromium の仮想認証器（CDP `WebAuthn.addVirtualAuthenticator`）で、本物の `navigator.credentials` を通す。
  - 発行した Mandate をエージェントに渡す道（コールバックなど）を決める。
- **Workers と Next.js のアダプタ。** `charge()` を呼ぶ道がまだない。Node だけが `req.ludion.charge` を持つ。
- **`per_day` を複数の Gate で共有したいとき。** 今は Gate のプロセスごと。
- **カテゴリの Mandate。** サイトの自己申告で効く。同じ仮名が、そのカテゴリのサイトすべてに見える。Principal への説明は同意ページに要る。
- **本番の Principal の仮名の鍵 `k`。** 今は Registry の状態ファイルに平文で置いている。本番は KMS。
