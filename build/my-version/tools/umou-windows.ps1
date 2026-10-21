param(
  [Parameter(Mandatory = $true)][string]$ClipFile,
  [int]$WaitSeconds = 12
)

# Start Umoupen on a file and report what windows and processes appear.
# The program is a packaged app, so the window may belong to another process
# than the one that was started.

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static bool Cb(IntPtr h, IntPtr l) {
    int len = GetWindowTextLength(h);
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    var cn = new StringBuilder(256);
    GetClassName(h, cn, 256);
    RECT r; GetWindowRect(h, out r);
    uint pid; GetWindowThreadProcessId(h, out pid);
    Console.WriteLine($"{h}\tpid={pid}\tvis={IsWindowVisible(h)}\tclass={cn}\ttext={sb}\trect={r.Right - r.Left}x{r.Bottom - r.Top}@{r.Left},{r.Top}");
    return true;
  }
}
'@
if (-not ("Win" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }

$exe = "H:\Umoupen-windows\Umoupen.exe"
$proc = Start-Process -FilePath $exe -ArgumentList "`"$ClipFile`"" -WorkingDirectory (Split-Path $exe) -PassThru
Write-Output "started pid=$($proc.Id)"

Start-Sleep -Seconds $WaitSeconds

Write-Output "--- processes ---"
Get-Process | Where-Object { $_.ProcessName -match "umou|webview|ApplicationFrame" } |
  Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize | Out-String | Write-Output

Write-Output "--- windows ---"
[Win]::EnumWindows([Win+EnumProc]{ param($h, $l) return [Win]::Cb($h, $l) }, [IntPtr]::Zero) | Out-Null
