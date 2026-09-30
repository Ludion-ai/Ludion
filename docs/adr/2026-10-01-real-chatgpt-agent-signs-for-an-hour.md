# 本物の ChatGPT agent の署名は寿命が 1 時間で、今の Gate はそれを SPOOFED にする（GATE-8）

日付：2026-10-01

## 見つけたこと

- **本物の署名付きリクエストがあった。**
  - ChatGPT agent（OpenAI）が 2025-08-04 に simonwillison.net の `/test-url-context` へ送ったもの。
  - サイトの運営者が、自分のサイトのログをその日のうちに記事で公開した（https://simonwillison.net/2025/Aug/4/chatgpt-agents-user-agent/）。
  - Wayback Machine に同じ日（要求の約 3 時間後）の保存版がある。そのヘッダーのブロックは、今日の記事とバイト単位で同じ。
- **当時の鍵が残っていた。**
  - chatgpt.com の鍵ディレクトリの Wayback の保存（2025-10-07 と 2025-11-23）に、署名の keyid の鍵がある。
  - keyid は、その鍵の JWK の拇印（RFC 7638）と一致する。`nbf` は 2025-01-01 で、要求より前。
  - 今日のディレクトリにはない（回転した）。
- **署名は本物。**
  - 記事のヘッダーから署名の土台を組み、その鍵で検証すると通る。
  - パス、authority、メソッド、Signature-Agent、署名、created のどれか 1 か所を変えると落ちる。
- **2 件目もあった。**
  - ChatGPT agent が 2025-08-11 に `api.seatgeek.com` へ送った `GET /2/events`。
  - SeatGeek の技術者が、自分たちの検証器を作るときに使った「本物の ChatGPT Agent の要求のデータ」として公開した（https://chairnerd.seatgeek.com/chasing-signature/ 、2025-08-26）。
  - 公開されたのは署名の 3 つのフィールドと URL だけ。同じ鍵で検証が通る。
- **寿命は、公開された捕獲の 3 件とも 3600 秒。**
  - 2025-08-01（Castle のブログ。nonce が伏せてあり、検証はできない）
  - 2025-08-04（simonwillison.net）
  - 2025-08-11（SeatGeek）
- **Gate の判定は SPOOFED だった**（`invalid_signature`、`PolicyViolation`）。
  - 理由は 1 つだけ。`expires - created` が 3600 秒で、spec §10.4 の「60 秒以内」を超える。
  - 鍵の発見は通っている。旧来の文字列形式の Signature-Agent（`"https://chatgpt.com"`）から chatgpt.com のディレクトリを引けた（spec §10.4 の注のとおり）。
- **影響**（ChatGPT agent が今も 2025-08 と同じ寿命で署名しているなら）：
  - この Gate を入れたサイトは、ChatGPT agent の署名付きリクエストを、すべて SPOOFED と数える。日次レポートでは「なりすまし」になる。
  - Pressure 2 の経路では、401 `invalid_signature` で拒否する。
  - spec §10.8 の「Web Bot Auth で正しく署名したエージェントは VERIFIED(depth=0)。既存の署名者は、初日から供給として取り込まれる」と逆になる。
- **WG のドラフト**（draft-ietf-webbotauth-httpsig-protocol-00）の立場：
  - §5.2：「expiry は 24 時間以内を推奨」。
  - 付録 C.6：検証者は、自分のリスクモデルが許すより長い鮮度の窓を受け入れないように。
  - つまり 60 秒は、WG の要件ではなく Ludion の方針。

## 決定（今夜）

- GATE-8 を配線した。
  - フィクスチャ：`accept/gate8/real/chatgpt-agent-2025-08-04.json`、`accept/gate8/real/chatgpt-agent-2025-08-11.json`
    - 2 件目は着いた時刻が公開されていないので、署名の `created` を時計にした。
  - テスト：`accept/gate8/gate8.test.mjs`
- **出所**：記事の URL、同じ日の Wayback の保存版とその CDX のダイジェスト、取得時刻、取り方を書いた。
  - ディレクトリは、Wayback の保存のバイトそのもの。CDX のダイジェスト（SHA-1、base32）と一致することを、テストがオフラインで確かめる。
- **本物であること**：Gate とは別の道で確かめる。
  - 署名の土台はテストの中で組む。Gate が使う http-message-sig は使わない。
  - 検証は監査済みの `web-bot-auth/crypto`。
  - 1 か所の改ざんで落ちること、今日のディレクトリでは検証できないこと（「当時の鍵」であること）も確かめる。
- **Gate**：要求が着いた時刻（ログの X-Request-Start）の時計で動かす。
  - fetch は当時のディレクトリを返す。authorities はそのサイト、経路は Pressure 2。
  - 求めるもの：VERIFIED、正しい識別子（`https://chatgpt.com/.well-known/http-message-signatures-directory`）、keyid、allow。
- **対（GATE-7 の側）**：次のどれも VERIFIED にならず、拒否されること。
  - パスの変更、署名の反転、メソッドの変更
  - 別サイトの Host、別サイトへのリプレイ
  - 期限と許容のずれ（30 秒）の後
  - 今日のディレクトリ（鍵の回転の後）
  - 同じ Gate への 2 度目
- **GATE-8 は PENDING から FAIL になる。** PASS にするには、ラチェット済みの 2 つのオラクルを緩める必要がある。今夜は緩めない（CLAUDE.md「検証器の規律」）。
  - STD-2「lifetime over 60s → SPOOFED」（`packages/gate-core/test/std2.test.mjs`）
  - GATE-7 の攻撃 `clock-skew--long-lived`（「created の 1 時間後に expires」）と、GATE-10 の vectors.json にあるその写し
- **確かめたこと**（コミットしていない実験）：Gate の上限を 3600 秒にした。
  - GATE-8 は 6 つのテストがすべて通った。本物の 2 件は VERIFIED になり、対の拒否もすべて保たれた。
  - 落ちたのは上の 2 つだけ。`clock-skew--pre-dated-long-lived` は拒否されたまま。

## 人間に頼む判断：Gate が受け入れる寿命の上限

推奨は A。

- **A（推奨）**：Gate が受け入れる寿命を 3600 秒まで広げる。
  - 60 秒を超える署名には nonce を必須にする。リプレイは nonce キャッシュで捕まえる（今の規則のまま）。
  - Diver が付ける寿命は 60 秒のまま。spec §10.4 を「署名する側」と「検証する側」に分けて書く。
  - 3600 秒の根拠は 3 つ：観測した実運用の署名者の値、spec §10.5 の Staple の最長寿命と同じ、WG の推奨（24 時間）より狭い。
  - オラクルの書き換え（攻撃は消さずに向け直す）：
    - STD-2：「3600 秒超は SPOOFED」「60 秒超で nonce なしは SPOOFED」「3600 秒で nonce ありは VERIFIED」。
    - GATE-7 の `clock-skew--long-lived`：「created の 1 日後に expires」と「1 時間の寿命で nonce なし」。
    - GATE-10 は書き出し直す。
  - 残るリスク：nonce キャッシュはプロセスごと。インスタンスが複数あると、同じ署名を 1 時間のうちに別のインスタンスへ送り直せる（今は 90 秒）。ただし、署名が覆う成分（ChatGPT agent なら `@authority`、`@method`、`@path`）の外へは届かない。
- **B**：WG の推奨どおり、24 時間まで受け入れる。受け入れる署名者は最も広いが、リプレイの窓も最も広い。
- **C**：60 秒のまま。
  - ChatGPT agent は SPOOFED のまま。
  - GATE-8 は、60 秒以内で署名する別の実運用の署名者を待つ。
  - spec §10.8 の約束は守れない。

## 捨てた代替案

- **署名者ごとの例外**（chatgpt.com だけ長くする）：規則が相手の名前に依存する。中立（不変条件 3）に反する。
- **GATE-8 の中だけ Gate の設定を変えて通す**：既定の Gate が ChatGPT agent を拒否するという事実を隠す。オラクルを欺くことになる。
- **寿命超えを SPOOFED ではなく UNVERIFIED にする**：
  - Pressure 2 では同じく拒否されるので、GATE-8 は通らない。
  - これも STD-2 の期待値を変える（人間の判断）。
  - 「暗号として正しい署名を偽造と呼ばない」点は、A と一緒に考える価値がある。
- **別の本物を使う**：SANS ISC の 2025-09-08 の日記にある SitesOverPagesBot の要求。
  - Host が伏せてあるので、署名を検証できない。
  - 寿命は 300 秒で、これも 60 秒を超える。

## 見直す条件

- 今の ChatGPT agent の寿命は確かめていない。手元にあるのは 2025-08 の捕獲だけ（3 件とも 3600 秒）。
  - LIVE-2 で canary が本物を捕まえたら、そのフィクスチャを `accept/gate8/real/` に足す。
- WG のドラフトが寿命の上限を決めたら、それに合わせる。新しい版は STD-4 が知らせる。
