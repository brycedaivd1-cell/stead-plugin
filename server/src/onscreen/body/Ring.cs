// The ring she draws around something on your screen when she shows you where it is ("that's the
// Save button, here"). A see-through window you can click straight through, gone in a few seconds.
using System;
using System.Drawing;
using System.Windows.Forms;

class Ring : Form {
  readonly Timer life = new Timer();
  DateTime until;
  int pulse;

  public Ring() {
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
    BackColor = Color.Magenta; TransparencyKey = Color.Magenta; DoubleBuffered = true;
    life.Interval = 60;
    life.Tick += delegate { if (DateTime.Now > until) { life.Stop(); Hide(); return; } pulse++; Invalidate(); };
  }
  // Click-through, never takes focus, and never shows up in her own screenshots.
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x20 | 0x80000 | 0x08000000 | 0x80; return p; } }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Native.HideFromCapture(Handle); }

  public void Flash(Rectangle r, int ms) {
    int g = 8;
    Bounds = new Rectangle(r.X - g, r.Y - g, Math.Max(12, r.Width) + g * 2, Math.Max(12, r.Height) + g * 2);
    until = DateTime.Now.AddMilliseconds(ms); pulse = 0;
    if (!Visible) Show();
    life.Start(); Invalidate();
  }

  protected override void OnPaint(PaintEventArgs e) {
    int inset = 2 + (int)Math.Round(2 * (1 + Math.Sin(pulse / 3.0)));   // it breathes, so the eye finds it
    using (var dark = new Pen(Color.FromArgb(10, 10, 10), 5)) e.Graphics.DrawRectangle(dark, inset, inset, Width - inset * 2 - 1, Height - inset * 2 - 1);
    using (var light = new Pen(Color.White, 2)) e.Graphics.DrawRectangle(light, inset, inset, Width - inset * 2 - 1, Height - inset * 2 - 1);
  }
}
