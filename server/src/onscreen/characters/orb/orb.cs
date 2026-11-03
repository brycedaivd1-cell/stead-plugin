// The orb: a small glowing ball, the quiet one. No face, no tricks of its own; it floats, drifts along,
// and sits on whatever it's about to click. Black and white unless they pick a color: a white ball with
// a black rim, so it reads on light and dark windows alike.
using System;
using System.Drawing;

public partial class Orb : Character {
  public override bool Outline { get { return false; } }
  public override bool Calm { get { return true; } }
  public override bool Stays { get { return true; } }   // a ball: wherever they put it, it stays
  public override int ZzzY { get { return -1; } }
  public override Color Edge { get { return Tint.IsEmpty ? Color.White : Mix(Tint, Color.White, 0.5); } }

  // Its color this frame: dim asleep, flickering while it thinks, talks or types.
  Color Body() {
    Color c = Tint.IsEmpty ? Color.FromArgb(238, 238, 238) : Tint;
    if (Asleep) return Mix(c, Color.Black, 0.45);
    if (Mouth >= 0) return Mix(c, Color.White, new[] { 0.0, 0.15, 0.4, 0.3, 0.22 }[Math.Min(4, Mouth)]);   // speaking out loud: it glows with each sound
    if (Thinking || Talking || Typing) return (Tick / (Typing ? 2 : 4)) % 2 == 0 ? Mix(c, Color.White, 0.25) : c;
    return c;
  }
  // How high it floats: a slow bob (none asleep).
  protected double Bob() { return Asleep ? 0 : (Math.Sin(Tick * 0.07) + 1) * 0.9; }

  // A shaded ball centered at (cx, cy) with radii rx, ry, lit from the top left.
  protected void Ball(double cx, double cy, double rx, double ry) {
    Color c = Body(), hi = Mix(c, Color.White, 0.6), lo = Mix(c, Color.Black, 0.3), rim = Color.FromArgb(18, 18, 18);
    Func<int, int, bool> inside = (x, y) => { double a = (x + 0.5 - cx) / rx, b = (y + 0.5 - cy) / ry; return a * a + b * b <= 1; };
    for (int i = 0; i < GW; i++) for (int j = 0; j < GH; j++) {
      double ux = (i + 0.5 - cx) / rx, uy = (j + 0.5 - cy) / ry, d = ux * ux + uy * uy;
      if (d > 1) continue;
      Color p = c;
      // The black rim: any pixel of the ball touching the outside, a solid one-pixel ring.
      if (!inside(i - 1, j) || !inside(i + 1, j) || !inside(i, j - 1) || !inside(i, j + 1) ||
          !inside(i - 1, j - 1) || !inside(i + 1, j - 1) || !inside(i - 1, j + 1) || !inside(i + 1, j + 1)) { Px(i, j, rim); continue; }
      double hx = ux + 0.38, hy = uy + 0.38;
      if (hx * hx + hy * hy < 0.12) p = hi;
      else if (d > 0.62 && ux + uy > 0.35) p = lo;
      Px(i, j, p);
    }
  }
}
