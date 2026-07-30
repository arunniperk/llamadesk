'use strict';
// Admin-mode support: detect elevation and relaunch the app elevated (UAC prompt).
const { execSync, spawn } = require('child_process');
const { app } = require('electron');

function isElevated() {
  try {
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function relaunchElevated() {
  const exe = process.execPath;
  const args = process.argv.slice(1).filter((a) => a !== '--relaunch-elevated');
  const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const ps = argList.length
    ? `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${argList} -Verb RunAs`
    : `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs`;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
  setTimeout(() => app.quit(), 300);
}

module.exports = { isElevated, relaunchElevated };
