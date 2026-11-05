// Stead, on screen: a little pixel character that lives on top of your windows. It walks along their
// top edges, climbs their sides, hangs off their corners, rides a window when you drag it, falls when
// the window goes away, sleeps when you're idle and pops up a speech bubble to talk. It keeps out of
// your way: click near it and it hops aside; click it while it's covering a button and it jumps off
// and your click goes through. Click it otherwise and you get its menu (Menu.cs); pick CHAT and it
// hauls a chat window up in the bottom-right of the screen (Chat.cs). It can also read and fill the form in
// front of you (UI Automation) and take a screenshot for the brain.
//
// This is the engine: physics, windows, clicks, messages. What it looks like is a Character
// (Character.cs), one folder per look under ../characters, one file per move.
//
// Compiled on the person's own machine by the C# compiler that ships with Windows (.NET Framework 4,
// so C# 5: no $"", no ?.), from these files, by ../index.js. Nothing to download, nothing prebuilt.
//
// It is only the body. The brain is Node (../index.js): one warm Claude session that reads state.json
// (what's on screen) and writes messages into inbox/. What you do goes back through outbox.jsonl.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

static class Native {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  // Leaves the window out of screenshots and screen capture (Windows 10 2004 and later).
  public static bool HideFromCapture(IntPtr h) { try { return SetWindowDisplayAffinity(h, 0x11); } catch { return false; } }
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, ref Point l);
  [DllImport("user32.dll")] public static extern int GetScrollPos(IntPtr h, int bar);
  [DllImport("user32.dll")] public static extern bool GetScrollRange(IntPtr h, int bar, out int min, out int max);
  [DllImport("user32.dll", EntryPoint = "SendMessage")] static extern IntPtr SendMsg(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  // Move a borderless window the way Windows moves one by its title bar.
  public static void Drag(IntPtr h) { ReleaseCapture(); SendMsg(h, 0xA1, new IntPtr(2), IntPtr.Zero); }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);

  public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  // The visible frame, without the invisible resize borders GetWindowRect includes on Windows 10/11.
  public static Rectangle Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r);
    return Rectangle.FromLTRB(r.L, r.T, r.R, r.B);
  }
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  // 1 locked/away, 2-3 full-screen app, 4 presentation mode, 5 free, 6 quiet time, 7 full-screen store app.
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
  public static int NotifState() { int n; try { return SHQueryUserNotificationState(out n) == 0 ? n : 0; } catch { return 0; } }
  // Some app other than her is using the mic right now (a call): Windows notes each use under the
  // privacy ConsentStore, with LastUsedTimeStop 0 while it's still in use. Read-only, HKCU.
  public static bool MicInUse() {
    const string K = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    try {
      using (var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(K)) {
        if (root == null) return false;
        if (Live(root, false)) return true;
        using (var np = root.OpenSubKey("NonPackaged")) if (np != null && Live(np, true)) return true;
      }
    } catch { }
    return false;
  }
  static bool Live(Microsoft.Win32.RegistryKey k, bool skipMe) {
    foreach (var n in k.GetSubKeyNames()) {
      if (n == "NonPackaged" || (skipMe && n.IndexOf("#stead-", StringComparison.OrdinalIgnoreCase) >= 0)) continue;
      try {
        using (var a = k.OpenSubKey(n)) {
          if (a == null) continue;
          object start = a.GetValue("LastUsedTimeStart"), stop = a.GetValue("LastUsedTimeStop");
          if (start is long && (long)start != 0 && stop is long && (long)stop == 0) return true;
        }
      } catch { }
    }
    return false;
  }

  // Make h the window you're typing into. Windows only lets the app you're already using do that, so
  // borrow its input queue for a moment (no Alt-key trick: that opens menu bars in other apps).
  public static void ForceForeground(IntPtr h) {
    var fg = GetForegroundWindow();
    if (fg == h) return;
    uint pid, me = GetCurrentThreadId(), ft = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out pid);
    bool att = ft != 0 && ft != me && AttachThreadInput(me, ft, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (att) AttachThreadInput(me, ft, false);
  }
  public static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  public static uint IdleMs() {
    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    return GetLastInputInfo(ref i) ? (uint)Environment.TickCount - i.dwTime : 0;
  }
}

// A window she can stand on. Z is its place in the stack: 0 is the frontmost.
class Win { public IntPtr H; public Rectangle R; public int Z; }

enum St { Appear, Stand, Walk, Crouch, Jump, Fall, Land, Sit, Drag, Vanish, Hang, Climb, Wave, Stretch, Dance, Look, Leap, Perch, Blink, Type, Pull, Peep, Trip, Ceil, Press, Camp, Grab, Throw }

class Stead : Form {
  const int GW = Character.GW, GH = Character.GH;   // the sprite grid
  static readonly Color KEY = Character.KEY;          // see-through (and click-through) color
  static readonly Color INK = Character.INK, GLOW = Character.GLOW;
  // Where her hands are when she hangs: this many sprite pixels ahead of her middle.
  const double HAND = 5.5;

  readonly string dir, inbox, outbox, statePath;
  readonly int watchPid;
  int sc;                             // screen pixels per sprite pixel
  double k;                           // physics scale (1.0 at scale 3)
  int baseSc;                         // sc from the screen's dpi; a detailed look (Res 2) rounds it up to even
  Bitmap frame = new Bitmap(GW, GH);
  readonly Random rnd = new Random();
  double[] rank = new double[GW * GH];
  readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
  readonly JavaScriptSerializer json = new JavaScriptSerializer();
  readonly Bubble bubble;
  readonly RetroMenu menu;
  readonly Ring ring = new Ring();   // what she rings on your screen when she shows you where something is
  readonly ChatWindow chat;

  St st = St.Appear;
  double x, y, vx, vy;                // feet, bottom-centre, screen pixels
  int facing = 1, tick, actTicks, stTicks, blinkAt = 60, blinkLeft;
  IntPtr on = IntPtr.Zero;            // the window we're standing on (Zero = the taskbar/ground)
  Rectangle onRect;
  List<Win> wins = new List<Win>();
  double progress;                    // appear/vanish 0..1
  bool thinking, hidden, quitting, happyHover;
  Point grab, downAt; bool mouseDown; double dragVx, dragVy; Point lastCur;
  int idleSleep;                      // >0 while asleep
  DateTime lastState = DateTime.MinValue, lastTopmost = DateTime.MinValue, lastWatch = DateTime.Now;
  string fgTitle = "", fgProc = "", fgUrl = "", urlFor = ""; bool fgFull; IntPtr fgH;
  bool urlBusy;
  IntPtr wall = IntPtr.Zero;          // the window we're climbing or hanging from
  Rectangle wallRect; int side;       // side: -1 its left edge, +1 its right edge
  int climbDir, climbRest;            // -1 up, +1 down; ticks before it fancies another climb
  bool lmb, throughUntilSet; DateTime throughUntil;
  List<AutomationElement> found = new List<AutomationElement>();
  static readonly object outLock = new object();
  // Leaping to a point on a fixed arc (to a click target, a bar, or across the taskbar).
  double lx0, ly0, ltx, lty, lvy; int lT; bool leapPerch; IntPtr leapOn;
  string goId;                        // the brain is waiting for her to get to a click target
  bool stomp; int danceFace = 1;
  // Which take on a move this is (picked fresh each time she starts one), and the variations the
  // engine itself picks: creeping instead of walking, a yawn instead of a stretch, how she sits.
  int variant, sitKind, held;          // sitKind: 0 sit, 1 legs over the edge, 2 knees hugged; held: ticks dragged without moving
  bool thrown, creeping, yawning, chasing, leapCeil;
  // An errand on the taskbar: run to X, hop on it, open the app there (or press Start).
  class Errand { public string Id, Name; public double X; public AutomationElement El; }
  Errand errand;
  Rectangle fgBar, fgBarFrame;        // the browser's address bar, something to hang off
  // Somewhere to get to along the taskbar: she runs there, then hops the rest.
  class Trip { public double X, Y; public bool Perch; public IntPtr On; }
  Trip trip;
  const int BLINK = 7, SQUASH = 10;
  int codeLeft;                       // ticks left of working on code: glasses on, at her laptop (the brain keeps topping it up)
  int typeLeft;                       // ticks left of tapping away at a keyboard                // ticks to break up into pixels (and the same to come back)
  // What she looks like (a Character, by name), their color for it, what she's called, and whether she
  // wanders about. Saved in look.json.
  string model = "orb", called = "Stead"; Color tint = Color.Empty; bool roam = true;
  // Her voice: off unless they turn it on (saved in look.json). Made only when on, so with it off
  // nothing about her changes. notif and inCall: is now a time to talk (see ../attention.js).
  bool voiceOn; Voice voice; int notif; bool inCall; DateTime micAt;
  Character ch; bool drawFailed;
  bool formHere;                      // the brain sees a form in front: the menu offers to fill it
  int pulling; DateTime pullAt; double pullFrom;   // on her way to haul the chat window up
  // Not clicked for a while: she phases out and peeps up over the bottom of the screen for a bit.
  DateTime touchedAt = DateTime.Now, peepAfter = DateTime.Now.AddMinutes(4); bool leapPeep;
  // A window that just opened: she peeks over its top edge at it. peekWin is the one she's behind.
  HashSet<IntPtr> known; IntPtr newWin, peekWin; Rectangle peekRect; DateTime newAt, peekAfter = DateTime.Now.AddSeconds(20);
  string mood = ""; int moodLeft;
  // Her own little things: a campfire in her corner, the mouse pointer she sometimes steals, windows
  // dragged into her, the pencil she writes into blanks with.
  readonly Fire fire = new Fire();
  double fireX; DateTime campAfter = DateTime.Now.AddMinutes(3), grabAfter = DateTime.Now.AddMinutes(6), knockAfter;
  Point mouseSet, mouseFrom; double mvx, mvy, mpx, mpy;
  IntPtr knockH; Rectangle knockR;
  int writeLeft;

  public Stead(string dir, int watchPid) {
    this.dir = dir; this.watchPid = watchPid;
    inbox = Path.Combine(dir, "inbox"); outbox = Path.Combine(dir, "outbox.jsonl"); statePath = Path.Combine(dir, "state.json");
    Directory.CreateDirectory(inbox);
    using (var g = CreateGraphics()) baseSc = sc = Math.Max(2, (int)Math.Round(3 * g.DpiX / 96.0));
    k = sc / 3.0;
    LoadLook();
    Rescale();

    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
    BackColor = KEY; TransparencyKey = KEY; DoubleBuffered = true;
    ClientSize = new Size(GW * sc, GH * sc);
    Text = "Stead";

    // Start on the taskbar near the right, above the clock.
    var wa = Screen.PrimaryScreen.WorkingArea;
    x = wa.Right - 160 * k; y = wa.Bottom;
    LoadSpot();   // the orb they put somewhere: back exactly there
    Place();

    bubble = new Bubble(this);
    menu = new RetroMenu(this);
    chat = new ChatWindow(this);
    Native.HideFromCapture(bubble.Handle); Native.HideFromCapture(menu.Handle);
    // Twice as fast as she thinks: every other tick only keeps her on the window she's riding, so she
    // moves with it smoothly while you drag it.
    timer.Interval = 15; timer.Tick += delegate { if (++half % 2 == 0) Step(); else Ride(); };
    timer.Start();
    File.WriteAllText(Path.Combine(dir, "body.pid"), Process.GetCurrentProcess().Id.ToString());
  }

  protected override CreateParams CreateParams {
    get { var cp = base.CreateParams; cp.ExStyle |= 0x80 | 0x08000000 | 0x8; return cp; } // toolwindow, noactivate, topmost
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); seeing = Native.HideFromCapture(Handle); }

  public string Called { get { return called; } }
  public string Model { get { return model; } }
  public bool Roam { get { return roam; } }
  public bool VoiceOn { get { return voiceOn; } }
  public bool FormHere { get { return formHere; } }
  Character Ch { get { if (ch == null) ch = Character.Make(model) ?? Character.Make("orb"); return ch; } }

  public Point Head() { return new Point((int)x, (int)(y - (GH - 3) * sc)); }
  public string Dir { get { return dir; } }
  public Point Center() { return new Point((int)x, (int)(y - GH * sc / 2.0)); }   // her middle (the menu's arc comes out of it)
  public int BodyR { get { return GH * sc / 2; } }
  public Rectangle Work() { return Screen.FromPoint(new Point((int)x, (int)y - 4)).WorkingArea; }

  void Place() {
    int sink = (Ch.Below >= 0 ? Ch.Below : st == St.Sit && !(prep > 0 && stTicks < prep) ? 2 : 0) * sc;   // sitting: feet hang over the edge
    Location = new Point((int)Math.Round(x - GW * sc / 2.0), (int)Math.Round(y - GH * sc + sink));
  }

  // ---------- the world: windows to stand on ----------
  void Scan() {
    var list = new List<Win>();
    var me = Handle; var bh = bubble.Handle; var mh = menu.Handle;
    int z = 0;
    Native.EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (h == me || h == bh || h == mh || !Native.IsWindowVisible(h) || Native.IsIconic(h) || Native.Cloaked(h)) return true;
      int ex = Native.GetWindowLong(h, -20);
      if ((ex & 0x80) != 0 || (ex & 0x20) != 0) return true;   // tool windows, click-through overlays
      string cls = Native.Class(h);
      if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return true;
      if (Native.Text(h).Length == 0) return true;
      var r = Native.Frame(h);
      if (r.Width < 160 || r.Height < 90) return true;
      list.Add(new Win { H = h, R = r, Z = z++ });
      return true;
    }, IntPtr.Zero);
    wins = list;
    if (known == null) { known = new HashSet<IntPtr>(); foreach (var w in list) known.Add(w.H); return; }
    foreach (var w in list) if (known.Add(w.H) && w.Z == 0 && w.H != chat.Handle) { newWin = w.H; newAt = DateTime.Now; }
  }

  // Can you see this point, or is a window in front of it?
  bool Clear(int z, int px, int py) {
    for (int i = 0; i < wins.Count && wins[i].Z < z; i++) if (wins[i].R.Contains(px, py)) return false;
    return true;
  }

  // A window's top edge is a floor where it's visible, isn't the top of the screen (maximized),
  // and nothing in front of it covers where she would stand.
  bool Floor(Win w, int px) {
    if (px < w.R.Left + 4 || px > w.R.Right - 4) return false;
    var wa = Screen.FromPoint(new Point(px, w.R.Top)).WorkingArea;
    if (w.R.Top <= wa.Top + 8 || w.R.Top >= wa.Bottom - 4) return false;
    return Clear(w.Z, px, w.R.Top + 2) && Clear(w.Z, px, w.R.Top - 6 * sc);
  }

  Win Find(IntPtr h) { foreach (var w in wins) if (w.H == h) return w; return null; }
  double Ground(double px) { return Screen.FromPoint(new Point((int)px, (int)y - 4)).WorkingArea.Bottom; }

  // ---------- one frame ----------
  void Step() {
    tick++; stTicks++;
    // Resting, she looks around less often and animates at half rate: most of a desktop pet's day.
    bool resting = (st == St.Stand || st == St.Sit) && !mouseDown && double.IsNaN(walkTo) && stTicks > 2;
    if (tick % (resting ? 6 : 2) == 0 || st == St.Fall || st == St.Jump) Scan();
    Foreground();
    Knock();
    ReadInbox();
    if (newWin != IntPtr.Zero && (DateTime.Now - newAt).TotalMilliseconds > 900) {
      var h = newWin; newWin = IntPtr.Zero;
      if (DateTime.Now > peekAfter && Motive.PeekOk(Sig()) && Ready("peek") && PeekAt(h)) { Stamp("peek"); Why("peek", "a window just opened: peeking over it"); }
    }
    if (watchPid > 0 && (DateTime.Now - lastWatch).TotalSeconds > 3) {
      lastWatch = DateTime.Now;
      try { Process.GetProcessById(watchPid); } catch { Quit(); }
    }

    // Out of the way of full-screen apps (games, video, slides) and exam browsers.
    bool away = fgFull || Regex.IsMatch(fgProc, "lockdown|respondus|safeexam|seb", RegexOptions.IgnoreCase);
    if (away != hidden) { hidden = away; Visible = !away; if (away) { bubble.Hide(); fire.Gone(); if (st == St.Grab || st == St.Throw || st == St.Camp) Go(St.Stand); } }

    if (pulling == 1 && (DateTime.Now - pullAt).TotalSeconds > 8) ChatNow();   // took too long getting there
    Clicks();
    if (throughUntilSet && DateTime.Now > throughUntil) { throughUntilSet = false; ClickThrough(false); }
    Physics();
    Swing();
    if (!resting || tick % 2 == 0) Animate();
    Place();
    if (frameChanged) Invalidate();
    bubble.Follow();

    if ((DateTime.Now - lastTopmost).TotalSeconds > 2) {
      lastTopmost = DateTime.Now;
      Native.SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }
    if ((DateTime.Now - lastState).TotalMilliseconds > 900) WriteState();
  }

  int half;
  // Where a window is right now (the scan is up to a frame old), kept in the scan's list too.
  Win Fresh(IntPtr h) {
    var w = Find(h);
    if (w != null && Native.IsWindow(h)) w.R = Native.Frame(h);
    return w;
  }

  // Between steps: follow the window she stands on or hangs off.
  void Ride() {
    if (hidden || mouseDown) return;
    bool moved = false;
    if (on != IntPtr.Zero && st != St.Jump && st != St.Fall && st != St.Leap && st != St.Blink && st != St.Vanish && st != St.Appear && st != St.Hang && st != St.Climb && st != St.Ceil) {
      var w = Fresh(on);
      if (w != null && w.R != onRect) moved = RideOn(w);
    } else if (wall != IntPtr.Zero && (st == St.Hang || st == St.Climb)) {
      var w = Fresh(wall);
      if (w != null && w.R != wallRect) { HoldOn(w); moved = true; }
    }
    if (moved) { Place(); bubble.Follow(); }
  }

  // The floor under her moved: go with it. Yanked down faster than she'd fall, she lifts off it and
  // falls after it instead (and lands on it again). Returns whether she's still on it.
  bool RideOn(Win w) {
    x += w.R.Left - onRect.Left;
    int drop = w.R.Top - onRect.Top;
    onRect = w.R;
    if (drop > 9 * k) { on = IntPtr.Zero; vx = 0; vy = 0; Go(St.Fall); return false; }
    y = w.R.Top;
    return true;
  }

  // The window she's holding moved: she moves with her hands.
  void HoldOn(Win w) {
    double d = side < 0 ? w.R.Left - wallRect.Left : w.R.Right - wallRect.Right;
    rideDx += d; x += d;
    y += w.R.Top - wallRect.Top;
    wallRect = w.R;
  }

  void Go(St s) {
    if (st == St.Camp && s != St.Camp) { fire.Out(); Emit("camp-out", null, null); }
    // In between: lowering herself before a sit, pushing up out of one, a beat to lean before a walk.
    prep = 0;
    if (s == St.Sit && (st == St.Stand || st == St.Walk || st == St.Look || st == St.Wave || st == St.Stretch)) prep = PREP;
    else if (st == St.Sit && (s == St.Stand || s == St.Walk)) prep = PREP;
    st = s; stTicks = 0; variant = rnd.Next(4); creeping = yawning = false; sitKind = 0; walkTo = double.NaN; }

  const int PREP = 6; int prep;      // ticks of the in-between pose (a crouch) when sitting down or getting up

  // ---------- staying out of the way: she rests where there's nothing to read or click ----------
  // She can walk over text and buttons, but when she stops, she picks a clear spot: not over text,
  // icons or controls (Sight), not over a window's minimize/maximize/close buttons, and never over
  // the box you're typing in.
  bool seeing;                       // she's left out of screen capture, so she can look behind herself
  double walkTo = double.NaN;        // walking to this x, then resting
  int clearIn = 30;
  Rectangle focusRect; bool focusAsking; DateTime focusAt;
  double[] seen; int seenLeft;

  // The floor she's on, as a strip of screen the height of her body.
  Rectangle Strip() {
    var wa = Work();
    int l = wa.Left, r = wa.Right;
    if (on != IntPtr.Zero) { l = Math.Max(l, onRect.Left); r = Math.Min(r, onRect.Right); }
    return new Rectangle(l, (int)y - GH * sc, Math.Max(0, r - l), GH * sc);
  }
  void Look() { var r = Strip(); seen = Sight.Columns(r); seenLeft = r.Left; }

  // How much she'd cover standing at px: 0 is clear, 1 is something she must not sit on.
  double Cover(double px) {
    double half = GW * sc * 0.32;
    if (on != IntPtr.Zero) {
      int caption = 150 * sc / 3;   // the minimize, maximize and close buttons sit under the right end of the top
      if (px + half > onRect.Right - caption || px - half < onRect.Left + 12 * sc / 3) return 1;
    }
    var me = new Rectangle((int)(px - half), (int)y - GH * sc, (int)(2 * half), GH * sc + 6 * sc);
    if (!focusRect.IsEmpty && focusRect.IntersectsWith(me)) return 1;
    return seen == null ? 0 : Sight.Over(seen, seenLeft, px - half, px + half);
  }
  const double BUSY = 0.06, CLEAR = 0.025;

  // A clear spot along her floor within reach: the nearest, or a random one.
  double FindClear(double reach, bool any) {
    var r = Strip();
    double lo = Math.Max(r.Left + 24 * k, x - reach), hi = Math.Min(r.Right - 24 * k, x + reach);
    var ok = new List<double>();
    double best = double.NaN;
    for (double px = lo; px <= hi; px += Sight.Col) {
      if (Cover(px) >= CLEAR) continue;
      ok.Add(px);
      if (double.IsNaN(best) || Math.Abs(px - x) < Math.Abs(best - x)) best = px;
    }
    if (any && ok.Count > 0) return ok[rnd.Next(ok.Count)];
    return best;
  }

  // Standing or sitting on something busy: usually move to the nearest clear spot.
  void StepAside() {
    Look();
    if (Cover(x) < BUSY) return;
    if (rnd.NextDouble() < 0.12) { clearIn = 300; return; }   // now and then she just stays put a while
    double nx = FindClear(700 * k, false);
    if (double.IsNaN(nx) || Math.Abs(nx - x) < 4) { clearIn = 150; return; }
    WalkTo(nx);
  }
  Point hoverAt; int hoverTicks;
  void MakeWay(double cx) {
    Look();
    if (Cover(x) < BUSY) return;
    double half = GW * sc * 0.55, best = double.NaN;
    var r = Strip();
    for (double d = half + 6 * k; d < 500 * k; d += Sight.Col)
      foreach (double px in new[] { cx + d, cx - d }) {
        if (px < r.Left + 24 * k || px > r.Right - 24 * k || Cover(px) >= BUSY) continue;
        if (double.IsNaN(best) || Math.Abs(px - x) < Math.Abs(best - x)) best = px;
      }
    if (double.IsNaN(best)) best = cx + (cx < x ? 1 : -1) * (half + 10 * k);
    WalkTo(Math.Max(r.Left + 24 * k, Math.Min(r.Right - 24 * k, best)));
  }
  void WalkTo(double nx) { Go(St.Walk); walkTo = nx; facing = nx > x ? 1 : -1; actTicks = 900; }

  // What has the keyboard (asked off the UI thread: UI Automation can stall on a busy app). Only a
  // field-sized thing counts: a whole document isn't "the box you're typing in".
  void AskFocus() {
    if (focusAsking || (DateTime.Now - focusAt).TotalMilliseconds < 900) return;
    focusAsking = true; focusAt = DateTime.Now;
    int me = Process.GetCurrentProcess().Id;
    ThreadPool.QueueUserWorkItem(delegate {
      var r = Rectangle.Empty;
      try {
        var el = AutomationElement.FocusedElement;
        if (el != null && el.Current.ProcessId != me) {
          var b = el.Current.BoundingRectangle;
          if (!b.IsEmpty && b.Width < 1400 && b.Height < 260) r = new Rectangle((int)b.X, (int)b.Y, (int)b.Width, (int)b.Height);
        }
      } catch { }
      focusRect = r; focusAsking = false;
    });
  }

  // Sit down: plain, legs dangling over the edge, or knees hugged.
  void Sit(int ticks) { Go(St.Sit); actTicks = ticks; double r = rnd.NextDouble(); sitKind = r < 0.35 ? 1 : r < 0.6 ? 2 : 0; }

  void Physics() {
    var cur = Cursor.Position;
    switch (st) {
      case St.Appear:
        progress = Math.Min(1, progress + 0.035);
        if (progress >= 1) { if (Placed && AtSpot()) Go(St.Land); else Go(St.Fall); vy = 0; squash = SQUASH; }
        break;
      case St.Vanish:
        progress = Math.Max(0, progress - 0.05);
        if (progress <= 0) { timer.Stop(); Application.Exit(); }
        return;
      case St.Drag:
        double nx = cur.X - grab.X, ny = cur.Y - grab.Y;
        dragVx = dragVx * 0.5 + (nx - x) * 0.5; dragVy = dragVy * 0.5 + (ny - y) * 0.5;
        held = Math.Abs(nx - x) + Math.Abs(ny - y) < 2 * k ? held + 1 : 0;
        x = nx; y = ny;
        return;
      case St.Fall: case St.Jump:
        Fly();
        return;
      case St.Crouch:
        if (stTicks > 5) { if (stomp) { vx = 0; vy = -6.5 * k; } Go(St.Jump); }
        return;
      case St.Land:
        if (stTicks > landHold) { Go(St.Stand); actTicks = jobLeft > 0 ? 1 : 20 + rnd.Next(40); }
        break;
      case St.Hang: case St.Climb:
        OnWall();
        return;
      case St.Press:
        // Leaning over the taskbar button and pressing it with her hand.
        if (stTicks == 12) Press();
        if (stTicks > 30) { Go(St.Stand); actTicks = 30; }
        return;
      case St.Grab: GrabStep(); return;
      case St.Throw: ThrowStep(); return;
      case St.Camp:
        // Striking it alight, then sitting by it warming her hands.
        facing = fireX >= x ? 1 : -1;
        if (stTicks == 45) fire.Light((int)Math.Round(fireX), (int)Math.Round(Ground(fireX)), sc);
        break;
      case St.Ceil: {
        // Hand over hand along the top of the screen: she only moves while a hand swings forward.
        var wa = Work();
        if (stTicks % 20 >= 14) x += facing * 1.5 * k;
        if (x < wa.Left + 30 * k || x > wa.Right - 30 * k) facing = x < wa.Left + 30 * k ? 1 : -1;
        if (--actTicks <= 0) { vx = 0; vy = 0; Fall(); }
        return;
      }
      case St.Leap:
        LeapStep();
        return;
      case St.Blink:
        if (stTicks <= BLINK) { progress = 1 - stTicks / (double)BLINK; return; }
        if (stTicks == BLINK + 1) { x = ltx; y = lty; progress = 0; return; }
        progress = Math.Min(1, (stTicks - BLINK - 1) / (double)BLINK);
        if (progress >= 1) EndMove();
        return;
      case St.Pull: {
        // Hauling the chat window up from the bottom of the screen, hanging off its top-left corner.
        var t = chat.Target();
        double p = Math.Min(1, stTicks / 26.0), e = 1 - Math.Pow(1 - p, 3);
        int top = (int)Math.Round(pullFrom + (t.Top - pullFrom) * e);
        chat.SetTop(top);
        x = WallX(new Rectangle(t.Left, top, t.Width, t.Height), -1); y = top + (GH - 1) * sc; facing = 1;
        if (p >= 1) {
          Scan();
          wall = chat.Handle; side = -1; wallRect = Native.Frame(chat.Handle); climbDir = 0;
          Go(St.Hang); actTicks = 60 + rnd.Next(90);
          chat.Take();
        }
        return;
      }
      case St.Peep: {
        // Peeking up over the bottom edge, watching the mouse; then back up the same way she came.
        if (peekWin != IntPtr.Zero) {
          var pw = Find(peekWin);
          if (stTicks < 90) facing = pw != null && pw.R.Left + pw.R.Width / 2 >= x ? 1 : -1;
          else facing = Cursor.Position.X >= x ? 1 : -1;
          if (pw == null || pw.R != peekRect || pw.Z != 0) actTicks = 0;
          if (actTicks <= 0 || --actTicks <= 0) { peekWin = IntPtr.Zero; peekAfter = DateTime.Now.AddSeconds(40); Blink(x, Work().Bottom, false, IntPtr.Zero); }
          return;
        }
        facing = Cursor.Position.X >= x ? 1 : -1;
        if (--actTicks <= 0) { peepAfter = DateTime.Now.AddMinutes(2 + rnd.NextDouble() * 3); Blink(x, Work().Bottom, false, IntPtr.Zero); }
        return;
      }
      case St.Perch:
        // Hanging off a bar: let go when time's up, or when the window under her hands moves.
        bool moved = goId == null && !throughUntilSet && fgH != IntPtr.Zero && Native.Frame(fgH) != fgBarFrame;
        if (jobLeft > 0) {
          // Hanging there on the job: she holds on while it lasts, unless that window goes or moves.
          if (jobH != IntPtr.Zero) { Win jw = Find(jobH); moved = jw == null || jw.R != jobRect; }
          // A point job (a click, a scroll): she holds on while the same window is still under her hands.
          // A click that closed the menu or dialog she was on lets her drop instead of hanging in the air.
          else if (stTicks % 15 == 0) moved = TopAt(new Point((int)(x + facing * HAND * sc), (int)(y - (GH - 1) * sc) + 3)) != jobPtH;
          else moved = false;
          if (jobNew) { jobNew = false; if (job == "scroll" || job == "press") swingV += facing * 0.05; }
          else if (job == "scroll" && stTicks % 24 == 0) swingV += 0.035;   // swinging with the page as it goes
          if (actTicks < 30) actTicks = 30;
        }
        if (--actTicks <= 0 || moved) { vx = 0; vy = 0; Fall(); }
        return;
    }
    if (climbRest > 0) climbRest--;
    if (st == St.Appear) return;

    // Grounded: ride the window we're on, fall if it's gone.
    if (on != IntPtr.Zero) {
      var w = Fresh(on);
      if (w == null || !Floor(w, (int)x)) { Fall(); return; }
      if (w.R.Top != onRect.Top || w.R.Left != onRect.Left) {
        if (!RideOn(w)) return;
        if (!Floor(w, (int)x)) { Fall(); return; }
      }
      y = w.R.Top;
    } else if (Placed && AtSpot()) {
      x = spotX; y = spotY;   // the orb they put here: it floats right where they left it, no floor needed
    } else {
      y = Ground(x);
      // A window that moved under us while we stood on the taskbar is fine: we're in front.
    }

    if (trip != null) { TripStep(); return; }
    if (errand != null) { Errand1(); return; }
    // Away from its spot (a job took it somewhere) and nothing has it now: pop straight back.
    if (Spot.GoBack(Placed, AtSpot(), jobLeft > 0 || goId != null, mouseDown || pulling == 1)) {
      Why("spot", "back to where they put me");
      Blink(spotX, spotY, false, IntPtr.Zero);
      return;
    }

    bool busy = bubble.Visible || thinking || menu.Visible;
    uint idle = Native.IdleMs();
    if (jobLeft > 0) idle = 0;   // the AI's at work for them: nobody naps on the job
    // Asleep (the motive model winds her down: stretch, yawn, sit, sleep): nothing else happens till
    // they're back. Then she stretches first, and the next decision is a hello (justWoke).
    if (idleSleep > 0) {
      if (idle >= 2000 && !busy) return;
      idleSleep = 0; justWoke = true;
      if (st != St.Camp) { Go(St.Stretch); actTicks = 80; }   // up off the floor, then the stretch
      Why("stretch", "they're back: waking up");
    }
    if (st == St.Stand || st == St.Sit || st == St.Look) { if (restFrom == DateTime.MinValue) restFrom = DateTime.Now; } else restFrom = DateTime.MinValue;
    Notice(busy);

    if (busy && (st == St.Walk || st == St.Dance)) Go(St.Stand);
    if (seeing && roam) AskFocus();
    // The mouse resting on her over something busy: they're after what's under her, so she makes way.
    if (seeing && roam && !Placed && happyHover && !mouseDown && !busy && double.IsNaN(walkTo) && (st == St.Stand || st == St.Sit || st == St.Walk)) {
      var cp = Cursor.Position;
      if (Math.Abs(cp.X - hoverAt.X) + Math.Abs(cp.Y - hoverAt.Y) > 6) { hoverAt = cp; hoverTicks = 0; }
      else if (++hoverTicks == 45) MakeWay(cp.X);
    } else hoverTicks = 0;
    if (seeing && roam && !Placed && !busy && jobLeft == 0 && double.IsNaN(walkTo) && idleSleep == 0 && (st == St.Stand || st == St.Sit) && stTicks > 15 && --clearIn <= 0) {
      clearIn = 45;
      StepAside();
    }
    if (st == St.Walk && !double.IsNaN(walkTo)) {
      double sp = 1.6 * k;
      facing = walkTo > x ? 1 : -1;
      if (Math.Abs(walkTo - x) <= sp) {
        x = walkTo;
        Go(St.Stand); actTicks = 20 + rnd.Next(30);   // there: a moment, then the next reason decides (Decide)
        clearIn = 60;
        return;
      }
    }
    // A lean into the first step before she moves (or, out of a sit, getting up first).
    if (st == St.Walk && stTicks >= Math.Max(4, prep)) {
      double nx2 = x + facing * (creeping ? 0.7 : 1.6) * k;
      if (on != IntPtr.Zero) {
        var w = Find(on);
        if (nx2 < onRect.Left + 4 || nx2 > onRect.Right - 4) {
          // The edge: usually turn back, sometimes hop off.
          double r = rnd.NextDouble();
          if (r < 0.4) facing = -facing;
          else if (r < 0.7 && w != null && Grab(w, facing, false)) return;
          else { vx = facing * 2.2 * k; vy = -4 * k; Fall(); return; }
        } else if (w != null && !Floor(w, (int)nx2)) {
          facing = -facing; walkTo = double.NaN;   // walked into a window in front: turn around
        } else if (!WalkIntoWall(nx2)) x = nx2;
      } else {
        var wa = Work();
        if (nx2 < wa.Left + 20 || nx2 > wa.Right - 20) facing = -facing; else if (!WalkIntoWall(nx2)) x = nx2;
      }
    }

    if (st == St.Look && stTicks == 35) facing = -facing;
    if (st == St.Dance) facing = (stTicks / 32) % 2 == 0 ? danceFace : -danceFace;
    if (--actTicks <= 0) { if (jobLeft > 0) DoJob(); else if (!busy) Decide(); else if ((st >= St.Wave && st <= St.Look) || st == St.Trip) Go(St.Stand); }
  }

  int landHold = 4;
  void Fall() { on = IntPtr.Zero; Go(St.Fall); }

  void Fly() {
    double g = 0.9 * k;
    double py = y;
    vy = Math.Min(vy + g, 30 * k);
    x += vx; y += vy; vx *= 0.995;
    var vs = SystemInformation.VirtualScreen;
    if (x < vs.Left + 10) { x = vs.Left + 10; vx = Math.Abs(vx) * 0.5; }
    if (x > vs.Right - 10) { x = vs.Right - 10; vx = -Math.Abs(vx) * 0.5; }
    if (vy <= 0) return;
    // Land on the first floor we crossed on the way down.
    Win best = null;
    foreach (var w in wins) {
      int t = w.R.Top;
      if (py <= t && y >= t && Floor(w, (int)x) && (best == null || t < best.R.Top)) best = w;
    }
    double gr = Ground(x);
    if (best != null && best.R.Top < gr) { y = best.R.Top; on = best.H; onRect = best.R; }
    else if (y >= gr) { y = gr; on = IntPtr.Zero; }
    else return;
    double impact = vy;
    vx = 0; vy = 0;
    // A hard landing (a long drop): she stays down in the squat a beat longer to soak it up.
    landHold = impact > 18 * k ? 8 : 4;
    if (thrown) { thrown = false; Go(St.Trip); actTicks = 75; } else Go(St.Land);
    if (stomp) { stomp = false; Press(); }
  }

  // Clicked: she stops where she is, so her menu doesn't walk away with her (or under her feet).
  void Hold() {
    walkTo = double.NaN; trip = null; chasing = false; creeping = false;
    if (st == St.Walk || st == St.Dance || st == St.Sit || st == St.Stretch || st == St.Look) { Go(St.Stand); actTicks = 90; }
  }

  // Home is the bottom-right corner, by the clock, until they pick her up and put her down somewhere:
  // then it's the floor under where they let go, on that screen, until Stead is started again (it's
  // only kept here, never saved). She goes off exploring, but that's where she lives. (The orb is
  // different: it stays exactly where it was put, saved; see "the orb's spot" below.)
  // homeX is in desktop pixels, so it says which screen too.
  double homeX = double.NaN;
  double HomeX() {
    var wa = Work();
    if (double.IsNaN(homeX)) return wa.Right - 110 * k;
    // On another screen than home: as near to it as this one goes.
    return Math.Max(wa.Left + 40 * k, Math.Min(wa.Right - 40 * k, homeX));
  }
  // Within a few steps of home, on the floor (her walk home aims anywhere up to 220 short of it).
  bool AtHome() {
    var wa = Work(); double hx = HomeX();
    return x > hx - 270 * k && x < hx + 110 * k && on == IntPtr.Zero && Math.Abs(y - wa.Bottom) < 4;
  }

  // ---------- the orb's spot: put it down and it stays there ----------
  // A look that Stays (the orb) lives exactly where they last put it: x and y in desktop pixels (so the
  // screen too), saved in pos.json so it survives a restart. Nothing she does on her own moves it; a job
  // the AI does for them (a click, an errand) can take it away, and then it pops straight back. Reset
  // (her menu, `stead onscreen reset`) forgets the spot: back to the bottom right.
  double spotX = double.NaN, spotY = double.NaN;
  public bool HasSpot { get { return !double.IsNaN(spotX); } }
  bool Placed { get { return HasSpot && Ch.Stays; } }
  bool AtSpot() { return HasSpot && on == IntPtr.Zero && Spot.At(x, y, spotX, spotY); }
  string SpotPath { get { return Path.Combine(dir, "pos.json"); } }

  // A point kept on a screen: the work area of the screen it's on (or nearest), so all of her shows.
  double[] OnScreen(double px, double py) {
    var wa = Screen.FromPoint(new Point((int)px, (int)py - 4)).WorkingArea;
    return Spot.Clamp(px, py, wa.Left, wa.Top, wa.Right, wa.Bottom, GW * sc * 0.35, GH * sc * 0.75);
  }

  void PutSpot(double px, double py) {
    var p = OnScreen(px, py);
    spotX = x = p[0]; spotY = y = p[1];
    homeX = x;   // and if they switch to a look that walks, the floor under it is home
    vx = 0; vy = 0; on = IntPtr.Zero; wall = IntPtr.Zero; thrown = false; trip = null;
    justLanded = true;   // a look around, right there
    Go(St.Land);
    var d = new Dictionary<string, object>();
    d["x"] = (int)Math.Round(spotX); d["y"] = (int)Math.Round(spotY);
    try { File.WriteAllText(SpotPath, json.Serialize(d)); } catch { }
    Emit("placed", null, (int)spotX + "," + (int)spotY);
  }

  void LoadSpot() {
    try {
      var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(SpotPath));
      double px = Convert.ToDouble(d["x"]), py = Convert.ToDouble(d["y"]);
      // Saved on a screen that's gone (unplugged, rearranged): onto the nearest one that's here.
      var p = OnScreen(px, py);
      spotX = p[0]; spotY = p[1];
      if (Ch.Stays) { x = spotX; y = spotY; }
    } catch { spotX = spotY = double.NaN; }
  }

  // Forget the spot: back to the bottom right of the main screen, as on a first start.
  void ResetSpot() {
    spotX = spotY = double.NaN; homeX = double.NaN;
    try { File.Delete(SpotPath); } catch { }
    Emit("placed", null, "reset");
    if (hidden || st == St.Drag || st == St.Vanish || st == St.Appear) return;
    if (st == St.Hang || st == St.Climb) wall = IntPtr.Zero;
    var wa = Screen.PrimaryScreen.WorkingArea;
    Blink(wa.Right - 160 * k, wa.Bottom, false, IntPtr.Zero);
  }

  // ---------- why she does what she does (see Motive.cs) ----------
  // Every move she makes on her own comes out of Motive.Next: what the person is up to, what the AI is
  // up to, the hour, how long since anyone touched her. Each one is emitted with its reason ("why"),
  // which the daemon logs, so "why did she do that?" always has an answer.
  readonly Motive motive = new Motive();
  readonly DateTime born = DateTime.Now;
  string outcome; int outcomeSteps;    // the AI's last job, not yet reacted to ("ok" / "error")
  bool justWoke, justLanded;
  DateTime restFrom = DateTime.MinValue, hoverFrom = DateTime.MinValue;
  string lastWhy = "";
  void Clock() { motive.Now = (DateTime.Now - born).TotalSeconds; }
  bool Ready(string m) { Clock(); return motive.Ready(m); }
  void Stamp(string m) { Clock(); motive.Stamp(m); }
  void Why(string move, string reason) {
    string w = move + ": " + reason;
    if (w == lastWhy) return;
    lastWhy = w; Emit("why", move, reason);
  }

  Signals Sig() {
    var s = new Signals();
    s.IdleSec = jobLeft > 0 ? 0 : Native.IdleMs() / 1000.0;
    s.Quiet = !Talkable();
    s.Talking = bubble.Visible || menu.Visible || thinking;
    s.Working = jobLeft > 0; s.Asking = jobLeft > 0 && job == "ask"; s.Coding = codeLeft > 0;
    s.Outcome = outcome; s.Steps = outcomeSteps;
    s.JustWoke = justWoke; s.JustLanded = justLanded;
    s.Roam = roam; s.Calm = Ch.Calm; s.Placed = Placed;
    s.Hour = DateTime.Now.Hour;
    s.AtHome = AtHome(); s.OnWindow = on != IntPtr.Zero;
    s.UntouchedSec = (DateTime.Now - touchedAt).TotalSeconds;
    s.FieldFocused = !focusRect.IsEmpty;
    s.RestSec = restFrom == DateTime.MinValue ? 0 : (DateTime.Now - restFrom).TotalSeconds;
    return s;
  }

  // What to do next, when nothing is going on.
  void Decide() {
    Clock();
    var s = Sig();
    var c = motive.Next(s, Try);
    // The one-off reasons are spent once she's acted on them (unless something kept her from it).
    if (s.Roam && !s.Quiet && !s.Talking) { outcome = null; justWoke = false; justLanded = false; }
    Why(c.Move, c.Reason);
  }

  // On the ground and free to move: not mid-air, on a wall, carried, or blinking somewhere.
  bool Grounded() {
    return st != St.Hang && st != St.Climb && st != St.Perch && st != St.Ceil && st != St.Blink && st != St.Leap && st != St.Fall
      && st != St.Jump && st != St.Drag && st != St.Crouch && st != St.Peep && st != St.Grab && st != St.Throw && st != St.Pull
      && errand == null && trip == null && goId == null;
  }
  void FaceCursor() { var cp = Cursor.Position; if (Math.Abs(cp.X - x) > 8) facing = cp.X >= x ? 1 : -1; }

  // Do a chosen move, if it can happen here. True if it did.
  bool Try(Choice c) {
    int t = c.Ticks > 0 ? c.Ticks : 60;
    bool g = Grounded();
    switch (c.Move) {
      case "stand":
        if (st != St.Stand && st != St.Camp) Go(St.Stand);
        actTicks = t; return true;
      case "sit":
        if (st == St.Camp) { actTicks = t; return true; }
        if (!g) return false;
        if (st != St.Sit) Sit(t); else actTicks = t;
        return true;
      case "sleep":
        idleSleep = 1;
        if (st != St.Camp) { var to = Ch.Has("sleep") || on == IntPtr.Zero ? St.Stand : St.Sit; if (st != to) Go(to); }
        actTicks = t; return true;
      case "look": case "glance":
        if (!g) return false;
        if (c.Move == "glance") FaceCursor();
        Go(St.Look); actTicks = t; return true;
      case "home":
        if (AtHome() || !g || Placed) return false;
        Travel(Math.Max(Work().Left + 30 * k, HomeX() - rnd.Next((int)(220 * k))), Work().Bottom, false, IntPtr.Zero);
        return true;
      case "wander": {
        if (!g || Placed) return false;
        double nx = double.NaN;
        if (seeing) { Look(); nx = FindClear(300 * k, true); }
        if (double.IsNaN(nx) || Math.Abs(nx - x) < 30 * k) {
          // Toward what they were working on (the pointer), a few steps, staying on what she's standing on.
          var cp = Cursor.Position;
          int dir = Math.Abs(cp.X - x) > 20 * k ? Math.Sign(cp.X - x) : (rnd.NextDouble() < 0.5 ? -1 : 1);
          nx = x + dir * (60 + rnd.Next(100)) * k;
          var wa = Work(); double lo = wa.Left + 30 * k, hi = wa.Right - 30 * k;
          if (on != IntPtr.Zero) { lo = Math.Max(lo, onRect.Left + 20 * k); hi = Math.Min(hi, onRect.Right - 20 * k); }
          nx = Math.Max(lo, Math.Min(hi, nx));
          if (Math.Abs(nx - x) < 20 * k) return false;
        }
        WalkTo(nx); return true;
      }
      case "walk":
        if (!g) return false;
        Go(St.Walk); if (rnd.NextDouble() < 0.4) facing = -facing; actTicks = 60 + rnd.Next(120); return true;
      case "creep":
        if (!g) return false;
        Go(St.Walk); creeping = true; actTicks = t; return true;
      case "climb":
        if (!g || climbRest != 0 || !TowardWall()) return false;
        Go(St.Walk); actTicks = t; return true;
      case "hang": return g && BarHang();
      case "ceiling": if (!g) return false; Anim("ceiling"); return leapCeil;
      case "hop": return g && TryJump();
      case "dance":
        if (!g) return false;
        idleSleep = 0; danceFace = facing; Go(St.Dance); actTicks = t; return true;
      case "grab": return g && GrabMouse(true);
      case "camp": return g && AtHome() && Camp(true);
      case "peep": return g && PeepNow();
      case "stretch": case "yawn":
        if (!g) return false;
        Go(St.Stretch); yawning = c.Move == "yawn"; actTicks = t; return true;
      case "trip":
        if (!g) return false;
        Go(St.Trip); actTicks = t; return true;
      case "jump":
        if (!g || Ch.Calm || !roam) return false;
        vx = 0; vy = -7 * k; on = IntPtr.Zero; Go(St.Jump); return true;
      case "wave": case "greet":
        if (!g) return false;
        FaceCursor(); Go(St.Wave); actTicks = t; return true;
    }
    return false;
  }

  // Something she reacts to on the spot (a mood from the brain, the job's outcome): the move, if it's
  // off cooldown and can happen here, with its reason.
  bool React(string move, string reason, int ticks) {
    if (hidden || !Ready(move)) return false;
    if (!Try(new Choice(move, reason, ticks))) return false;
    Stamp(move); Why(move, reason);
    return true;
  }

  // Every frame, cheap: what's going on right around her (the pointer) that she'd notice.
  void Notice(bool busy) {
    // The pointer resting on her: after a second she's pleased (they've played with her lately) or shy.
    if (happyHover && !mouseDown && idleSleep == 0) {
      if (hoverFrom == DateTime.MinValue) hoverFrom = DateTime.Now;
      else if ((DateTime.Now - hoverFrom).TotalSeconds > 1.2 && mood.Length == 0 && Ready("shy")) {
        Stamp("shy");
        bool friends = (DateTime.Now - touchedAt).TotalMinutes < 5;
        mood = friends ? "happy" : "embarrassed"; moodLeft = 60;
        Why(mood, friends ? "the mouse is on me: happy" : "the mouse is on me: shy");
      }
    } else hoverFrom = DateTime.MinValue;
    // The pointer moving about close behind her while she rests: she turns round to it.
    if ((st == St.Stand || st == St.Sit) && idleSleep == 0 && !busy && !mouseDown && double.IsNaN(walkTo) && stTicks > 20
        && tick % 6 == 0 && poseLeft == 0 && Native.IdleMs() < 800 && Ready("turn")) {
      var cp = Cursor.Position;
      double dx = cp.X - x, dy = (y - GH * sc / 2) - cp.Y;
      if (Math.Abs(dx) > 30 * k && Math.Abs(dx) < 260 * k && Math.Abs(dy) < 220 * k && Math.Sign(dx) == -facing) { facing = -facing; Stamp("turn"); }
    }
  }

  // The AI's job ended or a step failed (see director.js). A failed step: a stumble, once, if she's
  // standing about; otherwise it waits for the next decision. A finished job: joy, at the next one.
  void Outcome(string what, int steps) {
    outcome = what; outcomeSteps = steps;
    if (what == "error" && Grounded() && (st == St.Stand || st == St.Look || st == St.Land || st == St.Sit) && React("trip", "that step failed", 30)) outcome = null;
  }

  // ---------- her own little things ----------
  // A campfire beside her, at home in her corner: she lights it and sits by it for a while.
  bool Camp(bool asked) {
    if (hidden || on != IntPtr.Zero || (!asked && (!AtHome() || DateTime.Now < campAfter))) return false;
    var wa = Work();
    int side = x > wa.Right - 140 * k ? -1 : 1;
    fireX = Math.Max(wa.Left + 30 * k, Math.Min(wa.Right - 30 * k, x + side * 30 * k));
    facing = side; idleSleep = 0;
    Go(St.Camp); actTicks = 600 + rnd.Next(600);
    campAfter = DateTime.Now.AddMinutes(6 + rnd.Next(8));
    Emit("camp", null, null);
    return true;
  }

  // Now and then, when you've let go of the mouse: she reels the pointer in, waves it about and throws it.
  // The moment you move it yourself, it's yours again.
  bool GrabMouse(bool asked) {
    uint idle = Native.IdleMs();
    if (hidden || fgFull || on != IntPtr.Zero || mouseDown) return false;
    if (!asked && (DateTime.Now < grabAfter || idle < 8000 || idle > 60000)) return false;
    var cp = Cursor.Position;
    if (Math.Abs(cp.X - x) > 520 * k || !Screen.FromPoint(new Point((int)x, (int)y - 4)).Bounds.Contains(cp)) return false;
    grabAfter = DateTime.Now.AddMinutes(8 + rnd.Next(10));
    facing = cp.X >= x ? 1 : -1; mouseFrom = cp; mouseSet = cp;
    Go(St.Grab); actTicks = 0;
    Emit("yoink", null, null);
    return true;
  }
  Point HandAt() { return new Point((int)Math.Round(x + facing * 6 * sc), (int)Math.Round(y - 22 * sc)); }
  bool MouseTaken() { var c = Cursor.Position; return Math.Abs(c.X - mouseSet.X) + Math.Abs(c.Y - mouseSet.Y) > 3; }
  void SetMouse(double px, double py) {
    var vs = SystemInformation.VirtualScreen;
    int ix = (int)Math.Max(vs.Left + 2, Math.Min(vs.Right - 3, px)), iy = (int)Math.Max(vs.Top + 2, Math.Min(vs.Bottom - 3, py));
    Native.SetCursorPos(ix, iy); mouseSet = new Point(ix, iy);
  }
  void Yours() { Go(St.Stand); actTicks = 40; mood = "surprised"; moodLeft = 45; }
  void GrabStep() {
    if (MouseTaken()) { Yours(); return; }
    var h = HandAt();
    if (stTicks <= 24) {
      double p = stTicks / 24.0, e = p * p * (3 - 2 * p);
      SetMouse(mouseFrom.X + (h.X - mouseFrom.X) * e, mouseFrom.Y + (h.Y - mouseFrom.Y) * e);
      return;
    }
    mood = "mischievous"; moodLeft = 60;
    SetMouse(h.X + Math.Sin(stTicks / 3.0) * 5 * k, h.Y + Math.Cos(stTicks / 2.0) * 3 * k);
    if (stTicks > 70) Go(St.Throw);
  }
  void ThrowStep() {
    if (MouseTaken()) { Yours(); return; }
    var h = HandAt();
    if (stTicks < 10) { mpx = h.X - facing * stTicks * 2.5 * k; mpy = h.Y - stTicks * 0.8 * k; SetMouse(mpx, mpy); return; }   // winding up
    if (stTicks == 10) { mvx = facing * (16 + rnd.Next(10)) * k; mvy = -(14 + rnd.Next(4)) * k; }
    mvy += 0.9 * k; mpx += mvx; mpy += mvy;
    SetMouse(mpx, mpy);
    var vs = SystemInformation.VirtualScreen;
    if (stTicks > 44 || mpy >= Work().Bottom - 12 || mpx <= vs.Left + 3 || mpx >= vs.Right - 4) { Go(St.Stand); actTicks = 60; mood = "laughing"; moodLeft = 60; }
  }

  // A window dragged into her knocks her flying.
  void Knock() {
    if (fgH == IntPtr.Zero) return;
    var r = Native.Frame(fgH);
    if (fgH != knockH) { knockH = fgH; knockR = r; return; }
    var was = knockR; knockR = r;
    if (r == was || r.Size != was.Size || hidden || on == fgH || DateTime.Now < knockAfter || Placed) return;
    if ((Control.MouseButtons & MouseButtons.Left) == 0) return;   // only a window someone is dragging
    if (!(st == St.Stand || st == St.Walk || st == St.Sit || st == St.Camp || st == St.Look || st == St.Wave || st == St.Dance || st == St.Stretch || st == St.Land)) return;
    var body = new Rectangle((int)(x - 5 * sc), (int)(y - 20 * sc), 10 * sc, 20 * sc);
    if (!r.IntersectsWith(body) || was.IntersectsWith(body)) return;
    int dx = r.Left - was.Left, dy = r.Top - was.Top;
    int dir = Math.Abs(dx) >= Math.Abs(dy) && dx != 0 ? Math.Sign(dx) : (x >= r.Left + r.Width / 2.0 ? 1 : -1);
    knockAfter = DateTime.Now.AddSeconds(3);
    thrown = true; on = IntPtr.Zero; facing = -dir;
    vx = dir * (8 + rnd.Next(5)) * k; vy = -(6 + rnd.Next(3)) * k;
    Go(St.Fall);
    Emit("knocked", null, null);
  }

  // A little show: on her own, or because the brain asked (she waves hello, dances when told to).
  public void Anim(string name) {
    if (hidden || errand != null || goId != null) return;
    if ((Ch.Calm || !roam) && name != "hang" && name != "wave") return;
    if (Placed && name != "wave") return;   // put somewhere by them: a wave on the spot, nothing that carries it off
    bool ground = st != St.Hang && st != St.Climb && st != St.Perch && st != St.Ceil && st != St.Blink && st != St.Leap && st != St.Fall && st != St.Jump && st != St.Drag && st != St.Crouch;
    if (name == "jump") { if (ground) { vx = 0; vy = -7 * k; on = IntPtr.Zero; Go(St.Jump); } return; }
    if (name == "hang") { BarHang(true); return; }
    if (!ground) return;
    idleSleep = 0;
    if (name == "wave") { Go(St.Wave); actTicks = 45; }
    else if (name == "dance") { danceFace = facing; Go(St.Dance); actTicks = 128; }
    else if (name == "stretch") { Go(St.Stretch); actTicks = 50; }
    else if (name == "look") { Go(St.Look); actTicks = 70; }
    else if (name == "sit") Sit(200);
    else if (name == "yawn") { Go(St.Stretch); yawning = true; actTicks = 45; }
    else if (name == "trip") { Go(St.Trip); actTicks = 75; }
    else if (name == "creep") { Go(St.Walk); creeping = true; actTicks = 90; }
    else if (name == "chase") Chase();
    else if (name == "campfire" || name == "camp") Camp(true);
    else if (name == "yoink" || name == "grab") GrabMouse(true);
    else if (name == "ceiling") {
      // Blink up to the top of the screen and go hand over hand along it.
      var wa = Work();
      double cx = Math.Max(wa.Left + 60 * k, Math.Min(wa.Right - 60 * k, x + (rnd.NextDouble() - 0.5) * 600 * k));
      Blink(cx, wa.Top + GH * sc, true, IntPtr.Zero); leapCeil = true;
    }
  }

  // ---------- leaping: a fixed arc from here to an exact point ----------
  // perch: arrive hanging with her hands at the point; otherwise land standing there (feet at it).
  void LeapTo(double tx, double ty, bool perch, IntPtr onto) {
    lx0 = x; ly0 = y; ltx = tx; lty = ty; leapPerch = perch; leapOn = onto;
    double g = 0.9 * k, top = Math.Min(y, ty) - Math.Min(10 * k + Math.Abs(tx - x) * 0.15, 34 * k);
    lT = (int)Math.Max(6, Math.Round(Math.Sqrt(2 * (y - top) / g) + Math.Sqrt(2 * (ty - top) / g)));
    lvy = ((lty - ly0) - 0.5 * g * lT * lT) / lT;
    if (Math.Abs(tx - x) > 2) facing = tx > x ? 1 : -1;
    on = IntPtr.Zero; wall = IntPtr.Zero; idleSleep = 0; vx = 0;
    Go(St.Leap);
  }

  void LeapStep() {
    double g = 0.9 * k; int t = stTicks;
    if (t < lT) {
      x = lx0 + (ltx - lx0) * t / lT; y = ly0 + lvy * t + 0.5 * g * t * t; vy = lvy + g * t;
      return;
    }
    EndMove();
  }

  void EndMove() {
    if (st == St.Blink) squash = SQUASH;   // put back together: a little squash on landing
    x = ltx; y = lty; vx = 0; vy = 0; progress = 1;
    if (leapPeep) { leapPeep = false; on = IntPtr.Zero; Go(St.Peep); actTicks = peekWin != IntPtr.Zero ? 170 + rnd.Next(80) : 300 + rnd.Next(450); if (peekWin != IntPtr.Zero) Emit("peek", null, Native.Text(peekWin)); return; }
    if (leapCeil) { leapCeil = false; on = IntPtr.Zero; Go(St.Ceil); actTicks = 140 + rnd.Next(200); if (rnd.NextDouble() < 0.5) facing = -facing; return; }
    if (leapPerch) {
      Go(St.Perch);
      actTicks = goId != null ? 75 : 100 + rnd.Next(120);
    } else {
      on = leapOn;
      var w = on != IntPtr.Zero ? Find(on) : null;
      if (w != null) onRect = w.R; else on = IntPtr.Zero;
      Go(St.Land);
    }
    Arrived();
  }

  // ---------- getting somewhere, the way she would ----------
  // Close: a hop. Along the taskbar: a run, then a hop. Far, or higher than she could jump: a blink
  // (she's pixels, after all: she breaks up and puts herself back together there).
  bool Hoppable(double tx, double ty) { return y - ty <= 1.2 * GH * sc && Math.Abs(tx - x) <= 230 * k; }

  void Travel(double tx, double ty, bool perch, IntPtr onto) {
    trip = null; idleSleep = 0; chasing = false;
    if (Math.Abs(tx - x) > 2) facing = tx > x ? 1 : -1;
    if (Hoppable(tx, ty)) { LeapTo(tx, ty, perch, onto); return; }
    if (popping) { Blink(tx, ty, perch, onto); return; }   // on the job: there in a pop, no jog along the taskbar
    var wa = Work();
    bool floor = on == IntPtr.Zero && Math.Abs(y - wa.Bottom) < 3 && (st == St.Stand || st == St.Walk || st == St.Land || st == St.Sit || (st >= St.Wave && st <= St.Look) || st == St.Type);
    double rise = y - ty;
    if (floor && rise <= 1.2 * GH * sc && Math.Abs(tx - x) <= 560 * k && tx > wa.Left && tx < wa.Right) {
      trip = new Trip { X = tx, Y = ty, Perch = perch, On = onto };
      Go(St.Walk);
      return;
    }
    Blink(tx, ty, perch, onto);
  }

  // Run along the taskbar to just under the mouse, then wave up at it (Shimeji's ChaseMouse).
  bool Chase() {
    var wa = Work(); var c = Cursor.Position;
    if (on != IntPtr.Zero || Math.Abs(y - wa.Bottom) > 3 || !wa.Contains(c) || c.Y < wa.Top + wa.Height / 3) return false;
    double tx = Math.Max(wa.Left + 30 * k, Math.Min(wa.Right - 30 * k, c.X - Math.Sign(c.X - x) * 30 * k));
    if (Math.Abs(tx - x) < 60 * k || Math.Abs(tx - x) > 700 * k) return false;
    trip = new Trip { X = tx, Y = y }; chasing = true; Go(St.Walk);
    return true;
  }

  // A window just opened in front: phase out and pop up from behind its top edge, near a corner, to look.
  bool PeekAt(IntPtr h) {
    if (hidden || goId != null || errand != null || pulling == 1 || mouseDown || !roam || Ch.Calm || jobLeft > 0) return false;
    if (st != St.Stand && st != St.Sit && st != St.Walk && st != St.Look && st != St.Type) return false;
    var w = Find(h);
    if (w == null || w.Z != 0) return false;
    var wa = Screen.FromPoint(new Point(w.R.Left + w.R.Width / 2, w.R.Top)).WorkingArea;
    if (w.R.Top <= wa.Top + GH * sc || w.R.Width < 300) return false;   // maximized: no top edge to peek over
    bool left = rnd.NextDouble() < 0.5;
    double px = left ? w.R.Left + 60 * k : w.R.Right - 60 * k;
    if (!Clear(0, (int)px, w.R.Top - 4)) return false;
    peekWin = h; peekRect = w.R;
    Blink(px, w.R.Top + 12 * sc, false, IntPtr.Zero);
    leapPeep = true;
    return true;
  }

  // Phase out and come back peeping up from below the bottom of the screen, somewhere along it.
  bool PeepNow() {
    if (hidden || goId != null || errand != null || pulling == 1 || chat.Visible) return false;
    var wa = Work();
    double px = Math.Max(wa.Left + 40 * k, Math.Min(wa.Right - 40 * k, x + (rnd.NextDouble() - 0.5) * 900 * k));
    Blink(px, wa.Bottom + 12 * sc, false, IntPtr.Zero);
    leapPeep = true;
    return true;
  }

  void Blink(double tx, double ty, bool perch, IntPtr onto) {
    leapPeep = false; leapCeil = false;
    ltx = tx; lty = ty; leapPerch = perch; leapOn = onto;
    on = IntPtr.Zero; wall = IntPtr.Zero; vx = 0; vy = 0; idleSleep = 0;
    Go(St.Blink);
  }

  void TripStep() {
    var t = trip;
    double ground = Work().Bottom;
    bool there = !t.Perch && Math.Abs(t.Y - ground) < 3;
    double stop = there ? t.X : t.X - Math.Sign(t.X - x) * Math.Min(Math.Abs(t.X - x), 140 * k);
    double dx = stop - x;
    if (Math.Abs(dx) > 2) {
      facing = dx > 0 ? 1 : -1;
      if (st != St.Walk) Go(St.Walk);
      x += facing * Math.Min(2.4 * k, Math.Abs(dx));   // a brisk walk, never a run
      return;
    }
    trip = null;
    if (chasing) { chasing = false; facing = Cursor.Position.X >= x ? 1 : -1; Go(St.Wave); actTicks = 45; return; }
    if (there) { ltx = x = t.X; lty = y; leapPerch = false; leapOn = IntPtr.Zero; Go(St.Land); Arrived(); return; }
    LeapTo(t.X, t.Y, t.Perch, t.On);
  }

  // Got to the click target: clicks go straight through her for a moment, then tell the brain.
  void Arrived() {
    if (pulling == 1) { StartPull(); return; }
    if (goId == null) return;
    ClickThrough(true); throughUntil = DateTime.Now.AddMilliseconds(2500); throughUntilSet = true;
    Emit("arrived", goId, null); goId = null;
  }

  // The brain is about to click (x, y) for them: get there first, so they can watch her do it.
  void GoTo(string id, int px, int py) {
    if (goId != null) Emit("arrived", goId, null);   // superseded
    if (pulling == 1) ChatNow();
    goId = id;
    bool onScreen = false;
    foreach (var s in Screen.AllScreens) if (s.Bounds.Contains(px, py)) onScreen = true;
    if (hidden || !onScreen || st == St.Drag || st == St.Vanish || st == St.Appear) { Arrived(); return; }
    Reach(px, py);
  }
  // Hands at (px, py): hanging off it, or on the ground beside it when it's too low to hang from.
  void Reach(int px, int py) {
    if (st == St.Hang || st == St.Climb) wall = IntPtr.Zero;
    errand = null; stomp = false;
    var wa = Screen.FromPoint(new Point(px, py)).WorkingArea;
    int f = px >= x ? 1 : -1;
    double bx = px - f * HAND * sc, by = py + (GH - 1) * sc;
    if (by > wa.Bottom - 2) {
      // Too low to hang from (the taskbar, the bottom of a window): stand on the ground beside it.
      double gx = Math.Max(wa.Left + 20, Math.Min(wa.Right - 20, px - f * 9 * sc));
      if (Math.Abs(gx - x) < 6 && on == IntPtr.Zero && st != St.Leap) { facing = f; Arrived(); return; }
      Travel(gx, wa.Bottom, false, IntPtr.Zero);
      return;
    }
    Travel(bx, by, true, IntPtr.Zero);
  }

  // ---------- on the job: the AI's real work, acted out where it happens ----------
  // Every tool call the AI makes comes here as an act (see ../director.js): what kind of work it is and
  // where. She pops over there (out in pixels, back in on the spot) and does it: presses, sits on the
  // window's top typing, reads, writes it down, throws it off to their phone, turns to them to ask.
  // job holds while the work goes on (topped up by every call); "home" ends it and she pops home.
  string job = "";                    // press type scroll look read write code wave throw grab present ask
  int jobLeft;                        // ticks the job holds her (no wandering off while it's on)
  bool jobNew;                        // the move hasn't been done yet at this spot
  string pose = ""; int poseLeft;     // a drawn move held for a moment while she stands (press, throw, grab)
  bool popping;                       // getting there: a pop, never a run along the taskbar
  int squash;                         // ticks of squash-and-stretch left from landing a pop
  IntPtr jobH, jobPtH; Rectangle jobRect;     // the window she's hanging off for the job (she lets go if it moves)

  string homeOk; int homeSteps;       // from the director's "home": the job went well, in this many steps
  void Act(string move, int px, int py, int pw, int ph, bool hasPt, int secs, IntPtr wh) {
    if (hidden || quitting || move.Length == 0) return;
    idleSleep = 0;
    bool free = st != St.Drag && st != St.Vanish && st != St.Appear && st != St.Pull && !mouseDown && errand == null && pulling != 1;
    if (move == "home") {
      // The work's over: back home with a pop, unless she's there already. How it went (ok, steps) is
      // a reason for the next decision: a jump, or a little dance after a long job.
      job = ""; jobLeft = 0; pose = ""; poseLeft = 0;
      if (homeOk != null) { outcome = homeOk; outcomeSteps = homeSteps; if (AtHome() && st == St.Stand) actTicks = Math.Min(actTicks, 15); }
      if (mood == "curious" || mood == "thinking") { mood = ""; moodLeft = 0; }
      if (free && goId == null && !Placed && !AtHome()) { popping = true; Travel(Math.Max(Work().Left + 30 * k, HomeX() - rnd.Next((int)(120 * k))), Work().Bottom, false, IntPtr.Zero); popping = false; }
      return;
    }
    job = move; jobNew = true;
    jobLeft = Math.Max(60, Math.Min(900, secs * 30));
    if (move == "ask") { mood = "curious"; moodLeft = jobLeft; }
    else if (move == "read") { mood = "thinking"; moodLeft = 120; }
    else if (move == "throw" || move == "present") { mood = "happy"; moodLeft = 90; }
    else if (move == "code") codeLeft = Math.Max(codeLeft, 20 * 30);
    else if (move == "write") writeLeft = Math.Max(writeLeft, 75);
    // Asking: the question is in the app in front (their Claude), so that's where she goes.
    if (move == "ask" && pw <= 0 && !hasPt && fgH != IntPtr.Zero && fgH != chat.Handle) {
      var fr = Native.Frame(fgH); if (!fr.IsEmpty) { px = fr.Left; py = fr.Top; pw = fr.Width; ph = fr.Height; }
    }
    if (!free || goId != null) return;   // busy being carried, or already heading to a click: the job waits
    // Her hands are where the AI is about to click: let clicks go straight through her for a moment.
    ClickThrough(true); throughUntil = DateTime.Now.AddMilliseconds(3000); throughUntilSet = true;
    popping = true;
    if (pw > 0) OnTop(new Rectangle(px, py, pw, ph), wh);
    else if (hasPt) { jobH = IntPtr.Zero; jobPtH = TopAt(new Point(px, py)); bool there = Math.Abs(px - x) < 40 * k && Math.Abs(py - (y - (GH - 1) * sc)) < 40 * k; if (there) actTicks = 1; else Reach(px, py); }
    else if (st == St.Stand || st == St.Sit || st == St.Land || (st >= St.Wave && st <= St.Look)) actTicks = 1;   // right here, now
    popping = false;
  }

  // Up on a window: standing on its top edge where there's room, or hanging off its title bar when it
  // fills the screen or something covers its top.
  void OnTop(Rectangle r, IntPtr wh) {
    Scan();
    Win w = wh != IntPtr.Zero ? Find(wh) : null;
    var mid = new Point(r.Left + r.Width / 2, r.Top + Math.Min(r.Height / 2, 40));
    if (w == null) foreach (var c in wins) if (c.R == r) { w = c; break; }
    if (w == null) foreach (var c in wins) if (c.R.Contains(mid)) { w = c; break; }   // frontmost first
    if (w == null) { actTicks = 1; return; }
    jobH = w.H; jobRect = w.R;
    if (on == w.H && (st == St.Stand || st == St.Sit || (st >= St.Wave && st <= St.Look))) { actTicks = 1; return; }   // already up there
    // Somewhere along its top, toward the right (where a person's eye doesn't start), not on the corner.
    double sx = Math.Max(w.R.Left + 40 * k, Math.Min(w.R.Right - 60 * k, w.R.Left + w.R.Width * 0.68));
    if (Floor(w, (int)sx)) { Travel(sx, w.R.Top, false, w.H); return; }
    double hy = w.R.Top + 9 * sc;   // the title bar's bottom edge, roughly
    if (hy + (GH - 1) * sc > Ground(sx) - 4) { actTicks = 1; return; }
    Travel(sx - HAND * sc, hy + (GH - 1) * sc, true, IntPtr.Zero);
  }

  // The frontmost window at a point on the screen (Zero: none, the desktop).
  IntPtr TopAt(Point p) { Scan(); foreach (var c in wins) if (c.R.Contains(p)) return c.H; return IntPtr.Zero; }

  // What she does there once she's arrived (and keeps doing while the job holds her).
  void DoJob() {
    bool fresh = jobNew; jobNew = false;
    if (st == St.Trip || st == St.Camp || st == St.Dance) Go(St.Stand);   // a stumble or a show never holds up the job
    if (st != St.Stand && st != St.Sit && st != St.Land && !(st >= St.Wave && st <= St.Look)) { actTicks = 10; return; }
    var cur = Cursor.Position;
    if (!fresh) {
      // Between steps: still at it, now and then glancing about, never wandering off.
      // Only a change of pose goes through Go (it starts the pose over and picks a new way to sit).
      if (job == "type" || job == "code") { if (st != St.Sit && on != IntPtr.Zero) Sit(90); else if (st != St.Sit && st != St.Stand) Go(St.Stand); actTicks = 45; return; }
      if (rnd.NextDouble() < 0.25) { if (st != St.Look) Go(St.Look); actTicks = 70; return; }
      if (st != St.Stand) Go(St.Stand); actTicks = 40 + rnd.Next(40); return;
    }
    if (job == "press" || job == "grab") { Go(St.Stand); pose = job; poseLeft = 28; actTicks = 34; return; }
    if (job == "type") { if (on != IntPtr.Zero) Sit(Math.Min(jobLeft, 300)); else Go(St.Stand); typeLeft = Math.Max(typeLeft, 60); actTicks = 60; return; }
    if (job == "code") { Go(on != IntPtr.Zero ? St.Sit : St.Stand); actTicks = 60; return; }
    if (job == "scroll") { if (Ch.Has("pull")) { Go(St.Stand); pose = "pull"; poseLeft = 40; actTicks = 44; } else { Go(St.Look); actTicks = 60; } return; }
    if (job == "look" || job == "read") { Go(St.Look); actTicks = 70; return; }
    if (job == "write") { Go(St.Stand); writeLeft = Math.Max(writeLeft, 75); actTicks = 75; return; }
    if (job == "throw") { Go(St.Stand); pose = "throw"; poseLeft = 36; actTicks = 40; return; }
    if (job == "wave" || job == "present") { Go(St.Wave); actTicks = 45; return; }
    if (job == "ask") { facing = cur.X >= x ? 1 : -1; Go(St.Wave); actTicks = 45; return; }
    Go(St.Stand); actTicks = 40;
  }

  // Now and then: leap up and hang off the bottom of the browser's address bar for a bit.
  bool BarHang() { return BarHang(false); }
  bool BarHang(bool asked) {
    if (fgBar.IsEmpty || fgH == IntPtr.Zero || Native.Frame(fgH) != fgBarFrame || st == St.Hang || st == St.Climb) return false;
    double px = Math.Max(fgBar.Left + 24 * k, Math.Min(fgBar.Right - 24 * k, x + (rnd.NextDouble() - 0.5) * 240 * k));
    double py = fgBar.Bottom;
    if (py + (GH - 1) * sc > Ground(px) - 4 || !Clear(0, (int)px, (int)py - 2)) return false;
    int f = px >= x ? 1 : -1;
    double hx = px - f * HAND * sc, hy = py + (GH - 1) * sc;
    if (!asked && !Hoppable(hx, hy)) return false;
    if (st == St.Hang || st == St.Climb) wall = IntPtr.Zero;
    Travel(hx, hy, true, IntPtr.Zero);
    facing = f;
    return true;
  }

  // ---------- errands: opening an app the way a person would, off the taskbar ----------
  void OpenApp(string id, string name) {
    ThreadPool.QueueUserWorkItem(delegate {
      AutomationElement hit = null, start = null; Rectangle hr = Rectangle.Empty, sr = Rectangle.Empty;
      try {
        var tray = AutomationElement.FromHandle(Native.FindWindow("Shell_TrayWnd", null));
        int best = 99;
        foreach (AutomationElement el in tray.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button))) {
          var c = el.Current; string n = (c.Name ?? "").Trim();
          var r = c.BoundingRectangle;
          if (n.Length == 0 || r.IsEmpty || c.IsOffscreen) continue;
          if (n == "Start") { start = el; sr = new Rectangle((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height); continue; }
          int score = n.StartsWith(name, StringComparison.OrdinalIgnoreCase) ? 0 : n.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0 ? 1 : 99;
          if (score < best) { best = score; hit = el; hr = new Rectangle((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height); }
        }
      } catch { }
      try {
        BeginInvoke((MethodInvoker)delegate {
          var el = hit ?? start; var r = hit != null ? hr : sr;
          if (el == null || hidden) { Emit("opened", id, "{\"ok\":false}"); return; }
          // Not on the taskbar: she still runs to Start and hops on it; the brain opens it from there.
          errand = new Errand { Id = id, Name = hit != null ? name : null, X = r.Left + r.Width / 2.0, El = hit };
          if (pulling == 1) ChatNow();
          goId = null; idleSleep = 0; bubble.Hide();
          if (st == St.Hang || st == St.Climb) LetGo(); else if (st == St.Perch) Fall();
        });
      } catch { }
    });
  }

  // One step of the errand: down to the taskbar, run along it, hop on the button.
  void Errand1() {
    var e = errand;
    double side = x <= e.X ? 1 : -1;
    double gx = e.X - side * 20 * k, dx = gx - x;
    var wa = Screen.FromPoint(new Point((int)gx, (int)y - 4)).WorkingArea;
    if (on != IntPtr.Zero || Math.Abs(y - wa.Bottom) > 2 || Math.Abs(dx) > 560 * k) {
      double lx = Math.Abs(dx) > 160 * k ? gx - Math.Sign(dx) * 110 * k : x + (Math.Abs(dx) < 30 * k ? -facing * 30 * k : 0);
      if (Math.Abs(lx - x) <= 230 * k) LeapTo(lx, wa.Bottom, false, IntPtr.Zero); else Blink(lx, wa.Bottom, false, IntPtr.Zero);
      return;
    }
    if (Math.Abs(dx) > 2) {
      facing = dx > 0 ? 1 : -1;
      if (st != St.Walk) Go(St.Walk);
      x += facing * Math.Min(2.4 * k, Math.Abs(dx));   // a brisk walk, never a run
      return;
    }
    // Beside the button, not on it: she leans over and presses it with her hand.
    facing = (int)side; x = gx; Go(St.Press);
  }

  // Landed on the button: press it.
  void Press() {
    var e = errand; errand = null;
    if (e == null) return;
    if (e.El == null) { Emit("opened", e.Id, "{\"ok\":false,\"start\":true}"); return; }
    // Already in front? Clicking it again would minimize it.
    string fg = (fgProc + " " + fgTitle).ToLower();
    if (fg.Contains(e.Name.ToLower())) { Emit("opened", e.Id, "{\"ok\":true}"); return; }
    var el = e.El; var me = this;
    ThreadPool.QueueUserWorkItem(delegate {
      bool ok = false;
      try { object p; if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); ok = true; } } catch { }
      if (!ok) {
        try {
          me.Invoke((MethodInvoker)delegate {
            var r = el.Current.BoundingRectangle;
            var back = Cursor.Position;
            ClickThrough(true);
            Native.SetCursorPos((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2));
            Native.mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); Native.mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
            Native.SetCursorPos(back.X, back.Y);
            throughUntil = DateTime.Now.AddMilliseconds(400); throughUntilSet = true;
          });
          ok = true;
        } catch { }
      }
      Emit("opened", e.Id, ok ? "{\"ok\":true}" : "{\"ok\":false}");
    });
  }

  // ---------- walls: climbing a window's side, hanging off its corner ----------
  // Where its feet go on a side: body just outside the edge, hands on it.
  double WallX(Rectangle r, int sd) { return sd < 0 ? r.Left - 5 * sc : r.Right + 5 * sc; }
  int EdgeX(Rectangle r, int sd) { return sd < 0 ? r.Left : r.Right - 1; }

  // Can it hold on here? The side has to be there and not covered by a window in front.
  bool Holdable(Win w, int sd, double feetY) {
    int ex = EdgeX(w.R, sd);
    int hy = (int)(feetY - (GH - 1) * sc) + 2;
    if (hy < w.R.Top - 2 || hy > w.R.Bottom) return false;
    return Clear(w.Z, ex, Math.Max(w.R.Top + 1, hy)) && Clear(w.Z, ex, (int)Math.Min(w.R.Bottom - 1, feetY - 4 * sc));
  }

  // Off the end of a window's top: grab the corner and dangle.
  bool Grab(Win w, int dir, bool fromClimb) {
    int sd = dir > 0 ? 1 : -1;
    if (!Clear(w.Z, EdgeX(w.R, sd), w.R.Top + 2)) return false;
    double fy = w.R.Top + (GH - 1) * sc;
    if (!fromClimb && fy > Ground(x)) return false;   // no room to hang
    wall = w.H; wallRect = w.R; side = sd; on = IntPtr.Zero;
    x = WallX(w.R, sd); y = fy;
    facing = -sd;   // face the window
    Go(St.Hang); actTicks = fromClimb ? 12 + rnd.Next(20) : 50 + rnd.Next(110);
    return true;
  }

  // Walking along into a window's side that comes down to its feet: sometimes climb it.
  bool WalkIntoWall(double nx) {
    if (climbRest > 0) return false;
    foreach (var w in wins) {
      if (w.H == on) continue;
      int sd = facing > 0 ? -1 : 1;            // walking right meets a left side
      double wx = WallX(w.R, sd);
      if ((x - wx) * (nx - wx) > 0) continue;  // didn't reach it this step
      if (w.R.Top > y - 40 * sc || w.R.Bottom < y - 6 * sc) continue;
      if (!Holdable(w, sd, y)) continue;
      if (rnd.NextDouble() < 0.5) { climbRest = 150; return false; }   // not this time
      wall = w.H; wallRect = w.R; side = sd; x = wx; facing = -sd;
      climbDir = -1; Go(St.Climb);
      return true;
    }
    return false;
  }

  // Pick a climbable side nearby and turn toward it.
  bool TowardWall() {
    Win best = null; double bd = 500 * k; int bsd = 0;
    foreach (var w in wins) {
      if (w.H == on || w.R.Top > y - 40 * sc || w.R.Bottom < y - 6 * sc) continue;
      foreach (int sd in new[] { -1, 1 }) {
        double d = Math.Abs(WallX(w.R, sd) - x);
        if (d < bd && d > 20 && Holdable(w, sd, y)) { best = w; bd = d; bsd = sd; }
      }
    }
    if (best == null) return false;
    facing = WallX(best.R, bsd) > x ? 1 : -1;
    return true;
  }

  void LetGo() { wall = IntPtr.Zero; vx = side * 1.5 * k; vy = 0; climbRest = 200; climbDir = 0; Fall(); }
  // Push off the wall with her feet: a jump away from it.
  void KickOff() { wall = IntPtr.Zero; climbRest = 200; climbDir = 0; facing = side; vx = side * 4 * k; vy = -6 * k; on = IntPtr.Zero; Go(St.Jump); }

  void OnWall() {
    var w = Fresh(wall);
    if (w == null) { LetGo(); return; }
    if (w.R != wallRect) HoldOn(w);   // ride the window: it moves, we move
    if (st == St.Hang) {
      y = w.R.Top + (GH - 1) * sc;
      if (!Clear(w.Z, EdgeX(w.R, side), w.R.Top + 2)) { LetGo(); return; }
      if (--actTicks > 0) return;
      double r = rnd.NextDouble();
      if (r < 0.5 || climbDir < 0) {
        // Pull up onto the top, if there's room up there.
        double nx = side < 0 ? w.R.Left + 10 * sc : w.R.Right - 10 * sc;
        if (Floor(w, (int)nx)) {
          x = nx; y = w.R.Top; on = w.H; onRect = w.R; wall = IntPtr.Zero;
          climbDir = 0; climbRest = 200; facing = -side; Go(St.Land); return;
        }
      }
      if (r < 0.8 && w.R.Bottom - w.R.Top > 60 * k) { climbDir = 1; Go(St.Climb); return; }
      if (rnd.NextDouble() < 0.5) KickOff(); else LetGo();
      return;
    }
    // Climbing, the way Shimeji climbs: hold, step, hold with the other hand, step (see climb.cs).
    int ph = stTicks % 28;
    if ((ph >= 10 && ph < 14) || ph >= 24) y += climbDir * 3.5 * k;
    if (climbDir < 0 && y - (GH - 1) * sc <= w.R.Top) { Grab(w, side, true); climbDir = -1; return; }
    double gr = Ground(x);
    if (climbDir > 0 && y >= gr) { y = gr; wall = IntPtr.Zero; climbDir = 0; climbRest = 200; Go(St.Land); return; }
    if (climbDir > 0 && y - 6 * sc > w.R.Bottom) { LetGo(); return; }
    if (!Holdable(w, side, y)) { LetGo(); return; }
    if (rnd.NextDouble() < 0.004) climbDir = -climbDir;   // changed its mind
    else if (rnd.NextDouble() < 0.002 && y < Ground(x) - 40 * k) KickOff();
  }

  // ---------- keeping out of the way ----------
  // A click near it (not on it): hop away from the cursor.
  void Clicks() {
    bool down = (Native.GetAsyncKeyState(0x01) & 0x8000) != 0;
    if (down && !lmb && !mouseDown && !hidden && !throughUntilSet) {
      var c = Cursor.Position;
      bool onUs = Bounds.Contains(c) || (bubble.Visible && bubble.Bounds.Contains(c)) || (menu.Visible && menu.Bounds.Contains(c)) || (chat.Visible && chat.Bounds.Contains(c));
      double dx = c.X - x, dy = c.Y - (y - GH * sc / 2.0);
      if (!onUs && Math.Abs(dx) < 130 * k && Math.Abs(dy) < 110 * k) Scoot(dx >= 0 ? -1 : 1);
    }
    lmb = down;
  }

  void Scoot(int dir) {
    if (Placed && AtSpot()) return;   // put here: it doesn't hop out of the way, the click just goes through
    if (st == St.Drag || st == St.Vanish || st == St.Appear || st == St.Jump || st == St.Fall || st == St.Crouch || st == St.Leap || st == St.Blink || st == St.Pull || trip != null || goId != null || pulling == 1) return;
    idleSleep = 0; actTicks = 60;
    if (st == St.Hang || st == St.Climb) { LetGo(); vx = dir * 3 * k; return; }
    if (st == St.Perch || st == St.Ceil) { Fall(); vx = dir * 3 * k; vy = 0; return; }
    facing = dir; vx = dir * 3.4 * k; vy = -7.5 * k; on = IntPtr.Zero; Go(St.Jump);
    Emit("dodge", null, null);
  }

  void ClickThrough(bool through) {
    int ex = Native.GetWindowLong(Handle, -20);
    Native.SetWindowLong(Handle, -20, through ? ex | 0x20 : ex & ~0x20);
    bubble.ClickThrough(through);
  }

  static readonly ControlType[] CLICKY = { ControlType.Button, ControlType.Hyperlink, ControlType.MenuItem, ControlType.TabItem,
    ControlType.CheckBox, ControlType.RadioButton, ControlType.ListItem, ControlType.TreeItem, ControlType.ComboBox, ControlType.Edit, ControlType.SplitButton };

  // Clicked on it. If it was covering something you can click, that's what you meant: it jumps
  // aside and the click goes through. Otherwise you get its menu (click again to close it).
  void ClickedMe() {
    var p = Cursor.Position;
    int me = Process.GetCurrentProcess().Id;
    ClickThrough(true);
    ThreadPool.QueueUserWorkItem(delegate {
      bool clicky = false;
      try {
        var el = AutomationElement.FromPoint(new System.Windows.Point(p.X, p.Y));
        var walker = TreeWalker.ControlViewWalker;
        for (int i = 0; i < 4 && el != null && !clicky; i++) {
          if (el.Current.ProcessId == me) break;
          if (Array.IndexOf(CLICKY, el.Current.ControlType) >= 0) clicky = true;
          el = walker.GetParent(el);
        }
      } catch { }
      try {
        BeginInvoke((MethodInvoker)delegate {
          if (clicky && Cursor.Position == p) {
            Scoot(p.X >= x ? -1 : 1);
            Native.mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); Native.mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
            throughUntil = DateTime.Now.AddMilliseconds(500); throughUntilSet = true;
            return;
          }
          ClickThrough(false);
          if (menu.Visible || menu.JustClosed) { menu.Close2(true); return; }
          Emit("poke", null, null);
          Hold();
          menu.Open();
        });
      } catch { }
    });
  }

  // Jump up onto a window that's in reach: a real arc, aimed to land just inside its edge.
  bool TryJump() {
    var opts = new List<Win>();
    foreach (var w in wins) {
      double up = y - w.R.Top;
      if (up < 20 * k || up > 1.15 * GH * sc || w.H == on) continue;
      double tx = Math.Max(w.R.Left + 30, Math.Min(w.R.Right - 30, x));
      if (Math.Abs(tx - x) > 200 * k || !Floor(w, (int)tx)) continue;
      opts.Add(w);
    }
    if (opts.Count == 0) return false;
    var t = opts[rnd.Next(opts.Count)];
    double tgx = Math.Max(t.R.Left + 30, Math.Min(t.R.Right - 30, x + (rnd.NextDouble() - 0.5) * 120 * k));
    double g = 0.9 * k, h = y - t.R.Top + 12 * k;
    vy = -Math.Sqrt(2 * g * h);
    double T = -vy / g + Math.Sqrt(2 * 12 * k / g);
    vx = (tgx - x) / T;
    facing = vx >= 0 ? 1 : -1;
    on = IntPtr.Zero;
    Go(St.Crouch);
    return true;
  }

  // ---------- the look ----------
  void Animate() {
    if (--blinkAt <= 0) { blinkLeft = 4; blinkAt = 70 + rnd.Next(110); }
    if (blinkLeft > 0) blinkLeft--;
    if (typeLeft > 0) typeLeft--;
    if (codeLeft > 0) codeLeft--;
    if (writeLeft > 0) writeLeft--;
    if (jobLeft > 0 && --jobLeft == 0) job = "";
    if (poseLeft > 0 && (--poseLeft == 0 || st != St.Stand)) { poseLeft = 0; pose = ""; }
    if (squash > 0) squash--;
    if (moodLeft > 0 && --moodLeft == 0) mood = "";
    Draw();
  }

  void Px(int cx, int cy, Color c) {
    if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) return;
    if (facing < 0) cx = GW - 1 - cx;
    int R = frame.Width / GW;
    for (int i = 0; i < R; i++) for (int j = 0; j < R; j++) frame.SetPixel(cx * R + i, cy * R + j, c);
  }

  // The frame and scale for the look's detail: a Res 2 look draws 32x48 and sc goes even so each of its
  // pixels is a whole number of screen pixels; Res 4 draws 64x96 for a look fine enough not to need that.
  // A look's Scale makes it bigger or smaller on screen.
  void Rescale() {
    int R = Character.ResOf(Ch);
    if (frame.Width != GW * R) { frame = new Bitmap(GW * R, GH * R); rank = new double[GW * GH * R * R]; for (int i = 0; i < rank.Length; i++) rank[i] = rnd.NextDouble(); }
    else if (rank[0] == 0) for (int i = 0; i < rank.Length; i++) rank[i] = rnd.NextDouble();
    int nsc = Math.Max(2, (int)Math.Round(baseSc * Math.Max(0.5, Math.Min(2, Ch.Scale))));
    if (R == 2 && nsc % 2 == 1) nsc++;
    if (nsc == sc && ClientSize.Width == GW * sc) return;
    sc = nsc; k = sc / 3.0;
    if (IsHandleCreated) { ClientSize = new Size(GW * sc, GH * sc); Place(); }
  }
  // One frame of the character: tell it what's going on, let it draw, then outline it.
  void Draw() {
    var c = Ch;
    if (frame.Width != GW * Character.ResOf(c)) Rescale();
    using (var g = Graphics.FromImage(frame)) g.Clear(KEY);
    bool asleep = idleSleep > 0;
    c.Frame = frame; c.Move = MoveName(asleep); c.Tick = tick; c.StTicks = stTicks; c.Facing = facing; c.Vy = vy;
    c.Lean = dragVx / (6 * k); c.Asleep = asleep; c.Thinking = thinking; c.Talking = bubble.Talking || (voice != null && voice.Speaking); c.BubbleUp = bubble.Visible;
    c.Mouth = voice != null && voice.Speaking ? voice.Mouth : -1;
    bubble.RevealTo(voice != null ? voice.RevealFor(bubble.Id) : -1);
    c.Mood = mood; c.Hover = happyHover; c.Blinking = blinkLeft > 0; c.Coding = Coding(asleep); c.Typing = typeLeft > 0 || st == St.Type || c.Coding; c.Writing = typeLeft > 0 || writeLeft > 0; c.Busy = goId != null;
    c.Perching = st == St.Perch; c.Tint = tint; c.Swing = swinging ? SwingPose() : 0; c.Variant = variant; c.Held = held;
    var cur = Cursor.Position;
    double cdx = cur.X - x;
    bool near = Math.Abs(cdx) < 360 * k && Math.Abs(cur.Y - y) < 360 * k;
    c.LookX = near ? ((cdx * facing) > 12 ? 1 : (cdx * facing) < -12 ? -1 : 0) : 0;
    c.LookUp = cur.Y < y - 30 * sc && Math.Abs(cdx) < 360 * k;
    try { c.Render(); }
    catch (Exception e) { if (!drawFailed) { drawFailed = true; Emit("error", null, model + " " + c.Move + ": " + e.Message); } }
    Finish(asleep, c.Outline);
    // Below the bottom of the screen (peeping): only what's above the edge shows.
    int edge = st == St.Peep && peekWin != IntPtr.Zero ? peekRect.Top : Screen.FromPoint(new Point((int)x, (int)y - GH * sc)).WorkingArea.Bottom, top = (int)Math.Round(y - GH * sc);
    int FW = frame.Width, FH = frame.Height, R = FW / GW;
    if (y > edge + 1) frameChanged = true;
    if (y > edge + 1) for (int j = 0; j < FH; j++) if (top + j * sc / R + sc / R / 2 >= edge) for (int i = 0; i < FW; i++) frame.SetPixel(i, j, KEY);
  }

  // Working on code shows only while she's still (standing or sitting, on the floor or a window): mid-jump,
  // dragged or asleep she's not at her laptop.
  bool Coding(bool asleep) { return codeLeft > 0 && !asleep && !hidden && (st == St.Stand || st == St.Sit || st == St.Type || st == St.Perch); }

  // Which move the character should draw, from what the engine is doing.
  string MoveName(bool asleep) {
    if (poseLeft > 0 && st == St.Stand && pose.Length > 0) return pose;   // on the job: pressing, throwing, scrolling
    if (st == St.Press) return "press";
    if (st == St.Camp) return stTicks < 45 ? "kindle" : "camp";
    if (st == St.Grab) return "grab";
    if (st == St.Throw) return "throw";
    if (st == St.Pull) return "pull";
    if (st == St.Peep) return "peep";
    if (st == St.Climb) return "climb";
    if (st == St.Ceil || (st == St.Blink && leapCeil && stTicks > BLINK)) return "ceiling";
    if (Hangs()) return "hang";
    if (st == St.Drag) return "drag";
    if (st == St.Walk) return creeping ? "creep" : "walk";
    if (st == St.Jump || st == St.Leap) return vy < 0 ? "jump" : "fall";
    if (st == St.Fall) return thrown ? "thrown" : "fall";
    if (st == St.Crouch || st == St.Land) return "crouch";
    if (prep > 0 && stTicks < prep && (st == St.Sit || st == St.Stand || st == St.Walk) && !asleep && Ch.Has("crouch")) return "crouch";
    if (st == St.Trip) return stTicks < 14 ? "trip" : "sprawl";
    if (asleep && (st == St.Stand || st == St.Sit) && Ch.Has("sleep")) return "sleep";
    if (st == St.Sit) return sitKind == 1 ? "dangle" : sitKind == 2 ? "hug" : "sit";
    if (st == St.Wave) return "wave";
    if (st == St.Stretch) return yawning ? "yawn" : "stretch";
    if (st == St.Dance) return "dance";
    if (st == St.Look) return "look";
    return asleep ? "sleep" : "stand";
  }

  // Hanging, she's a pendulum from her hands: the window she holds jerking sideways throws her body the
  // other way, gravity swings her back, and now and then she kicks to get a swing going herself. The
  // angle only picks one of five drawn poses (SwingPose), the way Shimeji picks hand-drawn lean frames;
  // the sprite itself is never rotated.
  double swing, swingV, rideDx, lastRideDx;   // swing: radians, feet to the right is positive
  bool swinging;
  void Swing() {
    bool h = Hangs() && st != St.Blink;
    if (!h) { swinging = false; swing = swingV = 0; rideDx = lastRideDx = 0; return; }
    if (!swinging) { swinging = true; swing = 0; swingV = Math.Max(-0.1, Math.Min(0.1, vx * 0.012 / k)); lastRideDx = rideDx = 0; }
    double accel = rideDx - lastRideDx;
    lastRideDx = rideDx; rideDx = 0;
    swingV -= accel * 0.006 / k;                        // the window lurches, her body lags behind
    swingV -= 0.03 * Math.Sin(swing);                   // gravity
    swingV *= 0.965;                                    // air
    if (Math.Abs(swing) < 0.04 && Math.Abs(swingV) < 0.01 && rnd.NextDouble() < 0.006) swingV += (rnd.Next(2) * 2 - 1) * 0.045;   // a kick
    swing = Math.Max(-0.6, Math.Min(0.6, swing + swingV));
    if (Math.Abs(swing) >= 0.6) swingV *= -0.3;
  }

  int SwingPose() { double a = swing * facing; return a > 0.3 ? 2 : a > 0.1 ? 1 : a < -0.3 ? -2 : a < -0.1 ? -1 : 0; }

  // She hangs with her hands at the top of the sprite, a little ahead of her middle.
  bool Hangs() { return st == St.Hang || st == St.Perch || (st == St.Blink && leapPerch && stTicks > BLINK); }

  // Their color, by name ("teal", "hot pink") or hex ("#88aaff").
  static Color ParseColor(string s) {
    s = (s ?? "").Trim().ToLower().Replace(" ", "");
    if (s.Length == 0) return Color.Empty;
    var m = Regex.Match(s, "^#?([0-9a-f]{6})$");
    if (m.Success) return Color.FromArgb(Convert.ToInt32(m.Groups[1].Value, 16) | unchecked((int)0xFF000000));
    var c = Color.FromName(s);
    return c.IsKnownColor && c.A == 255 ? Color.FromArgb(c.R, c.G, c.B) : Color.Empty;
  }

  public void SetLook(string name, string color, bool save) {
    name = (name ?? "").Trim().ToLower();
    if (name.Length > 0 && Character.All().ContainsKey(name) && name != model) { model = name; ch = null; drawFailed = false; }
    if (color != null) { var c = ParseColor(color); if (!c.IsEmpty || color.Trim().Length == 0) tint = c; }
    if (save) SaveLook();
    try { Face.Save(model, tint, Path.Combine(dir, "..", "stead-face.ico")); } catch { }
  }

  public void SetName(string n) {
    n = Regex.Replace(n ?? "", @"\s+", " ").Trim();
    if (n.Length == 0) return;
    if (n.Length > 24) n = n.Substring(0, 24);
    called = n; chat.Rename(n); SaveLook();
  }

  void SaveLook() {
    var d = new Dictionary<string, object>();
    d["model"] = model; d["color"] = tint.IsEmpty ? "" : "#" + (tint.ToArgb() & 0xFFFFFF).ToString("x6");
    d["name"] = called; d["roam"] = roam; d["voice"] = voiceOn;
    try { File.WriteAllText(Path.Combine(dir, "look.json"), json.Serialize(d)); } catch { }
  }

  void LoadLook() {
    try {
      var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(dir, "look.json")));
      SetLook(S(d, "model"), S(d, "color"), false);
      string n = S(d, "name"); if (!string.IsNullOrEmpty(n)) called = n;
      roam = S(d, "roam") != "False";
      voiceOn = S(d, "voice") == "True";
    } catch { }
  }

  // Everyone: an outline (so it reads on any background), sleep z's, and the digitize effect.
  int[] lastPx; bool frameChanged = true;
  void Finish(bool asleep, bool outline) {
    int keyc = KEY.ToArgb(), inkc = INK.ToArgb(), FW = frame.Width, FH = frame.Height;
    var px = Pixels();
    if (outline) {
      var edge = new List<int>();
      for (int j = 0; j < FH; j++) for (int i = 0; i < FW; i++) {
        int o = j * FW + i;
        if (px[o] != keyc) continue;
        for (int d = 0; d < 4; d++) {
          int ni = i + (d == 0 ? 1 : d == 1 ? -1 : 0), nj = j + (d == 2 ? 1 : d == 3 ? -1 : 0);
          if (ni < 0 || nj < 0 || ni >= FW || nj >= FH) continue;
          int c = px[nj * FW + ni];
          if (c != keyc && c != inkc) { edge.Add(o); break; }
        }
      }
      foreach (int o in edge) px[o] = inkc;
    }
    if (st == St.Appear || st == St.Vanish || st == St.Blink) {
      // Breaking up into pixels (or putting herself back together), top first going, feet first coming:
      // a bright seam where she's coming apart, and glitchy scanlines running through the part still going.
      int edgeC = Ch.Edge.ToArgb(), R = FW / GW;
      for (int j = 0; j < FH; j++) {
        bool scan = ((j / R) + tick) % 3 == 0;
        for (int i = 0; i < FW; i++) {
          int o = j * FW + i;
          if (px[o] == keyc) continue;
          double r = rank[o] * 0.55 + (FH - j) / (double)FH * 0.45;
          if (r > progress) px[o] = keyc;
          else if (r > progress - 0.14 || (scan && r > progress - 0.3)) px[o] = edgeC;
        }
      }
    }
    if (squash > 0) px = Squash(px, keyc, FW, FH);
    Pixels(px);
    frameChanged = lastPx == null || lastPx.Length != px.Length;
    if (!frameChanged) for (int i = 0; i < px.Length; i++) if (px[i] != lastPx[i]) { frameChanged = true; break; }
    lastPx = px;
    if (asleep && Ch.ZzzY >= 0) {
      frameChanged |= tick % 20 == 0;
      int zp = (tick / 20) % 3, zx = 13, zy = Ch.ZzzY - zp;
      Px(zx, zy, GLOW); Px(zx + 1, zy, GLOW); Px(zx + 1, zy + 1, GLOW); Px(zx, zy + 2, GLOW); Px(zx + 1, zy + 2, GLOW);
    }
    if (mood.Length > 0 && !asleep && Ch.MoodY >= 0) Emote(mood, Ch.MoodY);
  }

  // Landing a pop: squashed flat for a beat, then a springy stretch, settling (feet stay put; hanging,
  // her hands do). Nearest pixel, so she stays crisp.
  int[] Squash(int[] px, int keyc, int FW, int FH) {
    double t = 1 - squash / (double)SQUASH, a = Math.Sin(t * Math.PI * 2) * (1 - t) * 0.22;
    double sy = 1 - a, sx = 1 + a * 0.6;
    if (Math.Abs(a) < 0.01) return px;
    double cx = FW / 2.0, ay = st == St.Perch ? 0 : FH;
    var o = new int[px.Length];
    for (int j = 0; j < FH; j++) {
      int sj = (int)Math.Floor(ay + (j + 0.5 - ay) / sy);
      for (int i = 0; i < FW; i++) {
        int si = (int)Math.Floor(cx + (i + 0.5 - cx) / sx);
        o[j * FW + i] = si < 0 || sj < 0 || si >= FW || sj >= FH ? keyc : px[sj * FW + si];
      }
    }
    return o;
  }

  // The little mark over her head that says how she feels, for every look (a look's face can say more).
  static readonly Dictionary<string, string> EMOTE = new Dictionary<string, string> {
    { "love", "heart" }, { "sympathetic", "heart" }, { "happy", "note" }, { "laughing", "note" }, { "calm", "note" },
    { "excited", "spark" }, { "proud", "spark" }, { "smug", "spark" }, { "relieved", "drop" }, { "curious", "ask" }, { "confused", "ask" },
    { "thinking", "dots" }, { "bored", "dots" }, { "surprised", "bang" }, { "shocked", "bang" }, { "scared", "drop" }, { "worried", "drop" },
    { "nervous", "drop" }, { "embarrassed", "drop" }, { "shy", "drop" }, { "sad", "gloom" }, { "crying", "gloom" }, { "angry", "vein" },
    { "annoyed", "vein" }, { "disgusted", "squig" }, { "sleepy", "z" }, { "determined", "fire" }, { "mischievous", "spark" }, { "idea", "bulb" } };
  static readonly Dictionary<string, string[]> MARK = new Dictionary<string, string[]> {
    { "heart", new[] { "X.X", "XXX", ".X." } }, { "note", new[] { ".XX", ".X.", "XX." } }, { "spark", new[] { ".X.", "XXX", ".X." } },
    { "ask", new[] { "XX.", "..X", ".X.", "...", ".X." } }, { "bang", new[] { "X", "X", "X", ".", "X" } }, { "dots", new[] { "X.X.X" } },
    { "drop", new[] { ".X", "XX", "XX" } }, { "gloom", new[] { "X.X", "X.X", "..X" } }, { "vein", new[] { "X.X", "...", "X.X" } },
    { "squig", new[] { "X.X.", ".X.X" } }, { "z", new[] { "XX", ".X", "XX" } }, { "fire", new[] { ".X.", "XX.", "XXX" } }, { "bulb", new[] { "XXX", "XXX", ".X." } } };
  void Emote(string m, int my) {
    string kind; string[] rows;
    if (!EMOTE.TryGetValue(m, out kind) || !MARK.TryGetValue(kind, out rows)) return;
    Color c = kind == "heart" ? Color.FromArgb(240, 80, 110) : kind == "vein" || kind == "fire" ? Color.FromArgb(235, 70, 60)
      : kind == "drop" || kind == "gloom" ? Color.FromArgb(120, 185, 255) : kind == "squig" ? Color.FromArgb(130, 200, 90)
      : kind == "dots" || kind == "z" ? Color.FromArgb(215, 215, 225) : Color.FromArgb(255, 215, 70);
    int bob = (tick / 15) % 2;   // a slow bounce, so it reads as alive
    frameChanged |= tick % 15 == 0;
    int x0 = rows[0].Length > 3 ? 11 : 13, y0 = Math.Max(0, my - 1 - bob);
    for (int j = 0; j < rows.Length; j++) for (int i = 0; i < rows[j].Length; i++) if (rows[j][i] == 'X') Px(x0 + i, y0 + j, c);
  }

  // The frame's pixels as ARGB ints, and back (GetPixel/SetPixel one at a time is slow).
  int[] Pixels() {
    var px = new int[frame.Width * frame.Height];
    var d = frame.LockBits(new Rectangle(0, 0, frame.Width, frame.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    for (int y = 0; y < frame.Height; y++) Marshal.Copy(d.Scan0 + y * d.Stride, px, y * frame.Width, frame.Width);
    frame.UnlockBits(d);
    return px;
  }
  void Pixels(int[] px) {
    var d = frame.LockBits(new Rectangle(0, 0, frame.Width, frame.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    for (int y = 0; y < frame.Height; y++) Marshal.Copy(px, y * frame.Width, d.Scan0 + y * d.Stride, frame.Width);
    frame.UnlockBits(d);
  }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    g.Clear(KEY);
    g.InterpolationMode = InterpolationMode.NearestNeighbor;
    g.PixelOffsetMode = PixelOffsetMode.Half;
    g.DrawImage(frame, new Rectangle(0, 0, GW * sc, GH * sc));
  }

  // ---------- you ----------
  protected override void OnMouseDown(MouseEventArgs e) {
    touchedAt = DateTime.Now;
    mouseDown = true; downAt = Cursor.Position;
    grab = new Point(Cursor.Position.X - (int)x, Cursor.Position.Y - (int)y);
  }
  protected override void OnMouseMove(MouseEventArgs e) {
    if (mouseDown && st != St.Drag && st != St.Vanish && st != St.Pull) {
      var c = Cursor.Position;
      if (Math.Abs(c.X - downAt.X) + Math.Abs(c.Y - downAt.Y) > 5) {
        if (pulling == 1) ChatNow();
        Go(St.Drag); on = IntPtr.Zero; wall = IntPtr.Zero; idleSleep = 0; dragVx = dragVy = 0; stomp = false; trip = null; chasing = false; held = 0; thrown = false;
        if (errand != null) { Emit("opened", errand.Id, "{\"ok\":false}"); errand = null; }
        if (goId != null) { Emit("arrived", goId, null); goId = null; }
      }
    }
  }
  protected override void OnMouseUp(MouseEventArgs e) {
    if (!mouseDown) return;
    mouseDown = false;
    if (st == St.Drag && Ch.Stays) {
      // The orb: a ball, not a body. Wherever they let go is where it stays, exactly, from now on (and
      // after a restart), until they move it again or reset it. No falling, no rolling, no wandering home.
      PutSpot(x, y);
      return;
    }
    if (st == St.Drag) {
      vx = Math.Max(-25, Math.Min(25, dragVx)); vy = Math.Max(-25, Math.Min(25, dragVy)); Go(St.Fall);
      thrown = Math.Abs(dragVx) + Math.Abs(dragVy) > 14 * k;
      justLanded = true;   // wherever she comes down, she'll look around (after a sprawl, if thrown)
      if (thrown) Emit("thrown", null, null);
      // Put down (not flung): where they let go is home now. A throw is play, not a move, so it doesn't
      // count. Over a window she may land on it, but home is the floor under that spot.
      else { var wa = Work(); homeX = Math.Max(wa.Left + 40 * k, Math.Min(wa.Right - 40 * k, x)); }
      return;
    }
    idleSleep = 0;
    Hush(true);
    ClickedMe();
  }
  protected override void OnMouseEnter(EventArgs e) { happyHover = true; }
  protected override void OnMouseLeave(EventArgs e) { happyHover = false; }

  // ---------- the menu and the chat window ----------
  public void MenuPick(string id) {
    if (id == "chat") { OpenChat(); return; }
    if (id == "resetpos") { ResetSpot(); Emit("menu", "resetpos", null); return; }
    if (id.StartsWith("look:")) { SetLook(id.Substring(5), null, true); if (!hidden) Anim("wave"); Emit("menu", "look", model); return; }
    if (id == "roam") {
      roam = !roam; SaveLook();
      if (!roam && (st == St.Walk || st == St.Dance || st == St.Sit)) { Go(St.Stand); actTicks = 60; }
      Emit("menu", "roam", roam ? "on" : "off");
      return;
    }
    // Quick chat: talk to her in her bubble instead of the window. Same mind, same tools; her answer
    // comes back in the bubble with a box to keep going.
    if (id == "quick") { bubble.Ask("What's up?", "quick"); return; }
    if (id == "rename") { bubble.Ask("What should I be called?", "rename"); return; }
    if (id == "newlook") { bubble.Ask("Describe the new me. I'll redraw every move to match.", "newlook"); return; }
    if (id == "color") { bubble.Ask("What color? (teal, hot pink, #88aaff...)", "color"); return; }
    if (id == "voice") {
      voiceOn = !voiceOn; SaveLook();
      if (!voiceOn) Hush(false);
      Emit("menu", "voice", voiceOn ? "on" : "off");
      string said = !voiceOn ? "Voice off." : Talkable() ? "Voice on. Hi!" : "Voice on. I'll stay quiet while you're in a call or full screen.";
      bubble.Show2(said, new List<string[]>(), 4000, "voice", "say", false);
      Speak("voice", said, true);
      return;
    }
    if (id == "quiet") { bubble.Hide(); Hush(false); }
    Emit("menu", id, null);
  }

  // Open the chat: it's there at once, ready to type in, and she hops up onto it after. Nobody waits
  // on the show. Already open: just type.
  public void OpenChat() {
    bubble.Hide();
    if (chat.Visible && !chat.Sliding) { chat.Take(); return; }
    Emit("chat-opened", null, null);
    ChatNow();
    if (hidden || !roam || Placed || st == St.Drag || st == St.Vanish || st == St.Appear || st == St.Pull || goId != null || errand != null) return;
    var t = chat.Target();
    if (st == St.Hang || st == St.Climb) wall = IntPtr.Zero;
    Scan();
    Travel(t.Left + 34 * k, t.Top, false, chat.Handle);
  }

  void StartPull() {
    pulling = 0;
    var t = chat.Target();
    pullFrom = t.Bottom - (GH - 1) * sc;
    chat.SetTop((int)pullFrom);
    if (!chat.Visible) chat.Show();
    on = IntPtr.Zero; wall = IntPtr.Zero; facing = 1; idleSleep = 0;
    Go(St.Pull);
  }

  // No time for the show: the chat window just appears.
  void ChatNow() {
    pulling = 0;
    chat.SetTop(chat.Target().Top);
    if (!chat.Visible) chat.Show();
    chat.Take();
  }

  // A screenshot of the screen you're on, small enough to send, for the brain.
  void Snap(string id) {
    string path = Path.Combine(dir, "snap.jpg");
    try {
      var s = Screen.FromHandle(fgH != IntPtr.Zero ? fgH : Handle).Bounds;
      double f = Math.Min(1, 1280.0 / s.Width);
      using (var full = new Bitmap(s.Width, s.Height))
      using (var small = new Bitmap((int)(s.Width * f), (int)(s.Height * f))) {
        using (var g = Graphics.FromImage(full)) g.CopyFromScreen(s.Location, Point.Empty, s.Size);
        using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, small.Width, small.Height); }
        ImageCodecInfo jpeg = null;
        foreach (var e in ImageCodecInfo.GetImageEncoders()) if (e.MimeType == "image/jpeg") jpeg = e;
        var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
        small.Save(path, jpeg, ps);
      }
      Emit("snapped", id, path);
    } catch (Exception e) { Emit("snapped", id, "error: " + e.Message); }
  }

  // ---------- the brain's side ----------
  // Speaking out loud: only with voice on, and never in a call or over a full-screen app.
  bool Talkable() { return !inCall && !fgFull && notif != 1 && notif != 2 && notif != 3 && notif != 4 && notif != 6 && notif != 7; }
  void Speak(string id, string text, bool final) {
    if (!voiceOn || !Talkable()) return;
    if (voice == null) voice = new Voice();
    voice.Say(id, text, final);
  }
  // Cut her off. Their doing (a click, a dismiss, a new message): the brain hears where she got to.
  void Hush(bool theirs) {
    if (voice == null) return;
    var said = voice.Stop();
    bubble.RevealTo(-1);
    if (theirs && said != null) Emit("interrupted", null, said.Length > 300 ? said.Substring(said.Length - 300) : said);
  }

  public void Emit(string type, string id, string msg) {
    if (type == "chat" || type == "dismiss" || type == "button") Hush(true);
    var d = new Dictionary<string, object>();
    d["at"] = DateTime.UtcNow.ToString("o"); d["type"] = type;
    if (id != null) d["id"] = id;
    if (msg != null) d["msg"] = msg;
    lock (outLock) { try { File.AppendAllText(outbox, new JavaScriptSerializer().Serialize(d) + "\n"); } catch { } }
  }

  // New messages from the brain: a watcher flags them as they land, with a slow poll as a backstop.
  FileSystemWatcher inboxWatch; volatile bool inboxNew = true;
  void ReadInbox() {
    if (inboxWatch == null) {
      try {
        inboxWatch = new FileSystemWatcher(inbox, "*.json");
        inboxWatch.Created += delegate { inboxNew = true; }; inboxWatch.Renamed += delegate { inboxNew = true; };
        inboxWatch.EnableRaisingEvents = true;
      } catch { }
    }
    if (!inboxNew && tick % 30 != 0) return;
    inboxNew = false;
    string[] files;
    try { files = Directory.GetFiles(inbox, "*.json"); } catch { return; }
    Array.Sort(files);
    foreach (var f in files) {
      Dictionary<string, object> m = null;
      try { m = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(f)); } catch { }
      try { File.Delete(f); } catch { }
      if (m != null) OnMessage(m);
    }
  }

  // A number from a message, whole or not (JSON may say 412 or 412.5); def when it isn't one.
  static int N(Dictionary<string, object> m, string key, int def) {
    double d; string v = S(m, key);
    if (v == null || !double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) return def;
    return (int)Math.Round(Math.Max(-1e6, Math.Min(1e6, d)));
  }
  static string S(Dictionary<string, object> m, string key) { object v; return m.TryGetValue(key, out v) && v != null ? v.ToString() : null; }

  void OnMessage(Dictionary<string, object> m) {
    string type = S(m, "type") ?? "say";
    if (type == "quit") { Quit(); return; }
    if (type == "reload") { Environment.Exit(3); return; }   // the brain rebuilds her (a new look) and starts her again
    if (type == "snap") { Snap(S(m, "id") ?? ""); return; }
    if (type == "name") { SetName(S(m, "name")); return; }
    if (type == "roam") { roam = S(m, "on") != "False"; SaveLook(); return; }
    if (type == "reset-pos") { ResetSpot(); return; }
    if (type == "menuinfo") { formHere = S(m, "form") == "True"; return; }
    if (type == "chat-open") { OpenChat(); return; }
    if (type == "chat-close") { chat.Close2(); return; }
    if (type == "chat-add") { chat.Add(S(m, "who") ?? "me", S(m, "text") ?? ""); return; }
    if (type == "chat-delta") { chat.Delta(S(m, "text") ?? ""); return; }
    if (type == "chat-step") { chat.Step(S(m, "text") ?? ""); return; }
    if (type == "chat-end") { chat.Done(); return; }
    if (type == "chat-status") { chat.Status(S(m, "text") ?? ""); return; }
    if (type == "chat-history") {
      var items = new List<string[]>();
      object v;
      if (m.TryGetValue("items", out v) && v is System.Collections.ArrayList)
        foreach (var o in (System.Collections.ArrayList)v) {
          var d = o as Dictionary<string, object>;
          if (d != null) items.Add(new[] { S(d, "who") ?? "me", S(d, "text") ?? "" });
        }
      chat.History(items);
      return;
    }
    if (type == "think") { thinking = S(m, "on") != "False"; return; }
    if (type == "mood") {
      int secs = 14; int.TryParse(S(m, "secs") ?? "", out secs);
      mood = secs > 0 ? (S(m, "mood") ?? "") : ""; moodLeft = Math.Max(0, Math.Min(120, secs)) * 30;
      if (!hidden && goId == null && (st == St.Stand || st == St.Sit)) {
        if (mood == "excited" || mood == "proud") React("jump", "feeling " + mood, 30);
        else if (mood == "sleepy" || mood == "bored") React("yawn", "feeling " + mood, 45);
        else if (mood == "love" || mood == "happy") React("wave", "feeling " + mood, 45);
      }
      return;
    }
    if (type == "hush") { Hush(false); bubble.Dismiss(); return; }
    if (type == "voice-flush") { if (voice != null && Talkable()) voice.Flush(S(m, "id") ?? ""); return; }
    if (type == "point") {
      // "That's it, there": she runs over to it and rings it on your screen. Nothing gets clicked.
      int px = 0, py = 0, pw = 0, ph = 0;
      int.TryParse(S(m, "x") ?? "", out px); int.TryParse(S(m, "y") ?? "", out py); int.TryParse(S(m, "w") ?? "", out pw); int.TryParse(S(m, "h") ?? "", out ph);
      ring.Flash(new Rectangle(px, py, pw, ph), 7000);
      if (!hidden) GoTo("", px + pw / 2, py + ph / 2);
      return;
    }
    if (type == "go") { int gx = 0, gy = 0; int.TryParse(S(m, "x") ?? "", out gx); int.TryParse(S(m, "y") ?? "", out gy); GoTo(S(m, "id") ?? "", gx, gy); return; }
    if (type == "outcome") { int n = N(m, "steps", 0); Outcome(S(m, "ok") == "False" ? "error" : "ok", n); return; }
    if (type == "act") {
      homeOk = S(m, "ok") == "True" ? "ok" : null; homeSteps = N(m, "steps", 0);
      // The AI's at work: what it's doing and where (see Act). No x/y: right where she is.
      int ax = N(m, "x", int.MinValue), ay = N(m, "y", int.MinValue), aw = N(m, "w", 0), ah = N(m, "h", 0), secs = N(m, "secs", 15);
      bool pt = ax != int.MinValue && ay != int.MinValue;
      if (!pt) { ax = 0; ay = 0; }
      if (aw <= 0 || ah <= 0) { aw = 0; ah = 0; }
      // the window itself, when the tool knows it: matching it by its rect alone can miss (rects from
      // other DPI-aware processes, a browser's invisible resize borders)
      long ahw = 0; long.TryParse(S(m, "hwnd") ?? "", out ahw);
      Act(S(m, "move") ?? "", ax, ay, aw, ah, pt, secs, new IntPtr(ahw));
      return;
    }
    if (type == "openApp") { OpenApp(S(m, "id") ?? "", S(m, "name") ?? ""); return; }
    if (type == "code") {
      // Working on code: glasses on, at her laptop. The brain tops it up with every coding step and
      // winds it down to a few seconds when the work's done; 0 stops it now.
      int secs = 0; int.TryParse(S(m, "secs") ?? "", out secs);
      codeLeft = Math.Max(0, Math.Min(600, secs)) * 30;
      if (codeLeft > 0) { idleSleep = 0; if (goId == null && errand == null && trip == null && (st == St.Walk || st == St.Dance || st == St.Stretch || st == St.Look || st == St.Wave)) { Go(St.Stand); actTicks = 60; } }
      return;
    }
    if (type == "type") { int n = 45; int.TryParse(S(m, "ticks") ?? "", out n); typeLeft = Math.Max(0, Math.Min(400, n)); idleSleep = 0; return; }
    if (type == "look") { SetLook(S(m, "model"), S(m, "color"), true); if (!hidden) Anim("wave"); return; }
    if (type == "anim") { if (!hidden) Anim(S(m, "name") ?? ""); return; }
    if (type == "scan") { ScanFields(S(m, "id") ?? ""); return; }
    if (type == "fill") {
      object v; if (m.TryGetValue("values", out v) && v is System.Collections.ArrayList) FillFields(S(m, "id") ?? "", (System.Collections.ArrayList)v);
      return;
    }
    if (type == "say") {
      var btns = new List<string[]>();
      object b;
      if (m.TryGetValue("buttons", out b) && b is System.Collections.ArrayList)
        foreach (var o in (System.Collections.ArrayList)b) {
          var d = o as Dictionary<string, object>;
          if (d != null) btns.Add(new[] { S(d, "id") ?? "ok", S(d, "label") ?? "OK" });
        }
      int ttl = 14000; int.TryParse(S(m, "ttl") ?? "", out ttl); if (ttl <= 0) ttl = btns.Count > 0 ? 25000 : 14000;
      ttl = Math.Max(ttl, 3000 + (S(m, "text") ?? "").Length * 70);   // long enough to read: ~14 characters a second
      idleSleep = 0;
      if (hidden) return;
      // A narration line ("Popping over to Gmail!") never talks over something real she's saying.
      bool narr = S(m, "kind") == "narrate";
      if (narr && bubble.Visible && bubble.Kind != "narrate" && bubble.Kind != "status") return;
      if (!narr && (st == St.Sit || st == St.Walk)) Go(St.Stand);
      if (S(m, "kind") == "greet" && (st == St.Stand || st == St.Sit)) React("greet", "saying hello", 45);
      bubble.Show2(S(m, "text") ?? "", btns, ttl, S(m, "id") ?? "", S(m, "kind") ?? "say", S(m, "input") == "True");
      // A streamed reply (kind chat) is said a sentence at a time; the rest on voice-flush.
      if (S(m, "speak") == "True" && S(m, "kind") != "status") Speak(S(m, "id") ?? "", S(m, "text") ?? "", (S(m, "kind") ?? "say") != "chat");
    }
  }

  // ---------- filling a form, instantly, through UI Automation ----------
  // scan: list the fields on the page in front (labels, kinds, what's in them now).
  void ScanFields(string id) {
    var h = fgH;
    ThreadPool.QueueUserWorkItem(delegate {
      var outp = new List<Dictionary<string, object>>();
      var els = new List<AutomationElement>();
      try {
        var root = AutomationElement.FromHandle(h);
        AutomationElement doc = null;
        // A browser builds the page's tree on first ask; only the page, never its address bar.
        for (int attempt = 0; attempt < 6 && doc == null; attempt++) {
          if (attempt > 0) Thread.Sleep(400);
          doc = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
        }
        bool browser = Regex.IsMatch(fgProc, "^(chrome|msedge|brave|firefox|opera|vivaldi)$", RegexOptions.IgnoreCase);
        if (doc == null && !browser) doc = root;
        for (int attempt = 0; attempt < 1 && doc != null; attempt++) {
          els.Clear(); outp.Clear();
          var cond = new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ComboBox),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.CheckBox),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.RadioButton));
          foreach (AutomationElement el in doc.FindAll(TreeScope.Descendants, cond)) {
            if (els.Count >= 80) break;
            try {
              var c = el.Current;
              if (!c.IsEnabled || c.IsPassword || c.IsOffscreen && c.BoundingRectangle.IsEmpty) continue;
              var f = new Dictionary<string, object>();
              string name = c.Name;
              if (string.IsNullOrEmpty(name) && c.LabeledBy != null) name = c.LabeledBy.Current.Name;
              if (string.IsNullOrEmpty(name)) name = c.HelpText;
              f["name"] = name ?? "";
              object pat;
              if (c.ControlType == ControlType.Edit) {
                if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out pat) || ((ValuePattern)pat).Current.IsReadOnly) continue;
                f["kind"] = "text"; f["value"] = ((ValuePattern)pat).Current.Value;
              } else if (c.ControlType == ControlType.ComboBox) {
                f["kind"] = "select";
                f["value"] = el.TryGetCurrentPattern(ValuePattern.Pattern, out pat) ? ((ValuePattern)pat).Current.Value : "";
                var opts = new List<string>();
                f["options"] = Options(el);
              } else if (c.ControlType == ControlType.CheckBox) {
                f["kind"] = "check";
                f["value"] = el.TryGetCurrentPattern(TogglePattern.Pattern, out pat) && ((TogglePattern)pat).Current.ToggleState == ToggleState.On ? "on" : "";
              } else {
                f["kind"] = "radio";
                f["value"] = el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat) && ((SelectionItemPattern)pat).Current.IsSelected ? "on" : "";
              }
              f["i"] = els.Count;
              els.Add(el); outp.Add(f);
            } catch { }
          }
        }
      } catch { }
      lock (outLock) found = els;
      var res = new Dictionary<string, object>(); res["fields"] = outp;
      Emit("fields", id, new JavaScriptSerializer().Serialize(res));
    });
  }

  // A dropdown's choices. Browsers only list them while it's open, so open it for a moment.
  List<string> Options(AutomationElement el) {
    var opts = new List<string>();
    var cond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem);
    for (int pass = 0; pass < 2 && opts.Count == 0; pass++) {
      object ec = null;
      if (pass == 1) { if (!el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out ec)) break; try { ((ExpandCollapsePattern)ec).Expand(); Thread.Sleep(120); } catch { } }
      foreach (AutomationElement o in el.FindAll(TreeScope.Descendants, cond)) if (opts.Count < 60) opts.Add(o.Current.Name);
      if (ec != null) { try { ((ExpandCollapsePattern)ec).Collapse(); } catch { } }
    }
    return opts;
  }

  // fill: put values in the fields the last scan found. [{i, v}]; v "on" ticks a box or picks a radio.
  void FillFields(string id, System.Collections.ArrayList vals) {
    List<AutomationElement> els; lock (outLock) els = found;
    var todo = new List<KeyValuePair<int, string>>();
    foreach (var o in vals) {
      var d = o as Dictionary<string, object>;
      int i; if (d == null || !int.TryParse(S(d, "i") ?? "", out i) || i < 0 || i >= els.Count) continue;
      todo.Add(new KeyValuePair<int, string>(i, S(d, "v") ?? ""));
    }
    if (todo.Count > 0) {
      writeLeft = Math.Min(600, 60 + todo.Count * 30);
      try {
        var fr = els[todo[0].Key].Current.BoundingRectangle;
        if (!fr.IsEmpty && goId == null && errand == null) GoTo("", (int)(fr.Left + Math.Min(40, fr.Width / 2)), (int)fr.Bottom);
      } catch { }
    }
    ThreadPool.QueueUserWorkItem(delegate {
      var ok = new List<int>(); var fail = new List<int>();
      foreach (var t in todo) {
        bool done = false;
        try { done = FillOne(els[t.Key], t.Value); } catch { }
        (done ? ok : fail).Add(t.Key);
      }
      var res = new Dictionary<string, object>(); res["ok"] = ok; res["fail"] = fail;
      Emit("filled", id, new JavaScriptSerializer().Serialize(res));
    });
  }

  bool FillOne(AutomationElement el, string v) {
    object pat; var ct = el.Current.ControlType;
    if (ct == ControlType.Edit) {
      if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) {
        try { ((ValuePattern)pat).SetValue(v); } catch { }
        if (((ValuePattern)pat).Current.Value == v) return true;
      }
      // Some pages ignore a set value: type it like a person would.
      el.SetFocus();
      string keys = Regex.Replace(v.Replace("\r", "").Replace("\n", " "), @"[+^%~(){}\[\]]", "{$0}");
      Invoke((MethodInvoker)delegate { SendKeys.SendWait("^a" + keys); });
      return el.TryGetCurrentPattern(ValuePattern.Pattern, out pat) && ((ValuePattern)pat).Current.Value == v;
    }
    if (ct == ControlType.CheckBox) {
      if (!el.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) return false;
      var tp = (TogglePattern)pat; bool want = v == "on";
      if ((tp.Current.ToggleState == ToggleState.On) != want) tp.Toggle();
      return true;
    }
    if (ct == ControlType.RadioButton) {
      if (v != "on" || !el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) return false;
      ((SelectionItemPattern)pat).Select();
      return true;
    }
    if (ct == ControlType.ComboBox) {
      object ec = null; el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out ec);
      var cond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem);
      AutomationElement hit = null;
      for (int pass = 0; pass < 2 && hit == null; pass++) {
        if (pass == 1 && ec != null) { try { ((ExpandCollapsePattern)ec).Expand(); Thread.Sleep(150); } catch { } }
        foreach (AutomationElement o in el.FindAll(TreeScope.Descendants, cond))
          if (string.Equals(o.Current.Name.Trim(), v.Trim(), StringComparison.OrdinalIgnoreCase)) { hit = o; break; }
      }
      bool done = false;
      if (hit != null && hit.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); done = true; }
      if (ec != null) { try { if (((ExpandCollapsePattern)ec).Current.ExpandCollapseState == ExpandCollapseState.Expanded) ((ExpandCollapsePattern)ec).Collapse(); } catch { } }
      if (!done) {
        el.SetFocus();
        string keys = Regex.Replace(v, @"[+^%~(){}\[\]]", "{$0}");
        Invoke((MethodInvoker)delegate { SendKeys.SendWait(keys); });
        Thread.Sleep(80);
        done = el.TryGetCurrentPattern(ValuePattern.Pattern, out pat) && string.Equals(((ValuePattern)pat).Current.Value.Trim(), v.Trim(), StringComparison.OrdinalIgnoreCase);
      }
      return done;
    }
    return false;
  }

  public void Quit() {
    if (quitting) return;
    quitting = true; bubble.Hide(); menu.Hide(); chat.Hide(); thinking = false;
    if (st == St.Appear) progress = Math.Max(progress, 0.01);
    progress = 1; Go(St.Vanish);
  }

  // What's on screen, for the brain: the window in front, its app, and (for browsers) the address.
  // Process names by pid, looked up once (Process.GetProcessById takes ~15ms).
  readonly Dictionary<uint, string> procNames = new Dictionary<uint, string>();
  string ProcName(uint pid) {
    string n;
    if (procNames.TryGetValue(pid, out n)) return n;
    n = "";
    try { n = Process.GetProcessById((int)pid).ProcessName; } catch { }
    if (procNames.Count > 300) procNames.Clear();
    return procNames[pid] = n;
  }

  void Foreground() {
    if (tick % 15 != 0) return;
    var h = Native.GetForegroundWindow();
    if (h == Handle || h == bubble.Handle || h == menu.Handle || h == chat.Handle) return;
    string title = Native.Text(h);
    uint pid; Native.GetWindowThreadProcessId(h, out pid);
    string proc = ProcName(pid);
    var r = Native.Frame(h);
    var scr = Screen.FromHandle(h).Bounds;
    string cls = Native.Class(h);
    fgFull = r.Width >= scr.Width && r.Height >= scr.Height && cls != "Progman" && cls != "WorkerW" && proc.ToLower() != "explorer";
    if (h != fgH || title != fgTitle) { fgUrl = ""; urlFor = ""; fgBar = Rectangle.Empty; }
    fgH = h; fgTitle = title; fgProc = proc;
    // The address bar, read with UI Automation off the UI thread (it can take a moment in Chrome).
    if (!urlBusy && urlFor != title && Regex.IsMatch(proc, "^(chrome|msedge|brave|firefox|opera|vivaldi)$", RegexOptions.IgnoreCase)) {
      urlBusy = true; urlFor = title;
      var hh = h;
      ThreadPool.QueueUserWorkItem(delegate {
        string u = "";
        try {
          var el = AutomationElement.FromHandle(hh);
          var edit = el.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
          object vp;
          if (edit != null && edit.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) u = ((ValuePattern)vp).Current.Value;
          if (edit != null) {
            var br = edit.Current.BoundingRectangle;
            if (br.Width > 80 && br.Height > 8) { fgBarFrame = Native.Frame(hh); fgBar = new Rectangle((int)br.X, (int)br.Y, (int)br.Width, (int)br.Height); }
          }
        } catch { }
        fgUrl = u; urlBusy = false;
      });
    }
  }

  void WriteState() {
    lastState = DateTime.Now;
    var fg = new Dictionary<string, object>();
    fg["title"] = fgTitle; fg["proc"] = fgProc; fg["url"] = fgUrl; fg["full"] = fgFull;
    var d = new Dictionary<string, object>();
    d["at"] = DateTime.UtcNow.ToString("o"); d["pid"] = Process.GetCurrentProcess().Id;
    notif = Native.NotifState();
    if ((DateTime.Now - micAt).TotalSeconds >= 3) { micAt = DateTime.Now; inCall = Native.MicInUse(); }
    if (voice != null && voice.Speaking && !Talkable()) Hush(false);   // a call started while she was talking
    d["notif"] = notif; d["inCall"] = inCall; d["voice"] = voiceOn;
    d["fg"] = fg; d["idle"] = Native.IdleMs(); d["state"] = st.ToString(); d["hidden"] = hidden;
    d["bubble"] = bubble.Visible ? bubble.Kind : "";
    d["chat"] = chat.Visible; d["menu"] = menu.Visible; d["model"] = model; d["name"] = called;
    var br = bubble.BoxRect(); if (bubble.Visible && !br.IsEmpty) d["box"] = new[] { br.X, br.Y, br.Width, br.Height };
    d["x"] = (int)x; d["y"] = (int)y; d["placed"] = Placed;
    // Through a temp file and a swap: the brain reads this every second and must never see half of it.
    var tmp = statePath + ".tmp";
    try {
      File.WriteAllText(tmp, json.Serialize(d));
      if (File.Exists(statePath)) File.Replace(tmp, statePath, null, true); else File.Move(tmp, statePath);
    } catch { try { File.WriteAllText(statePath, json.Serialize(d)); } catch { } }
  }

  static readonly Queue<DateTime> crashes = new Queue<DateTime>();
  static void Crashed(string dir, Exception e, bool canGoOn) {
    try {
      string log = Path.Combine(dir, "crash.log");
      if (File.Exists(log) && new FileInfo(log).Length > 200000) File.Delete(log);
      File.AppendAllText(log, DateTime.Now.ToString("s") + " " + e + Environment.NewLine + Environment.NewLine);
    } catch { }
    lock (crashes) {
      crashes.Enqueue(DateTime.Now);
      while (crashes.Count > 0 && (DateTime.Now - crashes.Peek()).TotalSeconds > 30) crashes.Dequeue();
      if (canGoOn && crashes.Count < 50) return;
    }
    Environment.Exit(1);
  }

  [STAThread]
  static void Main(string[] args) {
    Native.SetProcessDPIAware();
    string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hands", "onscreen");
    int watch = 0;
    for (int i = 0; i < args.Length - 1; i++) {
      if (args[i] == "--dir") dir = args[i + 1];
      if (args[i] == "--watch") int.TryParse(args[i + 1], out watch);
    }
    bool fresh;
    using (var mx = new Mutex(true, "Local\\SteadOnscreen", out fresh)) {
      if (!fresh) return;   // one of her is plenty
      Directory.CreateDirectory(dir);
      // Never Windows' "Unhandled exception... Continue / Quit" box: waking or unlocking the laptop
      // can leave a window handle stale for a moment ("The handle is invalid"). Log it and carry on;
      // only a storm of them (broken for real) ends her, and the daemon starts a fresh one.
      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
      Application.ThreadException += (s, e) => Crashed(dir, e.Exception, true);
      AppDomain.CurrentDomain.UnhandledException += (s, e) => Crashed(dir, e.ExceptionObject as Exception, false);
      Application.EnableVisualStyles();
      Application.Run(new Stead(dir, watch));
    }
  }
}
