'use strict';
// Minimal MCP client (stdio transport, newline-delimited JSON-RPC).
// Lets the agent modes use Claude Desktop-style extensions: Filesystem,
// Desktop Commander, PDF tools, or anything from claude_desktop_config.json.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROTOCOL_VERSION = '2024-11-05';

class McpClient {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.status = 'stopped'; // stopped | starting | ready | error
    this.error = null;
  }

  async start() {
    if (this.status === 'ready' || this.status === 'starting') return;
    this.status = 'starting';
    this.error = null;
    try {
      const cmdLine = [this.cfg.command, ...(this.cfg.args || [])]
        .map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
      // shell:cmd so that npx / uvx shims resolve on Windows
      this.proc = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.cfg.env || {}) },
      });
      let buf = '';
      this.proc.stdout.on('data', (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
              const { resolve, reject } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result);
            }
          } catch { /* non-JSON output on stdout — ignore */ }
        }
      });
      this.proc.stderr.on('data', () => { /* server logs — ignore */ });
      this.proc.on('exit', () => {
        this.status = this.status === 'ready' ? 'stopped' : 'error';
        if (!this.error && this.status === 'error') this.error = 'process exited during startup';
        for (const { reject } of this.pending.values()) reject(new Error('MCP server exited'));
        this.pending.clear();
        this.proc = null;
      });

      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'LlamaDesk', version: '1.0.0' },
      }, 30000);
      this.notify('notifications/initialized', {});
      const res = await this.request('tools/list', {}, 30000);
      this.tools = res.tools || [];
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.error = String(err.message || err);
      this.stop();
      throw err;
    }
  }

  request(method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('MCP server not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    if (this.proc) this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args || {} });
    const parts = (res.content || []).map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return `[image ${c.mimeType}]`;
      return JSON.stringify(c);
    });
    const text = parts.join('\n');
    return res.isError ? `TOOL ERROR: ${text}` : text;
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* already dead */ } }
    this.proc = null;
    if (this.status !== 'error') this.status = 'stopped';
  }
}

class McpManager {
  constructor() { this.clients = new Map(); }

  sync(serversCfg) {
    // drop removed
    for (const [name, client] of this.clients) {
      if (!serversCfg[name]) { client.stop(); this.clients.delete(name); }
    }
    for (const [name, cfg] of Object.entries(serversCfg)) {
      if (!this.clients.has(name)) this.clients.set(name, new McpClient(name, cfg));
      else this.clients.get(name).cfg = cfg;
    }
  }

  async startEnabled(serversCfg) {
    this.sync(serversCfg);
    const results = [];
    for (const [name, cfg] of Object.entries(serversCfg)) {
      const client = this.clients.get(name);
      if (cfg.enabled) {
        try { await client.start(); results.push({ name, ok: true, tools: client.tools.length }); }
        catch (e) { results.push({ name, ok: false, error: String(e.message || e) }); }
      } else {
        client.stop();
      }
    }
    return results;
  }

  status() {
    return [...this.clients.entries()].map(([name, c]) => ({
      name, status: c.status, error: c.error, tools: c.tools.map((t) => t.name),
      command: [c.cfg.command, ...(c.cfg.args || [])].join(' '), enabled: !!c.cfg.enabled,
    }));
  }

  // OpenAI-format tool definitions, namespaced mcp__<server>__<tool>
  toolDefs() {
    const defs = [];
    for (const [name, c] of this.clients) {
      if (c.status !== 'ready') continue;
      for (const t of c.tools) {
        defs.push({
          type: 'function',
          function: {
            name: `mcp__${name}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
            description: `[${name}] ${t.description || t.name}`.slice(0, 1024),
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
          _server: name,
          _tool: t.name,
        });
      }
    }
    return defs;
  }

  async call(fullName, args) {
    const m = fullName.match(/^mcp__(.+?)__(.+)$/);
    if (!m) throw new Error('Not an MCP tool: ' + fullName);
    const client = this.clients.get(m[1]);
    if (!client || client.status !== 'ready') throw new Error(`MCP server "${m[1]}" is not running`);
    // resolve original tool name (may have been sanitized)
    const tool = client.tools.find((t) => t.name === m[2] || t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === m[2]);
    return client.callTool(tool ? tool.name : m[2], args);
  }

  stopAll() { for (const c of this.clients.values()) c.stop(); }
}

function importClaudeDesktopConfig() {
  const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (!fs.existsSync(p)) throw new Error('Claude Desktop config not found at ' + p);
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const servers = {};
  for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
    if (!s.command) continue;
    servers[name] = { command: s.command, args: s.args || [], env: s.env || {}, enabled: false };
  }
  return servers;
}

module.exports = { manager: new McpManager(), importClaudeDesktopConfig };
