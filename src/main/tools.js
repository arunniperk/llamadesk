'use strict';
// Built-in tools for Desktop Agent and Coding Agent modes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MAX_OUT = 24000;
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…(truncated, ${s.length} chars total)` : s);

function runPowershell(command, cwd, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: cwd || os.homedir(), windowsHide: true,
    });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* dead */ } }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve(clip(`exit code: ${code}\n${out}${err ? '\nSTDERR:\n' + err : ''}`));
    });
    p.on('error', (e) => { clearTimeout(timer); resolve('Failed to start PowerShell: ' + e.message); });
  });
}

const DEFS = [
  {
    type: 'function',
    function: {
      name: 'run_powershell',
      description: 'Run a PowerShell command on this Windows 11 machine and return stdout/stderr and exit code. Use for shell tasks, launching apps, system queries, git, npm, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'PowerShell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file and return its content (truncated at 24k chars).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute file path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write text content to a file, creating parent directories as needed. Overwrites existing content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact text snippet in a file. The find string must appear in the file; all occurrences are replaced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string', description: 'Exact text to find' },
          replace: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders at a path with sizes.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute directory path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL over HTTP(S) and return the response body as text (truncated at 24k chars).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
];

async function call(name, args) {
  try {
    switch (name) {
      case 'run_powershell':
        return await runPowershell(args.command, args.cwd);
      case 'read_file':
        return clip(fs.readFileSync(args.path, 'utf8'));
      case 'write_file':
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
        fs.writeFileSync(args.path, args.content);
        return `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`;
      case 'edit_file': {
        const src = fs.readFileSync(args.path, 'utf8');
        if (!src.includes(args.find)) return 'TOOL ERROR: find string not present in file.';
        const count = src.split(args.find).length - 1;
        fs.writeFileSync(args.path, src.split(args.find).join(args.replace));
        return `Replaced ${count} occurrence(s) in ${args.path}`;
      }
      case 'list_directory': {
        const entries = fs.readdirSync(args.path, { withFileTypes: true }).map((e) => {
          let size = '';
          if (e.isFile()) { try { size = ' (' + fs.statSync(path.join(args.path, e.name)).size + ' B)'; } catch { /* gone */ } }
          return (e.isDirectory() ? '[dir] ' : '      ') + e.name + size;
        });
        return clip(entries.join('\n') || '(empty)');
      }
      case 'fetch_url': {
        const res = await fetch(args.url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'LlamaDesk/1.0' } });
        return clip(`HTTP ${res.status}\n` + (await res.text()));
      }
      default:
        return `TOOL ERROR: unknown tool ${name}`;
    }
  } catch (err) {
    return 'TOOL ERROR: ' + String(err.message || err);
  }
}

module.exports = { DEFS, call };
