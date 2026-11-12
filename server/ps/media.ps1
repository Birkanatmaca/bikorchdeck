# Bikorch Deck media + volume: every 2s prints one JSON line {media, vol, mute}. media is what is playing
# (Windows media session, Spotify preferred) or null; the cover image is saved to -Art when the track changes.
# Runs the command the agent writes into the -Cmd file (next / prev / toggle) and into the -VolCmd file
# (lines: "v 0..100" sets the master volume, "m 0|1" sets mute). Exits when the agent (-ParentPid) is gone.
# ASCII only (PowerShell 5.1).
param([Parameter(Mandatory)][string]$Art, [Parameter(Mandatory)][string]$Cmd, [string]$VolCmd = '', [int]$ParentPid = $PID)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(5000)) { throw 'timeout' }
  $task.Result
}

[void][Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

# Master volume of the default playback device (Core Audio). If this fails, vol is reported as null.
$audioOk = $true
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
public static class DeckAudio {
  static IAudioEndpointVolume Vol() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    IMMDevice dev; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static int Get() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return (int)Math.Round(v * 100); }
  public static void Set(int v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, v)) / 100f, Guid.Empty)); }
  public static bool Muted() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void Mute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
'@
} catch { $audioOk = $false; [Console]::Error.WriteLine("audio: $_") }

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$mgr = Await ($mgrType::RequestAsync()) $mgrType

function Get-Session {
  $all = @($mgr.GetSessions())
  $sp = $all | Where-Object { $_.SourceAppUserModelId -match 'spotify' } | Select-Object -First 1
  if ($sp) { return $sp }
  $mgr.GetCurrentSession()
}

function Save-Art($props) {
  if (-not $props.Thumbnail) { return $false }
  $ras = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  # PowerShell sees the WinRT stream as a plain COM object, so the extension method is called through reflection.
  $in = $asStream.Invoke($null, @($ras))
  $tmp = "$Art.tmp"
  $fs = [System.IO.File]::Create($tmp)
  try { $in.CopyTo($fs) } finally { $fs.Dispose(); $in.Dispose() }
  if ((Get-Item $tmp).Length -lt 100) { Remove-Item $tmp; return $false }
  Move-Item -Force $tmp $Art
  $true
}

$artKey = ''   # track whose cover is currently on disk
$artSeq = 0
function Get-Media {
  $s = Get-Session
  if (-not $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $key = "$($p.Title)|$($p.Artist)"
  if ($key -ne $script:artKey) {
    # The cover can arrive a moment after the title; keep trying until it is saved.
    $ok = $false
    try { $ok = Save-Art $p } catch { }
    if ($ok) { $script:artKey = $key; $script:artSeq++ }
  }
  @{
    app = ($s.SourceAppUserModelId -replace '\.exe$', '' -replace '^.*[!_]', '')
    title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle
    playing = ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Playing')
    art = $(if ($script:artKey -eq $key) { $script:artSeq } else { 0 })
  }
}
function Emit {
  $o = @{ media = $null; vol = $null; mute = $false }
  try { $o.media = Get-Media } catch { [Console]::Error.WriteLine("media: $_") }
  if ($audioOk) { try { $o.vol = [DeckAudio]::Get(); $o.mute = [DeckAudio]::Muted() } catch { } }
  $o | ConvertTo-Json -Compress -Depth 3
}

$tick = 0
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  if (Test-Path -LiteralPath $Cmd) {
    $c = ''
    try { $c = (Get-Content -LiteralPath $Cmd -Raw).Trim(); Remove-Item -LiteralPath $Cmd -Force } catch { }
    try {
      $s = Get-Session
      if ($s) {
        if ($c -eq 'next') { [void](Await ($s.TrySkipNextAsync()) ([bool])) }
        elseif ($c -eq 'prev') { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) }
        elseif ($c -eq 'toggle') { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
      }
    } catch { [Console]::Error.WriteLine("cmd: $_") }
    $tick = 6   # report the new state shortly after the command
  }
  if ($VolCmd -and $audioOk -and (Test-Path -LiteralPath $VolCmd)) {
    $c = ''
    try { $c = (Get-Content -LiteralPath $VolCmd -Raw).Trim(); Remove-Item -LiteralPath $VolCmd -Force } catch { }
    try {
      foreach ($l in ($c -split "`n")) {
        if ($l.Trim() -match '^v (\d{1,3})$') { [DeckAudio]::Set([int]$Matches[1]) }
        elseif ($l.Trim() -match '^m ([01])$') { [DeckAudio]::Mute($Matches[1] -eq '1') }
      }
    } catch { [Console]::Error.WriteLine("vol: $_") }
    $tick = 7
  }
  if ($tick % 8 -eq 0) {
    try { Emit } catch { [Console]::Error.WriteLine("emit: $_") }
  }
  $tick++
  Start-Sleep -Milliseconds 250
}
