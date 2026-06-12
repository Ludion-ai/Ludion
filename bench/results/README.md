# bench/results — measurement archive

Exported `ludion.bench.v0` JSON documents (legacy `entelic.bench.v0` exports
are accepted as an alias of the identical format), placed here **by the operator**
(the harness never writes to this directory). Failed/aborted runs are data:
archive them too. The entire dataset is public domain — see
[`DATA_LICENSE`](DATA_LICENSE) (CC0 1.0).

Two provenances (Gate 2.7):

- **operator archives** — placed by hand, named `{device-label}-{timestamp}.json`;
- **web submissions** — landed by `pnpm pull-submissions` from the collector's
  R2 bucket, named `web-{label}-{timestamp}.json` and carrying an injected
  top-level `"source": "web-submission"` field plus the collector's
  `received_at`. The operator reviews `git diff` before committing; corrupt
  documents are excluded by the pull script, but failure-only documents are
  valid and land normally.

## File naming convention

```
{device-label}-{timestamp}.json
```

- `device-label`: lowercase, hyphen-separated, stable per physical device.
  Established labels:
  - `desktop-chrome`
  - `iphone-11-pro-max` (4 GB — include ALL JSONs, failures included)
  - `pixel-8a`
- `timestamp`: `YYYYMMDDTHHMMSS` local time of export,
  e.g. `iphone-11-pro-max-20260610T193500.json`.

The device label is parsed from the filename by the supplier-table generator
(everything before the final `-{timestamp}`); the timestamp keeps multiple
exports from the same device distinct and sortable.

## Supplier quality table

```
pnpm supplier-table
```

reads every `*.json` in this directory and regenerates
`results/supplier-table.md` (rows = device × engine × model × prompt ×
cache_state; error-only cells are marked ×). Re-run after adding files and
commit both the JSONs and the regenerated table.

Older exports that predate schema additions (e.g. `kv_context_window` /
`prefill_chunk`, added 2026-06-10) are accepted; missing fields render as "–"
and validation warnings are listed at the bottom of the generated table.
