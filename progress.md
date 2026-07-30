# Progress log

## 2026-07-30 — total token counters

Executed:
- `agent.js`: real token accounting. Reads `timings.prompt_n`/`predicted_n` (llama-server)
  and `usage.prompt_tokens`/`completion_tokens` (online, via new
  `stream_options.include_usage`); `usage` is captured before the empty-`choices` guard.
  Both totals sum over the round-trips of a tool-calling turn; chunk counting remains a
  flagged (`exact: false`) fallback. Removed the now-dead `totalTokens` delta counter.
- `monitor.js`: cumulative session `tokensIn`/`tokensOut` in the stats broadcast, plus a
  provisional live count so the tile ticks up mid-stream (`setLiveTokens`/`commitTokens`).
- Renderer: **TOKENS in/out** telemetry tile; per-message footer now reads
  `41.7 tok/s · 512 generated · 1,340 consumed · 12.3s`.
- Layout: the 6th tile made RAM/VRAM wrap, so those now share one unit
  (`18.4 / 63.9 GB`); sparkline 120→105 px and flex ratios retuned — tile/row heights
  measured back at the pre-change 61 px / 78 px.

Test outcomes:
- `npx electron scripts/test-tokens.js` (new) — 20/20 PASS against a scripted SSE server:
  llama-server timings path, provider usage-chunk path, `include_usage` actually sent,
  no-usage fallback flagged approximate, tool-call round-trip summation, monitor totals
  incremented once, stats payload shape.
- Dev smoke test (`LLAMADESK_SMOKE=1 npx electron .`) — renderer loaded, no console errors.
- Telemetry layout verified by measuring the DOM at 1360 px (default) against the
  pre-change files from git HEAD.
- Not tested in-session: live inference against a real GGUF or a real provider key, so the
  numbers are verified against scripted server responses rather than a live model.

Installer rebuild:
- `npm run dist` was failing outright on the `winCodeSign` symlink extraction (root cause
  and the privilege-free fix are in findings.md). Staged the cache manually, after which the
  build ran clean.
- `dist\LlamaDesk-Setup-2.0.0.exe` rebuilt — 81,738,799 bytes, NSIS, unsigned. **Version not
  bumped**, so this installer replaces the earlier 2.0.0 artifact with different contents.
- Verified the packaged `app.asar` contains the new code (`setLiveTokens`, `commitTokens`,
  `include_usage`, `st-tokens-out`, `fmtPairGB`) and `dist\win-unpacked\LlamaDesk.exe`
  passes the smoke test.

## 2026-07-30 — v2.0.0 (branch `v2`)

Executed:
- Forked repo: git init, v1.0.0 committed + tagged on `main`, work continues on `v2`.
- New `src/main/providers.js`: DeepSeek/OpenAI/OpenRouter presets + custom providers,
  keys encrypted via Electron safeStorage (DPAPI), test + fetch-models endpoints.
- Agent loop routes to online providers (Authorization header, provider model id);
  reasoning_content streaming (deepseek-reasoner) already supported from v1.
- Renderer: "Online" sidebar section (☁ cards), Providers settings tab, target-aware
  chat send/pill/labels.
- Version bumped to 2.0.0; installer rebuilt; pushed to github.com/arunniperk.

Test outcomes:
- `npx electron scripts/test-providers.js` — 15/15 PASS: DPAPI availability, key
  round-trip, **key absent from keys.json in plaintext**, resolve()/authHeaders wiring,
  OpenRouter extra headers, custom-provider merge, key removal, error paths.
- Dev smoke test (`LLAMADESK_SMOKE=1 npx electron .`) — renderer loaded, no console errors.
- Packaged `dist\win-unpacked\LlamaDesk.exe` smoke test — pass.
- `LlamaDesk-Setup-2.0.0.exe` built (78 MB, NSIS, unsigned).
- Not tested in-session: live DeepSeek API round-trip (needs the user's real key entered
  in Settings → Providers; the Test button performs this check).

## 2026-07-30 — Initial build (LlamaDesk 1.0.0)

Executed:
- Scaffolded Electron app (plain JS, no bundler): main process modules
  (settings, models/GGUF parser, llama.cpp manager+updater, monitor, agent loop,
  MCP client, skills, elevation), preload bridge, single-page renderer.
- Generated app icon (pure-JS PNG/ICO encoder) → build/icon.ico, build/icon.png.
- `npm install` (electron 33, electron-builder 25) — OK.
- Smoke test `LLAMADESK_SMOKE=1 npx electron .` — renderer loaded, no console errors.
- NSIS installer build via electron-builder — see findings.md for outcome.

Test outcomes:
- Icon generation: pass (verified visually).
- Electron launch smoke test: pass ("SMOKE: renderer loaded OK", zero console errors).
- Full end-to-end inference not tested in-session (requires a GGUF model on disk and
  the llama.cpp runtime download, both user actions at first run).
