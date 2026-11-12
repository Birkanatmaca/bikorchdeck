# DevDeck: save the icon of a running program (by process id) as a PNG, for the tablet dock.
# Exit code 2 = no usable icon (the tablet then shows the first letter). ASCII only (Windows PowerShell 5.1).
param([Parameter(Mandatory)][int]$ProcId, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
namespace DevDeck { public class Ico {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint count, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
} }
"@
try { $path = (Get-Process -Id $ProcId).Path } catch { exit 2 }
# ApplicationFrameHost only hosts Store apps; its own icon says nothing about the app inside.
if (-not $path -or $path -match 'ApplicationFrameHost\.exe$') { exit 2 }
$h = New-Object IntPtr[] 1
$ids = New-Object uint32[] 1
$n = [DevDeck.Ico]::PrivateExtractIcons($path, 0, 128, 128, $h, $ids, 1, 0)
if ($n -ge 1 -and $h[0] -ne [IntPtr]::Zero) {
  $bmp = [System.Drawing.Icon]::FromHandle($h[0]).ToBitmap()
  [void][DevDeck.Ico]::DestroyIcon($h[0])
} else {
  $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
  if (-not $ico) { exit 2 }
  $bmp = $ico.ToBitmap()
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
