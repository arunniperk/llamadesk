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
## v2 (online providers)

- **API keys**: Electron `safeStorage` (Windows DPAPI) encrypts per-user; stored in
  `userData\keys.json` separate from `settings.json` so settings stay shareable.
  Verified by test that the plaintext key never appears on disk.
- **DeepSeek** is OpenAI-compatible at `https://api.deepseek.com/v1`; `deepseek-reasoner`
  streams its chain-of-thought as `delta.reasoning_content`, which the v1 renderer
  already displays as a collapsible thinking block — no extra work needed.
- **OpenRouter** requires `HTTP-Referer` + `X-Title` headers and lists hundreds of
  models, so the fetch-models helper caps the sidebar list at 40.
- `.gitignore` must exclude `dist/` and `node_modules/`; `keys.json` lives in
  `%APPDATA%\llamadesk`, outside the repo, so keys can't be committed by accident.

## Building the installer on this machine

- **`npm run dist` fails at `winCodeSign` extraction** with "Cannot create symbolic link: A
  required privilege is not held by the client". electron-builder's `winCodeSign-2.6.0.7z`
  contains two macOS symlinks (`darwin/10.12/lib/libcrypto.dylib`, `libssl.dylib`); creating
  symlinks on Windows needs admin or Developer Mode, so extraction aborts and the build dies
  before packaging. Each retry re-downloads into a new random temp dir, so the cache never
  populates.
- **Turning Developer Mode on is not enough by itself** —
  `SeCreateSymbolicLinkPrivilege` is baked into the *logon token*, so it only takes effect
  after a sign-out/sign-in or reboot.
- **Fix that needs no privileges at all:** pre-extract the archive without the macOS tree
  into the cache dir electron-builder looks for —
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` (that exact name;
  delete the leftover numeric temp dirs first):

  ```
  node_modules\7zip-bin\win\x64\7za.exe x <cache>\<hash>.7z -o<cache>\winCodeSign-2.6.0 -xr!darwin -y
  ```

  The build then finds a populated cache and skips its own extraction. The vendor package is
  only used to *locate* `signtool.exe`; the log still says "no signing info identified,
  signing is skipped" because the app is unsigned either way, so nothing is lost by dropping
  the macOS files.

## Token accounting

- **Counting content deltas is not counting tokens** — the v1/v2 `tok/s` counter treated
  each SSE `delta.content` as one token, which drifts from the real count (a delta can be
  a word fragment or several tokens). Exact numbers have to come from the server.
- **llama-server** puts them in the final chunk's `timings`: `predicted_n` (generated) and
  `prompt_n` (consumed), alongside the `*_per_second` rates.
- **OpenAI-compatible providers** only append a usage chunk when the request carries
  `stream_options: { include_usage: true }` — and that chunk has an **empty `choices`
  array**, so any `if (!choice) continue` guard must come *after* reading `obj.usage`.
- A tool-calling turn is several round-trips that each re-send the whole conversation, so
  the honest per-turn figures are **sums over the round-trips** — prompt tokens especially,
  since the same context is billed again on every hop.
- Chunk counting survives as a last-resort fallback; those figures are flagged (`exact:
  false`) and rendered with a `~` prefix rather than passed off as measured.
- Adding a 6th telemetry tile made `RAM`/`VRAM` wrap and grew the row 21 px. Sharing one
  unit between the two values (`18.4 / 63.9 GB`) freed the space and restored the original
  61 px tile / 78 px row height.

- **Claude Desktop config** at `%APPDATA%\Claude\claude_desktop_config.json` can be
  imported directly to reuse its `mcpServers` entries (Filesystem, Desktop Commander,
  PDF tools, …).
