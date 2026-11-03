// The speech bubble, for Stead (Stead.cs).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

// The speech bubble: its own little window so it can sit anywhere near her. A retro paper
// dialog box with a pixel tail, text that types itself out. Clicking it (not a button) closes it.
class Bubble : Form {
  static readonly Color KEY = Color.FromArgb(255, 0, 255), PAPER = Color.FromArgb(244, 244, 238), INK = Color.FromArgb(14, 14, 16), HOT = Color.FromArgb(222, 222, 214);
  readonly Stead b;
  readonly Font font, bfont;
  readonly System.Windows.Forms.Timer clock = new System.Windows.Forms.Timer();
  string text = "", id = "";
  public string Kind = "";
  List<string[]> btns = new List<string[]>();
  List<Rectangle> rects = new List<Rectangle>();
  int shown, ttl, hover = -1, pad, tail, edge, shade;
  int scroll, maxScroll, fullTextH;   // a long answer scrolls inside the bubble instead of growing off the screen
  bool atEnd = true;                  // reading the end: new text keeps scrolling itself into view
  bool caret;
  Rectangle body, textBox;
  bool below, input, typing;
  DateTime since;
  readonly TextBox box;   // you can talk back

  public Bubble(Stead b) {
    this.b = b;
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
    BackColor = KEY; TransparencyKey = KEY; DoubleBuffered = true;
    font = new Font("Consolas", 8.5f); bfont = new Font("Consolas", 7.5f, FontStyle.Bold);
    using (var g = CreateGraphics()) { pad = (int)(7 * g.DpiX / 96); tail = (int)(6 * g.DpiX / 96); edge = Math.Max(2, (int)(2 * g.DpiX / 96)); shade = edge + 1; }
    box = new TextBox { BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White, ForeColor = INK, Font = font, Visible = false };
    box.KeyDown += (s2, e2) => {
      if (e2.KeyCode == Keys.Enter) {
        e2.SuppressKeyPress = true;
        string said = box.Text.Trim();
        if (said.Length > 0) { b.Emit("chat", id, said); box.Text = ""; Hide(); }
      } else if (e2.KeyCode == Keys.Escape) { e2.SuppressKeyPress = true; Dismiss(); }
    };
    // Always take the keyboard: after you click into another app's text box, this one still thinks
    // it's focused (inside a window that isn't), so checking Focused first left your typing over there.
    box.MouseDown += delegate { FocusBox(); };
    Controls.Add(box);
    clock.Interval = 33;
    clock.Tick += delegate { Tick2(); };
    clock.Start();
    var unused = Handle;   // make the window now, so she can tell it apart from others
    Native.SendMessage(box.Handle, 0x1501, new IntPtr(1), "Say something...");   // placeholder
  }

  public bool Talking { get { return Visible && shown < text.Length; } }
  public string Id { get { return id; } }
  // While she says it out loud, the text types out only as far as she's got (-1: at its own pace).
  int revealCap = -1;
  public void RevealTo(int n) { revealCap = n; }
  public void ClickThrough(bool t) {
    int ex = Native.GetWindowLong(Handle, -20);
    Native.SetWindowLong(Handle, -20, t ? ex | 0x20 : ex & ~0x20);
  }

  // Typing needs focus, so while the box is up the bubble can be activated; otherwise it never steals it.
  void Activatable(bool yes) {
    int ex = Native.GetWindowLong(Handle, -20);
    Native.SetWindowLong(Handle, -20, yes ? ex & ~0x08000000 : ex | 0x08000000);
  }
  public new void Hide() { if (typing || input) Activatable(false); box.Visible = false; input = false; typing = false; base.Hide(); }
  // A click on it while there's a box to type in activates it (Windows only lets a click do that).
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x21 && input) { m.Result = new IntPtr(1); return; }   // WM_MOUSEACTIVATE -> MA_ACTIVATE
    base.WndProc(ref m);
  }
  public Rectangle BoxRect() { return input ? box.RectangleToScreen(box.ClientRectangle) : Rectangle.Empty; }
  void FocusBox() { typing = true; Activatable(true); Native.ForceForeground(Handle); Activate(); box.Focus(); }
  // A question with a box to answer in, ready to type into.
  public void Ask(string t, string msgId) { Show2(t, new List<string[]>(), 60000, msgId, "ask", true); FocusBox(); }
  protected override CreateParams CreateParams {
    get { var cp = base.CreateParams; cp.ExStyle |= 0x80 | 0x08000000 | 0x8; return cp; }
  }
  protected override bool ShowWithoutActivation { get { return true; } }

  public void Show2(string t, List<string[]> buttons, int ttlMs, string msgId, string kind, bool withInput) {
    // More of the same reply, as it streams in: keep what's already typed out, carry on from there.
    bool more = Visible && msgId.Length > 0 && msgId == id && t.StartsWith(text);
    text = t; btns = buttons; ttl = ttlMs; id = msgId; Kind = kind; since = DateTime.Now;
    // A reply stays up as long as it takes to read (about 200 words a minute, plus a moment), counted from
    // when she's finished typing it out, then goes away on its own.
    if (kind == "chat" && buttons.Count == 0) {
      int words = t.Split(new[] { ' ', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries).Length;
      ttl = Math.Max(4000, Math.Min(90000, 2500 + words * 300));
    }
    if (!more) { shown = 0; hover = -1; scroll = 0; atEnd = true; }
    if (input != withInput) Activatable(withInput);
    if (!more || input != withInput) { input = withInput; box.Visible = withInput; typing = false; ActiveControl = null; }
    Layout2();
    Follow();
    if (!Visible) Show();
    Invalidate();
  }

  void Layout2() {
    int maxW = (int)(200 * Dpi() / 96.0);
    var ts = TextRenderer.MeasureText(text, font, new Size(maxW, 2000), TextFormatFlags.WordBreak);
    int bw = 0, bh = 0;
    var sizes = new List<Size>();
    foreach (var bt in btns) {
      var s = TextRenderer.MeasureText("> " + bt[1].ToUpper(), bfont);
      s = new Size(s.Width + pad, s.Height + pad / 3);
      sizes.Add(s); bw += s.Width + pad / 2; bh = Math.Max(bh, s.Height);
    }
    int ih = input ? box.PreferredHeight + pad / 2 : 0;
    // A long answer must not grow the bubble past the screen: the text stops at a bit over half the
    // work area and scrolls inside it (the wheel, or it follows itself as she types).
    int room = (int)(b.Work().Height * 0.55) - pad * 2 - ih - (btns.Count > 0 ? bh + pad / 2 : 0) - tail - shade;
    fullTextH = ts.Height;
    int th = Math.Min(ts.Height, Math.Max((int)(60 * Dpi() / 96.0), room));
    maxScroll = Math.Max(0, ts.Height - th);
    if (scroll > maxScroll) scroll = maxScroll;
    int w = Math.Max(ts.Width, bw) + pad * 2, h = th + pad * 2 + ih + (btns.Count > 0 ? bh + pad / 2 : 0);
    w = Math.Max(w, (int)((input ? 170 : 60) * Dpi() / 96.0));
    ClientSize = new Size(w + shade, h + tail + shade);
    var head = b.Head(); var wa = b.Work();
    below = head.Y - ClientSize.Height < wa.Top + 4;
    body = new Rectangle(0, below ? tail : 0, w, h);
    textBox = new Rectangle(body.X + pad, body.Y + pad, ts.Width + 4, th);
    rects.Clear();
    if (input) box.SetBounds(body.X + pad, textBox.Bottom + pad / 2, w - pad * 2, box.PreferredHeight);
    int bx = body.X + pad, by = body.Bottom - pad - bh;
    foreach (var s in sizes) { rects.Add(new Rectangle(bx, by, s.Width, s.Height)); bx += s.Width + pad / 2; }
  }

  int Dpi() { using (var g = CreateGraphics()) return (int)g.DpiX; }

  public void Follow() {
    if (!Visible) return;
    var head = b.Head(); var wa = b.Work();
    int lx = head.X - ClientSize.Width / 2;
    lx = Math.Max(wa.Left + 4, Math.Min(wa.Right - ClientSize.Width - 4, lx));
    int ly = below ? head.Y + (int)(20 * Dpi() / 96.0) * 3 : head.Y - ClientSize.Height - 2;
    if (Location.X != lx || Location.Y != ly) { Location = new Point(lx, ly); Invalidate(); }
  }

  void Tick2() {
    if (!Visible) return;
    if (shown < text.Length && (revealCap < 0 || shown < revealCap)) {
      shown = Math.Min(revealCap < 0 ? text.Length : Math.Min(text.Length, revealCap), shown + 2);
      since = DateTime.Now;   // the reading clock starts once it's all typed out
      if (atEnd && maxScroll > 0) {
        int typed = TextRenderer.MeasureText(text.Substring(0, shown), font, new Size(textBox.Width, 4000), TextFormatFlags.WordBreak).Height;
        scroll = Math.Max(0, Math.Min(maxScroll, typed - textBox.Height));
      }
      Invalidate();
    }
    else if (btns.Count == 0 && !input) { bool on = DateTime.Now.Millisecond < 500; if (on != caret) { caret = on; Invalidate(); } }
    bool hovering = ClientRectangle.Contains(PointToClient(Cursor.Position));
    if (hovering || (input && (typing || box.Text.Length > 0)) || (revealCap >= 0 && shown < text.Length)) since = DateTime.Now;   // reading, typing, or still being said: don't take it away
    if ((DateTime.Now - since).TotalMilliseconds > ttl) { b.Emit("expire", null, id); Hide(); }
  }

  public void Dismiss() { if (Visible) { b.Emit("dismiss", null, id); Hide(); } }   // Emit hushes her voice

  // A rectangle with its corners clipped off, the way old pixel dialog boxes did it.
  static void Notched(Graphics g, Brush br, Rectangle r, int n) {
    g.FillRectangle(br, r.X + n, r.Y, r.Width - n * 2, r.Height);
    g.FillRectangle(br, r.X, r.Y + n, r.Width, r.Height - n * 2);
  }

  // A retro dialog box: paper with a thick ink edge, notched corners, a hard drop shadow, and a
  // pixel staircase tail pointing at her head. A blinking arrow means she's done talking.
  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    g.Clear(KEY);
    g.SmoothingMode = SmoothingMode.None;
    var head = PointToClient(b.Head());
    int tx = Math.Max(body.X + tail * 2 + edge, Math.Min(body.Right - tail * 2 - edge, head.X));
    using (var ink = new SolidBrush(INK)) using (var paper = new SolidBrush(PAPER)) {
      var sh = body; sh.Offset(shade, shade);
      Notched(g, ink, sh, edge);
      Notched(g, ink, body, edge);
      var inner = Rectangle.Inflate(body, -edge, -edge);
      Notched(g, paper, inner, edge);
      // the tail: rows of ink with paper inside, narrowing toward her
      for (int i = 0; i < tail + edge; i++) {
        int half = Math.Max(0, tail - i);
        int yy = below ? body.Y - i - 1 : body.Bottom + i;
        g.FillRectangle(ink, tx - half - edge, yy, (half + edge) * 2, 1);
        if (half > 0) g.FillRectangle(paper, tx - half, yy, half * 2, 1);
      }
      // open the edge where the tail joins
      g.FillRectangle(paper, tx - tail, below ? body.Y : body.Bottom - edge, tail * 2, edge);
      var clip = g.Clip;
      g.SetClip(textBox);
      TextRenderer.DrawText(g, text.Substring(0, shown), font, new Rectangle(textBox.X, textBox.Y - scroll, textBox.Width, Math.Max(fullTextH, textBox.Height)), INK, PAPER, TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
      g.Clip = clip;
      if (maxScroll > 0) {
        int sw = Math.Max(2, edge), sx = body.Right - edge - sw - 1, sy = textBox.Y, sh2 = textBox.Height;
        using (var track = new SolidBrush(Color.FromArgb(206, 206, 200))) g.FillRectangle(track, sx, sy, sw, sh2);
        int thumb = Math.Max(edge * 2, sh2 * sh2 / Math.Max(1, fullTextH));
        g.FillRectangle(ink, sx, sy + (sh2 - thumb) * scroll / maxScroll, sw, thumb);
      }
      if (caret && shown >= text.Length && btns.Count == 0 && !input) {
        int c = Math.Max(3, pad / 2), cx = inner.Right - pad, cy = inner.Bottom - pad / 2 - c;
        for (int i = 0; i < c; i++) g.FillRectangle(ink, cx - c + i, cy + i, (c - i) * 2 - 1, 1);   // a little down-arrow
      }
      for (int i = 0; i < btns.Count && shown >= text.Length; i++) {
        var r = rects[i];
        bool primary = i == 0, hot = i == hover;
        g.FillRectangle(ink, r);
        if (!primary) { using (var f = new SolidBrush(hot ? HOT : PAPER)) g.FillRectangle(f, Rectangle.Inflate(r, -1, -1)); }
        else if (hot) g.FillRectangle(Brushes.Black, Rectangle.Inflate(r, -1, -1));
        TextRenderer.DrawText(g, (hot ? "> " : "") + btns[i][1].ToUpper(), bfont, r, primary ? PAPER : INK, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
      }
    }
  }

  protected override void OnMouseMove(MouseEventArgs e) {
    int h = rects.FindIndex(r => r.Contains(e.Location));
    if (h != hover) { hover = h; Invalidate(); Cursor = h >= 0 ? Cursors.Hand : Cursors.Default; }
  }
  protected override void OnMouseLeave(EventArgs e) { if (hover != -1) { hover = -1; Invalidate(); } }
  protected override void OnMouseWheel(MouseEventArgs e) {
    if (maxScroll <= 0) return;
    int want = Math.Max(0, Math.Min(maxScroll, scroll - e.Delta / 3));
    if (want != scroll) { scroll = want; atEnd = scroll >= maxScroll; since = DateTime.Now; Invalidate(); }
  }
  protected override void OnMouseUp(MouseEventArgs e) {
    int h = shown >= text.Length ? rects.FindIndex(r => r.Contains(e.Location)) : -1;
    if (h >= 0) { b.Emit("button", btns[h][0], id); Hide(); return; }
    if (shown < text.Length) { shown = text.Length; since = DateTime.Now; if (atEnd) scroll = maxScroll; Invalidate(); if (input) FocusBox(); return; }   // first click: finish typing
    if (input) { FocusBox(); return; }
    Dismiss();
  }
}
