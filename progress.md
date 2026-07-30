# Progress log

## 2026-07-30 — fix: fetched online models never appeared

Reported against the installed app (`C:\Program Files\LlamaDesk`, the 18:01 build) with a
DeepSeek key added. Not a fetch bug — root cause was the `enabled` gate; see findings.md.

Diagnosis from the real config (`%APPDATA%\llamadesk`):
- `keys.json` → `deepseek -> enc`, key saved fine.
- `settings.json` → `models: ["deepseek-v4-flash","deepseek-v4-pro"]`, so the fetch had
  worked *and* persisted.
- `"enabled": false` → sidebar filters `p.enabled && p.hasKey`, so nothing rendered, and the
  empty hint said "Add API keys", which pointed away from the real problem.

Executed:
- `main.js`: new `patchProvider()`; `providers:setKey` (non-empty key) and
  `providers:fetchModels` now set `enabled: true`. An explicit untick still wins.
- Provider row: checkbox + provider name share a `<label>` (the name is now a click target),
  and the key state spells out `🔒 key saved · hidden — tick to show` in amber.
- Online pane hint and the source-switch toast now name the hidden provider instead of
  telling you to add a key you already added.
- Repaired the existing config in place: flipped `providers.deepseek.enabled` to `true`
  (backup at `scratchpad/settings.json.bak`; all 14 top-level settings keys preserved). The
  code fix only auto-enables on the *next* key save or fetch, so the current state needed it.

Test outcomes:
- `scripts/test-providers-enable.js` (new) — 11/11 PASS, including a direct repro of the bug
  (key + models + `enabled:false` → empty sidebar), fetch/setKey enabling, manual disable
  still winning, and clearing a key not enabling anything.
- Confirmed against the real config that the Online pane will now render
  `DeepSeek · deepseek-v4-flash` and `DeepSeek · deepseek-v4-pro`.
- New provider UI driven in the browser harness with the exact reported state
  (key saved, models fetched, disabled): hint, toast, amber row state and label wiring all
  correct.
- `test-tokens.js` 20/20, `test-providers.js` ALL PASS, renderer smoke test clean.
Installer:
- Rebuilt `dist\LlamaDesk-Setup-2.0.0.exe` — 81,739,890 bytes, 18:13, NSIS, unsigned.
  `winCodeSign` cache still staged, so the build ran straight through.
- Verified the packaged `app.asar` carries the fix (`patchProvider`, `provider-enable`,
  `key-state.warn`, the `hidden — tick to show` / `but hidden` strings) plus the switch and
  token counters from the earlier builds; `dist\win-unpacked\LlamaDesk.exe` smoke test passes.
- `C:\Program Files\LlamaDesk` still holds the 18:01 build — **run the new installer over it**
  to pick up the code fix. Not urgent for this machine (the flag was repaired directly), but a
  fresh install elsewhere would otherwise hit the same trap.
- **Still version 2.0.0** — fourth distinct artifact under that version. Bump outstanding.

## 2026-07-30 — Local / Online source switch

Executed:
- Sidebar now leads with a **🖥 Local / ☁ Online** segmented switch; the two model lists
  became exclusive panes (`#pane-local` / `#pane-online`) instead of being stacked.
- The switch is also the routing control: `setSource()` clears `state.target` for Local (so
  chat goes to llama-server) and restores `state.lastOnline` for Online, so an online pick
  survives switching away and back.
- Pill reports `No online model selected` when the Online pane has no pick, and
  `llama.onState` no longer overwrites the pill while Online is active (it keys off
  `state.source`, not the target).
- Send guards are per-source now: "Load a local model first, or switch to Online." /
  "Pick an online model in the sidebar, or switch to Local."
- Welcome copy + README updated to describe the switch. Source choice is **not persisted**
  across restarts — same as the existing Chat/Agent mode switch.

Test outcomes:
- Drove the real renderer in a browser against a stubbed preload bridge
  (`scratchpad/v6/stub-api.js`, not committed): initial state, Local→Online pane swap,
  picking a model, Online→Local→Online restoring the remembered pick, and the selected
  card's `.active` highlight — all correct.
- Both send guards verified: send blocked, correct toast, no message appended, input text
  preserved.
- `LLAMADESK_SMOKE=1 npx electron .` — renderer loaded, no console errors.
  `scripts/test-tokens.js` — still 20/20.
- Note: a force-navigate to the same file URL does **not** reset the preview pane's
  document; an early "fresh load" check was invalid until the harness was copied to a new
  directory. Copy to a new path per iteration.

Installer:
- Rebuilt `dist\LlamaDesk-Setup-2.0.0.exe` — 81,739,389 bytes, 18:02, NSIS, unsigned. The
  staged `winCodeSign` cache from the previous build was still intact, so no workaround was
  needed this time.
- Verified the packaged `app.asar` carries the switch (`source-switch`, `setSource`,
  `lastOnline`, `pane-online`, the new pill/guard strings) alongside the token counters, and
  `dist\win-unpacked\LlamaDesk.exe` passes the smoke test.
- **Still 2.0.0** — this is now the third distinct artifact under that version. A bump is
  outstanding.

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
