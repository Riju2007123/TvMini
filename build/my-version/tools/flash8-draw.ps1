param(
  [Parameter(Mandatory = $true)][string]$OutPng,
  [int]$TimeoutSeconds = 90,
  [string]$Key = "b",
  [int]$Smoothing = 20,
  [int]$StartX = 700,
  [int]$StartY = 500,
  [int]$Width = 380,
  [int]$Amplitude = 45,
  [int]$Wavelength = 150,
  [int]$Steps = 60,
  [string]$Mode = "wave"
)

# Draw a wavy line in Macromedia Flash Professional 8 with the brush, and
# take a picture of the window.
#
# The tool is chosen with its key (B is the brush, Y is the pencil), the
# smoothing is typed into the field of the properties panel, and the line
# is drawn with the mouse: the same wave every time, so the pictures can
# be laid over each other.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Draw8 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr found = IntPtr.Zero;
  public static long foundArea = 0;
  public static string foundTitle = "";
  public static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    int len = GetWindowTextLength(h);
    if (len == 0) return true;
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    if (sb.ToString().IndexOf("Flash", StringComparison.OrdinalIgnoreCase) < 0) return true;
    RECT r; GetWindowRect(h, out r);
    long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
    if (area > foundArea) { found = h; foundArea = area; foundTitle = sb.ToString(); }
    return true;
  }
  public static IntPtr Find() {
    found = IntPtr.Zero; foundArea = 0;
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
if (-not ("Draw8" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
Add-Type -AssemblyName System.Drawing

$exe = "H:\flash 8\Flash 8\Flash.exe"
if (-not (Test-Path $exe)) { Write-Error "Flash 8 is not installed at $exe"; exit 1 }

$proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$win = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $w = [Draw8]::Find()
  if ($w -ne [IntPtr]::Zero) {
    $r = New-Object Draw8+RECT
    [void][Draw8]::GetWindowRect($w, [ref]$r)
    if (($r.Right - $r.Left) -gt 500 -and ($r.Bottom - $r.Top) -gt 300) { $win = $w; break }
  }
  Start-Sleep -Milliseconds 800
}
if ($win -eq [IntPtr]::Zero) { Write-Error "the window never appeared"; exit 1 }

[void][Draw8]::ShowWindow($win, 3)
Start-Sleep -Milliseconds 1200
[void][Draw8]::SetForegroundWindow($win)
Start-Sleep -Milliseconds 800

$rect = New-Object Draw8+RECT
[void][Draw8]::GetWindowRect($win, [ref]$rect)
$ox = $rect.Left
$oy = $rect.Top

$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate([Draw8]::Title($win))
Start-Sleep -Milliseconds 400
$shell.SendKeys($Key)
Start-Sleep -Milliseconds 700

# The field of the smoothing, in the properties panel at the bottom.
[void][Draw8]::SetCursorPos($ox + 322, $oy + 1036)
Start-Sleep -Milliseconds 200
[Draw8]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
[Draw8]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300
$shell.SendKeys("^a")
Start-Sleep -Milliseconds 150
$shell.SendKeys([string]$Smoothing)
Start-Sleep -Milliseconds 150
$shell.SendKeys("{ENTER}")
Start-Sleep -Milliseconds 500

# The wave, or a line with a tremble in it: the amplitude and the
# wavelength say how big and how quick it is.
$points = @()
for ($i = 0; $i -le $Steps; $i += 1) {
  $t = $i / $Steps
  $x = $StartX + ($Width * $t)
  $y = $StartY + ($Amplitude * [Math]::Sin(2 * [Math]::PI * $t * ($Width / $Wavelength)))
  $points += ,@($x, $y)
}

[void][Draw8]::SetCursorPos($ox + $points[0][0], $oy + $points[0][1])
Start-Sleep -Milliseconds 300
[Draw8]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 150
foreach ($point in $points) {
  [void][Draw8]::SetCursorPos($ox + $point[0], $oy + $point[1])
  Start-Sleep -Milliseconds 25
}
[Draw8]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 800

$r = New-Object Draw8+RECT
[void][Draw8]::GetWindowRect($win, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$printed = [Draw8]::PrintWindow($win, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "the smoothing was $Smoothing, the wave is ${Width} by ${Amplitude} -> $OutPng"
