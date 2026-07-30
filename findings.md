# Findings

- **RX 9070 XT (RDNA4) + llama.cpp**: the official prebuilt that works best is the
  **Vulkan** Windows build (`llama-<tag>-bin-win-vulkan-x64.zip`). HIP/ROCm prebuilts
  lag behind for RDNA4; the app defaults to Vulkan with HIP/CPU selectable.
- **GGUF metadata** can be parsed from the first ~2 MB of the file (magic `GGUF`,
  version, KV pairs). Parsing stops safely at the tokenizer vocab (huge arrays).
- **GPU telemetry on Windows without vendor SDKs**: perf counters
  `\GPU Engine(*)\Utilization Percentage` and `\GPU Adapter Memory(*)\Dedicated Usage`
  via a persistent PowerShell child; VRAM total from the display-class registry key
  `HardwareInformation.qwMemorySize`.
- **Tool calling** with llama-server requires the `--jinja` flag; tool_calls stream as
  indexed deltas in the OpenAI-compatible SSE and must be accumulated per index.
- **MCP stdio transport** is newline-delimited JSON-RPC 2.0 (initialize →
  notifications/initialized → tools/list / tools/call). Spawning through `cmd.exe /c`
  is needed on Windows so `npx`/`uvx` shims resolve.
- **Elevation**: Electron apps can't elevate in place; the Admin switch relaunches via
  `Start-Process -Verb RunAs` and detects elevation with a `net session` probe.
- **Claude Desktop config** at `%APPDATA%\Claude\claude_desktop_config.json` can be
  imported directly to reuse its `mcpServers` entries (Filesystem, Desktop Commander,
  PDF tools, …).
