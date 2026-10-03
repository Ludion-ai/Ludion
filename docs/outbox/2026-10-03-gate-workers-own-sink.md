# 提案：`@ludion/gate-workers` で、イベントの行き先をコードで渡せるようにする（もう1本のレーン向け）

日付：2026-10-03　出したのはレーン 2　対象：`packages/gate-workers/index.mjs`（レーン 2 は `packages/gate-*` の既存のコードを触らない約束なので、ここに置く）

## なぜ

tracecheck.dev のパイロット（`pilots/tracecheck`）では、自動化のイベントを、サイトのアカウントの中の D1 に貯めたかった。

今の `withLudion` は、イベントの行き先を設定の `report.endpoint`（HTTP の POST）でしか受け取れない。Workers のサイトが自分の D1、Analytics Engine、Queue に貯めるには、次のどちらかしかない。

- その受け口を別に立てる。
- アダプタを書き直す。

パイロットは後者を選んだ（`createGate` を直接使う）。応答に一切触らない、という別の理由もあったので、それで困ってはいない。ただ、普通の Workers のサイトには、行き先をコードで渡す道があるほうがよい。

- ファイルの設定からは渡せない。バインディングは `env` にしかない。
- `ctx.waitUntil` に任せれば、応答を待たせない。今の HTTP の sink と同じ扱い。
- spec §11.7 の「サイトの外に出るのはメタデータだけ」は変わらない。行き先がサイト自身のアカウントになるだけ。

## 差分の案

```js
// withLudion(handler, { configVar, onError, mandateLedger, sink })
//   sink: (event, env, ctx) => void | Promise<void>
//         イベント（gate-core の metadataEvent）を受け取る。Gate は待たず、ctx.waitUntil に渡す。
//         設定の report.endpoint と両方あれば両方に送る。
```

- `init(env)` の中で、`config.sink`（HTTP）と `options.sink` を合成する。どちらも、`trackedFetch` と同じく `pending` に積んで `ctx.waitUntil` に渡す。
- `options.sink` があれば、`report` がなくても `sendMetadata` は真にする（`createGate` の既定と同じ考え方）。

## 確かめ方（足すテスト）

- D1 を模した sink に、自動化のイベントだけが届く。人のリクエストでは呼ばれない。
- 例外を投げる sink、返らない sink でも、応答は変わらない（GATE-5 と同じ形）。
- イベントに IP、クエリの値、本文が入らない（PRIV-1 の検査をそのまま当てる）。
