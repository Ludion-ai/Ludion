# ADR-023：Gate はサイト自身の authority を知る。知らない Gate は Pressure 2〜3 に署名を通さない

日付：2026-09-30

## 背景

署名は `@authority` を対象に含む（spec §10.4）。しかし Gate は authority を、受け取ったリクエストから読む。読む先は Host で、信頼したプロキシの後ろなら X-Forwarded-Host になる。サイトは自分の authority を Gate に伝えていなかった。

本物の gate-node のサーバで、次を再現した。

- **POST のリプレイ**：shop-a.example 宛てに署名された `POST /checkout/1` を、`Host: shop-a.example` のまま shop-b の Gate に送った。結果は VERIFIED で、P2 の経路でアプリに届いた。B の nonce キャッシュは、その署名を一度も見ていない。
- **GET の持ち込み**：A で `/products` に送った GET は `@path` を含まない。これを B の `/checkout/9` に送ると、VERIFIED で通った。

B のアプリが Host を見ずに応答する場合に成立する。直接インターネットに出たサーバや、X-Forwarded-Host を素通しするプロキシの後ろがそうだ。これを使うと、A の運営者はエージェントの身元と Depth・Ballast を借りて、B の重要経路に入れる。受領証も「エージェントが B で行った行為」として B に残る。

## 決定

1. **`authorities` を設定に足す。** サイトの authority の一覧か、判定の関数を渡す。
   - 一覧の書き方：`"shop.example"`、`"shop.example:8443"`、`"*.shop.example"`（サブドメインだけ。apex は含まない）、`"https://shop.example"`（オリジン）
   - 関数：`(authority) => boolean`。`true` そのものだけを許可とみなす。
   - 照合は正規化してから行う。小文字にし、末尾のドットを外し、既定のポートを省く。
2. **固定した Gate は、自分のものでない authority の署名を SPOOFED にする。** 理由のコードは `foreign_authority`。
   - 鍵の発見と暗号処理の前に止める。攻撃者が指した先への fetch も起きない。
   - Pressure 2〜3 では `invalid_signature` で拒否する。その場に対して不正な署名だからで、新しいエラーコードは足さない。
3. **固定しない Gate（`authorities` が未設定）は「未固定」として扱う。**
   - Pressure 0〜1 では、今までどおり検証する。VERIFIED の結果に `authorityPinned: false` を付ける。
   - Pressure 2〜3 の経路に VERIFIED（または REVOKED）を通すことは、サイトの設定の欠落による Gate の故障とする。fail_mode に従う（ADR-020）。既定は closed で拒否する。サイトが open を選んだときだけ通す。
   - `gate.health.authorities` に `"pinned"` か `"unpinned"` を出す。
4. **署名のないリクエスト（人間を含む）には一切作用しない。** どんな Host でも、Gate なしと同じ応答になる。
5. **設定の誤りは起動時に TypeError にする。** 空の配列、パス付き、userinfo 付き、`*` だけ、文字列でないもの。黙って開いた Gate にはしない。
6. **関数が例外を投げたら、サイトの故障とする。** Pressure 0〜1 は開き、2〜3 は fail_mode に従う。

## 理由

- **署名だけでは区別できない。** 他のサイトから持ち込まれた署名と自分宛ての署名は、どちらも暗号的に正しい。区別できるのは、自分の authority を知る者だけだ。
- **ゼロ設定の既定を壊さない。** 既定の Pressure 0 は観測だけで、何も与えない。だから未固定でも、ゼロ設定の導入（GATE-3）と観測の数字はそのまま動く。
- **Pressure 2〜3 は何かを与える場所だ。** そこで未固定のまま署名を通すのは、黙って開くことになる。設定の欠落は Gate 側の問題なので、ADR-020 と同じく fail_mode の枠組みに乗せる。
- **P2 を設定するサイトは設定を書いている。** 1 行足すのは `routes` の隣でよい。

## 捨てた代替案

- **未固定でも P2 に通し、health に警告を出すだけ。** 黙って開くことになり、攻撃がそのまま通る。
- **`authorities` なしで Pressure を上げたら、起動時に TypeError にする。** 最も明快だが、既存の設定をすべて壊す。fail_mode closed でも、最初の試験で拒否として表に出るので、十分に大きな声になる。
- **最初に見た Host を覚える、人間の通信の Host から学ぶ。** 攻撃者が先に教えられる。
- **TLS 証明書の SAN から自動で求める。** Node が TLS を終端する構成でしか使えない。多くはプロキシの後ろにいる。将来、gate-node の自動設定として足す余地はある。
- **固定していない Gate の VERIFIED を UNVERIFIED に落とす。** ゼロ設定の観測がすべて消える。

## 見直す条件

- LIVE-3 の北極星（Verified Actions / day）を数えるとき。未固定の VERIFIED は、他サイトからの持ち込みで水増しできる。`authorityPinned` の分け方をそこで決める。
- 参照アプリ（GATE-3）の 60 秒導入で、`authorities` を設定ファイルに含めるかどうか。
- マルチテナントの SaaS で、関数形式が足りないと分かったとき。
