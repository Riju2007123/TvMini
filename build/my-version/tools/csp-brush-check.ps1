param(
  [Parameter(Mandatory = $true)][string]$SutFile,
  [Parameter(Mandatory = $true)][string]$OutPng,
  [int]$TimeoutSeconds = 180
)

# Open a .sut brush in Clip Studio Paint and take a picture of the window.
#
# The file is handed to the program the way Windows hands it over. The
# window is found by its title and the picture is taken with PrintWindow, so
# the window does not have to be in front.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Csp {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr found = IntPtr.Zero;
  public static long foundArea = 0;
  public static string want = "CLIP STUDIO";
  public static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    int len = GetWindowTextLength(h);
    if (len == 0) return true;
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    if (sb.ToString().IndexOf(want, StringComparison.OrdinalIgnoreCase) < 0) return true;
    RECT r; GetWindowRect(h, out r);
    long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
    if (area > foundArea) { found = h; foundArea = area; }
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
if (-not ("Csp" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
Add-Type -AssemblyName System.Drawing

$exe = "C:\Program Files\CELSYS\CLIP STUDIO 1.5\CLIP STUDIO PAINT\CLIPStudioPaint.exe"
if (-not (Test-Path $exe)) { Write-Error "Clip Studio Paint is not at $exe"; exit 1 }

$proc = Start-Process -FilePath $exe -ArgumentList "`"$SutFile`"" -WorkingDirectory (Split-Path $exe) -PassThru
Write-Output "started, the process is $($proc.Id)"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$win = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $w = [Csp]::Find("CLIP STUDIO")
  if ($w -ne [IntPtr]::Zero) {
    $r = New-Object Csp+RECT
    [void][Csp]::GetWindowRect($w, [ref]$r)
    if (($r.Right - $r.Left) -gt 500 -and ($r.Bottom - $r.Top) -gt 300) { $win = $w; break }
  }
  Start-Sleep -Milliseconds 1000
}
if ($win -eq [IntPtr]::Zero) { Write-Output "the window never appeared"; exit 1 }

# The program takes a moment to lay its palettes out.
Start-Sleep -Seconds 12
[void][Csp]::ShowWindow($win, 3)
Start-Sleep -Milliseconds 800
[void][Csp]::SetForegroundWindow($win)
Start-Sleep -Seconds 2

Write-Output "window title: $([Csp]::Title($win))"

$r = New-Object Csp+RECT
[void][Csp]::GetWindowRect($win, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [Csp]::PrintWindow($win, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "captured ${w}x${h} printWindow=$printed -> $OutPng"
