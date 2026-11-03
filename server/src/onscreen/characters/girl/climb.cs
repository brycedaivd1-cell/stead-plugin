// climb: up or down the side of a window, the way Shimeji climbs: hold, step, hold with the other
// hand, step (the engine only moves her on the steps; see Stead.cs).
using System;
using System.Drawing;

public partial class Girl {
  void climb() {
    int ph = StTicks % 28, f = ph < 10 ? 0 : ph < 14 ? 1 : ph < 24 ? 2 : 1;
    eyesUp = true;
    if (f == 1) {
      ba = new[] { 9, sy, 13, 7 }; fa = new[] { 10, sy, 14, 7 };
      bl = new[] { 7, hy, 11, 21 }; fl = new[] { 9, hy, 12, 21 };
      return;
    }
    ba = new[] { 9, sy, 13, f == 0 ? 5 : 9 }; fa = new[] { 10, sy, 14, f == 0 ? 9 : 5 };
    bl = new[] { 7, hy, 11, f == 0 ? 23 : 22 }; fl = new[] { 9, hy, 12, f == 0 ? 22 : 23 };
  }
}
