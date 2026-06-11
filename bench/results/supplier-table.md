# Supplier quality table — Gate 0

Generated from 6 result file(s):
- `desktop-chrome-20260610T102824.json` (36 runs, collected 2026-06-10T10:28:24.275Z)
- `iphone-11-pro-max-20260610T111359.json` (2 runs, collected 2026-06-10T11:13:59.419Z)
- `iphone-11-pro-max-20260610T112313.json` (1 runs, collected 2026-06-10T11:23:13.816Z)
- `iphone-11-pro-max-20260610T121735.json` (3 runs, collected 2026-06-10T12:17:35.817Z)
- `pixel-8a-20260610T125416.json` (6 runs, collected 2026-06-10T12:54:16.344Z)
- `pixel-8a-line-iab-20260610T124347.json` (0 runs, collected 2026-06-10T12:43:47.102Z)

× = no successful run in the group (error rows only). – = not reported.

| device | engine | model | prompt | cache | backend | decode_tps (med) | prefill_tps (med) | ttft_ms (med) | error rate | kv (ctx/chunk) |
|---|---|---|---|---|---|---|---|---|---|---|
| desktop-chrome | transformersjs | onnx-community/Llama-3.2-1B-Instruct-ONNX | long-context | cold | webgpu | 128.8 | – | 531 | 0/3 (0%) | –/– |
| desktop-chrome | transformersjs | onnx-community/Llama-3.2-1B-Instruct-ONNX | short | cold | webgpu | 125.4 | – | 67 | 0/3 (0%) | –/– |
| desktop-chrome | transformersjs | onnx-community/Qwen2.5-1.5B-Instruct | long-context | cold | webgpu | – | – | 5304 | 0/3 (0%) | –/– |
| desktop-chrome | transformersjs | onnx-community/Qwen2.5-1.5B-Instruct | short | cold | webgpu | 33 | – | 136 | 0/3 (0%) | –/– |
| desktop-chrome | webllm | Llama-3.2-1B-Instruct-q4f16_1-MLC | long-context | cold | webgpu | 112.7 | 2630.1 | 461 | 0/3 (0%) | –/– |
| desktop-chrome | webllm | Llama-3.2-1B-Instruct-q4f16_1-MLC | short | cold | webgpu | 196.2 | 1184.5 | 44 | 0/3 (0%) | –/– |
| desktop-chrome | webllm | Qwen2.5-1.5B-Instruct-q4f16_1-MLC | long-context | cold | webgpu | 31.1 | 1466.4 | 824 | 0/3 (0%) | –/– |
| desktop-chrome | webllm | Qwen2.5-1.5B-Instruct-q4f16_1-MLC | short | cold | webgpu | 121.5 | 910.9 | 52 | 0/3 (0%) | –/– |
| desktop-chrome | wllama | bartowski/Llama-3.2-1B-Instruct-GGUF | long-context | cold | webgpu | 15.9 | – | 1196 | 0/3 (0%) | –/– |
| desktop-chrome | wllama | bartowski/Llama-3.2-1B-Instruct-GGUF | short | cold | webgpu | 97.6 | – | 127 | 0/3 (0%) | –/– |
| desktop-chrome | wllama | bartowski/Qwen2.5-1.5B-Instruct-GGUF | long-context | cold | webgpu | 42.5 | – | 1488 | 0/3 (0%) | –/– |
| desktop-chrome | wllama | bartowski/Qwen2.5-1.5B-Instruct-GGUF | short | cold | webgpu | 45.3 | – | 280 | 0/3 (0%) | –/– |
| iphone-11-pro-max | webllm | Llama-3.2-1B-Instruct-q4f16_1-MLC | short | cold | × webgpu | × | × | × | 2/2 (100%) | –/–, 2048/1024 |
| iphone-11-pro-max | webllm | Qwen2.5-1.5B-Instruct-q4f16_1-MLC | long-context | cold | × – | × | × | × | 1/1 (100%) | –/– |
| iphone-11-pro-max | webllm | Qwen2.5-1.5B-Instruct-q4f16_1-MLC | short | cold | × – | × | × | × | 1/1 (100%) | –/– |
| iphone-11-pro-max | wllama | bartowski/Qwen2.5-0.5B-Instruct-GGUF | long-context | cold | × – | × | × | × | 1/1 (100%) | –/– |
| iphone-11-pro-max | wllama | bartowski/Qwen2.5-0.5B-Instruct-GGUF | short | cold | × – | × | × | × | 1/1 (100%) | –/– |
| pixel-8a | webllm | Llama-3.2-1B-Instruct-q4f16_1-MLC | long-context | cold | webgpu | 8.8 | 15.8 | 76996 | 0/3 (0%) | 2048/1024 |
| pixel-8a | webllm | Llama-3.2-1B-Instruct-q4f16_1-MLC | short | cold | webgpu | 10.3 | 13.8 | 3782 | 0/3 (0%) | 2048/1024 |

## Validation warnings

- `desktop-chrome-20260610T102824.json`: 72 schema deviation(s) — included anyway. First: $.runs[0].kv_context_window: missing
- `iphone-11-pro-max-20260610T111359.json`: 4 schema deviation(s) — included anyway. First: $.runs[0].kv_context_window: missing
- `iphone-11-pro-max-20260610T112313.json`: 2 schema deviation(s) — included anyway. First: $.runs[0].kv_context_window: missing
- `iphone-11-pro-max-20260610T121735.json`: 4 schema deviation(s) — included anyway. First: $.runs[0].kv_context_window: missing
