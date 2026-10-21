param(
  [string]$SutFile = "",
  [string]$OutPng = "",
  [int]$TimeoutSeconds = 180
)

# Start Clip Studio Paint and take a picture of the window.
#
# The window is put back to its own size, so that the whole of it can be seen.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CspRun {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
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
}
'@
if (-not ("CspRun" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
Add-Type -AssemblyName System.Drawing

$exe = "C:\Program Files\CELSYS\CLIP STUDIO 1.5\CLIP STUDIO PAINT\CLIPStudioPaint.exe"
if (-not (Test-Path $exe)) { Write-Error "Clip Studio Paint is not at $exe"; exit 1 }

if ($SutFile -ne "") {
  $proc = Start-Process -FilePath $exe -ArgumentList "`"$SutFile`"" -WorkingDirectory (Split-Path $exe) -PassThru
} else {
  $proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
}
Write-Output "started, the process is $($proc.Id)"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$win = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $w = [CspRun]::Find()
  if ($w -ne [IntPtr]::Zero) {
    $r = New-Object CspRun+RECT
    [void][CspRun]::GetWindowRect($w, [ref]$r)
    if (($r.Right - $r.Left) -gt 500 -and ($r.Bottom - $r.Top) -gt 300) { $win = $w; break }
  }
  Start-Sleep -Milliseconds 1000
}
if ($win -eq [IntPtr]::Zero) { Write-Output "the window never appeared"; exit 1 }

Start-Sleep -Seconds 12
# The window is put back to its own size, so that the whole of it is on the
# screen and can be photographed.
[void][CspRun]::ShowWindow($win, 9)
Start-Sleep -Milliseconds 800
[void][CspRun]::MoveWindow($win, 0, 0, 1900, 1040, $true)
Start-Sleep -Seconds 2
[void][CspRun]::SetForegroundWindow($win)
Start-Sleep -Seconds 1

$r = New-Object CspRun+RECT
[void][CspRun]::GetWindowRect($win, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [CspRun]::PrintWindow($win, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if ($OutPng -ne "") {
  $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "captured ${w}x${h} -> $OutPng"
} else {
  $bmp.Dispose()
  Write-Output "the window is ${w}x${h}"
}
