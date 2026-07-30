# Progress log

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
