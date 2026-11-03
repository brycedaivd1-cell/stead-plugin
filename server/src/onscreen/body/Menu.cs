// The menu you get when you click her: a small arc that comes out of her, see-through except for a
// few outlined words on it (CHAT, SETTINGS, GO AWAY). A button with more behind it (SETTINGS, then
// LOOK) branches off into its own arc and the words beside it tuck away; click it again, or Esc, to
// fold it back. Start typing and it
// goes into CHAT as a quick question (Enter sends it). A click anywhere else closes the lot and gives
// the keyboard back to where it was. Each arc turns to fit on the screen (she's usually standing on
// the taskbar, so the first one mostly swings up), and opens toward the roomier side of the screen.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

class RetroMenu : Form {
  static readonly Color KEY = Color.FromArgb(1, 0, 1), BG = Color.Black, FG = Color.FromArgb(242, 242, 239), DIM = Color.FromArgb(150, 150, 156);

  // One arc of buttons. The first comes out of her; each one after it out of the button that opened it.
  class Arc {
    public readonly List<string[]> rows = new List<string[]>();   // { id, label }
    public List<Rectangle> boxes = new List<Rectangle>();          // on the screen
    public readonly List<double> angles = new List<double>();
    public Point c;
    public int r0, R, popAt = -1, open = -1;   // open: which of its buttons has its own arc out
    public double dir, spread, grow;
    public bool stacked;
  }

  readonly Stead b;
  readonly Font font;
  readonly Timer tick;
  readonly List<Arc> arcs = new List<Arc>();
  string typed = "";
  int hoverArc = -1, hover = -1, pad, chipH, frames;
  Point her; int herR;
  IntPtr back = IntPtr.Zero;
  DateTime closedAt = DateTime.MinValue;
  bool closing, wasDown;

  public RetroMenu(Stead b) {
    this.b = b;
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
    BackColor = KEY; TransparencyKey = KEY; DoubleBuffered = true; KeyPreview = true;
    font = new Font("Consolas", 7.5f, FontStyle.Bold);
    int dpi; using (var g = CreateGraphics()) dpi = (int)g.DpiX;
    pad = 4 * dpi / 96;
    chipH = TextRenderer.MeasureText("X", font, Size.Empty, TextFormatFlags.NoPadding).Height + pad;
    tick = new Timer { Interval = 15 };
    tick.Tick += delegate { Step(); };
    var unused = Handle;   // make the window now, so she can tell it apart from others
  }

  protected override CreateParams CreateParams {
    get { var cp = base.CreateParams; cp.ExStyle |= 0x80 | 0x8; return cp; }   // toolwindow, topmost
  }

  // Closed a moment ago (a click on her closes it before her click arrives): that click meant "close".
  public bool JustClosed { get { return (DateTime.Now - closedAt).TotalMilliseconds < 400; } }

  public void Open() {
    back = Native.GetForegroundWindow();
    typed = ""; hoverArc = -1; hover = -1; frames = 0;
    Bounds = b.Work();   // the whole screen, all see-through: only the buttons catch clicks
    her = b.Center(); herR = b.BodyR;
    arcs.Clear();
    var a = new Arc { c = her, r0 = herR + pad / 2 };
    Rows(a, "main");
    // Toward the roomier side: out to her right, or to her left when she's over on the right.
    var dirs = new[] { 0, -0.2, -0.35, 0.2, 0.35, -0.5, 1, 1.2, 1.35, 0.8, 0.65, 1.5 };
    if (Right - her.X < her.X - Left) for (int i = 0; i < dirs.Length; i++) dirs[i] = 1 - dirs[i];
    FitArc(a, dirs);
    arcs.Add(a);
    Show();
    Take();
    tick.Start();
    Invalidate();
  }

  void Take() { Native.ForceForeground(Handle); Activate(); Focus(); }

  // Close it; give the keyboard back to the window you were in, unless what you picked takes it next.
  public void Close2(bool giveBack) {
    if (!Visible || closing) return;
    closing = true;
    tick.Stop(); Hide(); closedAt = DateTime.Now;
    if (giveBack && back != IntPtr.Zero) Native.SetForegroundWindow(back);
    closing = false;
  }
  protected override void OnDeactivate(EventArgs e) { base.OnDeactivate(e); if (Visible && !closing) { closing = true; tick.Stop(); Hide(); closedAt = DateTime.Now; closing = false; } }

  void Rows(Arc a, string page) {
    a.rows.Clear();
    if (page == "main") {
      a.rows.Add(new[] { "chat", "CHAT" });
      a.rows.Add(new[] { "quick", "QUICK CHAT" });
      a.rows.Add(new[] { "settings", "SETTINGS >" });
      a.rows.Add(new[] { "off", "GO AWAY · 1H" });
    } else if (page == "settings") {
      a.rows.Add(new[] { "help", "HELP WITH THIS" });
      if (b.FormHere) a.rows.Add(new[] { "fill", "FILL THIS FORM" });
      a.rows.Add(new[] { "looks", "LOOK >" });
      a.rows.Add(new[] { "rename", "RENAME" });
      a.rows.Add(new[] { "roam", b.Roam ? "STAY STILL" : "WANDER" });
      if (b.HasSpot) a.rows.Add(new[] { "resetpos", "RESET POSITION" });   // put somewhere: back to the bottom right
      a.rows.Add(new[] { "voice", b.VoiceOn ? "VOICE OFF" : "VOICE ON" });
      a.rows.Add(new[] { "quiet", "QUIET 1H" });
      a.rows.Add(new[] { "offgood", "TURN OFF" });
    } else {
      foreach (var n in Character.All().Keys) a.rows.Add(new[] { "look:" + n, n.ToUpperInvariant() + (n == b.Model ? " *" : "") });
      a.rows.Add(new[] { "newlook", "NEW..." });
      a.rows.Add(new[] { "color", "COLOR..." });
    }
  }

  string Label(Arc a, int i) {
    if (a.rows[i][0] != "chat" || typed.Length == 0) return a.rows[i][1];
    return (typed.Length > 40 ? "..." + typed.Substring(typed.Length - 37) : typed) + "_";
  }
  int ChipW(Arc a, int i) {
    string t = "> " + Label(a, i) + (a.rows[i][0] == "chat" && typed.Length == 0 ? " _" : "");
    return TextRenderer.MeasureText(t, font, Size.Empty, TextFormatFlags.NoPadding).Width + pad;
  }

  // Where each button sits for arc a at radius r pointing at d (screen coordinates).
  List<Rectangle> Place(Arc a, int r, double d) {
    var list = new List<Rectangle>();
    a.angles.Clear();
    int n = a.rows.Count;
    for (int i = 0; i < n; i++) {
      double t = n == 1 ? d : d - a.spread / 2 + a.spread * i / (n - 1);
      a.angles.Add(t);
      double cs = Math.Cos(t), sn = Math.Sin(t);
      int w = ChipW(a, i), px = a.c.X + (int)(r * cs), py = a.c.Y + (int)(r * sn);
      list.Add(new Rectangle(px - (int)(w * (1 - cs) / 2), py - (int)(chipH * (1 - sn) / 2), w, chipH));
    }
    return list;
  }

  bool Fits(List<Rectangle> list) {
    var room = Rectangle.Inflate(Bounds, -4, -4);
    var hers = new Rectangle(her.X - herR, her.Y - herR, herR * 2, herR * 2);
    for (int i = 0; i < list.Count; i++) {
      var q = Rectangle.Inflate(list[i], 1, 1);
      if (!room.Contains(list[i]) || q.IntersectsWith(hers)) return false;
      for (int j = 0; j < i; j++) if (q.IntersectsWith(list[j])) return false;
      foreach (var o in arcs) for (int j = 0; j < o.boxes.Count; j++) if (Showing(o, j) && q.IntersectsWith(o.boxes[j])) return false;
    }
    return true;
  }

  // Turn the arc (dirs, in half-turns) until its buttons fit; in a corner, squeeze them closer and
  // reach further; failing that, a straight stack on the roomier side.
  void FitArc(Arc a, double[] dirs) {
    a.grow = 0; a.popAt = -1; a.open = -1; a.stacked = false;
    double full = Math.PI * Math.Min(0.7, 0.14 * (a.rows.Count - 1));
    int baseR = a.r0 + chipH / 2;
    // Keep it tight, but in the direction asked for: find the smallest radius any direction fits
    // at, then take the first direction (in order) that fits within a little of it.
    foreach (var sp in new[] { full, Math.Min(full, Math.PI * 0.5), Math.Min(full * 1.4, Math.PI * 0.9) }) {
      a.spread = sp;
      int best = -1;
      for (int r = baseR; r <= baseR + chipH * 8 && best < 0; r += pad)
        foreach (var f in dirs) if (Fits(Place(a, r, f * Math.PI))) { best = r; break; }
      if (best < 0) continue;
      foreach (var f in dirs)
        for (int r = baseR; r <= best + chipH * 2; r += pad) {
          var l = Place(a, r, f * Math.PI);
          if (Fits(l)) { a.boxes = l; a.R = r; a.dir = f * Math.PI; return; }
        }
    }
    bool left = a.c.X - Left > Right - a.c.X;
    a.R = a.r0 + pad; a.dir = left ? Math.PI : 0; a.spread = Math.PI * 0.5; a.stacked = true;
    Place(a, a.R, a.dir);
    var got = new List<Rectangle>();
    int gap = chipH + 2, top = Math.Max(Top + 4, Math.Min(Bottom - 4 - gap * a.rows.Count, a.c.Y - gap * a.rows.Count / 2));
    for (int i = 0; i < a.rows.Count; i++) {
      int w = ChipW(a, i), x0 = left ? a.c.X - a.r0 - pad * 2 - w : a.c.X + a.r0 + pad * 2;
      got.Add(new Rectangle(x0, top + i * gap, w, chipH));
    }
    a.boxes = got;
  }

  // Open the arc behind button i of arc k (or fold it back if it's already out).
  void Branch(int k, string page, int i) {
    var p = arcs[k];
    bool wasOpen = p.open == i;
    Fold(k);
    if (wasOpen) return;
    p.open = i;
    var q = p.boxes[i];
    double t = p.angles[i];
    // It comes out of the far edge of the button, pointing the same way the button does.
    var a = new Arc { c = new Point(q.X + q.Width / 2 + (int)(Math.Cos(t) * q.Width / 2), q.Y + q.Height / 2 + (int)(Math.Sin(t) * q.Height / 2)), r0 = pad * 2 };
    Rows(a, page);
    double d = t / Math.PI;
    FitArc(a, new[] { d, d - 0.15, d + 0.15, d - 0.3, d + 0.3, d - 0.45, d + 0.45, d - 0.6, d + 0.6, d + 1 });
    arcs.Add(a);
    hoverArc = arcs.Count - 1; hover = -1;
    Invalidate();
  }
  void Fold(int k) { while (arcs.Count > k + 1) arcs.RemoveAt(arcs.Count - 1); arcs[k].open = -1; if (hoverArc > k) { hoverArc = k; hover = -1; } Invalidate(); }

  void Step() {
    frames++;
    bool moving = false;
    foreach (var a in arcs) {
      if (a.grow < 1) { a.grow = Math.Min(1, a.grow + 0.16); if (a.grow >= 1) a.popAt = frames; moving = true; }
      else if (frames - a.popAt < a.rows.Count * 2 + 2) moving = true;   // buttons popping in
    }
    if (moving || frames % 30 == 0) Invalidate();   // and the cursor in CHAT blinking
    // A click anywhere but on a button (or on her: she closes it herself) closes it.
    bool down = (Native.GetAsyncKeyState(0x01) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x02) & 0x8000) != 0;
    if (down && !wasDown) {
      var p = Cursor.Position;
      bool onHer = Math.Abs(p.X - her.X) < herR && Math.Abs(p.Y - her.Y) < herR;
      int k, i;
      if (!Hit(p, out k, out i) && !onHer) Close2(false);
    }
    wasDown = down;
  }

  static bool Showing(Arc a, int i) { return a.open < 0 || a.open == i; }   // a branched arc keeps only the word it branched from
  int Popped(Arc a) { return a.popAt < 0 ? 0 : Math.Min(a.rows.Count, (frames - a.popAt) / 2 + 1); }
  bool Hit(Point screen, out int k, out int i) {
    for (k = arcs.Count - 1; k >= 0; k--)
      for (i = 0; i < Math.Min(Popped(arcs[k]), arcs[k].boxes.Count); i++) if (Showing(arcs[k], i) && Rectangle.Inflate(arcs[k].boxes[i], 2, 2).Contains(screen)) return true;
    k = -1; i = -1; return false;
  }

  void Pick(int k, int i) {
    string id = arcs[k].rows[i][0];
    if (id == "chat" && typed.Length > 0) { Send(); return; }
    if (id == "settings" || id == "looks") { Branch(k, id, i); return; }
    bool next = id == "chat" || id == "quick" || id == "rename" || id == "newlook" || id == "color";   // these take the keyboard themselves
    Close2(!next);
    b.MenuPick(id);
  }

  void Send() { string t = typed.Trim(); typed = ""; if (t.Length == 0) return; Close2(true); b.Emit("chat", "quick", t); }

  void AddText(string s) {
    Fold(0);
    typed += s.Replace("\r", " ").Replace("\n", " ");
    Reflow();
  }
  void Reflow() {   // CHAT changed width: same arc, buttons re-measured
    var a = arcs[0];
    if (a.stacked) { var g = a.grow; FitArc(a, new[] { a.dir / Math.PI }); a.grow = g; a.popAt = -100; }
    else a.boxes = Place(a, a.R, a.dir);
    Invalidate();
  }

  protected override bool ProcessCmdKey(ref Message msg, Keys key) {
    int k = arcs.Count - 1, n = Math.Max(1, arcs[k].rows.Count);
    if (hoverArc != k) { hoverArc = k; hover = -1; }
    if (key == Keys.Down || key == Keys.Right) { hover = (hover + 1) % n; Invalidate(); return true; }
    if (key == Keys.Up || key == Keys.Left) { hover = hover <= 0 ? n - 1 : hover - 1; Invalidate(); return true; }
    if (key == Keys.Enter) {
      if (typed.Trim().Length > 0) Send();
      else if (hover >= 0) Pick(k, hover);
      else if (k == 0) Pick(0, 0);
      return true;
    }
    if (key == Keys.Escape) {
      if (typed.Length > 0) { typed = ""; Reflow(); }
      else if (k > 0) Fold(k - 1);
      else Close2(true);
      return true;
    }
    if (key == Keys.Back) { if (typed.Length > 0) { typed = typed.Substring(0, typed.Length - 1); Reflow(); } return true; }
    if (key == (Keys.Control | Keys.V)) { try { if (Clipboard.ContainsText()) AddText(Clipboard.GetText()); } catch { } return true; }
    return base.ProcessCmdKey(ref msg, key);
  }
  protected override void OnKeyPress(KeyPressEventArgs e) { if (e.KeyChar >= ' ') { AddText(e.KeyChar.ToString()); e.Handled = true; } }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    g.Clear(KEY);
    g.SmoothingMode = SmoothingMode.None;
    var flags = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;
    bool blink = frames / 30 % 2 == 0;
    using (var fg = new SolidBrush(FG)) using (var bg = new SolidBrush(BG)) using (var pen = new Pen(FG))
    using (var edge = new Pen(BG, 3)) using (var dash = new Pen(DIM, 1) { DashPattern = new float[] { 2, 4 } }) {
      for (int k = 0; k < arcs.Count; k++) {
        var a = arcs[k];
        var c = new Point(a.c.X - Left, a.c.Y - Top);
        double ease = 1 - Math.Pow(1 - a.grow, 3);
        int r = a.r0 + (int)((a.R - a.r0) * ease);
        float start = (float)((a.dir - Math.PI / 2) * 180 / Math.PI), sweep = (float)(180 * ease);
        if (k == 0) {   // the waves coming out of her
          int rr = a.r0 + (r - a.r0) / 2;
          if (rr > a.r0 + 2) g.DrawArc(dash, c.X - rr, c.Y - rr, rr * 2, rr * 2, start, sweep);
        } else g.FillRectangle(fg, c.X - 1, c.Y - 1, 3, 3);   // where it branches off
        if (a.open >= 0) {   // branched: just a dotted thread out to the word it branched from
          double t = a.angles[a.open];
          g.DrawLine(dash, c.X + (int)(a.r0 * Math.Cos(t)), c.Y + (int)(a.r0 * Math.Sin(t)), c.X + (int)(a.R * Math.Cos(t)), c.Y + (int)(a.R * Math.Sin(t)));
        } else if (r > 2) {   // a white line with a black edge, so it shows on anything
          g.DrawArc(edge, c.X - r, c.Y - r, r * 2, r * 2, start, sweep);
          g.DrawArc(pen, c.X - r, c.Y - r, r * 2, r * 2, start, sweep);
        }
        for (int i = 0; i < Math.Min(Popped(a), a.boxes.Count); i++) {
          if (!Showing(a, i)) continue;
          var q = a.boxes[i]; q.Offset(-Left, -Top);
          bool hot = (k == hoverArc && i == hover) || i == a.open;
          if (!a.stacked) g.FillRectangle(fg, c.X + (int)(a.R * Math.Cos(a.angles[i])) - 1, c.Y + (int)(a.R * Math.Sin(a.angles[i])) - 1, 3, 3);
          string t = (hot ? "> " : "  ") + Label(a, i);
          var tr = new Rectangle(q.X + pad / 2, q.Y, q.Width, q.Height);
          Outlined(g, t, tr, hot ? FG : Color.FromArgb(205, 205, 210), flags);
          if (a.rows[i][0] == "chat" && typed.Length == 0 && blink) {   // you can type here
            int tw = TextRenderer.MeasureText(t, font, Size.Empty, flags).Width;
            Outlined(g, " _", new Rectangle(tr.X + tw, tr.Y, tr.Width, tr.Height), DIM, flags);
          }
        }
      }
    }
  }

  // Just the word, with a black edge so it reads on anything (no box behind it).
  void Outlined(Graphics g, string t, Rectangle r, Color c, TextFormatFlags flags) {
    for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) {
      if (dx == 0 && dy == 0) continue;
      var o = r; o.Offset(dx, dy);
      TextRenderer.DrawText(g, t, font, o, BG, flags);
    }
    TextRenderer.DrawText(g, t, font, r, c, flags);
  }

  protected override void OnMouseMove(MouseEventArgs e) {
    int k, i;
    if (!Hit(PointToScreen(e.Location), out k, out i)) { k = -1; i = -1; }
    if (k != hoverArc || i != hover) { hoverArc = k; hover = i; Invalidate(); Cursor = i >= 0 ? Cursors.Hand : Cursors.Default; }
  }
  protected override void OnMouseUp(MouseEventArgs e) { int k, i; if (Hit(PointToScreen(e.Location), out k, out i)) Pick(k, i); }
}
