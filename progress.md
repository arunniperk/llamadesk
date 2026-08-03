# Progress log

## 2026-08-01 — review of v2.1.2 + vision-detection fix

Reviewed the incoming v2.1.2 (context sizing, model labels, alternation fix). The KV-cache
work, the per-layer `head_count_kv` NaN fix, the SWA exclusion and `normalizeConvo()` all
read correctly and are well covered by the two new suites.

Found and fixed one regression it introduced: **vision was decided two different ways that
could disagree** — see findings.md. `labelsFor()` read the mmproj proof while `pickFor()`'s
OCR gate read the filename guess, so a projector-shipping model with no vision word in its
name was badged "Vision" yet refused by the OCR task. Demonstrated against
`Huihui-Qwythos-9B` (ships `mmproj-model-bf16.gguf`), which is a model queued for download.

Executed:
- `models.js` — `capabilities()` now trusts `m.vision` (mmproj present) and falls back to the
  filename regex, so the badge and the picker cannot disagree.
- `test-tasks.js` — 4 new regression checks: proof beats a nameless filename, the OCR task
  then accepts the model, the label agrees with the picker, and a model with neither a
  projector nor a vision word stays non-vision.

Test outcomes — **10/10 suites green** on this machine, including `test-tts`.

On the `test-tts` failure recorded in the v2.1.2 commit ("more than one locale is offered"):
it does **not** reproduce here — this machine enumerates the OneCore en-IN voices (Heera,
Ravi) and the suite passes 27/27. The difference is the machine, not the code: that check
asserts more than one locale is *installed*, which is an environment fact. Worth relaxing to
a warning if the other machine is meant to stay green.

## 2026-07-31 — v2.1.2: context sizing, model labels, alternation fix

Work developed in parallel on another machine, reconciled onto v2.1.1. Its attachment/PDF
layer was **dropped in favour of `extract.js`** — that implementation is broader (OOXML, HTML)
and its decode-quality gate is better validated: printable-ratio scoring, which the parallel
branch also used, passes CID garbage at 0.78, while the lexical test catches it at 0.28.
The parts kept are the ones absent from v2.1.1.

Executed:
- `models.js` — `kvBytesPerToken()` / `maxContextFor()`: context length is bounded by
  `(VRAM − weights − buffers) / kv_bytes_per_token`, capped at the trained context.
  Handles `head_count_kv` as a **per-layer array** (Gemma 4) and skips **sliding-window
  layers**, whose cache is constant rather than proportional to n_ctx.
- `models.js` — the GGUF parser now consumes big tokenizer arrays instead of bailing, with a
  2 MB fast path and a 24 MB retry, because Gemma's shape keys sit *after* them. Without this
  the KV math silently produced `NaN` and reported the trained context as if validated.
- `models.js` — **model labels**: `MoE 8/128`, `Vision`, `Coder`, `Reasoning`, `Uncensored`,
  `SWA`, `256k ctx`. Vision is now determined by an actual `mmproj-*.gguf` beside the model
  (proof) rather than only a filename guess, matching what `ocr.js` pairs.
- `agent.js` — `normalizeConvo()` merges consecutive same-role messages. A turn that produced
  no reply leaves an orphaned user message, so the next send stacks two and Gemma templates
  raise "roles must alternate". Never merges `tool_calls` messages.
- `agent.js` — the two opaque 400s are translated: template-can't-tool-call, and
  prompt-exceeds-context (now quoting both numbers and pointing at ⚙ → Max).
- Renderer — label badges with explanatory tooltips; **Max** button beside Context size;
  the context input cap raised to 10,000,000.

Test outcomes — 9/10 suites green:
- `test-context-sizing.js` 14/14, `test-convo-normalize.js` 12/12 (both ported).
- extract, tasks, config-robustness, providers, providers-enable, tokens, ui all still green.
- **`test-tts` fails 1 check — "more than one locale is offered → en-US" — and this is
  pre-existing**: verified by stashing every one of my edits and re-running against pristine
  v2.1.1 code, where it fails identically. The OneCore voices (Heera/Ravi, en-IN) that v2.1.1
  documented are not being enumerated on this machine right now. Left open, not investigated.
- Measured ceilings on this 16 GB card: gemma-4-12B/26B **256k** (trained cap), the 13 GB
  uncensored gemma-4-26B **94k**, Qwen2.5-VL-7B **125k**, Qwen3.5-9B **76k**, Qwen3-14B **40k**.
  **10,000,000 tokens is not reachable** — ~191 GB of KV cache at the cheapest measured rate.
- `dist\LlamaDesk-Setup-2.1.2.exe` — 81,764,623 bytes; `ProductVersion 2.1.2.0`, asar declares
  2.1.2, all additions packaged and extract/ingest/ocr/tts/tasks intact; smoke test passes.

## 2026-07-31 — v2.1.1: TTS voice picker (language / type / voice) + demo

Reported: TTS should let you choose voice type, locale and language, with a small demo.

Root discovery while implementing: **the v2.1.0 TTS could only see 2 of the 5 voices
installed on this machine.** Windows splits voices across SAPI5 and OneCore registries;
`System.Speech` reads only the former, so Heera and Ravi (en-IN) were present but
unreachable. See findings.md.

Executed:
- `tts.js` rewritten around **two engines**. `voices()` merges WinRT
  (`Windows.Media.SpeechSynthesis`, via the PowerShell `AsTask` interop) with
  `System.Speech`, de-duplicating on (person, locale) and returning
  `{id, name, engine, locale, language, gender}` with `id = engine|name`.
- Speaking, saving and previewing dispatch per engine. WinRT has no `Rate` property, so
  speed goes through an SSML `<prosody rate='±N%'>` wrapper; SAPI keeps its `Rate`.
- `localeName()` maps BCP-47 to readable names ("en-IN" → "English (India)"), covering the
  major Indian languages alongside the usual European/CJK set.
- `preview()` speaks a short sample **in the voice's own language** — 26 localised strings,
  falling back to English. An English sample also names the voice.
- Renderer: cascading **Language → Type → Voice** selectors in both the TTS bar and
  Settings, kept in step through one shared `paintVoicePickers()`; a 🔈 Demo button in each;
  a hint telling the user how to install more languages.
- Legacy settings holding a bare voice name still resolve (`resolveVoice` falls back).

Test outcomes — 8/8 suites green:
- `test-tts.js` (new) 27/27 — discovery and merge, composite ids, locale/gender/language
  metadata, no duplicate people, **OneCore reachability**, locale naming, per-language demo
  text (asserts a Hindi voice gets Devanagari, not English), real RIFF/WAVE output per
  engine, and rate actually changing rendered audio length (255,386 vs 106,286 bytes).
- `test-ui.js` extended to 33 — language selector populated with readable names, Any+gender
  types, demo button present, changing language re-filters voices, gender filter narrows.
- All six earlier suites still green.

Note: a first run of the extended UI test hung silently. Cause was `await` in a non-async
arrow callback — a SyntaxError masked by suppressed stderr. `node --check` now used first.

## 2026-07-31 — v2.1.0: tabbed workspace, attachments, auto model pick, TTS, OCR

Executed:
- `tasks.js` (new): 8 task profiles — code, extract, docs, terminal, prompt, tutor, tts, ocr.
  Each carries its own system prompt, tool policy (`full`/`readonly`/`none`), temperature,
  minimum context and capability weights. Prompts stay in the main process; only
  id/label/icon/blurb/kind reach the renderer.
- `models.js`: `capabilities()` infers a 0-10 profile per model (coding, tools, reasoning,
  creative, longctx, vision, uncensored, embedding) from name, architecture, measured
  context length and parameter size; `pickFor()` ranks against a task's weights plus VRAM
  fit and context. Embedding models can never win a chat task; OCR rejects non-vision models.
- `extract.js` (new): dependency-free PDF (zlib + content-stream text ops), OOXML
  (docx/xlsx/pptx via a minimal ZIP central-directory reader) and HTML extraction.
- `ingest.js` (new): file/URL → text dispatch, image + scanned-PDF detection, 300k-char cap,
  binary guard, and the `<attachment>` prompt block.
- `ocr.js` (new): `llama-mtmd-cli` wrapper, auto-pairs a vision GGUF with its
  `mmproj-*.gguf`, strips `<|det|>` layout markup, optional CPU vision encoder.
- `tts.js` (new): Windows SAPI via PowerShell. Text goes through a temp **file**, never the
  command line — arbitrary length and no interpolation into a shell string.
- `agent.js`: task profiles replace the 3 modes (legacy ids still map), per-task tool
  filtering and temperature, attachments folded into the newest user turn so the history
  stays valid across tool-call round-trips.
- Renderer: task tab strip, attachment tray with drag-and-drop and per-chip OCR, TTS and OCR
  control bars, ★ auto-pick badge, new "OCR & Voice" settings tab.
- Version bumped to **2.1.0** — clearing the 2.0.0-across-five-artifacts problem.

Test outcomes — 7/7 suites green:
- `test-extract.js` (new) 35/35 — real PDF/DOCX/PPTX/HTML fixtures built in-test, scanned and
  garbled PDF routing, binary and legacy-.doc guards, prompt-block assembly.
- `test-tasks.js` (new) 30/30 — profile shape, capability inference, per-task ranking, plus a
  printed ranking over the **real** 5-model library (Coder→code, gpt-oss→docs, OCR→ocr).
- `test-ui.js` (new) 27/27 — boots the real app and drives the real DOM: tab strip, control
  swapping per task kind, attachment chips, OCR button, settings tab, zero console errors.
- Regression: `test-providers`, `test-providers-enable`, `test-tokens`,
  `test-config-robustness` all still green.
- Validated the PDF extractor against 5 real-world PDFs with `pdftotext` as reference —
  98.4% and 99.2% word recall on the two that decode cleanly; see findings.md for the
  garbage-detection story.

Not covered: live inference through a task profile (needs a loaded GGUF), and OCR through the
new UI path against a real image (the underlying `ocr.js` command line is the one verified
working earlier against `Unlimited-OCR`).

## 2026-07-31 — code review fixes (config layer)

Reviewed the published `v2` and verified each suspect path by executing it rather than
reading it. Two confirmed bugs plus the shared root cause; see findings.md.

Executed:
- `providers.js`: new `mergeProviders()` merges stored entries over the presets
  entry-by-entry. `resolve()` uses it and now reports a missing base URL as an actionable
  error instead of a `TypeError`. Exported for tests.
- `llama.js`: `extraArgs` tokenising defaults to `[]` (`.match()` yields `null` for a
  whitespace-only string).
- `settings.js`: cache keyed on the settings.json mtime, so external edits are picked up
  without a restart. Documented why `save()` stays shallow.
- `main.js`: `providers:save` / `patchProvider` write only user deltas — the hand-spreading
  of `DEFAULT_PROVIDERS` that the old shallow merge forced is gone.
- `scripts/test-providers-enable.js`: its copy of the handler bodies kept in sync.

Test outcomes:
- `scripts/test-config-robustness.js` (new) — 19/19 PASS: preset inheritance from a partial
  entry, stored-value override, actionable missing-baseUrl error, unknown provider, six
  `extraArgs` tokenising cases incl. quoted paths, and external-edit pickup.
- Pre-fix behaviour captured before changing anything: `resolve(partial)` threw
  `TypeError: Cannot read properties of undefined (reading 'replace')` and
  `splitArgs("   ")` threw `TypeError: ... (reading 'map')`.
- Regression: `test-providers.js` ALL PASS, `test-providers-enable.js` all checks passed,
  `test-tokens.js` all checks passed, renderer smoke test clean.

Not fixed (reported, left open): multi-adapter VRAM aggregation in `monitor.js`
(sums used across adapters, takes max for the total — moot on a single-GPU box), tool calls
dropped when a model emits content *and* `tool_calls` with `finish_reason:'stop'`, MCP tool
names truncated at 64 chars not round-tripping, dead `reasoning` accumulator in `agent.js`,
and the `safeStorage`-unavailable fallback storing base64 while the UI still says
"encrypted". Version is still 2.0.0 across five distinct artifacts — bump still outstanding.

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
