param(
  [int]$X = -1,
  [int]$Y = -1,
  [string]$OutPng = "",
  [int]$WaitMs = 900,
  [switch]$DoubleClick,
  [string]$Keys = ""
)

# Look at the screen, and optionally click something on it.
#
# The point is given in the pixels of the screen, so a menu that opens can be
# seen and then clicked on.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Screen {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
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
  public static void ClickAt(int x, int y, bool twice) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    mouse_event(0x0002u, 0, 0, 0, IntPtr.Zero);
    mouse_event(0x0004u, 0, 0, 0, IntPtr.Zero);
    if (twice) {
      System.Threading.Thread.Sleep(60);
      mouse_event(0x0002u, 0, 0, 0, IntPtr.Zero);
      mouse_event(0x0004u, 0, 0, 0, IntPtr.Zero);
    }
  }
}
'@
if (-not ("Screen" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$win = [Screen]::Find()
if ($win -ne [IntPtr]::Zero) {
  [void][Screen]::SetForegroundWindow($win)
  Start-Sleep -Milliseconds 300
}

if ($Keys -ne "") {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
} elseif ($X -ge 0) {
  [Screen]::ClickAt($X, $Y, $DoubleClick.IsPresent)
}
Start-Sleep -Milliseconds $WaitMs

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
if ($OutPng -ne "") {
  $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "the screen is $($bounds.Width)x$($bounds.Height) -> $OutPng"
} else {
  $bmp.Dispose()
  Write-Output "the screen is $($bounds.Width)x$($bounds.Height)"
}
