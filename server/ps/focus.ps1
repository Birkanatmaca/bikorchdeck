# DevDeck: bring a window to the foreground (called when it is tapped on the tablet).
param([long]$Hwnd)
Add-Type @"
using System; using System.Runtime.InteropServices;
namespace DevDeck { public class Focus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}}
"@
$h = [IntPtr]$Hwnd
if ([DevDeck.Focus]::IsIconic($h)) { [void][DevDeck.Focus]::ShowWindow($h, 9) }
# Alt tap: Windows only lets a background process take focus right after input.
[DevDeck.Focus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[DevDeck.Focus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][DevDeck.Focus]::SetForegroundWindow($h)
