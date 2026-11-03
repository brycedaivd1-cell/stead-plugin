// trip: tipping over, then flat on her face (a hard landing, or tripping while walking).
using System;
using System.Drawing;

public partial class Girl {
  void trip() {
    if (StTicks < 5) {
      Pose(3); scared = true;
      ba = new[] { 6, sy, 9, 19, 12, 21 }; fa = new[] { 10, sy, 13, 18, 15, 20 };
      bl = new[] { 7, hy, 4, 21 }; fl = new[] { 9, hy, 6, 19 };
    } else {
      Pose(7); eyesShut = true;
      ba = new[] { 6, sy, 2, 21, 0, 23 }; fa = new[] { 10, sy, 13, 21, 15, 23 };
    }
  }
}
