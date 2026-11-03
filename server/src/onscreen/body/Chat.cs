// The chat window: a small plain chat with her, in the bottom-right of the screen. She hauls it up from the
// bottom when you open it (Stead.OpenChat) and it slides back down when you close it. Enter sends,
// Shift+Enter is a new line. Her replies stream in as she writes them. It's a real window: drag it by
// the top, resize it from any edge, and it stays where you put it (chat-place.txt) from then on.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class ChatWindow : Form {
  static readonly Color BG = Color.FromArgb(13, 13, 15), PANEL = Color.FromArgb(24, 24, 27), FG = Color.FromArgb(238, 238, 234),
    YOU = Color.FromArgb(178, 178, 184), DIM = Color.FromArgb(120, 120, 128), LINE = Color.FromArgb(52, 52, 58);
  readonly Stead b;
  readonly RichTextBox log;
  readonly TextBox input;
  readonly Label title, close, status, stop, look, hint, send, hello;
  readonly FlowLayoutPanel chips;
  readonly Panel bottom;
  readonly System.Windows.Forms.Timer clock = new System.Windows.Forms.Timer();
  DateTime askedAt; string doing = ""; string lastSent = "";
  readonly Font font, mono, small, bold, head, code;
  readonly System.Windows.Forms.Timer slide = new System.Windows.Forms.Timer();
  readonly int dpi;
  bool replying, loaded;
  Rectangle placed;   // where you put it; empty until you move or resize it
  public bool Placed { get { Load(); return placed != Rectangle.Empty; } }

  public ChatWindow(Stead b) {
    this.b = b;
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = true; StartPosition = FormStartPosition.Manual;
    BackColor = BG; Text = b.Called;
    using (var g = CreateGraphics()) dpi = (int)g.DpiX;
    font = new Font("Segoe UI", 10f); mono = new Font("Consolas", 9.5f, FontStyle.Bold); small = new Font("Segoe UI", 8.5f);
    bold = new Font("Segoe UI", 10f, FontStyle.Bold); head = new Font("Segoe UI Semibold", 11.5f); code = new Font("Consolas", 9.5f);
    int pad = D(14);
    Padding = new Padding(D(4));   // a thin frame of its own around everything, to grab and resize from
    MinimumSize = new Size(D(240), D(260));

    // the top: her name, and an X (kept clear of the corner she hangs off)
    var top = new Panel { Dock = DockStyle.Top, Height = D(40), BackColor = BG };
    title = new Label { Text = b.Called.ToUpperInvariant(), Font = mono, ForeColor = FG, AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(pad - 3, 0, 0, 0) };
    close = new Label { Text = "X", Font = mono, ForeColor = DIM, AutoSize = false, Dock = DockStyle.Right, Width = D(40), TextAlign = ContentAlignment.MiddleCenter, Cursor = Cursors.Hand };
    close.MouseEnter += delegate { close.ForeColor = FG; };
    close.MouseLeave += delegate { close.ForeColor = DIM; };
    close.Click += delegate { b.Emit("chat-closed", null, null); Close2(); };
    foreach (var c in new Control[] { top, title }) c.MouseDown += (s, e) => { if (e.Button == MouseButtons.Left) Native.Drag(Handle); };
    // One menu: a new conversation, and the quick look (text size, see-through, on top, reset), kept in chat-prefs.txt.
    look = Btn("≡", "Menu");
    look.Font = new Font("Segoe UI", 13f); look.Width = D(40);
    look.Click += delegate { Menu2().Show(look, new Point(look.Width - Menu2Width(), look.Height)); };
    top.Controls.Add(title); top.Controls.Add(look); top.Controls.Add(close); top.Controls.Add(new Panel { Dock = DockStyle.Right, Width = D(18), BackColor = BG });

    // the bottom: what she's doing, and the box you type in
    bottom = new Panel { Dock = DockStyle.Bottom, Height = D(112), BackColor = BG, Padding = new Padding(pad, 0, pad, pad) };
    var row = new Panel { Dock = DockStyle.Top, Height = D(26), BackColor = BG };
    status = new Label { Text = "", Font = small, ForeColor = DIM, AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };
    stop = Btn("STOP", "Stop her answer");
    stop.Visible = false;
    stop.Click += delegate { b.Emit("chat-stop", null, null); Status("stopping..."); };
    row.Controls.Add(status); row.Controls.Add(stop);
    var box = new Panel { Dock = DockStyle.Fill, BackColor = PANEL, Padding = new Padding(D(10), D(8), D(10), D(8)) };
    input = new TextBox { Multiline = true, BorderStyle = BorderStyle.None, BackColor = PANEL, ForeColor = FG, Font = font, Dock = DockStyle.Fill, AcceptsReturn = true };
    input.KeyDown += (s, e) => {
      if (e.KeyCode == Keys.Enter && !e.Shift) { e.SuppressKeyPress = true; Send(); }
      else if (e.KeyCode == Keys.Up && input.TextLength == 0 && lastSent.Length > 0) { e.SuppressKeyPress = true; input.Text = lastSent; input.SelectionStart = input.TextLength; }
      else if (e.KeyCode == Keys.N && e.Control) { e.SuppressKeyPress = true; Fresh(); }
      else if (e.KeyCode == Keys.C && e.Control && e.Shift) { e.SuppressKeyPress = true; CopyLast(); }
      else if (e.KeyCode == Keys.Escape) { e.SuppressKeyPress = true; if (askedAt != DateTime.MinValue) { b.Emit("chat-stop", null, null); Status("stopping..."); } else { b.Emit("chat-closed", null, null); Close2(); } }
      else if (e.KeyCode == Keys.V && e.Control && Clipboard.ContainsImage()) { e.SuppressKeyPress = true; Attach(Clipboard.GetImage()); }
    };
    input.MouseDown += delegate { Take(); };
    // The hint sat on top of the box and hid the blinking caret: it goes while you're in the box.
    input.TextChanged += delegate { hint.Visible = input.TextLength == 0 && !input.Focused; send.ForeColor = input.TextLength > 0 ? FG : DIM; Grow(); };
    input.GotFocus += delegate { hint.Visible = false; };
    input.LostFocus += delegate { hint.Visible = input.TextLength == 0; };
    // Files and pictures: drop them in, or paste a screenshot. She gets the path and can open it.
    AllowDrop = true; input.AllowDrop = true;
    DragEventHandler over = (s, e) => { e.Effect = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; };
    DragEventHandler drop = (s, e) => { var fs = e.Data.GetData(DataFormats.FileDrop) as string[]; if (fs != null) foreach (var f in fs) Insert("[file: " + f + "] "); };
    input.DragEnter += over; input.DragDrop += drop; DragEnter += over; DragDrop += drop;
    hint = new Label { Text = "Message " + b.Called + "...   Enter sends, Shift+Enter new line", Font = small, ForeColor = DIM, BackColor = PANEL, AutoSize = true, Location = new Point(D(10), D(8)), Cursor = Cursors.IBeam };
    hint.Click += delegate { Take(); };
    send = new Label { Text = "\u2191", Font = new Font("Segoe UI", 12f, FontStyle.Bold), ForeColor = DIM, BackColor = PANEL, AutoSize = false, Dock = DockStyle.Right, Width = D(30), TextAlign = ContentAlignment.BottomCenter, Cursor = Cursors.Hand };
    send.Click += delegate { Send(); };
    new ToolTip().SetToolTip(send, "Send (Enter)");
    box.Controls.Add(hint); box.Controls.Add(input); box.Controls.Add(send); hint.BringToFront();
    bottom.Controls.Add(box); bottom.Controls.Add(row);

    // the middle: the conversation
    var mid = new Panel { Dock = DockStyle.Fill, BackColor = BG, Padding = new Padding(pad, D(10), D(8), D(4)) };
    log = new RichTextBox { Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = BG, ForeColor = FG, Font = font, ReadOnly = true, ScrollBars = RichTextBoxScrollBars.Vertical, DetectUrls = true, TabStop = false };
    log.LinkClicked += (s, e) => { try { System.Diagnostics.Process.Start(e.LinkText); } catch { } };
    log.MouseUp += (s, e) => { if (e.Button == MouseButtons.Left) BarClick(e.Location); };
    var copy = new ContextMenuStrip { ShowImageMargin = false, BackColor = PANEL, ForeColor = FG, Font = font, Renderer = new Dark() };
    copy.Items.Add("Copy", null, delegate { if (log.SelectionLength > 0) log.Copy(); });
    copy.Items.Add("Copy her last reply", null, delegate { CopyLast(); });
    copy.Items.Add("Select all", null, delegate { log.SelectAll(); });
    log.ContextMenuStrip = copy;
    hello = new Label { Text = "Hey. Ask me anything, or tell me to do it:\nopen things, fill forms, find files, remember stuff.", Font = font, ForeColor = DIM, BackColor = BG, AutoSize = false, Dock = DockStyle.Top, Height = D(64), TextAlign = ContentAlignment.MiddleLeft };
    chips = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, BackColor = BG, Padding = new Padding(0, 0, 0, D(6)) };
    foreach (var c in new[] { new[] { "What's on my screen?", "send" }, new[] { "Help me with this", "send" }, new[] { "Open YouTube", "send" }, new[] { "Remind me to ", "type" }, new[] { "Find a file called ", "type" } }) {
      var it = c;
      var chip = new Label { Text = it[0].Trim(), Font = small, ForeColor = YOU, BackColor = PANEL, AutoSize = true, Padding = new Padding(D(8), D(5), D(8), D(5)), Margin = new Padding(0, 0, D(6), D(6)), Cursor = Cursors.Hand };
      chip.MouseEnter += delegate { chip.ForeColor = FG; }; chip.MouseLeave += delegate { chip.ForeColor = YOU; };
      chip.Click += delegate { input.Text = it[0]; input.SelectionStart = input.TextLength; if (it[1] == "send") Send(); else input.Focus(); };
      chips.Controls.Add(chip);
    }
    mid.Controls.Add(log); mid.Controls.Add(chips); mid.Controls.Add(hello);
    log.TextChanged += delegate { Empty(); };
    var rule = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = LINE };

    Controls.Add(mid); Controls.Add(rule); Controls.Add(bottom); Controls.Add(top);
    slide.Interval = 15; slide.Tick += delegate { SlideStep(); };
    clock.Interval = 500; clock.Tick += delegate { Show2(); };
    var unused = Handle;   // make the window now, so she can tell it apart from others
    LoadPrefs(); Apply(); Empty();
  }

  // Nothing said yet: a hello and some things to try, instead of a blank box.
  void Empty() { bool e = log.TextLength == 0; if (hello.Visible != e) { hello.Visible = e; chips.Visible = e; } }
  // The box grows with what you write, up to a point (then it scrolls).
  void Grow() {
    int w = Math.Max(D(60), input.Width);
    int h = TextRenderer.MeasureText(input.Text.Length == 0 ? "x" : input.Text + "x", input.Font, new Size(w, 0), TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl).Height;
    int want = Math.Max(D(112), Math.Min(D(240), h + D(26) + D(16) + D(14) + D(8)));
    if (bottom.Height != want) bottom.Height = want;
  }

  // A new conversation; until then it's one conversation that carries on.
  void Fresh() { if (replying || askedAt != DateTime.MinValue) b.Emit("chat-stop", null, null); log.Clear(); bars.Clear(); bar = null; End(); Ask(false); b.Emit("chat-new", null, null); Status("new conversation"); input.Focus(); }

  // ---------- quick look: chosen from the menu, kept in chat-prefs.txt ----------
  int size = 1, clear = 0; bool onTop;
  static readonly float[] ZOOM = { 0.9f, 1f, 1.15f, 1.35f };
  static readonly double[] SEE = { 1, 0.92, 0.82 };
  string PrefsPath() { return Path.Combine(b.Dir, "chat-prefs.txt"); }
  void LoadPrefs() {
    try {
      var n = File.ReadAllText(PrefsPath()).Trim().Split(',');
      size = Math.Max(0, Math.Min(ZOOM.Length - 1, int.Parse(n[0])));
      clear = Math.Max(0, Math.Min(SEE.Length - 1, int.Parse(n[1])));
      onTop = n.Length > 2 && n[2] == "1";
    } catch { }
  }
  void Apply() {
    log.ZoomFactor = 1f; log.ZoomFactor = ZOOM[size];
    input.Font = new Font(font.FontFamily, font.Size * ZOOM[size]);
    Opacity = SEE[clear]; TopMost = onTop;
    try { File.WriteAllText(PrefsPath(), size + "," + clear + "," + (onTop ? 1 : 0)); } catch { }
  }
  int Menu2Width() { return D(230); }
  ContextMenuStrip Menu2() {
    var m = new ContextMenuStrip { ShowImageMargin = false, ShowCheckMargin = true, BackColor = PANEL, ForeColor = FG, Font = font, Renderer = new Dark(), Padding = new Padding(0, D(6), 0, D(6)), MinimumSize = new Size(Menu2Width(), 0) };
    Func<ToolStripItemCollection, string, string, bool, Action, ToolStripMenuItem> item = (into, t, keys, on, act) => {
      var it = new ToolStripMenuItem(t) { Checked = on, ForeColor = FG, ShortcutKeyDisplayString = keys, Padding = new Padding(D(4), D(5), D(4), D(5)) };
      if (act != null) it.Click += delegate { act(); Apply(); };
      into.Add(it);
      return it;
    };
    Func<string, ToolStripMenuItem> sub = t => {
      var it = item(m.Items, t, null, false, null);
      ((ToolStripDropDownMenu)it.DropDown).ShowImageMargin = false;
      ((ToolStripDropDownMenu)it.DropDown).ShowCheckMargin = true;
      it.DropDown.Renderer = new Dark(); it.DropDown.BackColor = PANEL; it.DropDown.Font = font; it.DropDown.Padding = new Padding(0, D(6), 0, D(6));
      return it;
    };
    item(m.Items, "New conversation", "Ctrl+N", false, Fresh);
    item(m.Items, "Copy her last reply", "Ctrl+Shift+C", false, CopyLast);
    item(m.Items, "Clear this window", null, false, delegate { log.Clear(); End(); });
    m.Items.Add(new ToolStripSeparator());
    var text = sub("Text size");
    string[] sizes = { "Small", "Normal", "Large", "Huge" };
    for (int i = 0; i < sizes.Length; i++) { int k = i; item(text.DropDownItems, sizes[i], null, size == i, delegate { size = k; }); }
    var see = sub("See-through");
    string[] sees = { "Solid", "A little", "More" };
    for (int i = 0; i < sees.Length; i++) { int k = i; item(see.DropDownItems, sees[i], null, clear == i, delegate { clear = k; }); }
    item(m.Items, "Always on top", null, onTop, delegate { onTop = !onTop; });
    m.Items.Add(new ToolStripSeparator());
    item(m.Items, "Put it back in the corner", null, false, delegate {
      placed = Rectangle.Empty; try { File.Delete(PlacePath()); } catch { }
      Bounds = Target();
    });
    item(m.Items, "Close", "Esc", false, delegate { b.Emit("chat-closed", null, null); Close2(); });
    return m;
  }
  // The menu in the window's own black and white.
  class Dark : ToolStripRenderer {
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { using (var br = new SolidBrush(PANEL)) e.Graphics.FillRectangle(br, e.AffectedBounds); }
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) { using (var p = new Pen(LINE)) e.Graphics.DrawRectangle(p, 0, 0, e.AffectedBounds.Width - 1, e.AffectedBounds.Height - 1); }
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
      if (!e.Item.Selected) return;
      using (var br = new SolidBrush(LINE)) e.Graphics.FillRectangle(br, new Rectangle(2, 0, e.Item.Width - 4, e.Item.Height));
    }
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) { var mi = e.Item as ToolStripMenuItem; e.TextColor = mi != null && e.Text == mi.ShortcutKeyDisplayString ? DIM : FG; base.OnRenderItemText(e); }
    protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e) { e.ArrowColor = DIM; base.OnRenderArrow(e); }
    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e) {
      var r = e.ImageRectangle;
      using (var br = new SolidBrush(FG)) e.Graphics.FillEllipse(br, r.X + r.Width / 2 - 3, r.Y + r.Height / 2 - 3, 6, 6);
    }
    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
      using (var p = new Pen(LINE)) e.Graphics.DrawLine(p, 6, e.Item.Height / 2, e.Item.Width - 6, e.Item.Height / 2);
    }
  }

  int D(int px) { return px * dpi / 96; }
  Label Btn(string text, string tip) {
    var l = new Label { Text = text, Font = small, ForeColor = DIM, AutoSize = false, Dock = DockStyle.Right, Width = D(46), TextAlign = ContentAlignment.MiddleCenter, Cursor = Cursors.Hand };
    l.MouseEnter += delegate { l.ForeColor = FG; };
    l.MouseLeave += delegate { l.ForeColor = DIM; };
    new ToolTip().SetToolTip(l, tip);
    return l;
  }
  // While she's on it: what she's doing and for how long, and a way to stop her.
  void Ask(bool on) {
    askedAt = on ? DateTime.Now : DateTime.MinValue;
    stop.Visible = on; doing = on ? "thinking" : "";
    if (on) clock.Start(); else clock.Stop();
    Show2();
  }
  void Show2() {
    if (askedAt == DateTime.MinValue) { status.Text = doing; return; }
    int sec = (int)(DateTime.Now - askedAt).TotalSeconds;
    status.Text = (doing.Length > 0 ? doing : replying ? "writing" : "thinking") + (sec >= 2 ? "  " + sec + "s" : "");
  }
  protected override void OnPaint(PaintEventArgs e) { base.OnPaint(e); using (var p = new Pen(LINE)) e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1); }

  // Resizing from the edges: the frame around the inside reports itself as a window border.
  protected override void WndProc(ref Message m) {
    base.WndProc(ref m);
    if (m.Msg != 0x84 || (int)m.Result != 1) return;   // WM_NCHITTEST that landed on the form itself
    var p = PointToClient(new Point((short)((long)m.LParam & 0xFFFF), (short)(((long)m.LParam >> 16) & 0xFFFF)));
    int g = D(6);
    bool l = p.X < g, r = p.X >= Width - g, t = p.Y < g, bo = p.Y >= Height - g;
    int hit = t ? (l ? 13 : r ? 14 : 12) : bo ? (l ? 16 : r ? 17 : 15) : l ? 10 : r ? 11 : 1;
    m.Result = new IntPtr(hit);
  }
  protected override void OnResizeEnd(EventArgs e) {
    base.OnResizeEnd(e);
    if (Sliding || !Visible) return;
    placed = Bounds;
    try { File.WriteAllText(PlacePath(), placed.X + "," + placed.Y + "," + placed.Width + "," + placed.Height); } catch { }
  }
  string PlacePath() { return Path.Combine(b.Dir, "chat-place.txt"); }
  void Load() {
    if (loaded) return;
    loaded = true;
    try {
      var n = File.ReadAllText(PlacePath()).Split(',');
      var r = new Rectangle(int.Parse(n[0]), int.Parse(n[1]), int.Parse(n[2]), int.Parse(n[3]));
      foreach (var sc in Screen.AllScreens) if (sc.WorkingArea.IntersectsWith(Rectangle.Inflate(r, -D(40), -D(40)))) { placed = r; break; }
    } catch { }
  }

  // Where it sits when it's all the way up: where you put it, or a small window in the bottom-right.
  public Rectangle Target() {
    if (Placed) return placed;
    var wa = Screen.PrimaryScreen.WorkingArea;
    int w = D(380), h = Math.Min(wa.Height - D(24), D(560));
    return new Rectangle(wa.Right - w - D(12), wa.Bottom - h, w, h);   // sits on the taskbar, so she can stand there to haul it up
  }
  public void SetTop(int top) { var t = Target(); slide.Stop(); Bounds = new Rectangle(t.Left, top, t.Width, t.Height); }
  public bool Sliding { get { return slide.Enabled; } }
  public void Rename(string n) { Text = n; title.Text = n.ToUpperInvariant(); }

  public void Take() { Native.ForceForeground(Handle); Activate(); input.Focus(); }
  public void Close2() { if (Visible) slide.Start(); }
  void SlideStep() {
    int bottom = Screen.PrimaryScreen.Bounds.Bottom;
    int nt = Top + Math.Max(D(14), (bottom - Top) / 5);
    if (nt >= bottom) { slide.Stop(); Hide(); return; }
    Top = nt;
  }

  void Send() {
    string t = input.Text.Trim();
    if (t.Length == 0) return;
    input.Text = ""; lastSent = t;
    End(); Add("you", t);
    Ask(true);
    b.Emit("chat", "window", t);
  }

  string lastReply = "";
  void CopyLast() { if (lastReply.Length > 0) { try { Clipboard.SetText(lastReply); Status("copied"); } catch { } } }
  void Insert(string t) { input.SelectedText = t; input.Focus(); }
  void Attach(Image img) {
    try {
      var dir = Path.Combine(b.Dir, "pasted"); Directory.CreateDirectory(dir);
      var f = Path.Combine(dir, DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png");
      img.Save(f, System.Drawing.Imaging.ImageFormat.Png);
      Insert("[image: " + f + "] ");
    } catch { Status("couldn't paste that picture"); }
  }

  // Following along at the bottom, unless you've scrolled up to read: then it leaves you there.
  bool following = true;
  bool AtBottom() {
    int min, max; Native.GetScrollRange(log.Handle, 1, out min, out max);
    int pos = Native.GetScrollPos(log.Handle, 1);
    return max <= 0 || pos + log.ClientSize.Height >= max - D(24);
  }
  bool right;   // what's being written now is yours: it sits on the right
  void Append(string t, Color c, Font f) {
    log.SelectionStart = log.TextLength; log.SelectionLength = 0;
    log.SelectionColor = c; log.SelectionFont = f;
    log.SelectionAlignment = right ? HorizontalAlignment.Right : HorizontalAlignment.Left;
    // Yours sits right but off the edge (it was pressed against the scrollbar); hers has a little room too.
    log.SelectionIndent = right ? D(56) : D(2);
    log.SelectionRightIndent = right ? D(12) : D(20);
    log.AppendText(t);
    if (following) { log.SelectionStart = log.TextLength; log.ScrollToCaret(); }
  }
  void Header(string who) {
    if (log.TextLength > 0) Append("\n\n", FG, font);
    bool you = who == "you";
    right = you;
    Append(you ? "YOU" : b.Called.ToUpperInvariant(), you ? DIM : FG, mono);
    Append("  " + DateTime.Now.ToString("h:mm tt").ToLowerInvariant(), DIM, small);
    Append("\n", FG, font);
  }

  // A whole message, yours or hers. Hers is markdown.
  public void Add(string who, string text) {
    End(); following = true; Header(who);
    if (who != "you") lastReply = text;
    if (who == "you") Append(text, YOU, font); else Md(text);
    right = false;
  }

  // What she just did, as she does it. Every step of one reply collapses into a single dim bar
  // ("› 5 steps  ▸"); click the bar to see them, click again to put them away.
  class Bar { public int At, Len; public readonly List<string> Steps = new List<string>(); public bool Open; }
  readonly List<Bar> bars = new List<Bar>();
  Bar bar;
  string BarText(Bar s) {
    string n = s.Steps.Count + (s.Steps.Count == 1 ? " step" : " steps");
    if (!s.Open) return "\u203A " + n + "  \u25B8\n";
    var sb = new System.Text.StringBuilder("\u25BE " + n + "\n");
    foreach (var one in s.Steps) sb.Append("   \u203A " + one + "\n");
    return sb.ToString();
  }
  void WriteBar(Bar s) {
    bool keep = following;
    string text = BarText(s);
    int old = s.Len;
    log.ReadOnly = false;
    if (old > 0) { log.Select(s.At, old); log.SelectedText = ""; }
    log.SelectionStart = s.At; log.SelectionLength = 0;
    log.SelectionColor = DIM; log.SelectionFont = small;
    log.SelectionAlignment = HorizontalAlignment.Left; log.SelectionIndent = 0;
    log.SelectedText = text;
    log.ReadOnly = true;
    s.Len = text.Length;
    int delta = s.Len - old;
    if (delta != 0) {
      foreach (var o in bars) if (o != s && o.At > s.At) o.At += delta;
      if (replyAt > s.At) replyAt += delta;
    }
    following = keep;
    if (following) { log.SelectionStart = log.TextLength; log.ScrollToCaret(); }
  }
  // A click on a bar opens or closes it.
  void BarClick(Point p) {
    int i = log.GetCharIndexFromPosition(p);
    foreach (var s in bars) if (i >= s.At && i < s.At + s.Len) { following = false; s.Open = !s.Open; WriteBar(s); return; }
  }
  public void Step(string t) {
    following = AtBottom();
    if (!replying) { Header("me"); replying = true; }
    if (bar == null) {
      if (reply.Length > 0) Append("\n", FG, font);
      bar = new Bar { At = log.TextLength };
      bars.Add(bar);
    }
    bar.Steps.Add(t);
    WriteBar(bar);
    reply.Length = 0; replyAt = log.TextLength;
  }
  // More of her reply, as she writes it: the reply so far is drawn again from its markdown each time.
  readonly System.Text.StringBuilder reply = new System.Text.StringBuilder();
  int replyAt;
  public void Delta(string text) {
    following = AtBottom();
    if (!replying) { Header("me"); replying = true; reply.Length = 0; replyAt = log.TextLength; text = text.TrimStart('\n'); }
    if (reply.Length == 0) text = text.TrimStart('\n');
    reply.Append(text); lastReply = reply.ToString();
    if (askedAt != DateTime.MinValue && doing.Length > 0) { doing = ""; Show2(); }
    var at = new Point(); Native.SendMessage(log.Handle, 0x4DD, IntPtr.Zero, ref at);   // EM_GETSCROLLPOS: where you're reading
    Native.SendMessage(log.Handle, 0x0B, IntPtr.Zero, IntPtr.Zero);   // WM_SETREDRAW off while it's redrawn
    log.ReadOnly = false;
    log.Select(replyAt, log.TextLength - replyAt); log.SelectedText = "";
    log.ReadOnly = true;
    Md(reply.ToString());
    if (!following) Native.SendMessage(log.Handle, 0x4DE, IntPtr.Zero, ref at);   // EM_SETSCROLLPOS: and leave you there
    Native.SendMessage(log.Handle, 0x0B, new IntPtr(1), IntPtr.Zero);
    log.Invalidate();
  }

  // The markdown Claude writes: headings, **bold**, `code`, code blocks, bullets and tables.
  void Md(string text) {
    bool fence = false;
    var lines = text.Replace("\r", "").Split('\n');
    for (int i = 0; i < lines.Length; i++) {
      string l = lines[i], nl = i < lines.Length - 1 ? "\n" : "";
      string t = l.TrimStart();
      if (t.StartsWith("```")) { fence = !fence; continue; }
      if (fence || t.StartsWith("|")) { Block(l + nl); continue; }
      if (t.StartsWith("#")) { Append(t.TrimStart('#').Trim() + nl, FG, head); continue; }
      if (t == "---" || t == "***") { Append("──────" + nl, DIM, font); continue; }
      int ind = l.Length - t.Length;
      if (t.StartsWith("- ") || t.StartsWith("* ") || t.StartsWith("+ ")) { Append(new string(' ', ind) + "• ", DIM, font); t = t.Substring(2); }
      else if (ind > 0) Append(new string(' ', ind), FG, font);
      Inline(t + nl);
    }
  }
  void Block(string t) {
    log.SelectionStart = log.TextLength; log.SelectionLength = 0; log.SelectionBackColor = PANEL;
    Append(t, FG, code);
    log.SelectionStart = log.TextLength; log.SelectionBackColor = BG;
  }
  static readonly System.Text.RegularExpressions.Regex LINK = new System.Text.RegularExpressions.Regex(@"\[([^\]]+)\]\((https?://[^)\s]+)\)");
  void Inline(string t) {
    t = LINK.Replace(t, "$1 ($2)");   // a link shows its words, then the address (which you can click)
    int i = 0;
    while (i < t.Length) {
      int b2 = t.IndexOf("**", i), c1 = t.IndexOf('`', i);
      int at = b2 < 0 ? c1 : c1 < 0 ? b2 : Math.Min(b2, c1);
      if (at < 0) { Append(t.Substring(i), FG, font); return; }
      if (at > i) Append(t.Substring(i, at - i), FG, font);
      int n = at == b2 ? 2 : 1;
      int end = t.IndexOf(n == 2 ? "**" : "`", at + n);
      if (end < 0) { Append(t.Substring(at + n), FG, n == 2 ? bold : code); return; }   // still being written
      string inner = t.Substring(at + n, end - at - n);
      if (n == 2) Append(inner, FG, bold); else Block(inner);
      i = end + n;
    }
  }
  public void End() { replying = false; bar = null; }
  public void Done() { End(); Ask(false); }
  public void Status(string t) { doing = t.TrimEnd('.', ' '); if (askedAt == DateTime.MinValue) status.Text = t; else Show2(); }
  public void History(List<string[]> items) { log.Clear(); bars.Clear(); bar = null; replying = false; foreach (var it in items) Add(it[0], it[1]); }
}
