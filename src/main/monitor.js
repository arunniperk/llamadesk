'use strict';
// System telemetry: CPU (in-process), RAM (os), GPU utilization + VRAM via a
// persistent PowerShell child that emits one JSON line per second.
const os = require('os');
const { spawn } = require('child_process');

const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$total = 0
Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -Name HardwareInformation.qwMemorySize |
  ForEach-Object { $v = $_.'HardwareInformation.qwMemorySize'; if ($v -gt $total) { $total = $v } }
while ($true) {
  $util = 0; $vram = 0
  $g = Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage','\\GPU Engine(*engtype_Compute*)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue
  if ($g) {
    foreach ($s in $g.CounterSamples) {
      if ($s.Path -like '*utilization percentage*') { $util += $s.CookedValue }
      elseif ($s.Path -like '*dedicated usage*') { $vram += $s.CookedValue }
    }
  }
  $o = @{ gpu = [math]::Round([math]::Min(100, $util), 1); vramUsed = [int64]$vram; vramTotal = [int64]$total } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($o)
  Start-Sleep -Milliseconds 950
}`;

class Monitor {
  constructor() {
    this.gpu = { gpu: 0, vramUsed: 0, vramTotal: 0 };
    this.tokps = 0;
    this.prevCpu = os.cpus();
    this.child = null;
    this.timer = null;
    this.listeners = new Set();
  }

  start() {
    if (this.timer) return;
    try {
      this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let buf = '';
      this.child.stdout.on('data', (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try { this.gpu = JSON.parse(line); } catch { /* partial line */ }
        }
      });
      this.child.on('error', () => { this.child = null; });
    } catch { this.child = null; }

    this.timer = setInterval(() => {
      const cur = os.cpus();
      let idle = 0, total = 0;
      for (let i = 0; i < cur.length; i++) {
        const p = this.prevCpu[i].times, c = cur[i].times;
        const dIdle = c.idle - p.idle;
        const dTotal = (c.user - p.user) + (c.nice - p.nice) + (c.sys - p.sys) + (c.irq - p.irq) + dIdle;
        idle += dIdle; total += dTotal;
      }
      this.prevCpu = cur;
      const stats = {
        cpu: total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0,
        ramUsed: os.totalmem() - os.freemem(),
        ramTotal: os.totalmem(),
        gpu: this.gpu.gpu || 0,
        vramUsed: this.gpu.vramUsed || 0,
        vramTotal: this.gpu.vramTotal || 0,
        tokps: this.tokps,
      };
      for (const fn of this.listeners) fn(stats);
    }, 1000);
  }

  setTokps(v) { this.tokps = v; }

  onStats(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.child) { try { this.child.kill(); } catch { /* already dead */ } }
    this.child = null;
  }
}

module.exports = new Monitor();
