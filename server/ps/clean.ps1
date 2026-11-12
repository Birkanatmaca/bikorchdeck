# DevDeck cleanup: -Mode scan reports what would be removed, -Mode clean removes it.
# Only fixed, regenerable cache locations are touched. ASCII only (Windows PowerShell 5.1).
param([string]$Mode = 'scan', [string]$Targets = '')
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$la = $env:LOCALAPPDATA
$globs = @(
  "$la\Google\Chrome\User Data\*\Cache\Cache_Data", "$la\Google\Chrome\User Data\*\Code Cache",
  "$la\Microsoft\Edge\User Data\*\Cache\Cache_Data", "$la\Microsoft\Edge\User Data\*\Code Cache",
  "$la\BraveSoftware\Brave-Browser\User Data\*\Cache\Cache_Data", "$la\BraveSoftware\Brave-Browser\User Data\*\Code Cache"
)
$defs = @{
  # temp: only files untouched for a day, so nothing a running program still needs.
  temp    = @{ paths = @($env:TEMP); days = 1 }
  browser = @{ paths = @($globs | ForEach-Object { Get-Item $_ -Force } | ForEach-Object { $_.FullName }); days = 0 }
  npm     = @{ paths = @("$la\npm-cache\_cacache"); days = 0 }
}

function Get-CacheFiles($d) {
  $limit = (Get-Date).AddDays(-$d.days)
  # Manual .NET walk: several times faster than Get-ChildItem -Recurse, skips unreadable folders,
  # and does not follow junctions/symlinks out of the cache folder.
  $stack = New-Object System.Collections.Stack
  foreach ($p in $d.paths) { if (Test-Path -LiteralPath $p) { $stack.Push((New-Object IO.DirectoryInfo $p)) } }
  while ($stack.Count) {
    $dir = $stack.Pop()
    try {
      foreach ($f in $dir.GetFiles()) { if ($d.days -le 0 -or $f.LastWriteTime -lt $limit) { $f } }
      foreach ($s in $dir.GetDirectories()) {
        if (-not ($s.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $stack.Push($s) }
      }
    } catch {}
  }
}

$res = foreach ($id in ($Targets -split ',' | Where-Object { $_ })) {
  $r = @{ id = $id; bytes = [long]0; count = 0; freed = [long]0; removed = 0 }
  if ($defs.ContainsKey($id)) {
    foreach ($f in Get-CacheFiles $defs[$id]) {
      $r.bytes += $f.Length; $r.count++
      if ($Mode -eq 'clean') {
        try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $r.freed += $f.Length; $r.removed++ } catch {}
      }
    }
  }
  elseif ($id -eq 'recycle') {
    foreach ($i in @((New-Object -ComObject Shell.Application).Namespace(10).Items())) { $r.bytes += [long]$i.Size; $r.count++ }
    if ($Mode -eq 'clean' -and $r.count -gt 0) {
      try { Clear-RecycleBin -Force -ErrorAction Stop; $r.freed = $r.bytes; $r.removed = $r.count } catch {}
    }
  }
  elseif ($id -eq 'dns') {
    $r.count = @(Get-DnsClientCache).Count
    if ($Mode -eq 'clean') { ipconfig /flushdns | Out-Null; $r.removed = $r.count }
  }
  $r
}
ConvertTo-Json -InputObject @($res) -Compress
