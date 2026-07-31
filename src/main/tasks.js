'use strict';
// Task profiles (v2.1): the tabbed workspace. Each profile carries its own system
// prompt, tool policy, sampling defaults and — crucially — the capability weights
// used to auto-pick the best available model for that job (see models.pickFor).
//
// kind:
//   'chat' → normal LLM turn (streamed, optional tools)
//   'ocr'  → image/scanned-PDF → text via a vision model + mmproj (no chat model)
//   'tts'  → text → speech via Windows SAPI (no model at all)

const TASKS = [
  {
    id: 'code',
    label: 'Code Assistance',
    icon: '⌨️',
    kind: 'chat',
    blurb: 'Draft functions, refactor, write boilerplate — nothing leaves this PC.',
    tools: 'full',
    temperature: 0.2,
    minCtx: 8192,
    accepts: ['file', 'url'],
    // capability weights for model selection
    wants: { coding: 10, tools: 3, reasoning: 2, longctx: 1 },
    prompt:
      `You are LlamaDesk Code Assistant, an expert software engineer working offline on the user's Windows 11 machine. ` +
      `Read before you edit — never invent file contents. Make minimal, correct changes and show the diff or the key snippet. ` +
      `Prefer the idioms already present in the surrounding code. When you are unsure of an API, say so rather than guessing.`,
  },
  {
    id: 'extract',
    label: 'Data Extraction',
    icon: '🧾',
    kind: 'chat',
    blurb: 'Unstructured text, emails or dumps → tables, JSON or structured summaries.',
    tools: 'readonly',
    temperature: 0,
    minCtx: 8192,
    accepts: ['file', 'url'],
    wants: { tools: 6, reasoning: 4, coding: 2, longctx: 3 },
    prompt:
      `You are LlamaDesk Data Extractor. Convert whatever the user supplies into the exact structure they ask for ` +
      `(JSON, CSV, or a markdown table). Rules: emit ONLY the requested structure with no prose before or after; ` +
      `never invent values — use null or an empty string when a field is genuinely absent; keep the user's field names ` +
      `verbatim; preserve numbers and dates exactly as written in the source unless asked to normalise them. ` +
      `If the requested structure is ambiguous, choose the most literal reading and note nothing.`,
  },
  {
    id: 'docs',
    label: 'Document Vetting',
    icon: '📄',
    kind: 'chat',
    blurb: 'Parse long PDFs, reports and terms — extract clauses, summarise, query.',
    tools: 'readonly',
    temperature: 0.2,
    minCtx: 16384,
    accepts: ['file', 'url'],
    wants: { longctx: 10, reasoning: 5, tools: 1 },
    prompt:
      `You are LlamaDesk Document Analyst. Answer strictly from the supplied document text. ` +
      `Quote the exact wording when identifying a clause, term or figure, and give its location (section or page) when known. ` +
      `If the answer is not present in the document, say "not stated in this document" — do not fill the gap from general knowledge. ` +
      `Distinguish clearly between what the document says and any inference you draw from it.`,
  },
  {
    id: 'terminal',
    label: 'Terminal & System',
    icon: '🖥️',
    kind: 'chat',
    blurb: 'Run commands, manage files, automate Windows — with full tool access.',
    tools: 'full',
    temperature: 0.3,
    minCtx: 8192,
    accepts: ['file'],
    wants: { tools: 10, coding: 4, reasoning: 2 },
    prompt:
      `You are LlamaDesk System Agent, operating the user's Windows 11 PC with their permission via PowerShell and file tools. ` +
      `Inspect before you modify and verify after acting. State plainly when a command deletes, overwrites or installs something, ` +
      `and prefer the reversible approach where one exists. Report exactly what you ran and what it returned.`,
  },
  {
    id: 'prompt',
    label: 'Prompt Generation',
    icon: '🎨',
    kind: 'chat',
    blurb: 'Expand an idea into detailed visual, lighting and cinematic descriptors.',
    tools: 'none',
    temperature: 0.9,
    minCtx: 4096,
    accepts: ['file'],
    wants: { creative: 10, vision: 4, uncensored: 3 },
    prompt:
      `You are LlamaDesk Prompt Architect, a specialist at expanding a short idea into a rich prompt for image and video ` +
      `generation engines. Cover, in flowing comma-separated descriptors: subject and action; composition and framing ` +
      `(shot size, angle, lens); lighting (key, fill, practical, time of day); colour palette and grade; mood; texture and ` +
      `material detail; and rendering style or medium. Be concrete and visual — no abstractions, no meta-commentary. ` +
      `Unless the user asks otherwise, return exactly three variants labelled A, B and C, each a single paragraph, ` +
      `followed by one short negative-prompt line.`,
  },
  {
    id: 'tutor',
    label: 'Interactive Tutoring',
    icon: '🎓',
    kind: 'chat',
    blurb: 'Step-by-step STEM mentoring, interview practice, patient fact-checking.',
    tools: 'readonly',
    temperature: 0.4,
    minCtx: 8192,
    accepts: ['file', 'url'],
    wants: { reasoning: 10, longctx: 2, tools: 1 },
    prompt:
      `You are LlamaDesk Tutor — an infinitely patient, step-by-step mentor. Work problems one step at a time and state ` +
      `the reasoning for each step before giving the result. Define notation and symbols the first time they appear. ` +
      `When the user is wrong, identify the precise step that broke and why, rather than restating the whole solution. ` +
      `Check your own arithmetic and algebra before presenting an answer, and flag genuine uncertainty instead of bluffing. ` +
      `End with one short question that tests whether the idea landed.`,
  },
  {
    id: 'tts',
    label: 'Text to Speech',
    icon: '🔊',
    kind: 'tts',
    blurb: 'Speak or save text as audio using the offline Windows voices.',
    tools: 'none',
    temperature: 0,
    accepts: ['file', 'url'],
    wants: {},
    prompt: '',
  },
  {
    id: 'ocr',
    label: 'OCR',
    icon: '🔍',
    kind: 'ocr',
    blurb: 'Images and scanned PDFs → text, using a local vision model.',
    tools: 'none',
    temperature: 0,
    accepts: ['file'],
    wants: { vision: 10 },
    prompt: '',
  },
];

const BY_ID = Object.fromEntries(TASKS.map((t) => [t.id, t]));

function get(id) { return BY_ID[id] || BY_ID.code; }

// Shipped to the renderer for the tab strip — prompts stay in the main process.
function listForUi() {
  return TASKS.map(({ id, label, icon, kind, blurb, accepts, tools }) =>
    ({ id, label, icon, kind, blurb, accepts, tools }));
}

module.exports = { TASKS, get, listForUi };
