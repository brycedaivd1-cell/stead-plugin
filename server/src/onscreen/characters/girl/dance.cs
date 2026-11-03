// dance: a little dance: bouncing, arms up one side then the other, ponytail swinging.
using System;
using System.Drawing;

public partial class Girl {
  void dance() {
    int p = (StTicks / 8) % 4;
    Pose((StTicks / 8) % 2);
    armsFront = true; happy = true; sway = (StTicks / 8) % 2 == 0 ? 1 : -1;
    if (p == 0) { fa = new[] { 10, sy, 13, 9, 14, 5 }; ba = new[] { 6, sy, 4, 17 }; fl = new[] { 9, hy, 12, 21 }; }
    else if (p == 2) { ba = new[] { 6, sy, 3, 10, 2, 5 }; fa = new[] { 10, sy, 12, 17 }; bl = new[] { 7, hy, 4, 21 }; }
    else { ba = new[] { 6, sy, 3, 15 }; fa = new[] { 10, sy, 13, 15 }; }
  }
}
