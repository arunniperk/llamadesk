# Findings

## Windows hides half its TTS voices from you (v2.1.1)

- Windows keeps voices in **two separate registries with two separate APIs**, and the one
  most code reaches for sees fewer of them:
  - `HKLM\SOFTWARE\Microsoft\Speech\Voices\Tokens` — SAPI5, what `System.Speech` enumerates.
  - `HKLM\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens` — the modern set used by Narrator,
    reachable only through WinRT `Windows.Media.SpeechSynthesis`.
- On this machine that gap was **2 voices vs 5**. SAPI showed David and Zira (en-US) only;
  OneCore additionally had **Heera and Ravi (en-IN)** and Mark. The v2.1.0 build used
  `System.Speech`, so those Indian-English voices were installed and simply unreachable.
- The widely-posted "fix" is copying OneCore tokens into the SAPI registry key. That is an
  **admin-level modification of a system registry hive** — not something the app should do.
  Reading both engines achieves the same result with zero system changes.
- WinRT specifics worth remembering:
  - `SpeechSynthesizer.AllVoices` is static and enumerates without instantiating a voice.
  - It has **no `Rate` property** — speed must come from an SSML `<prosody rate='±N%'>`
    wrapper via `SynthesizeSsmlToStreamAsync`. Verified by measuring rendered WAV size:
    rate −6 → 255,386 bytes vs rate +8 → 106,286 bytes for identical text.
  - Output is a real `RIFF/WAVE` stream, so the same path serves both playback
    (`SoundPlayer.PlaySync`) and Save-to-WAV.
  - The async API needs the `AsTask` reflection dance in PowerShell 5.1; there is no
    `await` keyword.
- Voices are merged and de-duplicated on `(person, locale)` after stripping the `Microsoft `
  prefix and ` Desktop` suffix — otherwise "Microsoft David Desktop" (SAPI) and
  "Microsoft David" (OneCore) appear as two different people.

## Test-authoring trap

- `await` inside a **non-async arrow callback** (`langs.find(l => l !== await js(...))`) is a
  SyntaxError that aborts the whole script before a single line runs. With stderr suppressed
  it presents as a silent hang, not an error. `node --check <file>` catches it instantly and
  is worth running on any test script that appears to stall.

## PDF text extraction (v2.1)

- **"Looks like text" is not "is the right text."** The first decode-quality gate scored
  printable-character ratio. Validated against five real PDFs, one (`research_paper.pdf`)
  scored **0.78 — a pass — while sharing 0.0% of its words with `pdftotext`'s output.**
  PDFs with CID/custom font encodings decode to letters, just the *wrong* letters, so a
  character-class test cannot see the failure. Feeding that to a model is worse than
  extracting nothing: it answers confidently from noise.
- The separating signal is **lexical, not typographic**. Measured across the same PDFs:

  | | stop-word % | words with a vowel % |
  |---|---|---|
  | correct decode | 25–31 | 84–92 |
  | CID garbage | **0.02** | **40** |

  `textQuality` now scores `0.7 × vowelRatio + 0.3 × min(1, stopRatio/0.15)`. Vowel rate
  leads deliberately so correctly-decoded **non-English** text is not condemned as garbage
  (English stop words legitimately vanish there); stop words only add confidence.
  Real PDFs now score 0.89–0.94, the garbage one 0.28, scanned ones 0.00 — all three routed
  correctly, the last two to OCR.
- Recall against `pdftotext` on the PDFs that decode cleanly: **98.4%** and **99.2%**.
- `pdftotext` exists on this machine only because Git for Windows ships it. Deliberately
  **not** used at runtime — the extractor is pure Node + zlib so the app stays portable.

## Testing the renderer, properly

- The stubbed-browser harness has a hard limit: the Browser pane renders files outside the
  project folder as **static snapshots**, so no JavaScript executes and every DOM assertion
  is vacuous. Use it for layout only.
- `scripts/test-ui.js` instead `require`s the real `main.js`, grabs the created
  `BrowserWindow`, and drives the renderer through `webContents.executeJavaScript`. That
  exercises real IPC, real settings and the real main process — the TTS voice list in the
  test comes back from actual Windows SAPI. A load-only smoke test proves nothing beyond
  "no syntax errors".

## Config-layer robustness (code review, 2026-07-31)

- **Shallow merge at the wrong level.** `providers.js` merged `settings.providers` over
  `DEFAULT_PROVIDERS` with one map-level spread, so a *partial* stored entry
  (`{enabled:true}`) replaced an entire preset and silently dropped `baseUrl`, `label` and
  `models`. `resolve()` then died on `p.baseUrl.replace` with
  `TypeError: Cannot read properties of undefined`. Every UI writer happened to write
  complete entries, which is the only reason it never fired — a latent landmine, not an
  active fault. Fixed with `mergeProviders()`, an entry-by-entry merge; `settings.providers`
  now stores only user *deltas*, and `patchProvider`/`providers:save` no longer re-spread
  the defaults by hand.
- **`String.match()` returns `null`, not `[]`.** `llama.js` spread
  `extraArgs.match(...)` directly; a whitespace-only `extraArgs` is truthy but tokenises to
  `null`, so the spread threw and surfaced as "the model won't load". The renderer `.trim()`s
  that field, so again only reachable via a hand-edited `settings.json`. Fixed with `|| []`.
- **A cache with no invalidation hides external edits.** `settings.load()` returned its
  module-level cache forever, so a `settings.json` repaired by hand stayed invisible until
  restart. Now keyed on the file's mtime. `save()` stays a *shallow* merge deliberately —
  deep-merging would make it impossible to delete a nested entry (a provider, an MCP server).
- Lesson worth keeping: **"the UI always writes it correctly" is not a safety property.**
  Config files are a public API — anything hand-editable will eventually be hand-edited.


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

## Provider `enabled` gate (bug, 2026-07-30)

- Symptom: "fetched online models are not showing". The fetch was working perfectly — the
  models were in `settings.json` and the key was in `keys.json`. The blocker was
  `enabled: false`: `DEFAULT_PROVIDERS` ships every preset disabled, the sidebar filters on
  `p.enabled && p.hasKey`, and the only way to flip it was an **unlabeled checkbox** whose
  meaning lived in a `title` tooltip. Worse, the merge in `providers:fetchModels` carried
  `enabled: false` forward, so fetching wrote the models *and* re-affirmed the flag hiding
  them.
- Fix: saving a key or fetching models now implies intent and sets `enabled: true`
  (`patchProvider` in main.js). An explicit untick still wins — it's a later, separate write.
- The deeper lesson: **"stored but invisible" states need to say so.** The sidebar hint, the
  switch toast, and the provider row now all distinguish "no key" from "key saved but
  hidden", instead of showing the same "add an API key" message in both cases.

## Testing the renderer

- The renderer can be driven **outside Electron**: stub `window.api` (the preload bridge) in
  a script tag ahead of `app.js` and the whole UI runs in a plain browser, so sidebar/switch
  behaviour can be asserted against the DOM instead of eyeballed. A `Proxy` fallback that
  returns `() => {}` for `on*` and `Promise.resolve({})` for everything else covers the calls
  a test doesn't care about.
- Two traps when verifying layout/behaviour this way: `styles.css` is **cached** across
  reloads, and force-navigating to the **same file URL does not reset the document** (state
  from the previous run survives and quietly invalidates "fresh load" assertions). Copy the
  renderer to a new scratchpad directory per iteration.
- `npx electron scripts/foo.js` runs with app name **"Electron"**, so `app.getPath('userData')`
  is `%APPDATA%\Electron`, *not* `%APPDATA%\llamadesk`. Good news for tests (they can't harm
  real settings/keys), but any script meant to inspect the real app's config must call
  `app.setPath('userData', path.join(process.env.APPDATA, 'llamadesk'))` first — otherwise it
  silently reports defaults and looks like data loss.

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
