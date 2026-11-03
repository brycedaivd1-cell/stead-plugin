// Desktop control for Windows: windows, screenshots, real input, and the UI Automation tree.
// Loaded into a long-lived PowerShell host (host.ps1) so each call costs milliseconds, not a
// process start. Accessibility first: click controls by name; pixels only as a fallback.
// Compiled by Windows PowerShell 5.1's C# 5 compiler: no string interpolation, no ?., no out _.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Automation;

public static class Desktop
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT val, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int retLen);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYUP = 2, UNICODE = 4, EXTENDED = 1;
    const uint LDOWN = 2, LUP = 4, RDOWN = 8, RUP = 16, WHEEL = 0x800;

    // Per-monitor DPI awareness, so coordinates stay right on a laptop screen plus a monitor at a
    // different scale. Older Windows falls back to system-wide awareness.
    static Desktop()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    // ---------- windows ----------
    public class Win { public long hwnd; public string title; public string app; public int x, y, w, h; public bool active; public bool admin; }

    public static List<Win> Windows()
    {
        var list = new List<Win>();
        var fg = GetForegroundWindow();
        bool meAdmin = SelfElevated();
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h); if (len == 0) return true;
            int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;
            int ex = GetWindowLong(h, -20); if ((ex & 0x80) != 0) return true; // tool windows
            var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
            uint pid; GetWindowThreadProcessId(h, out pid);
            string app = ""; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
            RECT r; GetWindowRect(h, out r);
            if (r.R - r.L < 50 || r.B - r.T < 50) return true;
            if (sb.ToString() == "PopupHost") return true; // XAML menus and tooltips, not windows a person sees
            list.Add(new Win { hwnd = h.ToInt64(), title = sb.ToString(), app = app, x = r.L, y = r.T, w = r.R - r.L, h = r.B - r.T, active = h == fg, admin = !meAdmin && Elevated(pid) });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static bool Focus(long hwnd)
    {
        var h = new IntPtr(hwnd);
        if (!IsWindow(h)) throw new InvalidOperationException("That window is closed. Call desktop_windows for the current ones.");
        if (IsIconic(h)) ShowWindow(h, 9);
        if (GetForegroundWindow() == h) return true;
        bool ok = TryForeground(h);
        if (!ok)
        {
            // Windows lets only the process that sent the last input take the foreground. A tap of a key
            // nothing uses (F24) earns that. Not Alt: an Alt tap opens the menu bar in many apps, and the
            // next letters typed become menu shortcuts (typing "file" would open the File menu).
            KeyTap(0x87);
            ok = TryForeground(h);
        }
        Settle(h);
        return ok || GetForegroundWindow() == h;
    }

    // Keys sent before the app has handled its activation go to the window, not the box inside it.
    // Was a flat 120 ms; this returns as soon as the app's UI thread has caught up (WM_NULL answered).
    static void Settle(IntPtr h)
    {
        IntPtr r;
        SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero, 0x0002, 300, out r); // SMTO_ABORTIFHUNG
    }

    // After a click or keys: the window in front (or the given one) has picked up the input once its UI
    // thread answers again. Replaces flat 250-350 ms waits; a hung app costs at most maxMs.
    public static void SettleInput(long hwnd, int maxMs)
    {
        var h = hwnd != 0 ? new IntPtr(hwnd) : GetForegroundWindow();
        System.Threading.Thread.Sleep(30); // let the input reach the app's queue first
        IntPtr r;
        if (h != IntPtr.Zero) SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero, 0x0002, (uint)Math.Max(50, maxMs), out r);
    }

    // Poll instead of a fixed sleep: most of the time the thing is ready at once.
    static bool WaitUntil(Func<bool> ok, int maxMs)
    {
        var w = Stopwatch.StartNew();
        while (true)
        {
            try { if (ok()) return true; } catch { }
            if (w.ElapsedMilliseconds >= maxMs) return false;
            System.Threading.Thread.Sleep(40);
        }
    }

    static bool TryForeground(IntPtr h)
    {
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
        uint me = GetCurrentThreadId();
        AttachThreadInput(me, fgThread, true);
        BringWindowToTop(h);
        bool ok = SetForegroundWindow(h);
        AttachThreadInput(me, fgThread, false);
        return ok && GetForegroundWindow() == h;
    }

    // ---------- who can be typed into ----------
    // Windows silently drops input sent to an administrator window from a normal program, and to a
    // locked screen: the click "succeeds" and nothing happens. Say so instead.
    static bool Elevated(uint pid)
    {
        IntPtr proc = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (proc == IntPtr.Zero) return false;
        try { return TokenElevated(proc); } finally { CloseHandle(proc); }
    }
    static bool TokenElevated(IntPtr proc)
    {
        IntPtr tok;
        if (!OpenProcessToken(proc, 0x0008, out tok)) return false; // TOKEN_QUERY
        try { int elevated, len; return GetTokenInformation(tok, 20, out elevated, 4, out len) && elevated != 0; } // TokenElevation
        finally { CloseHandle(tok); }
    }
    static int selfElevated = -1;
    static bool SelfElevated() { if (selfElevated < 0) selfElevated = TokenElevated(GetCurrentProcess()) ? 1 : 0; return selfElevated == 1; }

    public static string InputBlocked()
    {
        IntPtr desk = OpenInputDesktop(0, false, 0x0100); // DESKTOP_SWITCHDESKTOP
        if (desk == IntPtr.Zero) return "The computer is locked (or a sign-in or permission prompt is up), so nothing can be clicked or typed until someone unlocks it.";
        CloseDesktop(desk);
        var fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return "";
        uint pid; GetWindowThreadProcessId(fg, out pid);
        if (!SelfElevated() && Elevated(pid))
        {
            string app = ""; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
            return "The window in front (" + app + ") runs as administrator, and Windows blocks other programs from clicking or typing into it. Ask them to do this step themselves.";
        }
        return "";
    }
    static void EnsureInput() { string why = InputBlocked(); if (why.Length > 0) throw new InvalidOperationException(why); }

    // Our own clicks and keys also count as "input" to Windows. Remember when we sent them, so a
    // job running with nobody watching can tell its own input from a person's.
    static uint lastOwnInput = 0;
    static uint personInput = 0;
    public static long IdleMs()
    {
        var li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        GetLastInputInfo(ref li);
        uint now = (uint)Environment.TickCount;
        // Tick counts wrap every 49.7 days: compare differences, never the raw values.
        if (lastOwnInput == 0 || unchecked((int)(li.dwTime - lastOwnInput)) > 1500) personInput = li.dwTime;
        if (personInput == 0) personInput = li.dwTime;
        return (long)unchecked(now - personInput);
    }

    // ---------- screenshots ----------
    // Returns base64 JPEG plus the mapping so image coordinates convert back to screen pixels.
    public class Shot { public string b64; public int originX, originY; public double scale; public int width, height; public long hwnd; }

    // rw > 0: just that screen rectangle (inside the window, if one is given), at full resolution: a zoom.
    public static Shot Screenshot(long hwnd, int maxW, bool all, int rx, int ry, int rw, int rh)
    {
        int x, y;
        using (var bmp = Grab(hwnd, all, rx, ry, rw, rh, out x, out y))
        {
            int w = bmp.Width, h = bmp.Height;
            double s = Math.Min(1.0, (double)maxW / w);
            int ow = (int)(w * s), oh = (int)(h * s);
            using (var outBmp = new Bitmap(ow, oh))
            {
                using (var g = Graphics.FromImage(outBmp))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(bmp, 0, 0, ow, oh);
                }
                if (jpeg == null) jpeg = ImageCodecInfo.GetImageEncoders().First(e => e.MimeType == "image/jpeg");
                var p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
                using (var ms = new MemoryStream())
                {
                    outBmp.Save(ms, jpeg, p);
                    return new Shot { b64 = Convert.ToBase64String(ms.ToArray()), originX = x, originY = y, scale = s, width = ow, height = oh, hwnd = hwnd };
                }
            }
        }
    }
    static ImageCodecInfo jpeg;

    // A lossless picture for OCR (host.ps1), enlarged up to 2x: Windows OCR misses small UI text.
    // scale maps it back: screen = origin + pixel / scale.
    public static Shot Png(long hwnd, int rx, int ry, int rw, int rh)
    {
        int x, y;
        using (var bmp = Grab(hwnd, false, rx, ry, rw, rh, out x, out y))
        {
            double s = Math.Max(1.0, Math.Min(2.0, 4000.0 / Math.Max(bmp.Width, bmp.Height)));
            int ow = (int)(bmp.Width * s), oh = (int)(bmp.Height * s);
            using (var big = new Bitmap(ow, oh))
            using (var ms = new MemoryStream())
            {
                using (var g = Graphics.FromImage(big))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(bmp, 0, 0, ow, oh);
                }
                big.Save(ms, ImageFormat.Png);
                return new Shot { b64 = Convert.ToBase64String(ms.ToArray()), originX = x, originY = y, scale = s, width = ow, height = oh, hwnd = hwnd };
            }
        }
    }

    // The pixels of a window, the person's monitor, or every monitor (all), cut to a region if given.
    static Bitmap Grab(long hwnd, bool all, int rx, int ry, int rw, int rh, out int x, out int y)
    {
        int w, h;
        var hw = new IntPtr(hwnd);
        if (hwnd != 0)
        {
            if (!IsWindow(hw)) throw new InvalidOperationException("That window is closed. Call desktop_windows for the current ones.");
            if (IsIconic(hw)) ShowWindow(hw, 9);
            RECT r;
            if (DwmGetWindowAttribute(hw, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(hw, out r); // the visible frame, without the invisible resize border
            x = r.L; y = r.T; w = r.R - r.L; h = r.B - r.T;
        }
        else if (!all)
        {
            // The monitor the person is working on, at a readable size (two monitors squeezed into one
            // image make text unreadable).
            var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            GetMonitorInfo(MonitorFromWindow(GetForegroundWindow(), 2), ref mi);
            x = mi.rcMonitor.L; y = mi.rcMonitor.T; w = mi.rcMonitor.R - mi.rcMonitor.L; h = mi.rcMonitor.B - mi.rcMonitor.T;
        }
        else
        {
            x = GetSystemMetrics(76); y = GetSystemMetrics(77); w = GetSystemMetrics(78); h = GetSystemMetrics(79);
        }
        if (rw > 0 && rh > 0)
        {
            int x2 = Math.Min(x + w, rx + rw), y2 = Math.Min(y + h, ry + rh);
            x = Math.Max(x, rx); y = Math.Max(y, ry); w = x2 - x; h = y2 - y;
            if (w <= 0 || h <= 0) throw new InvalidOperationException("That region is outside the window.");
        }
        if (w <= 0 || h <= 0) throw new InvalidOperationException("That window has no size on screen (minimized or hidden).");
        // A window behind others is rendered on its own (PrintWindow), so the person's window stays in
        // front. Apps that draw with the GPU can come back black; then it's brought forward and copied.
        Bitmap shot = null;
        if (hwnd != 0 && GetForegroundWindow() != hw) shot = RenderWindow(hw, x, y, w, h);
        if (shot == null)
        {
            if (hwnd != 0) Focus(hwnd); // a screen copy shows whatever covers it
            shot = new Bitmap(w, h);
            using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
        }
        return shot;
    }

    // The part x,y,w,h (screen pixels) of a window, drawn by the window itself; null if it drew nothing.
    static Bitmap RenderWindow(IntPtr hw, int x, int y, int w, int h)
    {
        RECT wr;
        if (!GetWindowRect(hw, out wr) || wr.R - wr.L <= 0 || wr.B - wr.T <= 0) return null;
        var full = new Bitmap(wr.R - wr.L, wr.B - wr.T);
        try
        {
            using (var g = Graphics.FromImage(full))
            {
                IntPtr dc = g.GetHdc();
                bool ok;
                try { ok = PrintWindow(hw, dc, 2); } finally { g.ReleaseHdc(dc); } // PW_RENDERFULLCONTENT
                if (!ok) return null;
            }
            // All black means it drew nothing (GPU surfaces, some games).
            bool blank = true;
            for (int i = 1; i < 8 && blank; i++)
                for (int j = 1; j < 8 && blank; j++)
                    if (full.GetPixel(full.Width * i / 8, full.Height * j / 8).ToArgb() != Color.Black.ToArgb()) blank = false;
            if (blank) return null;
            return full.Clone(new Rectangle(x - wr.L, y - wr.T, w, h), full.PixelFormat);
        }
        catch { return null; }
        finally { full.Dispose(); }
    }

    // ---------- input ----------
    static void Send(params INPUT[] i) { SendInput((uint)i.Length, i, Marshal.SizeOf(typeof(INPUT))); lastOwnInput = (uint)Environment.TickCount; }
    static INPUT Mouse(uint flags, uint data = 0) { var i = new INPUT { type = INPUT_MOUSE }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
    // Real keyboards send a scan code too; WinUI/XAML apps (the new Notepad) ignore shortcuts without one.
    static INPUT Key(ushort vk, bool up) { var i = new INPUT { type = INPUT_KEYBOARD }; i.u.ki.wVk = vk; i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0); i.u.ki.dwFlags = (up ? KEYUP : 0) | (IsExtended(vk) ? EXTENDED : 0); return i; }
    static bool IsExtended(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x5D; }
    static void KeyTap(ushort vk) { Send(Key(vk, false), Key(vk, true)); }

    // hwnd != 0: the point must be on that window, or something else is covering it.
    // The control a click at this screen point would press: "Role\tName", walking up from what is
    // under the point to the nearest button-like control. Used to judge a click before it happens.
    public static string At(int x, int y)
    {
        AutomationElement el;
        try { el = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch { return ""; }
        if (el == null) return "";
        // FromPoint stops at a XAML island or a custom-drawn pane (the Windows 11 taskbar, Teams):
        // look inside it for the smallest named control under the point.
        try
        {
            var pt = new System.Windows.Point(x, y);
            var ct0 = el.Current.ControlType;
            if (ct0 == ControlType.Pane || ct0 == ControlType.Group || ct0 == ControlType.Custom)
            {
                AutomationElement best = null;
                double area = double.MaxValue;
                // A cached walk with a time limit: FindAll(TrueCondition) fetched every control first.
                Scan(el, Stopwatch.StartNew(), 1500, c =>
                {
                    try
                    {
                        var ci = c.Cached;
                        var r = ci.BoundingRectangle;
                        if (r.IsEmpty || !r.Contains(pt) || ci.IsOffscreen) return true;
                        var t = ci.ControlType;
                        if (!(t == ControlType.Button || t == ControlType.SplitButton || t == ControlType.MenuItem || t == ControlType.Hyperlink
                            || t == ControlType.ListItem || t == ControlType.TabItem || t == ControlType.CheckBox || t == ControlType.RadioButton)) return true;
                        if (r.Width * r.Height < area) { area = r.Width * r.Height; best = c; }
                    }
                    catch { }
                    return true;
                });
                if (best != null) { var bi = best.Cached; return Short(bi.ControlType) + "\t" + OneLine(bi.Name, 80); }
            }
        }
        catch { }
        string first = null;
        var walker = TreeWalker.ControlViewWalker;
        for (int i = 0; el != null && i < 6; i++)
        {
            try
            {
                var info = el.Current;
                var ct = info.ControlType;
                string line = Short(ct) + "\t" + OneLine(info.Name, 80);
                if (first == null) first = line;
                if (ct == ControlType.Button || ct == ControlType.SplitButton || ct == ControlType.MenuItem
                    || ct == ControlType.Hyperlink || ct == ControlType.ListItem || ct == ControlType.TabItem
                    || ct == ControlType.CheckBox || ct == ControlType.RadioButton || ct == ControlType.Edit
                    || ct == ControlType.Document || ct == ControlType.Window) return line;
                el = walker.GetParent(el);
            }
            catch { break; }
        }
        return first ?? "";
    }

    static void CheckCovered(int x, int y, long hwnd)
    {
        if (hwnd == 0) return;
        var p = new POINT { X = x, Y = y };
        var at = GetAncestor(WindowFromPoint(p), 2); // GA_ROOT
        if (at != new IntPtr(hwnd))
        {
            var sb = new StringBuilder(256); GetWindowText(at, sb, 256);
            throw new InvalidOperationException("Something else (\"" + sb + "\") is covering that spot now. Take a new desktop_screenshot of the window.");
        }
    }

    public static void Click(int x, int y, string button, int count, long hwnd)
    {
        EnsureInput();
        CheckCovered(x, y, hwnd);
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(40);
        bool right = button == "right";
        for (int c = 0; c < Math.Max(1, count); c++)
        {
            Send(Mouse(right ? RDOWN : LDOWN), Mouse(right ? RUP : LUP));
            System.Threading.Thread.Sleep(60);
        }
    }

    public static void Scroll(int x, int y, int clicks)
    {
        EnsureInput();
        SetCursorPos(x, y);
        Send(Mouse(WHEEL, unchecked((uint)(-clicks * 120))));
    }

    // Mouse moves (hover) and drags, with the same covered-spot check as a click.
    public static void Drag(int x, int y, int toX, int toY, long hwnd)
    {
        EnsureInput();
        CheckCovered(x, y, hwnd);
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(40);
        Send(Mouse(LDOWN));
        // In steps, like a hand: apps start a drag only after the pointer moves a few pixels while down.
        for (int i = 1; i <= 12; i++) { SetCursorPos(x + (toX - x) * i / 12, y + (toY - y) * i / 12); System.Threading.Thread.Sleep(15); }
        System.Threading.Thread.Sleep(60);
        Send(Mouse(LUP));
    }
    public static void MoveMouse(int x, int y) { EnsureInput(); SetCursorPos(x, y); lastOwnInput = (uint)Environment.TickCount; }

    // Text goes in as a few big SendInput batches, not one key and a sleep per character: Sleep(4) is
    // really ~15 ms, so 150 characters took 2.6 s, and a focus change midway scattered the rest.
    public static void TypeText(string text)
    {
        EnsureInput();
        var batch = new List<INPUT>();
        int n = 0;
        foreach (char ch in (text ?? "").Replace("\r\n", "\n"))
        {
            if (ch == '\n') { batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); }
            else
            {
                var down = new INPUT { type = INPUT_KEYBOARD }; down.u.ki.wScan = ch; down.u.ki.dwFlags = UNICODE;
                var up = new INPUT { type = INPUT_KEYBOARD }; up.u.ki.wScan = ch; up.u.ki.dwFlags = UNICODE | KEYUP;
                batch.Add(down); batch.Add(up);
            }
            // 64 characters a batch, with a breath between, so a slow app's input queue never overflows.
            if (++n % 64 == 0) { Send(batch.ToArray()); batch.Clear(); System.Threading.Thread.Sleep(5); }
        }
        if (batch.Count > 0) Send(batch.ToArray());
        Absorbed(text ?? "", n);
    }

    // SendInput returns once the keys are queued, not typed: a slow app (the new Notepad) was still
    // typing 450 queued keys when the next call replaced the document, and they landed after it.
    // Wait until the focused box shows the end of what was typed, or stops changing.
    static void Absorbed(string text, int n)
    {
        string tail = text.Replace("\r", "").Split('\n').Where(l => l.Trim().Length > 0).LastOrDefault() ?? "";
        if (tail.Length > 16) tail = tail.Substring(tail.Length - 16);
        AutomationElement fe = null;
        object p = null;
        try { fe = AutomationElement.FocusedElement; } catch { }
        // A password box won't show its value (reading it throws): don't poll it until the time runs out.
        bool secret = false;
        try { secret = fe != null && fe.Current.IsPassword; } catch { }
        if (fe == null || secret || !fe.TryGetCurrentPattern(ValuePattern.Pattern, out p)) { System.Threading.Thread.Sleep(Math.Min(400, 30 + n)); return; }
        var vp = (ValuePattern)p;
        string last = null;
        int same = 0;
        WaitUntil(() =>
        {
            string v = vp.Current.Value ?? "";
            if (v.Length > 2000000) return true; // too big to keep re-reading
            same = v == last ? same + 1 : 0;
            last = v;
            return (tail.Length > 0 && v.Contains(tail) && same >= 2) || same >= 4;
        }, Math.Min(4000, 300 + n * 10));
    }

    // Long or multi-line text goes in with one paste: typing a newline presses Enter (which sends the
    // message in chat apps), per-key typing sets off AutoCorrect, and select-all then type wipes the
    // document long before the new text is in. Their clipboard is put back after.
    static readonly string[] ClipFormats = { "HTML Format", "UnicodeText", "Text", "Rich Text Format", "FileDrop", "Bitmap" };
    public static void PasteText(string text)
    {
        EnsureInput();
        var saved = new Dictionary<string, object>();
        try
        {
            var old = System.Windows.Forms.Clipboard.GetDataObject();
            if (old != null) foreach (var f in ClipFormats) { try { if (old.GetDataPresent(f)) saved[f] = old.GetData(f); } catch { } }
        }
        catch { }
        var d = new System.Windows.Forms.DataObject();
        d.SetData(System.Windows.Forms.DataFormats.UnicodeText, text ?? "");
        System.Windows.Forms.Clipboard.SetDataObject(d, true, 5, 50);
        Keys("ctrl+v");
        // The app reads the clipboard when it gets to the paste; nothing says when that is. Putting
        // theirs back too soon pasted it instead, and a save right after missed the text: wait until
        // the box shows it (or 250 ms when the box can't be read).
        System.Threading.Thread.Sleep(60);
        Absorbed(text ?? "", 200);
        if (saved.Count > 0)
        {
            var back = new System.Windows.Forms.DataObject();
            foreach (var kv in saved) { try { back.SetData(kv.Key, kv.Value); } catch { } }
            try { System.Windows.Forms.Clipboard.SetDataObject(back, true, 5, 50); } catch { }
        }
    }

    static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
    {
        {"ctrl",0x11},{"control",0x11},{"shift",0x10},{"alt",0x12},{"win",0x5B},{"meta",0x5B},{"apps",0x5D},{"menu",0x5D},
        {"enter",0x0D},{"return",0x0D},{"tab",0x09},{"esc",0x1B},{"escape",0x1B},{"space",0x20},{"backspace",0x08},
        {"delete",0x2E},{"del",0x2E},{"insert",0x2D},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},
        {"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},{"printscreen",0x2C},{"capslock",0x14},
        {"plus",0xBB},{"minus",0xBD},{"comma",0xBC},{"period",0xBE},{"slash",0xBF},{"backslash",0xDC},
        {"volumemute",0xAD},{"volumedown",0xAE},{"volumeup",0xAF},{"playpause",0xB3},{"nexttrack",0xB0},{"prevtrack",0xB1},
        {"f1",0x70},{"f2",0x71},{"f3",0x72},{"f4",0x73},{"f5",0x74},{"f6",0x75},{"f7",0x76},{"f8",0x77},{"f9",0x78},{"f10",0x79},{"f11",0x7A},{"f12",0x7B},
    };

    // "ctrl+shift+s", "alt+f4", "enter", "ctrl+a", "ctrl+,", "ctrl++"
    public static void Keys(string combo)
    {
        EnsureInput();
        string c0 = combo.Trim();
        var parts = c0.Split('+').Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
        if (c0.EndsWith("++") || c0 == "+") parts.Add("+"); // "ctrl++" means Ctrl and the plus key
        var codes = new List<ushort>();
        foreach (var p in parts)
        {
            ushort vk;
            if (VK.TryGetValue(p, out vk)) codes.Add(vk);
            else if (p.Length == 1 && char.IsLetterOrDigit(p[0]) && p[0] < 128) codes.Add((ushort)char.ToUpperInvariant(p[0]));
            else if (p.Length == 1)
            {
                // Punctuation ("ctrl+,", "ctrl+/", "ctrl+="): the key that types it on this keyboard layout.
                short k = VkKeyScan(p[0]);
                if (k == -1) throw new ArgumentException("No key types " + p + " on this keyboard.");
                if ((k & 0x100) != 0 && !codes.Contains(0x10)) codes.Add(0x10);
                codes.Add((ushort)(k & 0xFF));
            }
            else throw new ArgumentException("Unknown key: " + p);
        }
        // One SendInput call for the whole chord, like a real keyboard: some apps drop a shortcut whose
        // keys arrive in separate batches.
        var seq = new List<INPUT>();
        foreach (var c in codes) seq.Add(Key(c, false));
        for (int i = codes.Count - 1; i >= 0; i--) seq.Add(Key(codes[i], true));
        Send(seq.ToArray());
    }

    // ---------- UI Automation ----------
    // Ids never repeat within a session (e1, e2, ... e900): an id remembered from an old read can't
    // silently point at a different control after a new read. Old ones expire after a while.
    static readonly Dictionary<string, AutomationElement> refs = new Dictionary<string, AutomationElement>();
    static readonly Queue<string> refOrder = new Queue<string>();
    static int nextRef = 1;
    static string Remember(AutomationElement el)
    {
        string id = "e" + nextRef++;
        refs[id] = el;
        refOrder.Enqueue(id);
        while (refOrder.Count > 4000) refs.Remove(refOrder.Dequeue());
        return id;
    }

    static string Short(ControlType t) { return t == null ? "Element" : t.ProgrammaticName.Replace("ControlType.", ""); }

    // Text outline of a window's controls (or of one control, given its id), plus any menus or
    // dropdowns it has open. Each control gets an id like e12.
    public static string Tree(long hwnd, int maxDepth, int maxNodes, string fromId)
    {
        int count;
        string t = TreeOnce(hwnd, maxDepth, maxNodes, fromId, out count);
        // Chromium-based apps (new Outlook, Teams) build their tree lazily on the first query, and a
        // window that just opened can be an empty shell for a moment. Read again until it fills in.
        if (hwnd != 0 && string.IsNullOrEmpty(fromId) && (count <= 2 || (count < 12 && ClassOf(new IntPtr(hwnd)).StartsWith("Chrome_WidgetWin"))))
        {
            int first = count;
            var w = Stopwatch.StartNew();
            while (w.ElapsedMilliseconds < 1200 && count <= Math.Max(first, 2))
            {
                System.Threading.Thread.Sleep(150);
                t = TreeOnce(hwnd, maxDepth, maxNodes, fromId, out count);
            }
        }
        return t;
    }

    static string ClassOf(IntPtr h) { var c = new StringBuilder(64); GetClassName(h, c, 64); return c.ToString(); }

    static string TreeOnce(long hwnd, int maxDepth, int maxNodes, string fromId, out int count)
    {
        var root = !string.IsNullOrEmpty(fromId) ? Ref(fromId) : hwnd != 0 ? AutomationElement.FromHandle(new IntPtr(hwnd)) : AutomationElement.FocusedElement;
        var sb = new StringBuilder();
        int hidden = 0;
        count = 0;
        Walk(Cached(root), 0, maxDepth, maxNodes, ref count, ref hidden, sb);
        if (hwnd != 0 && string.IsNullOrEmpty(fromId))
        {
            foreach (var pop in PopupRoots(hwnd))
            {
                if (count >= maxNodes) break;
                sb.AppendLine("Open menu or popup:");
                // Menu items in XAML popups report themselves offscreen while plainly visible.
                walkAll = true;
                try { Walk(Cached(AutomationElement.FromHandle(pop)), 1, maxDepth, maxNodes, ref count, ref hidden, sb); } finally { walkAll = false; }
            }
        }
        if (count >= maxNodes) sb.AppendLine("…(truncated: desktop_find searches by name, desktop_read with id reads one part, desktop_read_text gives the words)");
        else if (hidden > 0) sb.AppendLine("(" + hidden + " more controls are scrolled out of view: desktop_find or scroll_into_view reaches them)");
        return sb.ToString();
    }

    // Everything a line of the outline shows, fetched in one round trip per control instead of one
    // per property and pattern (a dozen cross-process calls each, which is what made big apps slow).
    static CacheRequest cacheReq;
    static CacheRequest Cache()
    {
        if (cacheReq != null) return cacheReq;
        var c = new CacheRequest();
        foreach (var p in new AutomationProperty[] {
            AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.AutomationIdProperty,
            AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty, AutomationElement.HasKeyboardFocusProperty,
            AutomationElement.BoundingRectangleProperty, ValuePattern.ValueProperty, RangeValuePattern.ValueProperty,
            RangeValuePattern.MinimumProperty, RangeValuePattern.MaximumProperty, TogglePattern.ToggleStateProperty,
            SelectionItemPattern.IsSelectedProperty, ExpandCollapsePattern.ExpandCollapseStateProperty })
            c.Add(p);
        cacheReq = c;
        return c;
    }
    static AutomationElement Cached(AutomationElement el) { return el.GetUpdatedCache(Cache()); }

    // A property from the cache (or live), or NotSupported when the control doesn't have it.
    static object Prop(AutomationElement el, AutomationProperty p, bool cached)
    {
        try { return cached ? el.GetCachedPropertyValue(p, true) : el.GetCurrentPropertyValue(p, true); }
        catch { return AutomationElement.NotSupported; }
    }
    static bool Has(object v) { return v != null && v != AutomationElement.NotSupported; }
    static AutomationElement.AutomationElementInformation Info(AutomationElement el, bool cached) { return cached ? el.Cached : el.Current; }

    static string OneLine(string s, int max)
    {
        s = (s ?? "").Replace("\r\n", " ⏎ ").Replace("\n", " ⏎ ").Replace("\r", " ⏎ ").Trim();
        return s.Length > max ? s.Substring(0, max) + "…" : s;
    }

    // value="…" plus on/off, disabled, focused: what a person would see at a glance.
    static string Describe(AutomationElement el, bool cached)
    {
        var sb = new StringBuilder();
        var info = Info(el, cached);
        object v = Prop(el, ValuePattern.ValueProperty, cached);
        if (Has(v)) sb.Append(" value=\"").Append(OneLine(v as string, 80)).Append('"');
        else
        {
            v = Prop(el, RangeValuePattern.ValueProperty, cached);
            if (Has(v)) sb.Append(" value=").Append(v).Append(" (").Append(Prop(el, RangeValuePattern.MinimumProperty, cached)).Append('-').Append(Prop(el, RangeValuePattern.MaximumProperty, cached)).Append(')');
        }
        v = Prop(el, TogglePattern.ToggleStateProperty, cached);
        if (Has(v)) sb.Append(' ').Append(v.ToString().ToLower());
        v = Prop(el, SelectionItemPattern.IsSelectedProperty, cached);
        if (Has(v) && v is bool && (bool)v) sb.Append(" selected");
        v = Prop(el, ExpandCollapsePattern.ExpandCollapseStateProperty, cached);
        if (Has(v) && v is ExpandCollapseState)
        {
            var st = (ExpandCollapseState)v;
            if (st == ExpandCollapseState.Collapsed) sb.Append(" collapsed"); else if (st == ExpandCollapseState.Expanded) sb.Append(" expanded");
        }
        if (!info.IsEnabled) sb.Append(" disabled");
        if (info.HasKeyboardFocus) sb.Append(" focused");
        return sb.ToString();
    }

    static string Line(string id, AutomationElement el, bool cached)
    {
        var sb = new StringBuilder();
        var info = Info(el, cached);
        sb.Append('[').Append(id).Append("] ").Append(Short(info.ControlType));
        string name = OneLine(info.Name, 80);
        if (name.Length > 0) sb.Append(" \"").Append(name).Append('"');
        sb.Append(Describe(el, cached));
        return sb.ToString();
    }

    static readonly ControlType[] Boring = { ControlType.Pane, ControlType.Group, ControlType.Custom };
    static bool walkAll = false;

    // el arrives with its cache filled; children are fetched the same way.
    static void Walk(AutomationElement el, int depth, int maxDepth, int maxNodes, ref int count, ref int hidden, StringBuilder sb)
    {
        if (count >= maxNodes || depth > maxDepth) return;
        AutomationElement.AutomationElementInformation info;
        try { info = el.Cached; } catch { return; }
        if (info.IsOffscreen && depth > 1 && !walkAll) { hidden++; return; }
        string name = (info.Name ?? "").Trim();
        bool boring = Boring.Contains(info.ControlType) && name.Length == 0 && string.IsNullOrEmpty(info.AutomationId);
        int childDepth = depth;
        if (!boring)
        {
            string id = Remember(el);
            count++;
            string ln; try { ln = Line(id, el, true); } catch (Exception ex) { ln = "[" + id + "] (unreadable: " + ex.GetType().Name + ")"; }
            sb.Append(new string(' ', depth * 2)).Append(ln).AppendLine();
            childDepth = depth + 1;
        }
        var cr = Cache();
        AutomationElement child;
        try { child = TreeWalker.ControlViewWalker.GetFirstChild(el, cr); } catch { return; }
        while (child != null && count < maxNodes)
        {
            Walk(child, childDepth, maxDepth, maxNodes, ref count, ref hidden, sb);
            try { child = TreeWalker.ControlViewWalker.GetNextSibling(child, cr); } catch { break; }
        }
    }

    // Every control under root (control view), cached, in reading order, until visit says stop or
    // the time is up. Unlike FindAll(TrueCondition), which fetches the whole tree before the first
    // check (Outlook: 45 s), this can stop. False when it ran out of time.
    static bool Scan(AutomationElement root, Stopwatch watch, long budgetMs, Func<AutomationElement, bool> visit)
    {
        var cr = Cache();
        var stack = new Stack<AutomationElement>();
        try { stack.Push(Cached(root)); } catch { return true; }
        var kids = new List<AutomationElement>();
        while (stack.Count > 0)
        {
            if (watch.ElapsedMilliseconds > budgetMs) return false;
            var el = stack.Pop();
            if (!visit(el)) return true;
            kids.Clear();
            try { for (var c = TreeWalker.ControlViewWalker.GetFirstChild(el, cr); c != null; c = TreeWalker.ControlViewWalker.GetNextSibling(c, cr)) kids.Add(c); } catch { }
            for (int i = kids.Count - 1; i >= 0; i--) stack.Push(kids[i]);
        }
        return true;
    }

    // An exact name (any case), searched inside the app in one round trip: the fast path before a Scan.
    static Condition NameIs(string name, ControlType ct)
    {
        Condition c = new PropertyCondition(AutomationElement.NameProperty, name ?? "", PropertyConditionFlags.IgnoreCase);
        return ct == null ? c : new AndCondition(c, new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
    }
    static List<AutomationElement> FindExact(AutomationElement root, string name, ControlType ct)
    {
        var list = new List<AutomationElement>();
        try { using (Cache().Activate()) foreach (AutomationElement e in root.FindAll(TreeScope.Subtree, NameIs(name, ct))) list.Add(e); } catch { }
        return list;
    }

    // Right-click menus, dropdown lists and ribbon popups are separate top-level windows, not part of
    // the app's window, so a search of the window alone never finds "Rename" after a right-click.
    static List<IntPtr> PopupRoots(long hwnd)
    {
        var owner = new IntPtr(hwnd);
        uint pid; GetWindowThreadProcessId(owner, out pid);
        var found = new List<IntPtr>();
        EnumWindows((h, l) =>
        {
            if (h == owner || !IsWindowVisible(h)) return true;
            var cls = new StringBuilder(64); GetClassName(h, cls, 64);
            string c = cls.ToString();
            uint p2; GetWindowThreadProcessId(h, out p2);
            bool menu = c == "#32768"; // classic menus can belong to another process (the shell)
            if (!menu && p2 != pid) return true;
            if (ShellParts.Contains(c)) return true; // File Explorer shares a process with the taskbar and desktop
            int ex = GetWindowLong(h, -20);
            var t = new StringBuilder(64); GetWindowText(h, t, 64);
            bool popup = menu || c == "Net UI Tool Window" || c.StartsWith("ComboLBox") || t.ToString() == "PopupHost" || (ex & 0x80) != 0 || GetWindow(h, 4) == owner; // GW_OWNER
            if (!popup) return true;
            RECT r; GetWindowRect(h, out r);
            if (r.R - r.L < 20 || r.B - r.T < 10) return true;
            found.Add(h);
            return true;
        }, IntPtr.Zero);
        // Apps keep empty popup shells around; only ones showing something named count.
        var named = new NotCondition(new PropertyCondition(AutomationElement.NameProperty, ""));
        return found.Where(h =>
        {
            try { return AutomationElement.FromHandle(h).FindFirst(TreeScope.Descendants, named) != null; } catch { return false; }
        }).ToList();
    }

    static readonly HashSet<string> ShellParts = new HashSet<string> { "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland" };

    // Search roots for a window: open menus and popups first (they're what's in front), then the window.
    static List<AutomationElement> Roots(long hwnd)
    {
        var list = new List<AutomationElement>();
        foreach (var p in PopupRoots(hwnd)) { try { list.Add(AutomationElement.FromHandle(p)); } catch { } }
        list.Add(AutomationElement.FromHandle(new IntPtr(hwnd)));
        return list;
    }

    // ---------- the words in a window ----------
    // The full text of a document or box (Notepad, Word, a message body), or, for a window with no
    // document, every label and value in reading order. desktop_read shows only the first 80 chars.
    public static string ReadText(string id, long hwnd, int max)
    {
        if (max <= 0) max = 20000;
        AutomationElement el = !string.IsNullOrEmpty(id) ? Ref(id) : AutomationElement.FromHandle(new IntPtr(hwnd));
        string t = TextOf(el, max);
        if (t != null) return Cap(t, max);
        // A whole window: its biggest document if it has one, else everything readable.
        var best = BestDoc(el);
        if (best != null)
        {
            t = TextOf(best, max);
            if (t != null) return t.Trim().Length > 0 ? Cap(t, max) : "(the document is empty)";
        }
        var sb = new StringBuilder();
        var seen = new HashSet<string>();
        // A cached walk (names and values come with each control) that can stop: 8 s at most.
        bool atRoot = true; // the window itself (its title) isn't part of its text
        bool all = Scan(el, Stopwatch.StartNew(), 8000, x =>
        {
            if (atRoot) { atRoot = false; return true; }
            if (sb.Length > max) return false;
            try
            {
                var info = x.Cached;
                if (info.IsOffscreen) return true;
                string s = info.Name ?? "";
                var v = Prop(x, ValuePattern.ValueProperty, true) as string;
                if (!string.IsNullOrEmpty(v)) s = s.Length > 0 ? s + ": " + v : v;
                s = s.Trim();
                if (s.Length > 0 && seen.Add(s)) sb.AppendLine(s);
            }
            catch { }
            return true;
        });
        if (!all) sb.AppendLine("…(stopped after 8 s: the window is very big; pass an id to read one part)");
        return Cap(sb.ToString(), max);
    }

    static string TextOf(AutomationElement el, int max)
    {
        object p;
        try { if (el.TryGetCurrentPattern(TextPattern.Pattern, out p)) return ((TextPattern)p).DocumentRange.GetText(max + 1); } catch { }
        try { if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return ((ValuePattern)p).Current.Value; } catch { }
        return null;
    }

    static string Cap(string s, int max)
    {
        s = (s ?? "").Replace("\r\n", "\n").Replace("\r", "\n");
        return s.Length > max ? s.Substring(0, max) + "\n…(more text: pass a bigger max_chars)" : s;
    }

    // ---------- act by name ----------
    // One call instead of read-then-act: find the control by its name (exact match first, then
    // partial; enabled and visible first; inside an open menu or popup first) and act on it.
    public static string ActByName(long hwnd, string name, string type, int index, string action, string value) { return ActByName(hwnd, name, type, index, action, value, false); }
    public static string ActByName(long hwnd, string name, string type, int index, string action, string value, bool strict)
    {
        name = (name ?? "").Trim();
        var root = AutomationElement.FromHandle(new IntPtr(hwnd));
        ControlType ct = string.IsNullOrEmpty(type) ? null : ControlTypeByName(type);
        // With a popup covering the window, a name like "Close" means the popup's, not the window's.
        string bdesc;
        var blocker = FindBlocker(root, out bdesc);
        var inPopup = new HashSet<string>();
        if (blocker != null)
        {
            Condition bc = ct == null ? Condition.TrueCondition : new PropertyCondition(AutomationElement.ControlTypeProperty, ct);
            try { foreach (AutomationElement e in blocker.FindAll(TreeScope.Descendants, bc)) inPopup.Add(Key(e)); } catch { }
        }
        var roots = Roots(hwnd);
        var hits = new List<KeyValuePair<int, AutomationElement>>();
        // Exact match 0, starts with it 10, contains it 20; worse when disabled, offscreen, or behind a popup.
        Func<AutomationElement, bool, int> score = (el, isMenu) =>
        {
            var info = el.Cached;
            string n = (info.Name ?? "").Trim();
            if (n.Length == 0) return -1;
            if (ct != null && info.ControlType != ct) return -1;
            int s;
            if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) s = 0;
            else if (n.StartsWith(name, StringComparison.OrdinalIgnoreCase)) s = 10;
            else if (n.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) s = 20;
            else return -1;
            if (!info.IsEnabled) s += 5;
            if (info.IsOffscreen) s += 3;
            if (isMenu) s -= 2;
            else if (blocker != null && !inPopup.Contains(Key(el))) s += 30;
            return s;
        };
        // Fast path: the exact name, found inside the app. Good enough when the best exact hit can't
        // be beaten by a partial one (those score 8 at best) and there are enough for index.
        var exactKeys = new HashSet<string>();
        for (int ri = 0; ri < roots.Count; ri++)
            foreach (var el in FindExact(roots[ri], name, ct))
            {
                try { int s = score(el, ri < roots.Count - 1); if (s >= 0) { hits.Add(new KeyValuePair<int, AutomationElement>(s, el)); exactKeys.Add(Key(el)); } } catch { }
            }
        bool partial = false;
        if (hits.Count <= Math.Max(index, 0) || hits.Min(h => h.Key) >= 8)
        {
            // Partial names: walk the window, at most 6 s, keeping what was found by then.
            var watch = Stopwatch.StartNew();
            for (int ri = 0; ri < roots.Count && !partial; ri++)
            {
                bool isMenu = ri < roots.Count - 1;
                partial = !Scan(roots[ri], watch, 6000, el =>
                {
                    try
                    {
                        int s = score(el, isMenu);
                        if (s < 0) return true;
                        // Exact ones the fast path already has would be counted twice.
                        if (exactKeys.Count > 0 && string.Equals((el.Cached.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase) && exactKeys.Contains(Key(el))) return true;
                        hits.Add(new KeyValuePair<int, AutomationElement>(s, el));
                    }
                    catch { }
                    return true;
                });
            }
        }
        if (hits.Count == 0) throw new ArgumentException("No control named \"" + name + "\"" + (string.IsNullOrEmpty(type) ? "" : " of type " + type) + " in that window" + (partial ? " (searched for 6 s; the window is very big: desktop_read with an id reads one part)" : "") + ". desktop_find lists close names.");
        var ordered = hits.OrderBy(h => h.Key).ToList();
        var pick = ordered[Math.Min(Math.Max(index, 0), ordered.Count - 1)].Value;
        string id = Remember(pick);
        if (action == "where") return id + "|" + Act(id, "where", null);
        string what = Line(id, pick, true);
        string r = Act(id, action, value, strict);
        // Show the control as it is now (a checkbox that just turned on), unless it went away (a dialog closed).
        // Only actions that change what the line shows are worth waiting for.
        if (ChangesState(action, pick)) WaitUntil(() => Line(id, pick, false) != what, 150);
        try { what = Line(id, pick, false); } catch { }
        string more = ordered.Count > 1 && ordered[1].Key == ordered[0].Key && index == 0 ? " (" + ordered.Count + " matched; this was the first: pass index to pick another)" : "";
        return r + ": " + what + more;
    }
    // A plain button's line looks the same after a click: waiting for it to change would only add time.
    static bool ChangesState(string a, AutomationElement el)
    {
        if (a == "check" || a == "uncheck" || a == "set_value" || a == "select" || a == "expand" || a == "collapse") return true;
        if (a != "click" && a != "invoke") return false;
        return Has(Prop(el, TogglePattern.ToggleStateProperty, true)) || Has(Prop(el, SelectionItemPattern.IsSelectedProperty, true)) || Has(Prop(el, ExpandCollapsePattern.ExpandCollapseStateProperty, true));
    }

    static ControlType ControlTypeByName(string t)
    {
        foreach (var f in typeof(ControlType).GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
            if (string.Equals(f.Name, t, StringComparison.OrdinalIgnoreCase)) return (ControlType)f.GetValue(null);
        return null;
    }

    // A popup or dialog covering a window ("What's new", "License expired", a Save dialog) swallows
    // keystrokes meant for the window underneath. Name it, with its buttons, so it gets handled first.
    public static string Blocker(long hwnd)
    {
        string desc;
        FindBlocker(AutomationElement.FromHandle(new IntPtr(hwnd)), out desc);
        return desc;
    }

    static AutomationElement FindBlocker(AutomationElement root, out string desc)
    {
        desc = "";
        bool rootDisabled = false;
        try { rootDisabled = !root.Current.IsEnabled; } catch { }
        var wins = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window));
        foreach (AutomationElement w in wins)
        {
            try
            {
                var info = w.Current;
                if (info.IsOffscreen) continue;
                var r = info.BoundingRectangle;
                if (r.IsEmpty || r.Width < 80 || r.Height < 60) continue;
                bool modal = false;
                object wp;
                if (w.TryGetCurrentPattern(WindowPattern.Pattern, out wp)) { try { modal = ((WindowPattern)wp).Current.IsModal; } catch { } }
                if (!(modal || rootDisabled || string.Equals(info.Name, "Popup", StringComparison.OrdinalIgnoreCase))) continue;
                var names = new List<string>();
                foreach (AutomationElement b in w.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)))
                {
                    try { var n = b.Current.Name; if (!string.IsNullOrEmpty(n) && !names.Contains(n) && names.Count < 6) names.Add(n); } catch { }
                }
                string label = info.Name;
                if (string.IsNullOrEmpty(label) || label == "Popup") label = TitleText(w);
                if (names.Count == 0 && string.IsNullOrEmpty(label)) continue; // an empty shell, not the real popup
                desc = "\"" + OneLine(label, 70) + "\"" + (names.Count > 0 ? " (buttons: " + string.Join(", ", names) + ")" : "");
                return w;
            }
            catch { }
        }
        return null;
    }

    static string Key(AutomationElement e) { try { return string.Join(".", e.GetRuntimeId()); } catch { return ""; } }

    // The window's main document or text box: what "type into this window" means.
    static AutomationElement BestDoc(AutomationElement root)
    {
        AutomationElement best = null; double bestArea = 0;
        var docs = root.FindAll(TreeScope.Descendants, new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)));
        foreach (AutomationElement d in docs)
        {
            try
            {
                var info = d.Current;
                if (info.IsOffscreen || !info.IsEnabled) continue;
                object tmp;
                if (!d.TryGetCurrentPattern(TextPattern.Pattern, out tmp) && !d.TryGetCurrentPattern(ValuePattern.Pattern, out tmp)) continue;
                var r = info.BoundingRectangle; double a = r.IsEmpty ? 0 : r.Width * r.Height;
                if (info.ControlType == ControlType.Document) a *= 4;
                if (a > bestArea) { bestArea = a; best = d; }
            }
            catch { }
        }
        return bestArea > 40000 ? best : null;
    }

    // A popup's title is usually its shallowest text ("New in Notepad"), not the first one in the tree.
    static string TitleText(AutomationElement w)
    {
        var level = new List<AutomationElement> { w };
        for (int d = 0; d < 4 && level.Count > 0; d++)
        {
            var next = new List<AutomationElement>();
            foreach (var e in level)
            {
                AutomationElement c = null;
                try { c = TreeWalker.ControlViewWalker.GetFirstChild(e); } catch { }
                while (c != null && next.Count < 200)
                {
                    try { if (c.Current.ControlType == ControlType.Text && !string.IsNullOrEmpty(c.Current.Name)) return c.Current.Name; } catch { }
                    next.Add(c);
                    try { c = TreeWalker.ControlViewWalker.GetNextSibling(c); } catch { c = null; }
                }
            }
            level = next;
        }
        return "";
    }

    public static string WindowAction(long hwnd, string action)
    {
        var root = AutomationElement.FromHandle(new IntPtr(hwnd));
        object p;
        if (!root.TryGetCurrentPattern(WindowPattern.Pattern, out p)) throw new InvalidOperationException("That window can't be closed or resized that way; use its own buttons.");
        var w = (WindowPattern)p;
        switch (action)
        {
            case "close_window": w.Close(); return "asked it to close (if it has unsaved work it may ask first: read it again)";
            case "minimize": w.SetWindowVisualState(WindowVisualState.Minimized); return "minimized";
            case "maximize": w.SetWindowVisualState(WindowVisualState.Maximized); return "maximized";
            case "restore": w.SetWindowVisualState(WindowVisualState.Normal); return "restored";
        }
        throw new ArgumentException("Unknown window action " + action);
    }

    // The top-level window a control lives in.
    static IntPtr TopWindow(AutomationElement el)
    {
        IntPtr found = IntPtr.Zero;
        try
        {
            for (var e = el; e != null && !Automation.Compare(e, AutomationElement.RootElement); e = TreeWalker.ControlViewWalker.GetParent(e))
            {
                int h = e.Current.NativeWindowHandle;
                if (h != 0) found = GetAncestor(new IntPtr(h), 2); // GA_ROOT
                if (found != IntPtr.Zero) break;
            }
        }
        catch { }
        return found;
    }

    // Before typing into a control: its window must be in front, or the keys go somewhere else.
    static void EnsureTarget(AutomationElement el)
    {
        var top = TopWindow(el);
        if (top == IntPtr.Zero || IsPopupWindow(top)) return; // can't tell, or a dropdown that activating would close
        if (GetAncestor(GetForegroundWindow(), 2) != top && !Focus(top.ToInt64()))
        {
            var sb = new StringBuilder(256); GetWindowText(top, sb, 256);
            throw new InvalidOperationException("Couldn't bring \"" + sb + "\" to the front, so nothing was typed. Try desktop_focus, or click the window.");
        }
    }

    // Typing goes wherever the keyboard focus is, which may be the window the person is using.
    // Focusing the target first keeps it from landing in their chat. Throws when it can't.
    public static string FocusFor(string id, long hwnd)
    {
        if (!string.IsNullOrEmpty(id)) { var el = Ref(id); EnsureTarget(el); FocusEl(el); return "focused " + id; }
        if (hwnd == 0) return "";
        if (!Focus(hwnd)) // Focus waits for the app to catch up
        {
            var sb = new StringBuilder(256); GetWindowText(new IntPtr(hwnd), sb, 256);
            throw new InvalidOperationException("Couldn't bring \"" + sb + "\" to the front, so nothing was typed. Try desktop_focus, or click the window.");
        }
        var root = AutomationElement.FromHandle(new IntPtr(hwnd));
        try
        {
            var f = AutomationElement.FocusedElement;
            var ct = f == null ? null : f.Current.ControlType;
            bool editable = ct == ControlType.Edit || ct == ControlType.Document || ct == ControlType.ComboBox || ct == ControlType.DataItem;
            bool inside = false;
            for (var e = f; e != null && !inside; e = TreeWalker.ControlViewWalker.GetParent(e)) inside = Automation.Compare(e, root);
            if (!editable || !inside)
            {
                var doc = BestDoc(root);
                if (doc != null) { FocusEl(doc); return "focused its text"; }
            }
        }
        catch { }
        return "focused";
    }

    // SetFocus, then wait (briefly) until it has the keyboard, so the first keys don't land elsewhere.
    static void FocusEl(AutomationElement el)
    {
        el.SetFocus();
        WaitUntil(() => el.Current.HasKeyboardFocus, 150);
    }

    // Find controls anywhere in a window (and its open menus) by (partial) name, without dumping the whole tree.
    // Exact names come first (found inside the app, one round trip), then partial ones from a walk
    // that stops at budgetMs with what it has.
    public static string Find(long hwnd, string text, int limit) { return Find(hwnd, text, limit, 6000); }
    public static string Find(long hwnd, string text, int limit, int budgetMs)
    {
        if (!IsWindow(new IntPtr(hwnd))) throw new InvalidOperationException("That window is closed. Call desktop_windows for the current ones.");
        text = (text ?? "").Trim();
        if (limit <= 0) limit = 25;
        if (budgetMs <= 0) budgetMs = 6000;
        var sb = new StringBuilder();
        int n = 0;
        var roots = Roots(hwnd);
        var exact = new HashSet<string>();
        foreach (var root in roots)
        {
            foreach (var el in FindExact(root, text, null))
            {
                if (n >= limit) break;
                try { sb.AppendLine(Line(Remember(el), el, true)); exact.Add(Key(el)); n++; } catch { }
            }
        }
        var watch = Stopwatch.StartNew();
        bool done = true;
        foreach (var root in roots)
        {
            if (n >= limit) break;
            done = Scan(root, watch, budgetMs, el =>
            {
                try
                {
                    var info = el.Cached;
                    string nm = info.Name ?? "";
                    string hay = nm + "\u0001" + (info.AutomationId ?? "");
                    if (hay.IndexOf(text, StringComparison.OrdinalIgnoreCase) < 0) return true;
                    if (exact.Count > 0 && string.Equals(nm, text, StringComparison.OrdinalIgnoreCase) && exact.Contains(Key(el))) return true;
                    sb.AppendLine(Line(Remember(el), el, true));
                    n++;
                }
                catch { }
                return n < limit;
            }) && done;
            if (!done) break;
        }
        if (!done) sb.AppendLine("…(stopped searching after " + budgetMs / 1000.0 + " s: read one part with desktop_read id)");
        return n == 0 ? (done ? "No controls match." : "No controls match so far (stopped searching after " + budgetMs / 1000.0 + " s: read one part with desktop_read id).") : sb.ToString();
    }

    // desktop_wait: poll (every 200 ms) until a visible control named this (exact, then containing it)
    // shows up in the window or its popups, or with gone, until none is left. "" when time ran out.
    public static string WaitFor(long hwnd, string name, bool gone, int timeoutMs)
    {
        name = (name ?? "").Trim();
        if (name.Length == 0) throw new ArgumentException("Say what to wait for (name).");
        var watch = Stopwatch.StartNew();
        while (true)
        {
            if (!IsWindow(new IntPtr(hwnd)))
            {
                if (gone) return "gone (the window closed)";
                throw new InvalidOperationException("That window is closed. Call desktop_windows for the current ones.");
            }
            AutomationElement hit = null;
            bool sure = false; // a walk that ran out of time can't prove it's gone
            try { hit = Visible(hwnd, name, out sure); } catch { }
            if (gone && hit == null && sure) return "gone";
            if (!gone && hit != null) { try { return Line(Remember(hit), hit, true); } catch { return "appeared"; } }
            if (watch.ElapsedMilliseconds >= timeoutMs) return "";
            System.Threading.Thread.Sleep(200);
        }
    }
    static AutomationElement Visible(long hwnd, string name, out bool sure)
    {
        sure = true;
        var roots = Roots(hwnd);
        var shown = new PropertyCondition(AutomationElement.IsOffscreenProperty, false);
        foreach (var r in roots)
        {
            AutomationElement e = null;
            try { using (Cache().Activate()) e = r.FindFirst(TreeScope.Subtree, new AndCondition(NameIs(name, null), shown)); } catch { }
            if (e != null) return e;
        }
        // Partial names ("Saved" in "Saved to OneDrive"): a short cached walk each round.
        AutomationElement found = null;
        var w = Stopwatch.StartNew();
        bool done = true;
        foreach (var r in roots)
        {
            done = Scan(r, w, 600, el =>
            {
                try { var i = el.Cached; if (!i.IsOffscreen && (i.Name ?? "").IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) { found = el; return false; } } catch { }
                return true;
            });
            if (found != null || !done) break;
        }
        sure = done;
        return found;
    }

    static AutomationElement Ref(string id)
    {
        AutomationElement el;
        if (!refs.TryGetValue(id, out el)) throw new ArgumentException("Unknown element " + id + ". Read the window again (desktop_read) for fresh ids, or act by name.");
        return el;
    }

    // Security prompts are the person's to answer: Windows asks there because a program may be unsafe.
    static readonly string[] SecurityPrompts = { "Windows protected your PC", "Security Warning", "User Account Control", "SmartScreen", "Do you want to allow this app" };
    static void RefuseSecurityPrompt(AutomationElement el)
    {
        var top = TopWindow(el);
        if (top == IntPtr.Zero) return;
        var sb = new StringBuilder(256); GetWindowText(top, sb, 256);
        string t = sb.ToString();
        foreach (var s in SecurityPrompts)
            if (t.IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0)
                throw new InvalidOperationException("That is a Windows security prompt (\"" + t + "\"). Only the person should answer it: tell them what it is asking and let them click.");
    }

    // Invoke can block until a dialog the click opened is closed (UI Automation waits for the app).
    // Don't let that freeze every later call.
    static string InvokeWithTimeout(InvokePattern ip)
    {
        var task = Task.Run(() => ip.Invoke());
        try { if (task.Wait(4000)) return "invoked"; }
        catch (AggregateException ex) { throw ex.InnerException ?? ex; }
        return "invoked (the app is still busy, maybe a dialog opened: read the window again)";
    }

    public static string Act(string id, string action, string value) { return Act(id, action, value, false); }
    // strict (desktop_batch): a greyed-out control stops the run instead of being clicked to no effect.
    public static string Act(string id, string action, string value, bool strict)
    {
        var el = Ref(id);
        object p;
        try { var _probe = el.Current.ControlType; }
        catch (ElementNotAvailableException) { throw new InvalidOperationException("That control is gone (the window changed). Read the window again."); }
        RefuseSecurityPrompt(el);
        if (action == "where")   // where it is on screen, so Stead's buddy can walk over before it's clicked
        {
            var b = el.Current.BoundingRectangle;
            return (int)b.X + "," + (int)b.Y + "," + (int)b.Width + "," + (int)b.Height;
        }
        if (strict && !el.Current.IsEnabled && action != "scroll_into_view")
            throw new InvalidOperationException("\"" + OneLine(el.Current.Name, 60) + "\" is disabled (greyed out), so nothing was done.");
        switch (action)
        {
            case "click":
            case "invoke":
                if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) return InvokeWithTimeout((InvokePattern)p);
                if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggled"; }
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "selected"; }
                if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return "expanded"; }
                return ClickCenter(el, "left", 1);
            case "real_click":
                return ClickCenter(el, "left", 1);
            case "right_click":
                ClickCenter(el, "right", 1); return "right-clicked (read the window again: its menu is listed under \"Open menu or popup\")";
            case "double_click":
                ClickCenter(el, "left", 2); return "double-clicked";
            case "set_value":
                // Setting a whole document's value would wipe it. Make that a deliberate choice.
                if (el.Current.ControlType == ControlType.Document)
                    throw new InvalidOperationException("That is a whole document: set_value would replace everything in it. To add or change part of it, click into it (or focus) and use desktop_type / desktop_keys. To really replace all of it, use action replace_all.");
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly)
                {
                    var vp = (ValuePattern)p;
                    string v = value ?? "";
                    // Type it like a person when it's short: setting the value directly changes the box's
                    // text without telling the app, and some apps then ignore it (the Save As dialog saved
                    // under its old name with the new path showing in the box).
                    bool typed = false;
                    if (v.Length <= 400 && v.IndexOf('\n') < 0 && el.Current.IsKeyboardFocusable && InputBlocked().Length == 0)
                    {
                        // Inside the try: if the window can't be brought forward, SetValue below still works.
                        try { EnsureTarget(el); SelectAllAndPut(el, v); typed = true; } catch { }
                    }
                    string now = "";
                    try { now = vp.Current.Value ?? ""; } catch { }
                    if (typed && now == v) return "value set";
                    vp.SetValue(v);
                    return "value set";
                }
                if (el.TryGetCurrentPattern(RangeValuePattern.Pattern, out p) && !((RangeValuePattern)p).Current.IsReadOnly)
                {
                    double d;
                    if (!double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) throw new ArgumentException("That control takes a number.");
                    ((RangeValuePattern)p).SetValue(d);
                    return "value set";
                }
                EnsureTarget(el);
                SelectAllAndPut(el, value ?? "");
                return "typed";
            case "replace_all":
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly) { ((ValuePattern)p).SetValue(value ?? ""); return "replaced"; }
                EnsureTarget(el);
                SelectAllAndPut(el, value ?? "");
                return "replaced";
            case "check":
            case "uncheck":
            {
                bool on = action == "check";
                if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p))
                {
                    var want = on ? ToggleState.On : ToggleState.Off;
                    for (int i = 0; i < 3 && ((TogglePattern)p).Current.ToggleState != want; i++) ((TogglePattern)p).Toggle();
                    return ((TogglePattern)p).Current.ToggleState == want ? (on ? "on" : "off") : "could not change it";
                }
                // Radio buttons and list items: on means selected. Click only when it's the other way,
                // so "check" on one that's already on never turns it off.
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p))
                {
                    var si = (SelectionItemPattern)p;
                    if (si.Current.IsSelected == on) return (on ? "already on" : "already off");
                    if (on) si.Select(); else { try { si.RemoveFromSelection(); } catch { ClickCenter(el, "left", 1); } }
                    WaitUntil(() => si.Current.IsSelected == on, 300);
                    return si.Current.IsSelected == on ? (on ? "on" : "off") : "could not change it";
                }
                return Act(id, "click", value, strict) + " (it has no on/off state Stead can read, so this can't be verified: read it again)";
            }
            case "collapse":
                if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Collapse(); return "collapsed"; }
                return "not collapsible";
            case "focus":
                EnsureTarget(el); el.SetFocus(); return "focused";
            case "expand":
                if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return "expanded"; }
                return ClickCenter(el, "left", 1);
            case "select":
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "selected"; }
                return ClickCenter(el, "left", 1);
            case "scroll_into_view":
                if (el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { ((ScrollItemPattern)p).ScrollIntoView(); return "scrolled"; }
                return "not scrollable";
            case "scroll_down":
            case "scroll_up":
                if (el.TryGetCurrentPattern(ScrollPattern.Pattern, out p))
                {
                    ((ScrollPattern)p).ScrollVertical(action == "scroll_down" ? ScrollAmount.LargeIncrement : ScrollAmount.LargeDecrement);
                    return "scrolled";
                }
                {
                    var r = el.Current.BoundingRectangle;
                    if (r.IsEmpty) throw new InvalidOperationException("That control has no position on screen.");
                    Scroll((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), action == "scroll_down" ? 3 : -3);
                    return "scrolled";
                }
            default:
                throw new ArgumentException("Unknown action " + action);
        }
    }

    // Select all, then the new text in one go: typed when short, pasted when long or multi-line, so
    // there is no window where the old text is gone and the new text is half in.
    static void SelectAllAndPut(AutomationElement el, string v)
    {
        FocusEl(el);
        Keys("ctrl+a");
        if (v.Length > 50 || v.IndexOf('\n') >= 0) PasteText(v);
        else if (v.Length > 0) TypeText(v);
        else KeyTap(0x2E); // delete
    }

    static string ClickCenter(AutomationElement el, string button, int count)
    {
        object p;
        if (el.Current.IsOffscreen && el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { try { ((ScrollItemPattern)p).ScrollIntoView(); WaitUntil(() => !el.Current.IsOffscreen, 300); } catch { } }
        var r = el.Current.BoundingRectangle;
        if (r.IsEmpty) throw new InvalidOperationException("That control has no position on screen.");
        var top = TopWindow(el);
        // Bring its window forward so nothing covers the spot, but never a menu or dropdown: those
        // close when something else is activated.
        if (top != IntPtr.Zero && GetAncestor(GetForegroundWindow(), 2) != top && !IsPopupWindow(top)) Focus(top.ToInt64());
        Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), button, count, top.ToInt64());
        return "clicked";
    }

    static bool IsPopupWindow(IntPtr h)
    {
        var cls = new StringBuilder(64); GetClassName(h, cls, 64);
        var t = new StringBuilder(64); GetWindowText(h, t, 64);
        string c = cls.ToString();
        return c == "#32768" || c == "Net UI Tool Window" || c.StartsWith("ComboLBox") || t.ToString() == "PopupHost" || (GetWindowLong(h, -20) & 0x80) != 0;
    }
}
