// drag: held up by the mouse, Shimeji-style: five drawn leans (her body lags behind the cursor
// and swings, pivoting on her raised hands; never rotated), and kicking to get down when held still.
using System;
using System.Drawing;

public partial class Girl {
  void drag() {
    int s = Math.Max(-2, Math.Min(2, (int)Math.Round(-Lean * 1.2))) * Facing;
    Shear = s * 0.09;
    ba = new[] { 6, sy, 1, 6, 4, 1 }; fa = new[] { 10, sy, 14, 6, 11, 1 };   // hands up, elbows out
    sway = s > 0 ? -1 : s < 0 ? 1 : 0;
    if (s == 0 && Held > 40) {
      int f = (Tick / 4) % 2;   // put me down!
      bl = new[] { 7, hy, f == 0 ? 5 : 8, f == 0 ? 22 : 21 }; fl = new[] { 9, hy, f == 0 ? 11 : 9, f == 0 ? 21 : 23 };
      eyesShut = true; mouthOpen = (Tick / 8) % 2 == 0;
    } else if (Math.Abs(s) == 2) mouthOpen = true;
  }
}
