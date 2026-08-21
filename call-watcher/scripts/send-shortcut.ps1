<#
Finds the specific chrome.exe process running with --remote-debugging-port=$Port (unambiguous,
unlike matching by window title when multiple Chrome windows/profiles are open), forces real
OS-level foreground focus onto it, then injects the keystroke via SendInput.

Windows normally blocks a background process from stealing foreground focus outright, so this
uses the standard workaround: temporarily attach this script's input thread to the current
foreground window's input queue (AttachThreadInput) before calling SetForegroundWindow.

Confirmed by testing: System.Windows.Forms.SendKeys reliably achieves real OS focus on the
target window (verified via GetForegroundWindow), but Chrome's extension-command shortcut still
never fires - a real physical keypress on the same focused window DOES work. That means SendKeys
delivers keystrokes by posting window messages rather than true low-level input, and Chrome's
command layer doesn't treat that as a genuine keypress. SendInput injects synthetic input at the
same level as real hardware, indistinguishable from an actual keypress, which is what Chrome's
command shortcuts (and OS-level RegisterHotKey, for "global" shortcuts) actually listen for.
#>
param(
    [Parameter(Mandatory = $true)][string]$Port,
    [Parameter(Mandatory = $true)][string]$Keys,  # SendKeys-style syntax: ^ = Ctrl, + = Shift, % = Alt, last char = key
    [Parameter(Mandatory = $false)][string]$TitleHint = ''  # substring of the target tab's title, to disambiguate multiple top-level windows
)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class NativeMethods {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    // A chrome.exe process can own more than one top-level window (e.g. a webcast link that
    // opens its player in a separate popup window, not just a new tab) - Process.MainWindowHandle
    // only ever reports ONE of them, and which one is ambiguous/can shift. This enumerates every
    // visible top-level window owned by any of the given PIDs and returns the one whose title
    // contains titleHint, so we focus the window that actually holds our target tab.
    public static IntPtr FindWindowByPidsAndTitle(HashSet<uint> pids, string titleHint) {
        IntPtr best = IntPtr.Zero;
        EnumWindowsProc callback = (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (!pids.Contains(pid)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (!string.IsNullOrEmpty(titleHint) && title.IndexOf(titleHint, StringComparison.OrdinalIgnoreCase) >= 0) {
                best = hWnd;
                return false;
            }
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        return best;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public KEYBDINPUT ki;
        public uint padding1;
        public uint padding2;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const ushort VK_CONTROL = 0x11;
    public const ushort VK_SHIFT = 0x10;
    public const ushort VK_MENU = 0x12;

    public static INPUT KeyInput(ushort vk, bool keyUp) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.ki.wVk = vk;
        input.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
        return input;
    }
}
"@

$candidates = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains("remote-debugging-port=$Port") }
Write-Output "Candidates matching --remote-debugging-port=$Port : $($candidates.Count)"

if (-not $candidates -or $candidates.Count -eq 0) {
    Write-Error "Could not find any chrome.exe process with --remote-debugging-port=$Port on its command line."
    exit 1
}

# More than one chrome.exe process can carry this flag (child processes inherit it too), and
# any of them can end up owning the popup window a webcast link opened. So the PID set covers
# ALL matches, and FindWindowByPidsAndTitle searches every visible top-level window across all
# of them for the one whose title matches our actual target tab, rather than trusting a single
# process's (possibly wrong, once more than one top-level window exists) MainWindowHandle.
$pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($c in $candidates) { [void]$pidSet.Add([uint32]$c.ProcessId) }

$hwnd = [IntPtr]::Zero
if ($TitleHint) {
    $hwnd = [NativeMethods]::FindWindowByPidsAndTitle($pidSet, $TitleHint)
    if ($hwnd -ne [IntPtr]::Zero) {
        Write-Output "Matched window by title hint '$TitleHint': $hwnd"
    } else {
        Write-Output "No window matched title hint '$TitleHint'; falling back to MainWindowHandle."
    }
}

if ($hwnd -eq [IntPtr]::Zero) {
    $targetProc = $candidates | Select-Object -First 1
    $proc = Get-Process -Id $targetProc.ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
        Write-Error "Found a debug Chrome process (PID $($targetProc.ProcessId)) but it has no main window handle, and no title-hint match either."
        exit 1
    }
    $hwnd = $proc.MainWindowHandle
    Write-Output "Fallback MainWindowHandle: $hwnd (PID $($targetProc.ProcessId))"
}

$fgWndBefore = [NativeMethods]::GetForegroundWindow()

$dummy = [uint32]0
$fgThread = [NativeMethods]::GetWindowThreadProcessId($fgWndBefore, [ref]$dummy)
$curThread = [NativeMethods]::GetCurrentThreadId()

[NativeMethods]::AttachThreadInput($curThread, $fgThread, $true) | Out-Null
[NativeMethods]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE, in case it's minimized
$focusResult = [NativeMethods]::SetForegroundWindow($hwnd)
[NativeMethods]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null

Start-Sleep -Milliseconds 250
$fgWndAfter = [NativeMethods]::GetForegroundWindow()
$foregroundMatches = ($fgWndAfter -eq $hwnd)
Write-Output "SetForegroundWindow result: $focusResult, foreground after matches target: $foregroundMatches"

# Abort rather than inject blindly. If the target window is not actually in the foreground the
# keystroke lands somewhere else entirely: at best nothing opens (previously surfaced as a
# confusing "popup never appeared" timeout), at worst an already-open popup gets driven against
# a different tab and records the wrong call. This is also the signal that the screen is locked
# or another app stole focus, which the caller could not otherwise distinguish.
if (-not $foregroundMatches) {
    Write-Error "Target window is not in the foreground after SetForegroundWindow (screen locked, or another window stole focus). Refusing to inject keystrokes."
    exit 2
}

# Parse SendKeys-style modifier syntax and inject via SendInput: modifiers down (in order),
# key down, key up, modifiers up (reverse order) - mirrors how a real keypress is sequenced.
$ctrl = $Keys.Contains('^')
$shift = $Keys.Contains('+')
$alt = $Keys.Contains('%')
$keyChar = $Keys[$Keys.Length - 1]
$vkKey = [uint16][char]::ToUpper($keyChar)

$downs = New-Object System.Collections.Generic.List[NativeMethods+INPUT]
$ups = New-Object System.Collections.Generic.List[NativeMethods+INPUT]
if ($ctrl) { $downs.Add([NativeMethods]::KeyInput([NativeMethods]::VK_CONTROL, $false)); $ups.Insert(0, [NativeMethods]::KeyInput([NativeMethods]::VK_CONTROL, $true)) }
if ($shift) { $downs.Add([NativeMethods]::KeyInput([NativeMethods]::VK_SHIFT, $false)); $ups.Insert(0, [NativeMethods]::KeyInput([NativeMethods]::VK_SHIFT, $true)) }
if ($alt) { $downs.Add([NativeMethods]::KeyInput([NativeMethods]::VK_MENU, $false)); $ups.Insert(0, [NativeMethods]::KeyInput([NativeMethods]::VK_MENU, $true)) }
$downs.Add([NativeMethods]::KeyInput($vkKey, $false))
$ups.Insert(0, [NativeMethods]::KeyInput($vkKey, $true))

$sequence = @($downs.ToArray()) + @($ups.ToArray())
$inputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][NativeMethods+INPUT])
$sent = [NativeMethods]::SendInput([uint32]$sequence.Length, $sequence, $inputSize)
Write-Output "SendInput injected $sent of $($sequence.Length) events for keys: $Keys"

# A partial injection means the key sequence Chrome saw was malformed (e.g. Ctrl pressed but
# never released), so the command almost certainly did not fire - and a stuck modifier would
# then corrupt the user's own typing. Previously this was printed and ignored.
if ($sent -ne $sequence.Length) {
    Write-Error "SendInput injected only $sent of $($sequence.Length) events - the shortcut did not fire cleanly."
    exit 3
}
