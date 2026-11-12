# DevDeck collector: emits one JSON line every 2s (windows, processes, network, disks).
# ASCII only - Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices;
namespace DevDeck { public class Native {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}}
"@
$cores = [Environment]::ProcessorCount
$prev = @{}; $prevT = [DateTime]::UtcNow; $prevNet = $null; $tick = 0; $disks = @()

while ($true) {
  if ($ParentPid -and -not (Get-Process -Id $ParentPid)) { exit }
  $now = [DateTime]::UtcNow
  $dt = ($now - $prevT).TotalSeconds; if ($dt -le 0) { $dt = 1 }
  $prevT = $now
  $fg = [DevDeck.Native]::GetForegroundWindow().ToInt64()

  $cur = @{}; $agg = @{}; $wins = New-Object System.Collections.ArrayList
  foreach ($p in Get-Process) {
    if ($p.Id -eq 0) { continue }
    $c = $p.TotalProcessorTime.TotalSeconds
    if ($null -eq $c) { $c = 0.0 }
    $cur[$p.Id] = $c
    $d = 0.0
    if ($prev.ContainsKey($p.Id)) { $d = [Math]::Max(0.0, $c - $prev[$p.Id]) }
    $a = $agg[$p.ProcessName]
    if (-not $a) { $a = @{ name = $p.ProcessName; cpu = 0.0; mem = [long]0; n = 0 }; $agg[$p.ProcessName] = $a }
    $a.cpu += $d; $a.mem += $p.WorkingSet64; $a.n++
    if ($p.MainWindowTitle) {
      $h = $p.MainWindowHandle.ToInt64()
      [void]$wins.Add(@{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle; hwnd = $h; active = ($h -eq $fg) })
    }
  }
  $prev = $cur

  $procs = @($agg.Values | Sort-Object { $_.cpu } -Descending | Select-Object -First 10 | ForEach-Object {
    @{ name = $_.name; n = $_.n; cpu = [Math]::Round($_.cpu / $dt / $cores * 100, 1); mem = [Math]::Round($_.mem / 1MB) }
  })
  $memTop = @($agg.Values | Sort-Object { $_.mem } -Descending | Select-Object -First 5 | ForEach-Object {
    @{ name = $_.name; n = $_.n; mem = [Math]::Round($_.mem / 1MB) }
  })

  $rx = [long]0; $tx = [long]0
  foreach ($s in Get-NetAdapterStatistics) { $rx += $s.ReceivedBytes; $tx += $s.SentBytes }
  $net = @{ rx = 0; tx = 0 }
  if ($prevNet) {
    $net.rx = [Math]::Max(0, [Math]::Round(($rx - $prevNet.rx) / $dt))
    $net.tx = [Math]::Max(0, [Math]::Round(($tx - $prevNet.tx) / $dt))
  }
  $prevNet = @{ rx = $rx; tx = $tx }

  if ($tick % 15 -eq 0) {
    $disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
      @{ name = $_.DeviceID; total = [long]$_.Size; free = [long]$_.FreeSpace }
    })
  }
  $tick++

  $out = @{ windows = @($wins); procs = $procs; memTop = $memTop; net = $net; disks = $disks } |
    ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($out); [Console]::Out.Flush()
  Start-Sleep -Milliseconds 2000
}
