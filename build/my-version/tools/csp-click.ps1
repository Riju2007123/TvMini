param(
  [int]$X = -1,
  [int]$Y = -1,
  [string]$OutPng = "",
  [int]$WaitMs = 900,
  [switch]$DoubleClick,
  [switch]$Right,
  [string]$Keys = ""
)

# Click a point of the Clip Studio Paint window and take a picture of it.
#
# The point is given in the pixels of the window, so it does not matter where
# the window sits on the screen. With no point the window is only photographed.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CspClick {
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
    if (sb.ToString().IndexOf("CLIP STUDIO", StringComparison.OrdinalIgnoreCase) < 0) return true;
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
  public static void ClickAt(int x, int y, bool twice, bool right) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    uint down = right ? 0x0008u : 0x0002u;
    uint up = right ? 0x0010u : 0x0004u;
    mouse_event(down, 0, 0, 0, IntPtr.Zero);
    mouse_event(up, 0, 0, 0, IntPtr.Zero);
    if (twice) {
      System.Threading.Thread.Sleep(60);
      mouse_event(down, 0, 0, 0, IntPtr.Zero);
      mouse_event(up, 0, 0, 0, IntPtr.Zero);
    }
  }
}
'@
if (-not ("CspClick" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$win = [CspClick]::Find()
if ($win -eq [IntPtr]::Zero) { Write-Error "the Clip Studio Paint window was not found"; exit 1 }
$r = New-Object CspClick+RECT
[void][CspClick]::GetWindowRect($win, [ref]$r)
[void][CspClick]::SetForegroundWindow($win)
Start-Sleep -Milliseconds 250

if ($Keys -ne "") {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
} elseif ($X -ge 0) {
  [CspClick]::ClickAt($r.Left + $X, $r.Top + $Y, $DoubleClick.IsPresent, $Right.IsPresent)
}
Start-Sleep -Milliseconds $WaitMs

$r = New-Object CspClick+RECT
[void][CspClick]::GetWindowRect($win, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [CspClick]::PrintWindow($win, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if ($OutPng -ne "") {
  $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "the window is at $($r.Left),$($r.Top) and is ${w}x${h} -> $OutPng"
} else {
  $bmp.Dispose()
  Write-Output "the window is at $($r.Left),$($r.Top) and is ${w}x${h}"
}
