// does: Why is my computer slow / full? Disk space per drive, memory, the programs using the most memory and CPU, startup apps, uptime, battery, and the biggest space users in their folders. Read-only.
// args: {}
// Why a tool: answering "why is my laptop slow" otherwise takes 6-10 separate commands.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const lines = [];
const up = os.uptime();
lines.push(`Uptime: ${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h${up > 7 * 86400 ? '  (a restart often helps after a week+)' : ''}`);
lines.push(`Memory: ${gb(os.totalmem() - os.freemem())} of ${gb(os.totalmem())} in use (${Math.round((1 - os.freemem() / os.totalmem()) * 100)}%)`);
lines.push(`CPU: ${os.cpus()[0]?.model?.trim()} x${os.cpus().length}`);

if (process.platform === 'win32') {
  const ps = String.raw`
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | % { "DISK {0} {1:N1} GB free of {2:N1} GB" -f $_.DeviceID, ($_.FreeSpace/1GB), ($_.Size/1GB) }
Get-Process | Group-Object ProcessName | % { [pscustomobject]@{ n=$_.Name; m=($_.Group | Measure-Object WorkingSet64 -Sum).Sum; c=($_.Group | Measure-Object CPU -Sum).Sum; k=$_.Count } } | Sort-Object m -Descending | Select -First 8 | % { "MEM {0} {1:N0} MB ({2} process{3})" -f $_.n, ($_.m/1MB), $_.k, $(if($_.k -gt 1){'es'}else{''}) }
$c1 = Get-Process | Select Id,ProcessName,CPU; Start-Sleep -Milliseconds 1500; $c2 = Get-Process | Select Id,ProcessName,CPU
$d = foreach($p in $c2){ $o = $c1 | ? Id -eq $p.Id; if($o -and $p.CPU){ [pscustomobject]@{ n=$p.ProcessName; d=($p.CPU - $o.CPU) } } }
$d | Group-Object n | % { [pscustomobject]@{ n=$_.Name; d=($_.Group | Measure-Object d -Sum).Sum } } | Sort-Object d -Descending | Select -First 5 | ? { $_.d -gt 0.05 } | % { "CPU {0} {1:N0}% of one core" -f $_.n, ($_.d/1.5*100) }
Get-CimInstance Win32_StartupCommand | % { "START " + $_.Name }
$b = Get-CimInstance Win32_Battery; if($b){ "BATTERY {0}% {1}" -f $b.EstimatedChargeRemaining, $(if($b.BatteryStatus -eq 2){'charging'}else{'on battery'}) }
$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$rb = Get-PSDrive -PSProvider FileSystem | % { Get-ChildItem (Join-Path $_.Root ('$Recycle.Bin\' + $sid)) -Recurse -File -Force } | Measure-Object Length -Sum; "RECYCLE {0:N1} GB" -f ($rb.Sum/1GB)
"TEMP {0:N1} GB" -f ((Get-ChildItem $env:TEMP -Recurse -File -Force | Measure-Object Length -Sum).Sum/1GB)
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { 'REBOOT pending (updates are waiting for a restart)' }
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  if (process.env.STEAD_DEBUG) console.error(r.stderr, r.error);
  const out = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  const pick = (k) => out.filter((l) => l.startsWith(k + ' ')).map((l) => l.slice(k.length + 1));
  lines.push(...pick('DISK').map((d) => `Disk ${d}${/^\S+ ([\d.]+) GB free of ([\d.,]+)/.test(d) && parseFloat(RegExp.$1) < parseFloat(RegExp.$2.replace(/,/g, '')) * 0.1 ? '  (LOW: under 10% free slows Windows down)' : ''}`));
  lines.push('Using the most memory:', ...pick('MEM').map((l) => `  ${l}`));
  const cpu = pick('CPU');
  lines.push(cpu.length ? 'Busiest right now:' : 'CPU: nothing busy right now.', ...cpu.map((l) => `  ${l}`));
  const st = pick('START');
  lines.push(`Startup apps (${st.length}): ${st.join(', ') || 'none'}`);
  lines.push(...pick('BATTERY').map((b) => `Battery: ${b}`), ...pick('REBOOT').map((b) => `Restart: ${b}`));
  lines.push(`Recycle Bin: ${pick('RECYCLE')[0] || '?'} · Temp files: ${pick('TEMP')[0] || '?'}`);
} else {
  const df = spawnSync('df', ['-h', os.homedir()], { encoding: 'utf8' }).stdout;
  lines.push(`Disk:\n${df}`);
  const top = spawnSync('/bin/sh', ['-c', 'ps -Ao comm,%mem,%cpu -m | head -9'], { encoding: 'utf8' }).stdout;
  lines.push(`Top processes:\n${top}`);
}

// The biggest things in their own folders (one level down), so "my disk is full" has an answer.
const sizes = [];
const deadline = Date.now() + 15000;
function du(p, depth = 0) {
  if (Date.now() > deadline) return 0;
  let s = 0;
  let ents;
  try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const q = path.join(p, e.name);
    try { s += e.isDirectory() ? (depth < 6 ? du(q, depth + 1) : 0) : e.isFile() ? fs.statSync(q).size : 0; } catch {}
  }
  return s;
}
for (const d of ['Downloads', 'Documents', 'Desktop', 'Pictures', 'Videos', 'Music']) {
  const p = path.join(os.homedir(), d);
  if (fs.existsSync(p)) sizes.push([d, du(p)]);
}
lines.push(`Your folders: ${sizes.sort((a, b) => b[1] - a[1]).map(([d, s]) => `${d} ${gb(s)}`).join(', ')}${Date.now() > deadline ? ' (partial: stopped at the time limit)' : ''}`);
console.log(lines.join('\n'));
