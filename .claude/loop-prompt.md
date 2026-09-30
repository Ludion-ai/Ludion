docs/STATE.md の「次の一手」から続けろ。このセッションの目標は一つ：FAIL か PENDING のオラクルを1つ PASS にすること。
PASSしたら `npm run ratchet` で固定し、ブランチを切ってPRを出し、CIが緑なら `gh pr merge --auto --squash` でマージする。
終える前に docs/STATE.md を更新する（やったこと／scoreboardの差分／次の一手／人間が要ること）。
同じ失敗に3回挑んで解けなければ、STATE.md の BLOCKED に仮説と試したことを書いて、別のオラクルへ移れ。
