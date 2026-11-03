// dangle: sitting right on the edge, legs hanging over it, kicking them one at a time.
using System;
using System.Drawing;

public partial class Girl {
  void dangle() {
    Below = 5; Pose(-2);
    int f = Asleep ? 0 : (Tick / 10) % 4;
    ba = new[] { 6, sy, 5, 16 }; fa = new[] { 10, sy, 11, 16 };
    bl = new[] { 7, hy, 10, 18, f == 1 ? 12 : 10, f == 1 ? 21 : 22 }; fl = new[] { 9, hy, 12, 18, f == 3 ? 14 : 12, f == 3 ? 21 : 22 };
    if (Variant == 1) eyesUp = true; else if (Variant == 2) happy = (StTicks / 50) % 2 == 0;
  }
}
