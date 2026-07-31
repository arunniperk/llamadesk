# LlamaDesk

A modern Windows 11 desktop app for running local LLMs via **llama.cpp** — built for a
Ryzen 7 5800X / 64 GB RAM / Radeon RX 9070 XT (16 GB) machine, but works on any x64 PC.

![icon](build/icon.png)

## Features

- **GGUF model browser** — scans your chosen folders, reads GGUF metadata (architecture,
  context length, quant), and shows whether each model fits in VRAM.
- **Model advisor** — suggests the best local model for **Chat**, **Coding** and
  **Agent** use based on model family, size and your 16 GB VRAM budget.
- **llama.cpp manager** — one-click download/update of the latest prebuilt llama.cpp
  Windows binaries from GitHub (Vulkan build recommended for the RX 9070 XT; HIP/ROCm
  and CPU flavors selectable). Old versions are pruned automatically.
- **Live telemetry** — CPU, RAM, GPU utilization, VRAM usage and tokens/second with a
  sparkline, updated every second while generating. A **TOKENS in/out** tile tracks total
  tokens consumed (prompt) and generated (completion), cumulative for the session; each
  reply's own totals appear under it in the message footer.
- **Three modes**
  - 💬 **Chat** — plain streaming conversation.
  - 🖥️ **Desktop Agent** — the model can run PowerShell, read/write files, list
    directories and fetch URLs on your PC (full permissions).
  - ⌨️ **Coding Agent** — engineer-flavored system prompt with the same tools
    (git, npm, builds, tests, file edits).
- **Admin Mode switch** — relaunches the app elevated via UAC so agent tools run with
  Administrator rights on Windows 11.
- **MCP extensions** — connect Claude Desktop-style MCP servers (Filesystem,
  Desktop Commander, PDF tools, …). One-click **Import from Claude Desktop** reads your
  `claude_desktop_config.json`. All MCP tools are exposed to the agent modes.
- **Skills** — install skill folders (containing `SKILL.md`) from a local path, git URL
  or zip URL; enabled skills are injected into the agent system prompt.

## New in 2.0 — Online models

- **Provider system** — use cloud models alongside local GGUFs: **DeepSeek**
  (`deepseek-chat`, `deepseek-reasoner`), **OpenAI**, **OpenRouter**, or any custom
  OpenAI-compatible endpoint.
- **Encrypted API keys** — keys are stored with Windows DPAPI (Electron `safeStorage`)
  in `keys.json`, never in plain settings, and are only sent to their own provider.
- A **🖥 Local / ☁ Online** switch at the top of the sidebar chooses the model source and
  where chat is sent; each source gets its own pane, and your online pick is remembered
  when you switch away and back. All three modes work either way, including tool calling
  and DeepSeek-reasoner thinking traces.
- Per-provider **Test** (key check) and **Fetch** (live model list) buttons in
  Settings → Providers.

## New in 2.1 — Tabbed workspace, attachments, TTS & OCR

**Eight task tabs**, each with its own system prompt, tool policy, sampling defaults and
model preference:

| Tab | Does | Tools |
|---|---|---|
| ⌨️ Code Assistance | Draft, refactor, boilerplate | full |
| 🧾 Data Extraction | Text → JSON / CSV / tables (temp 0) | read-only |
| 📄 Document Vetting | Long PDFs, clauses, summaries | read-only |
| 🖥️ Terminal & System | PowerShell, files, automation | full |
| 🎨 Prompt Generation | Cinematic image/video prompts | none |
| 🎓 Interactive Tutoring | Step-by-step STEM mentoring | read-only |
| 🔊 Text to Speech | Offline Windows voices → speakers or .wav | none |
| 🔍 OCR | Images & scanned PDFs → text | none |

**Attachments** — drag files onto the transcript, or use 📎 / 🔗. Handled natively with no
external dependencies: **PDF** (text extraction with a decode-quality check), **DOCX /
XLSX / PPTX**, **HTML**, plain text and code, plus **web pages and PDFs by URL**. Images and
scanned PDFs are detected and offered a one-click **OCR** button rather than silently
contributing nothing.

**Automatic model selection** — each task ranks your local models on inferred capability
(coding, reasoning, long-context, vision, tool use), VRAM fit and context length, then marks
the winner with ★ in the sidebar. Toggle it off in Settings → OCR & Voice.

**Text to speech** picks voices by **language → type (gender) → voice**, with a **🔈 Demo**
button that speaks a short sample *in that voice's own language*. Voices are read from
**both** Windows engines — classic SAPI5 and the modern OneCore set — because they live in
separate registries and OneCore usually has more languages installed. On a stock Windows 11
box SAPI alone shows 2 en-US voices while the merged list also exposes English (India).
No model download, no network.

## Getting started

1. Install with `dist/LlamaDesk-Setup-1.0.0.exe` (or run from source: `npm install && npm start`).
2. First run: **Settings → llama.cpp → Download & install** (Vulkan backend).
3. Add your GGUF folder(s) with the **＋** button in the sidebar (default: `%USERPROFILE%\models`).
4. Select a model → **▶ Load model** → chat.

## Where things live

- Settings / runtime / skills: `%APPDATA%\llamadesk\` (`settings.json`, `llama-cpp\`, `skills\`)
- llama-server runs on `127.0.0.1:8033` (configurable) with `--jinja` for tool calling.

## Model tips for 16 GB VRAM

- Best all-round agent/chat: Qwen 3 / Llama 3.x 8–14B at Q5_K_M–Q6_K, or 30B-class MoE at Q4_K_M.
- Coding: Qwen2.5-Coder 14B Q5_K_M (fits fully), or 32B Q4_K_M (partial offload, slower).
- Files ≤ ~14 GB run fully on the GPU; larger models spill into system RAM.

## Build

```
npm install
npm run icon   # regenerate build/icon.ico
npm run dist   # NSIS installer → dist/
```
