// A little campfire she lights in her corner and sits by. A see-through window you can click straight
// through: crossed logs, a flickering flame, sparks, and a puff of smoke when it goes out.
using System;
using System.Drawing;
using System.Windows.Forms;

class Fire : Form {
  const int W = 16, H = 22;          // in her pixels (sc screen pixels each)
  readonly Timer life = new Timer();
  readonly Random rnd = new Random();
  int px = 3, f, smoke;              // f: frames since lit; smoke: frames of smoke left once it's out
  bool lit;

  public Fire() {
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
    BackColor = Color.Magenta; TransparencyKey = Color.Magenta; DoubleBuffered = true;
    life.Interval = 90;
    life.Tick += delegate {
      f++;
      if (!lit && --smoke <= 0) { life.Stop(); Hide(); return; }
      Invalidate();
    };
  }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x20 | 0x80000 | 0x08000000 | 0x80; return p; } }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Native.HideFromCapture(Handle); }

  public bool Lit { get { return lit; } }
  // Lit at (cx, ground): the logs sit on the ground there, centred on cx.
  public void Light(int cx, int ground, int sc) {
    px = Math.Max(1, sc); lit = true; f = 0; smoke = 0;
    Bounds = new Rectangle(cx - W * px / 2, ground - H * px, W * px, H * px);
    if (!Visible) Show();
    life.Start(); Invalidate();
  }
  public void Out() { if (!lit) return; lit = false; smoke = 30; }
  public void Gone() { lit = false; smoke = 0; life.Stop(); Hide(); }

  static readonly Color LOG = Color.FromArgb(112, 66, 34), LOGDK = Color.FromArgb(70, 40, 22), LOGEND = Color.FromArgb(196, 150, 96),
    CHAR = Color.FromArgb(40, 34, 32), STONE = Color.FromArgb(120, 120, 126), STONEDK = Color.FromArgb(78, 78, 84),
    RED = Color.FromArgb(222, 56, 30), ORANGE = Color.FromArgb(255, 140, 32), YELLOW = Color.FromArgb(255, 222, 96), WHITE = Color.FromArgb(255, 248, 210),
    EMBER = Color.FromArgb(255, 96, 40), SMOKE = Color.FromArgb(150, 150, 156), SMOKEDK = Color.FromArgb(110, 110, 116);

  void P(Graphics g, int i, int j, Color c) {
    if (i < 0 || i >= W || j < 0 || j >= H) return;
    using (var b = new SolidBrush(c)) g.FillRectangle(b, i * px, j * px, px, px);
  }
  // A cheap steady noise per column and frame, so the flame dances without strobing.
  double N(int i, int t) { int h = (i * 73856093) ^ (t * 19349663); h = (h << 13) ^ h; return ((h * (h * h * 15731 + 789221) + 1376312589) & 0x7fffffff) / 2147483647.0; }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    int b = H - 1;
    // stones in a ring, then two crossed logs
    foreach (int i in new[] { 0, 1, 14, 15 }) P(g, i, b, i == 0 || i == 15 ? STONEDK : STONE);
    P(g, 1, b - 1, STONE); P(g, 14, b - 1, STONE);
    bool burnt = !lit;
    for (int i = 2; i < 14; i++) { P(g, i, b, burnt ? CHAR : (i < 4 || i > 11 ? LOGDK : LOG)); }
    for (int i = 3; i < 13; i++) { int j = b - 1 - (i < 8 ? (i - 3) / 3 : (12 - i) / 3); P(g, i, j, burnt ? CHAR : LOG); }
    P(g, 2, b, burnt ? CHAR : LOGEND); P(g, 13, b, burnt ? CHAR : LOGEND);
    if (lit) {
      // It catches over the first second, then burns: each column's height wobbles with the noise.
      double grow = Math.Min(1, f / 10.0);
      int t = f / 2;
      for (int i = 3; i <= 12; i++) {
        double shape = 1 - Math.Abs(i - 7.5) / 5.0;
        double wob = 0.7 + 0.3 * (N(i, t) * 0.6 + N(i, t + 1) * 0.4);
        int h = (int)Math.Round(14 * shape * shape * wob * grow) + (grow > 0.2 ? 1 : 0);
        for (int k = 0; k < h; k++) {
          int j = b - 2 - k;
          double u = k / (double)Math.Max(1, h);   // 0 at the base, 1 at the tip
          bool core = Math.Abs(i - 7.5) < 2.5 * (1 - u);
          Color c = u > 0.78 ? RED : u > 0.5 ? ORANGE : core ? (u < 0.25 && Math.Abs(i - 7.5) < 1 ? WHITE : YELLOW) : ORANGE;
          P(g, i, j, c);
        }
      }
      // a spark drifting up now and then
      if (N(99, f / 3) > 0.55) { int sj = b - 14 - (f % 6); P(g, 5 + (int)(N(7, f / 3) * 6), sj, YELLOW); }
      if (f % 4 < 2) P(g, 7 + (f % 8) / 4, b - 1, EMBER);
    } else {
      // out: smoke curling up off the logs, thinning as it goes
      int age = 30 - smoke;
      for (int k = 0; k < 9; k++) {
        int j = b - 2 - k - age / 4;
        int i = 7 + (int)Math.Round(Math.Sin((k + age) / 2.0) * 1.6);
        if (j < 0 || k > 2 + age) continue;
        if (smoke > 6 || k % 2 == 0) { P(g, i, j, k % 3 == 0 ? SMOKEDK : SMOKE); if (k > 3) P(g, i + 1, j, SMOKE); }
      }
      if (smoke > 20) P(g, 8, b - 1, EMBER);
    }
  }
}
