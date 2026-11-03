// does: Print a file to the printer they choose, silently: PDF, Word/Excel/PowerPoint, images, text/HTML. Or list printers (list: true). No print dialogs, nothing to install.
// args: {file: "C:/Users/me/Downloads/form.pdf", printer: "name (omit = default printer)", copies: 1, pages: "1-3,5", duplex: true, color: false, list: true, to_file: "save as PDF here instead (testing)"}
// Why a tool: "print this PDF" by hand is open it, find the print dialog, pick the printer, set copies,
// confirm, check the queue. Here it is one call. Windows renders PDFs with the built-in Windows.Data.Pdf
// and prints through the spooler; Office files go through Office if installed; anything a browser can
// show goes through Stead's Chrome. Mac/Linux use lp.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--(.+)$/);
  if (!m) continue;
  let v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) v = 'true'; else i++;
  try { args[m[1]] = JSON.parse(v); } catch { args[m[1]] = v; }
}
// toolbox_run also sends the exact args as JSON: Windows PowerShell strips the quotes inside the
// --name values above, so a list like ["~/School Work"] arrives broken there.
try { Object.assign(args, JSON.parse(process.env.STEAD_ARGS || '{}')); } catch {}
const out = (o) => { console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 1)); };
const fail = (m) => { console.log(m); process.exit(1); };
const WIN = process.platform === 'win32';

function ps(script, env) {
  const f = path.join(os.tmpdir(), `stead-print-${process.pid}.ps1`);
  fs.writeFileSync(f, '\ufeff' + script);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  fs.rmSync(f, { force: true });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.status === 0 ? '' : r.stderr || ''}`.trim() };
}

// "1-3,5" -> [1,2,3,5]
const pageList = (s) => String(s).split(',').flatMap((p) => {
  const [a, b] = p.split('-').map((n) => parseInt(n, 10));
  return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
}).filter((n) => n > 0);

// ---------- list ----------
if (args.list) {
  if (WIN) {
    const r = ps(`Get-Printer | ForEach-Object { $d = (Get-CimInstance Win32_Printer -Filter ("Name='" + $_.Name.Replace("'","''") + "'")); [pscustomobject]@{ name=$_.Name; default=[bool]$d.Default; status="$($_.PrinterStatus)"; offline=[bool]$d.WorkOffline; jobs=(Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue | Measure-Object).Count } } | ConvertTo-Json -Compress`);
    out(r.ok ? JSON.parse(r.out || '[]') : r.out);
  } else {
    out(spawnSync('lpstat', ['-p', '-d'], { encoding: 'utf8' }).stdout || 'no printers found');
  }
  process.exit(0);
}

if (!args.file) fail('Give file: the full path of what to print (or list: true to see printers).');
let file = path.resolve(String(args.file).replace(/^~(?=$|[\\/])/, os.homedir()));
if (!fs.existsSync(file)) fail(`No file at ${file}.`);
const ext = path.extname(file).toLowerCase();

// ---------- mac / linux ----------
if (!WIN) {
  const a = [...(args.printer ? ['-d', args.printer] : []), '-n', String(args.copies || 1)];
  if (args.pages) a.push('-P', String(args.pages));
  if (args.duplex) a.push('-o', 'sides=two-sided-long-edge');
  if (args.color === false) a.push('-o', 'ColorModel=Gray');
  const r = spawnSync('lp', [...a, file], { encoding: 'utf8' });
  if (r.status !== 0) fail(r.stderr || 'lp failed');
  out(`Sent ${path.basename(file)} to ${args.printer || 'the default printer'}. ${r.stdout.trim()}`);
  process.exit(0);
}

// ---------- windows: get everything to a PDF (or an image) first ----------
const tmp = path.join(os.tmpdir(), `stead-print-${Date.now()}.pdf`);
const OFFICE = {
  word: ['.doc', '.docx', '.rtf', '.odt'],
  excel: ['.xls', '.xlsx', '.xlsm', '.csv', '.ods'],
  powerpoint: ['.ppt', '.pptx', '.odp'],
};
const IMAGES = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff'];
const app = Object.keys(OFFICE).find((k) => OFFICE[k].includes(ext));
if (app) {
  const conv = {
    word: `$w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0; try { $d = $w.Documents.Open($env:SRC, $false, $true); $d.ExportAsFixedFormat($env:DST, 17); $d.Close(0) } finally { $w.Quit() }`,
    excel: `$x = New-Object -ComObject Excel.Application; $x.Visible = $false; $x.DisplayAlerts = $false; try { $b = $x.Workbooks.Open($env:SRC, 0, $true); $b.ExportAsFixedFormat(0, $env:DST); $b.Close($false) } finally { $x.Quit() }`,
    powerpoint: `$p = New-Object -ComObject PowerPoint.Application; try { $d = $p.Presentations.Open($env:SRC, $true, $false, $false); $d.SaveAs($env:DST, 32); $d.Close() } finally { $p.Quit() }`,
  }[app];
  const r = ps(`$ErrorActionPreference='Stop'; ${conv}`, { SRC: file, DST: tmp });
  if (!r.ok || !fs.existsSync(tmp)) fail(`Could not open it with Microsoft ${app[0].toUpperCase() + app.slice(1)} (is Office installed?): ${r.out.slice(0, 300)}`);
  file = tmp;
} else if (ext !== '.pdf' && !IMAGES.includes(ext)) {
  // Text, HTML, SVG, anything Chrome displays: render it in Stead's browser.
  try {
    const { chromium } = await import('playwright-core');
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.STEAD_PORT || 9222}`);
    const ctx = b.contexts()[0];
    const p = await ctx.newPage();
    await p.goto('file:///' + file.replace(/\\/g, '/'));
    const s = await ctx.newCDPSession(p);
    const r = await s.send('Page.printToPDF', { printBackground: true });
    fs.writeFileSync(tmp, Buffer.from(r.data, 'base64'));
    await p.close();
    await b.close();
    file = tmp;
  } catch (e) { fail(`Can't print a ${ext || 'file with no extension'} directly, and the Stead browser could not render it: ${e.message}`); }
}

// ---------- windows: render + print ----------
const PRINT = String.raw`
$ErrorActionPreference = 'Stop'
$a = $env:STEAD_ARGS | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$items = New-Object System.Collections.ArrayList
if ($a.file.ToLower().EndsWith('.pdf')) {
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $asOp = $m | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' } | select -First 1
  $asAct = $m | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | select -First 1
  function Await($op, [Type]$t) { $k = $asOp.MakeGenericMethod($t).Invoke($null, @($op)); [void]$k.Wait(-1); $k.Result }
  function AwaitAct($op) { $k = $asAct.Invoke($null, @($op)); [void]$k.Wait(-1) }
  $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($a.file)) ([Windows.Storage.StorageFile])
  $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($sf)) ([Windows.Data.Pdf.PdfDocument])
  $n = [int]$doc.PageCount
  $want = if ($a.pages) { @($a.pages) } else { 1..$n }
  foreach ($i in $want) {
    if ($i -lt 1 -or $i -gt $n) { continue }
    $pg = $doc.GetPage([uint32]($i - 1))
    $o = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $o.DestinationWidth = [uint32][math]::Round($pg.Size.Width * 300 / 96)
    $o.DestinationHeight = [uint32][math]::Round($pg.Size.Height * 300 / 96)
    $s = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAct ($pg.RenderToStreamAsync($s, $o))
    $img = [System.Drawing.Image]::FromStream([System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($s))
    [void]$items.Add(@{ img = $img; w = $pg.Size.Width / 96; h = $pg.Size.Height / 96 })
    $pg.Dispose()
  }
  if (-not $items.Count) { throw "No pages to print (the PDF has $n pages)." }
} else {
  $img = [System.Drawing.Image]::FromFile($a.file)
  [void]$items.Add(@{ img = $img; w = $img.Width / $img.HorizontalResolution; h = $img.Height / $img.VerticalResolution })
}
$pd = New-Object System.Drawing.Printing.PrintDocument
if ($a.printer) {
  $pd.PrinterSettings.PrinterName = $a.printer
  if (-not $pd.PrinterSettings.IsValid) { throw ("No printer named '" + $a.printer + "'. Printers: " + ((Get-Printer).Name -join ', ')) }
}
$pd.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$pd.DocumentName = $a.name
if ($a.copies) { $pd.PrinterSettings.Copies = [int16]$a.copies; $pd.PrinterSettings.Collate = $true }
if ($a.duplex -and $pd.PrinterSettings.CanDuplex) { $pd.PrinterSettings.Duplex = 'Vertical' }
if ($a.color -eq $false) { $pd.DefaultPageSettings.Color = $false }
if ($a.to_file) { $pd.PrinterSettings.PrintToFile = $true; $pd.PrinterSettings.PrintFileName = $a.to_file }
$script:i = 0
$pd.add_QueryPageSettings({ param($x, $e) $it = $items[$script:i]; $e.PageSettings.Landscape = ($it.w -gt $it.h) })
$pd.add_PrintPage({
  param($x, $e)
  $it = $items[$script:i]
  $b = $e.Graphics.VisibleClipBounds
  $w = $it.w * 100; $h = $it.h * 100
  $k = [math]::Min(1, [math]::Min($b.Width / $w, $b.Height / $h))
  $e.Graphics.InterpolationMode = 'HighQualityBicubic'
  $e.Graphics.DrawImage($it.img, [single]($b.X + ($b.Width - $w * $k) / 2), [single]($b.Y + ($b.Height - $h * $k) / 2), [single]($w * $k), [single]($h * $k))
  $script:i++
  $e.HasMorePages = ($script:i -lt $items.Count)
})
$pd.Print()
$name = $pd.PrinterSettings.PrinterName
$p = Get-CimInstance Win32_Printer -Filter ("Name='" + $name.Replace("'", "''") + "'")
[pscustomobject]@{ pages = $items.Count; printer = $name; copies = $pd.PrinterSettings.Copies; duplex = "$($pd.PrinterSettings.Duplex)"; offline = [bool]$p.WorkOffline; printerStatus = "$((Get-Printer -Name $name).PrinterStatus)"; queued = (Get-PrintJob -PrinterName $name -ErrorAction SilentlyContinue | Measure-Object).Count } | ConvertTo-Json -Compress
`;
const r = ps(PRINT, { STEAD_ARGS: JSON.stringify({ file, printer: args.printer || '', copies: args.copies || 1, pages: args.pages ? pageList(args.pages) : null, duplex: Boolean(args.duplex), color: args.color, to_file: args.to_file || '', name: path.basename(String(args.file)) }) });
if (file === tmp) fs.rmSync(tmp, { force: true });
if (!r.ok) fail(`Printing failed: ${r.out.split('\n').filter((l) => !/^\s*(At |\+|CategoryInfo|FullyQualified)/.test(l)).join(' ').slice(0, 500)}`);
const j = JSON.parse(r.out.split('\n').at(-1));
out(`Sent ${j.pages} page(s) of ${path.basename(String(args.file))} to ${j.printer}${j.copies > 1 ? `, ${j.copies} copies` : ''}${args.duplex ? `, duplex ${j.duplex}` : ''}.${j.offline ? ' WARNING: that printer is set to offline, so it will wait in the queue until it is back on.' : ''} Printer status: ${j.printerStatus}; jobs in its queue: ${j.queued}.`);
