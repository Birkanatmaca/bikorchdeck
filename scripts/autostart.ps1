# DevDeck: add/remove the Startup-folder shortcut that launches the agent hidden at Windows sign-in.
# ASCII only (Windows PowerShell 5.1). No admin rights needed.
param([switch]$Remove)
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'DevDeck.lnk'
if ($Remove) {
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Host "Otomatik baslatma kaldirildi." }
  else { Write-Host "Zaten kurulu degil." }
  exit 0
}
$vbs = Join-Path $PSScriptRoot 'devdeck-hidden.vbs'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + $vbs + '"'
$s.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$s.Description = 'DevDeck tablet paneli ajani'
$s.Save()
Write-Host "Otomatik baslatma kuruldu: $lnk"
