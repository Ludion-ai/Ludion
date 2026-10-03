# ADR-039：MCP の名札は、loopback の redirect_uris と private_key_jwt（Q19 の解決）

日付：2026-10-03（人間の決定 5）

## 決定

- 名札（CIMD）の `redirect_uris` は loopback だけにする：`http://127.0.0.1/callback` と `http://[::1]/callback`。ポートは RFC 8252 どおり任意。
- `token_endpoint_auth_method` は `private_key_jwt`。`jwks_uri` は鍵の一覧（`/.well-known/http-message-signatures-directory`）を指す。
- Keycloak が EdDSA の client assertion を受けなければ、OAuth 専用の jwks（ES256）を別の URL に分ける。Web Bot Auth の鍵の一覧（Ed25519）はそのまま。
- MCP-1（CIMD を有効にした Keycloak での e2e）で確かめる。

## 理由

- CLI で動くエージェントには、受け取れる公開の URL がない。loopback なら、外に何も公開せずに認可コードを受け取れる（RFC 8252 §7.3）。
- `private_key_jwt` なら、クライアントの秘密を持たずに、名札の鍵で名乗れる。名札の鍵の一つで MCP と Web の両方に通じるのが、一点の約束（spec §9）。

## 捨てた代替案

- **公開の redirect_uri を Card Host に置く**：Card Host が認可の通り道に入り、行き先を知ってしまう（不変条件8）。
- **client_secret**：盗めば使える札を増やすことになる（spec §1）。

## 見直す条件

MCP の仕様か主要な認可サーバーが、loopback の redirect_uri を CIMD で受けないと分かった時。

## 出典

spec v2.0.1 §11.2、§25（Q19）、§23.4（MCP-1）。RFC 8252。
