param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$ToX,
  [Parameter(Mandatory = $true)][int]$ToY,
  [string]$OutPng = "",
  [int]$WaitMs = 900,
  [int]$Steps = 12
)

# Drag in the Umoupen window and take a picture of it.
#
# The points are given in the pixels of the window, so it does not matter
# where the window sits on the screen. The pointer walks from the first point
# to the second one in steps, the way a hand does, so the program sees a drag
# and not a jump.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Drag {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr found = IntPtr.Zero;
  public static long foundArea = 0;
  public static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    int len = GetWindowTextLength(h);
    if (len == 0) return true;
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    if (sb.ToString().IndexOf("Umoupen", StringComparison.OrdinalIgnoreCase) < 0) return true;
    RECT r; GetWindowRect(h, out r);
    long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
    if (area > foundArea) { found = h; foundArea = area; }
    return true;
  }
  public static IntPtr Find() {
    found = IntPtr.Zero; foundArea = 0;
    EnumWindows(Cb, IntPtr.Zero);
    return found;
  }
  public static void DragTo(int x1, int y1, int x2, int y2, int steps) {
    SetCursorPos(x1, y1);
    System.Threading.Thread.Sleep(200);
    mouse_event(0x0002u, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(120);
    for (int i = 1; i <= steps; i++) {
      int x = x1 + (x2 - x1) * i / steps;
      int y = y1 + (y2 - y1) * i / steps;
      SetCursorPos(x, y);
      System.Threading.Thread.Sleep(30);
    }
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0004u, 0, 0, 0, IntPtr.Zero);
  }
}
'@
if (-not ("Drag" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
Add-Type -AssemblyName System.Drawing

$win = [Drag]::Find()
if ($win -eq [IntPtr]::Zero) { Write-Error "the Umoupen window was not found"; exit 1 }
$r = New-Object Drag+RECT
[void][Drag]::GetWindowRect($win, [ref]$r)
[void][Drag]::SetForegroundWindow($win)
Start-Sleep -Milliseconds 250

[Drag]::DragTo($r.Left + $X, $r.Top + $Y, $r.Left + $ToX, $r.Top + $ToY, $Steps)
Start-Sleep -Milliseconds $WaitMs

$r = New-Object Drag+RECT
[void][Drag]::GetWindowRect($win, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [Drag]::PrintWindow($win, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if ($OutPng -ne "") {
  $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "dragged $X,$Y -> $ToX,$ToY : $OutPng (${w}x${h})"
} else {
  $bmp.Dispose()
  Write-Output "dragged $X,$Y -> $ToX,$ToY"
}
