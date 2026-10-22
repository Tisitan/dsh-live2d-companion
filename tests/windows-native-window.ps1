param([long]$WindowHandle, [string]$Operation = 'inspect', [int]$X = 0, [int]$Y = 0)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This probe is restricted to disposable GitHub runners.' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
if ($Operation -eq 'click') {
  [void][WindowProbe]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 100
  [WindowProbe]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [WindowProbe]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
}
$extended = [WindowProbe]::GetWindowLongPtr([IntPtr]$WindowHandle, -20).ToInt64()
$rect = New-Object WindowProbe+Rect
[void][WindowProbe]::GetWindowRect([IntPtr]$WindowHandle, [ref]$rect)
@{
  handle = $WindowHandle
  extendedStyle = $extended
  noActivate = ($extended -band 0x08000000) -ne 0
  transparent = ($extended -band 0x20) -ne 0
  topmost = ($extended -band 0x8) -ne 0
  foreground = [WindowProbe]::GetForegroundWindow().ToInt64()
  dpi = [WindowProbe]::GetDpiForWindow([IntPtr]$WindowHandle)
  physicalBounds = @{ x = $rect.left; y = $rect.top; width = $rect.right - $rect.left; height = $rect.bottom - $rect.top }
} | ConvertTo-Json -Compress
