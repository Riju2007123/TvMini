param(
  [Parameter(Mandatory = $true)][string]$OutPng,
  [int]$TimeoutSeconds = 90,
  [int]$ClickX = -1,
  [int]$ClickY = -1,
  [string]$Key = "",
  [int]$WaitAfterClick = 600
)

# Start Macromedia Flash Professional 8 and take a picture of its window.
#
# The window is found by its title and the picture is taken with
# PrintWindow, so the window does not have to be in front and the other
# applications on the desktop do not matter.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Flash8 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr found = IntPtr.Zero;
  public static long foundArea = 0;
  public static string foundTitle = "";
  public static string want = "Flash";
  public static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    int len = GetWindowTextLength(h);
    if (len == 0) return true;
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    if (sb.ToString().IndexOf(want, StringComparison.OrdinalIgnoreCase) < 0) return true;
    RECT r; GetWindowRect(h, out r);
    long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
    if (area > foundArea) {
      found = h; foundArea = area; foundTitle = sb.ToString();
    }
    return true;
  }
  public static IntPtr Find(string w) {
    found = IntPtr.Zero; foundArea = 0; want = w;
    EnumWindows(Cb, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) {
    int len = GetWindowTextLength(h);
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
}
'@
if (-not ("Flash8" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
Add-Type -AssemblyName System.Drawing

$exe = "H:\flash 8\Flash 8\Flash.exe"
if (-not (Test-Path $exe)) { Write-Error "Flash 8 is not installed at $exe"; exit 1 }

$proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$win = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $w = [Flash8]::Find("Flash")
  if ($w -ne [IntPtr]::Zero) {
    $r = New-Object Flash8+RECT
    [void][Flash8]::GetWindowRect($w, [ref]$r)
    if (($r.Right - $r.Left) -gt 500 -and ($r.Bottom - $r.Top) -gt 300) { $win = $w; break }
  }
  Start-Sleep -Milliseconds 800
}
if ($win -eq [IntPtr]::Zero) { Write-Error "the window never appeared"; exit 1 }

Write-Output "window title: $([Flash8]::Title($win))"

[void][Flash8]::ShowWindow($win, 3)
Start-Sleep -Milliseconds 1200
[void][Flash8]::SetForegroundWindow($win)
Start-Sleep -Milliseconds 800

# A click in the window, to choose a tool for instance.
if ($ClickX -ge 0) {
  $r0 = New-Object Flash8+RECT
  [void][Flash8]::GetWindowRect($win, [ref]$r0)
  $sx = $r0.Left + $ClickX
  $sy = $r0.Top + $ClickY
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Click8 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
'@ -Language CSharp
  [void][Click8]::SetCursorPos($sx, $sy)
  Start-Sleep -Milliseconds 200
  [Click8]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [Click8]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds $WaitAfterClick
  Write-Output "clicked at $sx,$sy"
}

# A key, to choose a tool for instance: the pencil is P and the brush is B.
if ($Key -ne "") {
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.AppActivate([Flash8]::Title($win))
  Start-Sleep -Milliseconds 400
  $shell.SendKeys($Key)
  Start-Sleep -Milliseconds $WaitAfterClick
  Write-Output "sent the key $Key"
}

$r = New-Object Flash8+RECT
[void][Flash8]::GetWindowRect($win, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [Flash8]::PrintWindow($win, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "captured ${w}x${h} printWindow=$printed -> $OutPng"
