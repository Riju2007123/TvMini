param(
  [Parameter(Mandatory = $true)][string]$ClipFile,
  [Parameter(Mandatory = $true)][string]$OutPng,
  [int]$TimeoutSeconds = 120
)

# Open a .clip file in Umoupen and take a picture of the window.
#
# The file is handed to the application the way Windows hands it over. The
# window is found by its title, and the picture is taken with PrintWindow, so
# the window does not have to be in front and the other applications on the
# desktop do not matter.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Umou {
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
  public static uint foundPid = 0;
  public static string foundTitle = "";
  public static string want = "Umoupen";
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
      uint pid; GetWindowThreadProcessId(h, out pid);
      found = h; foundPid = pid; foundArea = area; foundTitle = sb.ToString();
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
if (-not ("Umou" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
Add-Type -AssemblyName System.Drawing

$exe = "H:\Umoupen-windows\Umoupen.exe"
if (-not (Test-Path $exe)) { Write-Error "Umoupen is not installed at $exe"; exit 1 }

$proc = Start-Process -FilePath $exe -ArgumentList "`"$ClipFile`"" -WorkingDirectory (Split-Path $exe) -PassThru

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$win = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $w = [Umou]::Find("Umoupen")
  if ($w -ne [IntPtr]::Zero) {
    $r = New-Object Umou+RECT
    [void][Umou]::GetWindowRect($w, [ref]$r)
    if (($r.Right - $r.Left) -gt 500 -and ($r.Bottom - $r.Top) -gt 300) { $win = $w; break }
  }
  Start-Sleep -Milliseconds 800
}
if ($win -eq [IntPtr]::Zero) { Write-Error "the window never appeared"; exit 1 }

Write-Output "window title: $([Umou]::Title($win))"

[void][Umou]::ShowWindow($win, 3)
Start-Sleep -Milliseconds 800
[void][Umou]::SetForegroundWindow($win)
Start-Sleep -Milliseconds 600

$r = New-Object Umou+RECT
[void][Umou]::GetWindowRect($win, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [Umou]::PrintWindow($win, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "captured ${w}x${h} printWindow=$printed -> $OutPng"
