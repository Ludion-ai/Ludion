# bench/results — Gate 0 measurement archive

Exported `entelic.bench.v0` JSON documents, placed here **by the operator**
(the harness never writes to this directory). Failed/aborted runs are data:
archive them too.

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
