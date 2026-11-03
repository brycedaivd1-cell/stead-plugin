// sprawl: sat up after a fall, legs out flat, propped on a hand, seeing stars.
using System;
using System.Drawing;

public partial class Girl {
  void sprawl() {
    Pose(3); legsFront = true; dizzy = StTicks < 60;
    ba = new[] { 6, sy, 4, 19, 3, 22 }; fa = new[] { 10, sy, 12, 20 };
    bl = new[] { 7, 22, 12, 23 }; fl = new[] { 9, 22, 14, 23 };
  }
}
