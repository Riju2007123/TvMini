param(
  [Parameter(Mandatory = $true)][string]$ClipFile,
  [Parameter(Mandatory = $true)][string]$OutPng,
  [int]$TimeoutSeconds = 120
)

# Open a .clip file in Clip Studio Paint and take a picture of the window.
#
# The file is handed to the application the way Windows hands it over: the
# .clip association is CLIPStudioPaint.exe "%1", so the same thing happens
# as when the file is opened from the desktop.
#
# The window is found by its class, and the picture is taken with
# PrintWindow, so the window does not have to be in front and other
# applications on the desktop do not matter.

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
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr found = IntPtr.Zero;
  public static uint foundPid = 0;
  public static long foundArea = 0;
  public static string want = "";
  public static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    int len = GetWindowTextLength(h);
    if (len == 0) return true;
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    if (sb.ToString().IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) {
      // The application opens a small window while it starts up and a big
      // one afterwards, so the biggest match is the one to look at.
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > foundArea) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        found = h; foundPid = pid; foundArea = area;
      }
    }
    return true;
  }
  public static IntPtr Find(string w) { found = IntPtr.Zero; foundArea = 0; want = w; EnumWindows(Cb, IntPtr.Zero); return found; }
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
if (-not (Test-Path $exe)) { Write-Error "Clip Studio Paint is not installed at $exe"; exit 1 }

$proc = Start-Process -FilePath $exe -ArgumentList "`"$ClipFile`"" -WorkingDirectory (Split-Path $exe) -PassThru

# The document takes a while to come up: the application shows its start
# screen first and opens the document after it.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$win = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $w = [Csp]::Find("CLIP STUDIO")
  if ($w -ne [IntPtr]::Zero) {
    $r = New-Object Csp+RECT
    [void][Csp]::GetWindowRect($w, [ref]$r)
    if (($r.Right - $r.Left) -gt 600 -and ($r.Bottom - $r.Top) -gt 400) { $win = $w; break }
  }
  Start-Sleep -Milliseconds 800
}
if ($win -eq [IntPtr]::Zero) { Write-Error "the window never appeared"; exit 1 }

# Give the document time to be drawn.
Start-Sleep -Seconds 6
[void][Csp]::ShowWindow($win, 9)
[void][Csp]::SetForegroundWindow($win)
Start-Sleep -Seconds 2

$rect = New-Object Csp+RECT
[void][Csp]::GetWindowRect($win, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT makes a modern compositor draw its content
$ok = [Csp]::PrintWindow($win, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

"captured ${w}x${h} printWindow=$ok pid=$([Csp]::foundPid) -> $OutPng"
