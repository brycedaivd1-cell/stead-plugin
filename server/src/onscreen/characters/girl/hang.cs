// hang: hanging by both hands from an edge just above her head. Like a Shimeji's
// hand-drawn lean frames, Swing (set by the engine's pendulum) picks the pose: her hands stay put on the
// edge and everything below leans off them, a row at a time.
using System;
using System.Drawing;

public partial class Girl {
  void hang() {
    int s = Swing;
    OffX = s > 0 ? 0 : 1; Shear = s * 0.09;
    // the back arm is hidden behind her head; the front one goes up the outside of it, so it reads
    ba = new[] { 8, sy, 11 - OffX, 0 }; fa = new[] { 10, sy, 14, 8, 13 - OffX, 0 };
    bl = new[] { 7, hy, 7, 23 - Math.Abs(s) / 2 }; fl = new[] { 9, hy, 9, 23 - Math.Abs(s) / 2 };
    if (s == 0 && Perching && !Busy && (Tick / 8) % 2 == 0) fl = new[] { 9, hy, 11, 21 };   // kicking her feet
    sway = s > 0 ? -1 : s < 0 ? 1 : 0;   // the ponytail trails the swing
    hangs = true; eyesUp = true;
  }
}
