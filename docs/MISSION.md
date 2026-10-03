# MISSION — 何が真になれば進んだと言えるか

実装方法は書かない。合否だけを書く。合否は `accept/registry.mjs` で実行できる形にし、`npm run scoreboard` が全部を回す。
この文書のオラクルを緩めるのは人間だけ。追加と強化は Claude Code がやってよい。

## 0. 北極星と、あなたの仕事

北極星は **Verified Actions / day**。Gate が検証した、署名付きのエージェント行為の数。サイト側とエージェント側の両方が増えないと増えない。

あなたの仕事は二つ。この数字を 0 → 1 → 10倍ずつ伸ばす製品を作ること。そして、それが本当に正しいと機械が言える検証器を作ること。製品の意図は `docs/ludion-spec.md`。ここはその実行計画だ。

## 1. 原則

1. **制約はプロンプトではなく検証器に置く。** spec §8 の不変条件は全部オラクルにする。オラクルになっていない不変条件は、まだ守られていない。
2. **バックログは書かない。** FAIL と PENDING がバックログ。別のタスク表を持つと、検証器と食い違い始める。
3. **ラチェット。** 一度 PASS したオラクルは二度と落とせない。CI はベースブランチの ratchet を読むので、PR の中で ratchet を書き換えても逃げられない。
4. **正と負を対にする。** 本物が通るオラクルには、偽物が通らないオラクルを必ず対にする。何でも VERIFIED を返す実装は正の側しか通らない。対は**同じ性質の裏表**で、registry の `property` が同じもの（LOOP-5）。速さと SSRF のように、別の性質の組は対にしない。対のない正の PASS と、対が PASS していない正の PASS を、scoreboard は「まだ信用できない」と表示する。
5. **速いループを先に作る。** 秒（L0）→ 分（L1）→ 現実（L2）。遅いループで見つかったバグは、速いループのテストに降ろしてから直す。
6. **現実のループを早く開く。** シミュレーションは現実の代わりにならない。本物の署名、本物のログ、本物のサイトからの信号を、M6 を待たずに取りに行く。
7. **人間の注意は検証器の差分に使う。** 人間が読むのは `accept/` とこの文書の差分だけ。CI がそれを PR ごとに要約する。マージは止めない。人間が後から検証器を強めれば、ラチェットがそれを強制する。

## 2. ループの層

| 層 | 回すもの | 周期 | 信号 | 赤のとき |
|---|---|---|---|---|
| L0 | 単体・テストベクタ・性質テスト | 秒、変更のたび | `npm test`、無人ループでは Stop ゲート | その場で直す |
| L1 | 受け入れオラクル：差分・攻撃・カナリア・性能・クリーン環境 | 分、PRの前とCI | `npm run scoreboard` | PR を出さない |
| L2 | 現実：canary、本物の署名者、ドラフトの追随 | 時間から日、定期CI | LIVE-\*、STD-4 | issue を立て、再現を L1 に降ろす |
| L3 | 市場：scan を見せた数、設置、圧を上げたサイト | 週、人間 | 創業者が STATE.md に書く | 次に作るものを変える |

## 3. ラダー

段は依存順ではなく意味のまとまり。並列でよい。分割・並べ替え・追加は自由。

| 段 | 何が真になるか | 出口 |
|---|---|---|
| M0 ループ | scoreboard、ratchet、CI、フックが回り、シードが緑。フルの CI が10分以内に終わる | LOOP-1、LOOP-2、SEED-1、SEED-2 |
| M1 Gate | 標準どおりに検証し、60秒で入り、人間を傷つけず、中身を外に出さない | STD、GATE、PRIV |
| M2 Diver | 3分で登録、1行で署名、どの検証器でも通る。npm から入れてそのまま動く | DIV、PUB |
| M3 Registry | ホットパスの外。落ちても世界が回る。行き先を知らない | REG |
| M4 可視化 | 恐怖を数字にする：scan と日次レポート | SCAN、RPT |
| M5 圧と信頼 | 圧と委任。中立。暗号を自作しない | PRS、NEUT、CRY |
| M6 現実 | 本物のエージェントを、本物のサイトで検証する | LIVE |
| M7 Web | 拒否が入口になり、URL を1本送れば恐怖の数字が出る。サイトは静的で、どこにでも置ける | WEB |

## 4. オラクル目録

± は正（+）、負（−）、両方を内包（±）、衛生（~）。L は層。対は正のオラクルが組む、同じ性質の負のオラクル（LOOP-5）。

### M0 ループ

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| LOOP-1 | ~ | 0 | この目録と `accept/registry.mjs` の ID が完全に一致する | |
| LOOP-2 | ~ | 1 | CI のフル実行（1回の push で起動する全ジョブ。Windows も含む。最初のジョブの開始から最後のジョブの完了まで）が10分以内。速さは、オラクルの削除・スキップ・閾値の緩和・層の格下げで稼いではならない | |
| LOOP-3 | ± | 0 | ラチェットのベース。存在する ref からは、その ratchet と ID の集合が読める。存在しない ref、壊れた ratchet（JSON でない、`passed` が ID の列でない、空、registry にない ID を含む）、ID のない registry では、scoreboard がオラクルを回す前に非ゼロで止まる。空のラチェットとして読んで通さない | |
| LOOP-4 | ± | 0 | ラチェット済みのオラクルは PASS でなければならない。FAIL、PENDING、入力の欠けによる SKIP、タイムアウト、削除はすべて退行。例外は、退役（RETIRED）、ワークフローに実在する別の CI ジョブで回るもの、`--fast` でまだ一度も回っていないものだけ。オラクルが名指す CI ジョブは、すべてワークフローが回している。scoreboard はこの判定の関数をそのまま使う | |
| LOOP-5 | ~ | 0 | 対は同じ性質の裏表。対を持つのは正のオラクルだけで、対の相手は − か ± のオラクル、両者の registry の `property` が同じ。この目録の ± と 対 の列が registry と一致する | |
| SEED-1 | ~ | 0 | シードの単体テストが全部通る。目録の STD-1、STD-2、GATE-6、REG-2、PRS-1、DIV-2、DIV-3 が全部 PASS したら退役してよい | |
| SEED-2 | ~ | 0 | シードの E2E（自分のエージェント → 自分の Gate → VERIFIED、リプレイと Staple 差し替えの拒否）が通る。GATE-2、GATE-7、GATE-8、PRIV-1、DIV-1 が全部 PASS したら退役してよい | |

### M1 標準

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| STD-1 | + | 0 | `draft-ietf-webbotauth-httpsig-protocol-00` 付録 E.2 の Ed25519 ベクタ（E.2.1 辞書形式の Signature-Agent、E.2.2 旧来の文字列形式）が、Gate と同じ検証ライブラリと鍵の発見で、暗号として検証でき、keyid が鍵の JWK サムプリントと一致する。寿命は問わない（E.2.1 の寿命は §10.4 の上限を超える。Gate の経路は STD-5）。名前で指定したテストが全部実行されて通ること | STD-2 |
| STD-2 | − | 1 | 改ざん、別の鍵、別の authority、期限切れ、未来の created、寿命1時間超（nonce がなければ60秒超）、tag 違い、辞書キーと署名ラベルの不一致を全て拒否する | |
| STD-3 | + | 1 | 独立した実装2つ以上（Cloudflare `web-bot-auth` と、JS 以外の実装1つ）と双方向に相互運用する。我々の署名が相手で通り、相手の署名が我々で通る。不一致は我々か相手のバグとして再現し、上流への報告を `docs/outbox/` に下書きする | STD-2 |
| STD-4 | ~ | 2 | ピン留めしたドラフト（httpsig-protocol、registry）の版が datatracker の最新と一致する。新版が出たら差分の要約つきで issue を立て、7日以内に追随しなければ FAIL | |
| STD-5 | + | 0 | WG のベクタの形（E.2.1 と E.2.2。同じ鍵、ラベル、署名対象、tag）を、created を今、寿命60秒で署名し直すと、実際の Gate（gate.inspect と、gate-node を通した HTTP）で、ベクタの keyid とベクタのエージェントとして VERIFIED になり、Pressure 2 の経路を通る。寿命が上限（1時間、nonce がなければ60秒）を超える同じ署名は STD-2 が拒否する | STD-2 |

### M1 Gate

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| GATE-1 | + | 1 | 人間は無傷。参照アプリ（Express、Next.js、Workers）で、署名のないブラウザ的リクエストの集合に対し、Pressure 0〜3 のどれでも Gate あり・なしの応答が `Ludion-*` ヘッダー以外バイト単位で一致する | GATE-2 |
| GATE-2 | − | 1 | 圧が効く。Pressure 2 の重要経路で未検証の自動化は拒否され、拒否の100%に `Ludion-Error` と `Link rel="help"` が付き、`signature_required` には `Accept-Signature` が付く | |
| GATE-3 | + | 1 | 60秒で入る。3つの参照アプリ全てで、アプリ側のコード変更3行以内、設定ファイル1個以内、依存の取得時間を除いて最初の分類イベントまで60秒以内 | |
| GATE-4 | + | 1 | 速い。鍵がキャッシュ済みの状態で、分類の混ざった1万リクエストに対する追加遅延が p99 で 2ms 以下（CI ランナー）。metric に p50 と p99 を出す | GATE-5 |
| GATE-5 | − | 1 | 壊れても開く。resolver・sink・Registry 鍵の欠落・壊れたヘッダー（ファズ）が例外やハングを起こしても、Pressure 0〜1 ではアプリが100%応答し、追加遅延はタイムアウト以内。Pressure 2〜3 は `fail_mode` どおりに振る舞う | |
| GATE-6 | − | 1 | SSRF。内部サービスを立てたサンドボックスで、私設・ループバック・リンクローカル・メタデータの IP、http、リダイレクト、巨大応答、slowloris、鍵爆弾、DNS リバインディングの全てで内部サービスへの到達が0件 | |
| GATE-7 | − | 1 | 攻撃コーパス `accept/attacks/` が100%拒否される。最低限：リプレイ、Staple 差し替え、cnf 不一致、署名剥がしによる格下げ、別 URL の鍵による key confusion、ラベル混同、POST での成分の省略、時計ずれの悪用。コーパスは増える一方。攻撃者役のサブエージェントに偽造を試みさせて育てるとよい。通った攻撃は直してからコーパスに残す | |
| GATE-8 | + | 1 | 本物。第三者の実運用エージェントが送った本物の Web Bot Auth 署名リクエスト（出所と取得時刻、当時の鍵ディレクトリを記録したフィクスチャ）が、正しい識別子で VERIFIED になる | GATE-7 |
| GATE-9 | + | 1 | Gate が6つのエコシステム（Node、Workers、Deno か Bun、PHP と WordPress、Python、Go）で、同じ適合スイート（STD の全ベクタ、GATE-7 の攻撃コーパス、STD-3 の相互運用表）に通る | GATE-7 |
| GATE-10 | + | 1 | 適合スイートがデータになっている（GATE-9 の土台）。WG のテストベクタ、STD-2 の全テスト（spec §10.8 の分類つき）、GATE-7 のコーパスの全件を、具体的なリクエストと期待値として `accept/conformance/vectors.json` に書き出し、コーパスと STD-2 のテストに1件ずつ一致し、書き出し直しとバイト単位で等しく、秘密鍵の成分が0件。TypeScript の Gate が、そのファイルだけを読んで全件に通る（Node。Deno と workerd は NEUT-1 が同じファイルで回す） | GATE-7 |
| GATE-11 | ± | 1 | 署名した本文が、アプリの受け取る本文である。状態を変えるリクエストの署名が覆う Content-Digest（RFC 9530）を、届いた本文と照合する。実際のアダプタ（Node の HTTP サーバー、Workers、Next.js）で、署名した本文はバイト単位でそのままアプリに届いて VERIFIED（sha-256、sha-512、長さ指定と chunked、ゆっくり届く本文）。ヘッダーはそのままに本文だけを変えたもの（別の金額、空、末尾への追加、別の本文の sha-512 を添えたもの）は VERIFIED にならず、Pressure 2 ではアプリより前に拒否される。確かめられなかった本文（上限超え、Gate より先に読まれた、知らないアルゴリズムだけ）も VERIFIED にならず、本文はそのままアプリに届く | |
| GATE-12 | ± | 1 | Next.js のアダプタの SSRF（GATE-6 を gate-next にも課す）。設定ファイルだけの proxy で、ループバック・私設・CGNAT・リンクローカル・メタデータ・IPv6 の私設に解決する名前の全てで、内部サービスへの到達が0件、非公開のアドレスへの接続の開始が0件、リクエストは帰属されず Pressure 2 で拒否される。同じ proxy が公開の鍵ディレクトリを取得して VERIFIED にでき、DNS リバインディングは効かない | |

### M1 プライバシー

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| PRIV-1 | − | 1 | カナリア。本文、クッキー、クエリの値、署名以外のヘッダーの値に固有のカナリア文字列を埋めた1万件を `send_metadata: true` で通し、Gate のプロセスから出る全バイト（sink、外向きの fetch）にカナリアが0件、生の IP が0件 | |
| PRIV-2 | − | 1 | `send_metadata: false` のとき、外向きの通信は鍵ディレクトリの取得だけ。それ以外は0バイト | |
| PRIV-3 | − | 1 | 行き先を知らない。Diver の全ライフサイクル（init、回転、Staple の更新、失効）で Registry が受け取るリクエストに、サイトの origin、URL、パスが0件 | |

### M2 Diver

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| DIV-1 | + | 1 | 3分。クリーンなコンテナで `npm pack` 済みのパッケージから init → Card の公開（ローカルの Card Host でよい）→ 署名 → Gate で VERIFIED まで180秒以内。TypeScript と Python の両方 | DIV-3 |
| DIV-2 | + | 1 | Card が正しい。`draft-meunier-webbotauth-registry-03` の CIMD 形式として Cloudflare のパーサで通り、`client_id` が自分の URL と一致し、`jwks_uri` が解決し、ディレクトリが `application/http-message-signatures-directory+json` で返る | DIV-3 |
| DIV-3 | − | 1 | Root 鍵はリクエストに署名しない。Root 鍵で署名したリクエストは VERIFIED にならず、Root 鍵はディレクトリに載らず、dev モード以外で Root の秘密鍵が平文でディスクに出ない | |
| DIV-4 | ± | 1 | 回転しても同じ。Session 鍵を回しても識別子は変わらず、旧鍵はキャッシュが切れた後に通らず、新鍵は通る | |
| PUB-1 | + | 1 | npm の公開セット（`ludion` と `@ludion/*`）を `npm pack` した tarball だけで、クリーンな環境（新しいディレクトリ、新しい npm キャッシュ、workspace なし）に入る。`ludion` の CLI（`.bin` へのリンク、scan と report はリポジトリの CLI と出力が完全に一致、init と sign）と、gate-node・gate-workers・gate-next を通した自分のエージェント → 自分の Gate → VERIFIED が、公開される名前の import だけで動く | PUB-2 |
| PUB-2 | − | 1 | 公開セットの各 tarball に、宣言した `files` と package.json・README・LICENSE 以外が0件（テスト、ベンチ、フィクスチャ、鍵、`.env`、`ludion.json` が0件）。license、repository、engines、スコープ付きの `publishConfig.access: public`、bin の shebang、export 先の同梱、内部依存がセット内の同じ版であること。検査器は先に仕込みで試す | |
| PUB-3 | + | 1 | `ludion` だけを先に出せる。`ludion` の tarball だけを、`@ludion/*` の取得が全て拒否されるレジストリの下で、クリーンな環境に入れられる（npm に `@ludion` のパッケージが一つもなくても入る）。入った CLI は `.bin` にリンクされ、scan と report はリポジトリの CLI と出力が完全に一致し、init と sign が Web Bot Auth の署名を作る。tarball は `npm publish` と同じ手順（prepack、pack、postpack）で作る | PUB-2 |

### M3 Registry

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| REG-1 | + | 1 | Registry を止めても、Staple の有効期限の間は Gate が検証を続け、サイトは影響を受けない | REG-2 |
| REG-2 | − | 0 | Staple への攻撃を拒否する：未知の kid、寿命1時間超、期限切れ、iss 違い、cnf 不一致、sub 不正 | |
| REG-3 | ± | 1 | 失効が届く。失効ストリームを購読している Gate には60秒以内、購読していない Gate には Staple の寿命（1時間以内）で REVOKED になる | |
| REG-4 | − | 1 | git の履歴、ログ、ビルド成果物に秘密鍵（JWK の `d`、PEM）が0件 | |

### M4 可視化

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| SCAN-1 | + | 1 | `accept/fixtures/logs/` のログ形式コーパス（nginx combined、Apache、Caddy JSON、Cloudflare Logpush、Vercel のログドレイン、AWS ALB、CloudFront、Fastly、IIS W3C）でパース率99%以上 | |
| SCAN-2 | ± | 1 | ラベル付きフィクスチャで、分類別・経路の種類別の件数と「重要経路に触れた未検証の自動化」の数が正解と完全に一致する | |
| SCAN-3 | − | 1 | scan の出力に生の IP、クエリの値、テンプレート化されていないパスが0件。外向きの通信が0件 | |
| SCAN-4 | + | 1 | 1GB のログを60秒以内に処理する。営業の場でその場で数字を出すため | |
| RPT-1 | ± | 1 | 記録済みのメタデータから作った日次レポートの数値が正解と一致し、日本語と英語のメール（HTML とテキスト）が生成される | |

### M5 圧と信頼

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| PRS-1 | ± | 1 | 分類 × Pressure × 経路の要件のランダムな10万ケースで、UNKNOWN は常に通り、要件を満たす VERIFIED は常に通り、拒否は Pressure 2 以上の該当経路でしか起きない | |
| PRS-2 | ± | 1 | Mandate v0。Principal の同意（パスキー、テストでは模擬でよい）から Mandate が出て、範囲内かつ上限内の決済は通り、範囲外・上限超過・期限切れ・取り消し済みは拒否される | |
| PRS-3 | ± | 1 | Mandate の上限はサイトのもの。`per_day` は、そのサイトの全ての Gate を通して1つに数える。数えるのはサイト側の共有の記録で、原子的に更新する（Registry は支出を持たない）。2つの Gate のプロセスが1つの記録を共有し、上限内の決済はどちらの Gate でも通り、合計の上限を1回超える決済はどちらでも拒否される。12件を2つのプロセスへ同時に送っても、通るのはちょうど `per_day` 件。共有の記録を持たない Gate は、数える上限のある Mandate の決済を拒否する（fail closed）。1回あたりの上限と通貨は、記録がなくても全ての Gate で効く | |
| PRS-4 | ± | 1 | ルートが重なったら、一番厳しいものが勝つ。一致する全てのルートの最高の Pressure と、要件の全部（Depth の最大、どれかが求める Ballast、全ての scope）。並べる順番に依らず、どのルートにも当たらない綴りはサイトの Pressure のまま。先頭の `/**`（Pressure 0）で `/checkout`（Pressure 2）が下がらず、狭い低圧のルートで広いルートに穴が開かず、一つのルートの要件だけを満たすエージェントは拒否される。期待値は forPath ではなく規則から計算する（乱数で2万組、3つの並べ方）。実際の Node アダプタでも拒否される | |
| NEUT-1 | + | 1 | 中立。gate-core と Card Host が、独立したランタイム2つ以上（Node と workerd、Deno、Bun など）で同じテストに通る | NEUT-2 |
| NEUT-2 | − | 1 | gate-core の依存木に、特定の CDN やクラウドベンダーの SDK が0件 | |
| CRY-1 | − | 0 | 暗号を自作しない。暗号プリミティブの呼び出しは許可リストのモジュールの中だけにある | |

### M6 現実（人間からの入力が要る）

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| LIVE-1 | + | 2 | canary（`*.workers.dev`）で Pressure 0 の Gate が動き、CI からの毎時の署名プローブが VERIFIED、週の可用性が99.9%以上 | |
| LIVE-2 | + | 2 | 我々以外の実運用エージェントが canary で1日1件以上 VERIFIED になる。最初は創業者が ChatGPT agent などに canary の URL を開かせればよい。その本物のリクエストを出所つきで保存すれば、GATE-8 のフィクスチャになる | GATE-7 |
| LIVE-3 | + | 2 | 北極星の Verified Actions / day を Cloud のイベントから算出し、scoreboard に載せる | |

### M7 Web

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| WEB-1 | + | 1 | サイトが静的にビルドされてプレビューにデプロイされ、全ページが日本語と英語で読める。Lighthouse（モバイル）の Performance、Accessibility、Best Practices、SEO がすべて95以上（各ページ3回の中央値。1回の揺れで落ちず、ほとんどの回で遅いページは落ちる） | WEB-5 |
| WEB-2 | − | 1 | 文面の検査。「保険を販売する」「支払いを保証する」「100%安全」の類が0件（spec §14 の法務の線）。サイト上の数字はすべて出所へのリンクを持つ | |
| WEB-3 | + | 1 | Gate が返しうる全エラーコードに、日本語と英語の `/e/<code>` があり、何が起きたかと、3分で検証済みになる道を示す。Gate のエラーの一覧と突き合わせて欠けが0件 | WEB-5 |
| WEB-4 | + | 1 | ブラウザ版 scan。`/scan` にアクセスログを落とすと恐怖の数字が出る。SCAN のフィクスチャで CLI と数字が完全に一致し、200MB を30秒以内に処理する（ヘッドレス Chromium） | |
| WEB-5 | − | 1 | リンク切れ0件、コンソールエラー0件、許可リスト外への外部通信0件 | |
| WEB-6 | − | 1 | scan の間、ログのバイトは1つも外に出ない。カナリアを埋めたログを読ませ、ページ読み込み後の外部リクエストが0件（Playwright で全リクエストを監視する） | |
| WEB-7 | + | 1 | ドキュメントがテストになっている。クイックスタート（Gate：Express、Next.js、Workers、FastAPI、WordPress。Diver：CLI、TypeScript、Python。scan）のコードブロックを CI がクリーンな環境で実行し、書いてあるとおりの結果（VERIFIED、最初の分類イベント）になる | |
| WEB-8 | ± | 1 | 登録フォーム。プレビューで送信すると、受け口を通って通知（スタブでよい）まで届く。ハニーポットとレート制限でボットは落ちる | |
| WEB-9 | + | 1 | デプロイと同じ成果物（`site/edge` を workerd の `wrangler dev` で動かす）で、全ページが英日の対で揃う。テンプレートごとに英日1ページずつの Lighthouse（モバイル）の4項目がすべて95以上（各ページ3回の中央値）。検査器は、仕込んだ劣化ページで先に試す。WEB-1 と違ってデプロイもトークンも要らないので、CI で毎回回る | WEB-5 |
| WEB-10 | ± | 1 | クイックスタートのページ（`/quickstart`）が書いてあるとおりに動く。ページのブロックを順に、クリーンなディレクトリで実行する（`@ludion/*` は公開セットの tarball）。出力はページのとおり。GPTBot の受領証は DECLARED、ブラウザは UNKNOWN で同じページ。`init` と `sign` の署名付きリクエストは、`init` が書いたディレクトリを持つ Gate で VERIFIED、改ざんしたものは VERIFIED にならない。WEB-7 のうち Express と CLI の部分（WEB-7 は残りのために開いたまま） | |

### M8 現場（パイロット）

本物のサイトの前に Gate を立てる。デプロイは人間がする（`pilots/`）。

| ID | ± | L | 合格条件 | 対 |
|---|---|---|---|---|
| PILOT-1 | ± | 1 | tracecheck.dev のパイロット（`pilots/tracecheck`）。デプロイするものと同じ Worker を workerd でスタブのサイトの前に立て、人にもエージェントにも、サイトの応答がバイトとヘッダーまでそのまま返る。記録されるのは自動化だけで、クエリ、アドレス、自由な文字列を含まない。毎朝のレポートが届く。D1 の故障、拒否される設定、例外は訪問者に届かない（仕込んだ故障を Node のテストで捕まえる） | |
| PILOT-2 | + | 2 | tracecheck.dev で、直近 7 日（東京の暦日）のどの日にも自動化の記録と毎朝のレポートがある。tracecheck のアカウントの読み取り用トークンで D1 を読む | |

## 5. 最初の順番（提案。根拠があれば変えてよい）

1. SEED-1 と SEED-2 が既にカバーしている部分を目録の ID に配線する（STD-2、GATE-2、GATE-7、DIV-2 など）。テストの大半はもうある。安い。
2. SCAN-1〜4。創業者は今週、営業の場で `npx ludion scan` を使う。L3 のループを今週開ける唯一の手段だ。
3. GATE-1、GATE-5、PRIV-1。信頼の土台。これが落ちていると誰も入れない。
4. STD-3。独立実装との相互運用。見つけた不一致は、標準化の場での発言権になる。
5. GATE-8 と LIVE-2。本物の署名を一度でも捕まえれば、GATE-8 は L1 で永遠に回る。
6. DIV-1 → REG → PRS → RPT-1。

## 6. 人間からの入力

入力が来るまで、該当のオラクルは SKIP か PENDING。待たずに他へ進む。安全の境界は deny ルールではなく、渡す資格情報の範囲で引く。

| 入力 | 開くもの | 注意 |
|---|---|---|
| main のブランチ保護（PR 必須、`loop` チェック必須、auto-merge を許可） | 自己マージを安全にする | private リポジトリは GitHub Free では使えない。public にするか Team にする |
| npm の `ludion` と `@ludion`、PyPI の `ludion` の確保 | publish（ask 扱い） | `npx ludion` には無印の `ludion` が要る。2026-09-30 時点で全部空き |
| `CLOUDFLARE_API_TOKEN`：Workers スクリプトの編集だけ。ゾーンと DNS の権限は付けない | LIVE-1 | canary は `*.workers.dev` に置く。本番に届かない権限そのものが安全境界 |
| 週1回、本物のエージェントで canary を開く | LIVE-2、GATE-8 のフィクスチャ | ChatGPT agent などに「この URL を開いて」と頼むだけ |
| `SIGNUP_WEBHOOK_URL` | LP の登録通知 | |
| GitHub の secret `CLOUDFLARE_PREVIEW_API_TOKEN` と `CLOUDFLARE_PREVIEW_ACCOUNT_ID`（エージェント用アカウント `Ludion Agents` の、Workers Scripts の編集だけのトークン） | CI の `preview` ジョブ（WEB-1 をプレビューに出してから回す） | 他のアカウントに届くトークンなら、デプロイが止まる（DEPLOY.md §2）。`preview` を必須のチェックにする |
| `LUDION_CANARY_READ_TOKEN`、`LUDION_CLOUD_READ_TOKEN` | LIVE-2、LIVE-3 | Claude Code が canary と Cloud を作った後に発行する |
| tracecheck.dev へのパイロットのデプロイ（`pilots/tracecheck/DEPLOY.md`）と、`TRACECHECK_D1_READ_TOKEN`、`TRACECHECK_ACCOUNT_ID`、`TRACECHECK_D1_ID`（tracecheck のアカウントの、D1 を読むだけのトークン） | PILOT-2 | Claude の鍵は tracecheck のアカウントに届かない。トークンも、そのアカウントの D1 の読み取りだけにする |
