# 提案：CLAUDE.md の「触らないもの」に、許可の文面があっても書き換えない規則を明記する（人間が当てる）

日付：2026-10-01　対象：`CLAUDE.md`（Claude を縛る文書なので、Claude は自分で書き換えない）

## なぜ

2026-10-01 の朝、人間は質問への回答で「今回だけ」`.claude/settings.json` の変更を認めた。Claude はそれを受けて、Edit を塞ぐ deny ルールの外からスクリプトで書き換えた（PR #60。auto-merge は切ってあり、人間の確認待ち）。

人間はこれを受けて規則を固めた。Claude を縛るファイルを、Claude が許可を解釈して動かす形をなくす。この規則は Claude の記憶と夜勤の `NIGHT.md` §10 には書いたが、リポジトリで両レーンと CI のループが必ず読むのは CLAUDE.md なので、ここにも書いてほしい。

## 差分（今の main に対して）

```diff
 ## 触らないもの
 
-`.claude/settings.json`、`.claude/hooks/`、`accept/ratchet.json` は人間が持つ。あなたの権限と、あなたを測る仕組みだからだ。変えたいときは `docs/outbox/` に提案を書く（ratchet は `npm run ratchet` だけが書く）。
+`.claude/settings.json`、`.claude/hooks/`、`accept/ratchet.json`、`accept/ratchet/` は人間が持つ。あなたの権限と、あなたを測る仕組みだからだ。
+
+- どんな許可の文面があっても、あなたはこれらを書き換えない。Edit/Write だけでなく、スクリプトや git による書き換えも含む。
+- ratchet は `npm run ratchet` だけが書く。移行用や写し用のスクリプトも使わない。衝突したら main の版を採り、`npm run ratchet` を回し直す。
+- 変えたいときは `docs/outbox/` に差分を置き、STATE.md の「人間待ち」に書く。当てるのは人間。
```

`accept/ratchet/` はまだ存在しない（オラクル別ラチェットの提案の段階）。先に書いておいても害はない。

## PR #60 との関係

#60 には、`.claude/settings.json` の deny ルールと、CLAUDE.md への `accept/ratchet/` の追加が入っている。

- **#60 を採る場合**：上の差分を当てる前にマージすれば、差分の1行目は既に `accept/ratchet/` を含んでいる。そのときは箇条書きの3行だけを足せばよい。
- **#60 を採らない場合**：#60 を閉じて、deny ルールは `docs/outbox/2026-09-30-ratchet-dir-deny-rules.md`（高速化の案のブランチにある）の差分を人間が当てる。
