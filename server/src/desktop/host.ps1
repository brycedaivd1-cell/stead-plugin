# Long-lived desktop-control host. Reads one JSON request per line on stdin, writes one JSON
# reply per line on stdout. Desktop.cs is compiled once and cached next to the user's data.
param([string]$CacheDir = "$env:LOCALAPPDATA\stead")
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$src = Join-Path $PSScriptRoot 'Desktop.cs'
New-Item -ItemType Directory -Force $CacheDir | Out-Null
$hash = (Get-FileHash $src -Algorithm SHA1).Hash.Substring(0, 12)
$dll = Join-Path $CacheDir "Desktop-$hash.dll"
$refs = @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Drawing', 'System.Core', 'System.Windows.Forms') |
  ForEach-Object { [Reflection.Assembly]::LoadWithPartialName($_).Location }
if (Test-Path $dll) { Add-Type -Path $dll } else {
  Add-Type -Path $src -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library
  Add-Type -Path $dll
}

Add-Type -AssemblyName System.Windows.Forms

# Rich clipboard: HTML (CF_HTML with its byte-offset header) plus plain text, so pasting into
# Google Docs, Gmail, Word, Outlook keeps real headings, bullets and bold.
function Set-RichClipboard([string]$html, [string]$text) {
  $d = New-Object System.Windows.Forms.DataObject
  if ($html) {
    $enc = [Text.Encoding]::UTF8
    $open = '<html><body><!--StartFragment-->'; $close = '<!--EndFragment--></body></html>'
    $fmt = "Version:0.9`r`nStartHTML:{0:D10}`r`nEndHTML:{1:D10}`r`nStartFragment:{2:D10}`r`nEndFragment:{3:D10}`r`n"
    $hl = ($fmt -f 0, 0, 0, 0).Length
    $sf = $hl + $enc.GetByteCount($open); $ef = $sf + $enc.GetByteCount($html); $eh = $ef + $enc.GetByteCount($close)
    $d.SetData([System.Windows.Forms.DataFormats]::Html, (($fmt -f $hl, $eh, $sf, $ef) + $open + $html + $close))
  }
  $d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $(if ($text) { $text } else { $html -replace '<[^>]+>', '' }))
  [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)
}

# Start menu apps, for launching by name. Get-StartApps takes ~1 s and was run up to twice a launch:
# keep the list 10 minutes, and look again sooner only when a name isn't in it (just installed).
$script:apps = $null; $script:appsAt = [datetime]::MinValue
function Start-Apps { if (-not $script:apps -or ((Get-Date) - $script:appsAt).TotalSeconds -gt 600) { $script:apps = @(Get-StartApps); $script:appsAt = Get-Date }; $script:apps }
function Find-App([string]$name) {
  $like = '*' + [Management.Automation.WildcardPattern]::Escape($name) + '*' # "[" or "*" in a name is just a letter
  for ($try = 0; $try -lt 2; $try++) {
    $list = Start-Apps
    $app = $list | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if (-not $app) { $app = $list | Where-Object { $_.Name -like $like } | Select-Object -First 1 }
    if ($app -or ((Get-Date) - $script:appsAt).TotalSeconds -lt 30) { return $app }
    $script:apps = $null
  }
}

# Text in pictures (Windows OCR, through WinRT): windows that draw their own UI (games, canvases,
# remote desktops) and scanned PDF pages. Loaded on first use; Windows 10+ ships the engine.
$script:ocr = $null
function Init-Ocr {
  if ($script:ocr) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  foreach ($t in 'Windows.Media.Ocr.OcrEngine,Windows.Foundation', 'Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation', 'Windows.Storage.StorageFile,Windows.Storage',
    'Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams', 'Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf') { $null = [type]"$t,ContentType=WindowsRuntime" }
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
  $script:asOp = $m | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $script:asAct = $m | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
  $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $e) { throw 'Windows has no text-recognition (OCR) language installed. Settings > Time & language > Language: add one with "Optical character recognition".' }
  $script:ocr = $e
}
function Await($op, [type]$t) { $k = $script:asOp.MakeGenericMethod($t).Invoke($null, @($op)); [void]$k.Wait(30000); $k.Result }
function Await-Action($op) { $k = $script:asAct.Invoke($null, @($op)); [void]$k.Wait(30000) }
# Lines of text with their screen rectangles: screen = origin + pixel / scale.
function Ocr-Stream($stream, [double]$scale, [int]$ox, [int]$oy) {
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($script:ocr.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  foreach ($l in $res.Lines) {
    $x = 1e9; $y = 1e9; $x2 = 0; $y2 = 0
    foreach ($wd in $l.Words) { $r = $wd.BoundingRect; $x = [Math]::Min($x, $r.X); $y = [Math]::Min($y, $r.Y); $x2 = [Math]::Max($x2, $r.X + $r.Width); $y2 = [Math]::Max($y2, $r.Y + $r.Height) }
    @{ text = $l.Text; x = [int]($ox + $x / $scale); y = [int]($oy + $y / $scale); w = [int](($x2 - $x) / $scale); h = [int](($y2 - $y) / $scale) }
  }
}
function Ocr-Window([long]$hwnd, $a) {
  Init-Ocr
  $s = [Desktop]::Png($hwnd, [int]$a.rx, [int]$a.ry, [int]$a.rw, [int]$a.rh)
  $ms = New-Object System.IO.MemoryStream (, [Convert]::FromBase64String($s.b64))
  Ocr-Stream ([System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)) $s.scale $s.originX $s.originY
}
# The text of PDF pages that are pictures (scans): each page drawn by Windows' own PDF renderer, then read.
function Ocr-Pdf([string]$path, $pages) {
  Init-Ocr
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $out = @{}
  foreach ($p in @($pages)) {
    $n = [int]$p
    if ($n -lt 1 -or $n -gt $doc.PageCount) { continue }
    $page = $doc.GetPage($n - 1)
    try {
      $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      $opt.DestinationWidth = [uint32]1800 # ~200 dpi for a letter page: small print stays readable
      $ms = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      Await-Action ($page.RenderToStreamAsync($ms, $opt))
      $out["$n"] = (@(Ocr-Stream $ms 1 0 0) | ForEach-Object { $_.text }) -join "`n"
    } finally { $page.Dispose() }
  }
  $out
}

function Reply($id, $ok, $payload) {
  $o = if ($ok) { @{ id = $id; ok = $true; result = $payload } } else { @{ id = $id; ok = $false; error = "$payload" } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Depth 6 -Compress))
  [Console]::Out.Flush()
}

Reply 0 $true 'ready'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    # Inside the try: one garbled line gets an error reply instead of killing the host.
    $req = $line | ConvertFrom-Json
    $a = $req.args
    $r = switch ($req.op) {
      'windows'    { [Desktop]::Windows() }
      'focus'      { [Desktop]::Focus([long]$a.hwnd) }
      'screenshot' { [Desktop]::Screenshot([long]$a.hwnd, [int]$a.maxW, [bool]$a.all, [int]$a.rx, [int]$a.ry, [int]$a.rw, [int]$a.rh) }
      'drag'       { [Desktop]::Drag([int]$a.x, [int]$a.y, [int]$a.toX, [int]$a.toY, [long]$a.hwnd); 'dragged' }
      'move'       { [Desktop]::MoveMouse([int]$a.x, [int]$a.y); 'moved' }
      'click'      { [Desktop]::Click([int]$a.x, [int]$a.y, [string]$a.button, [int]$a.count, [long]$a.hwnd); 'clicked' }
      'at'         { [Desktop]::At([int]$a.x, [int]$a.y) }
      'scroll'     { [Desktop]::Scroll([int]$a.x, [int]$a.y, [int]$a.clicks); 'scrolled' }
      'type'       { [Desktop]::TypeText([string]$a.text); 'typed' }
      'keys'       { [Desktop]::Keys([string]$a.combo); 'pressed' }
      'tree'       { [Desktop]::Tree([long]$a.hwnd, [int]$a.depth, [int]$a.max, [string]$a.id) }
      'idle'       { [Desktop]::IdleMs() }
      'settle'     { [Desktop]::SettleInput([long]$a.hwnd, [int]$a.ms); 'settled' }
      'wait'       { [Desktop]::WaitFor([long]$a.hwnd, [string]$a.name, [bool]$a.gone, [int]$a.ms) }
      'ocr'        { , @(Ocr-Window ([long]$a.hwnd) $a) }
      'ocr_pdf'    { Ocr-Pdf ([string]$a.path) $a.pages }
      'input_blocked' { [Desktop]::InputBlocked() }
      'paste_text' { [Desktop]::PasteText([string]$a.text); 'pasted' }
      'find'       { [Desktop]::Find([long]$a.hwnd, [string]$a.text, [int]$a.limit, [int]$a.budget) }
      'act'        { [Desktop]::Act([string]$a.id, [string]$a.action, [string]$a.value, [bool]$a.strict) }
      'act_name'   { [Desktop]::ActByName([long]$a.hwnd, [string]$a.name, [string]$a.type, [int]$a.index, [string]$a.action, [string]$a.value, [bool]$a.strict) }
      'text'       { [Desktop]::ReadText([string]$a.id, [long]$a.hwnd, [int]$a.max) }
      'focus_for'  { [Desktop]::FocusFor([string]$a.id, [long]$a.hwnd) }
      'blocker'    { [Desktop]::Blocker([long]$a.hwnd) }
      'window'     { [Desktop]::WindowAction([long]$a.hwnd, [string]$a.action) }
      'clipboard_read' {
        $o = @{ text = [System.Windows.Forms.Clipboard]::GetText() }
        if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { $o.files = @([System.Windows.Forms.Clipboard]::GetFileDropList()) }
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $o.image = $true }
        $o
      }
      'apps'       { $like = '*' + [Management.Automation.WildcardPattern]::Escape([string]$a.name) + '*'; @(Start-Apps | Where-Object { $_.Name -like $like } | Select-Object -First 8 Name, AppID) }
      'launch'     {
        $app = Find-App ([string]$a.name)
        if ($app) { Start-Process "explorer.exe" "shell:AppsFolder\$($app.AppID)"; "launched $($app.Name)" }
        # Anything else runs as a command (cmd, regedit, a path): only once they've said yes.
        elseif ($a.raw) { Start-Process -FilePath ([string]$a.name) -ErrorAction Stop; 'launched' }
        else { 'nomatch' }
      }
      'clipboard'  { Set-RichClipboard ([string]$a.html) ([string]$a.text); 'clipboard set' }
      'open'       { Start-Process -FilePath ([string]$a.path) -ErrorAction Stop; 'opened' }
      default      { throw "unknown op $($req.op)" }
    }
    Reply $req.id $true $r
  } catch {
    $m = $_.Exception.InnerException; if (-not $m) { $m = $_.Exception }
    Reply $(if ($req) { $req.id } else { $null }) $false $m.Message
  }
}
