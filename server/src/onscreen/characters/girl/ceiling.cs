// ceiling: hand over hand along the top of the screen. The engine moves her only while a hand
// swings forward (StTicks % 20 >= 14), so each hand looks planted while she holds.
using System;
using System.Drawing;

public partial class Girl {
  void ceiling() {
    int ph = StTicks % 20; bool a = (StTicks / 20) % 2 == 0;
    hangs = true; eyesUp = true;
    int[] lead = { 0, 0, 12, 0 }, rear = ph >= 14 ? new[] { 0, 0, 7 + (ph - 14), 3 } : new[] { 0, 0, 6, 0 };
    ba = new[] { 6, sy, (a ? lead : rear)[2], (a ? lead : rear)[3] }; fa = new[] { 10, sy, 14, 6, (a ? rear : lead)[2], (a ? rear : lead)[3] };
    int sw = ph >= 14 ? -1 : 0;
    bl = new[] { 7, hy, 7 + sw, 23 }; fl = new[] { 9, hy, 9 + sw, 22 };
    Shear = ph >= 14 ? -0.05 : 0;
    sway = ph >= 14 ? 1 : 0;
  }
}
