// type: tapping at an invisible keyboard (drawn on top of whatever move she's in): hands out front, or feet if she's hanging.
using System;
using System.Drawing;

public partial class Girl {
  void type() {
    int f = (Tick / 2) % 2;
    if (hangs) { bl = new[] { 7, hy, f == 0 ? 9 : 7, f == 0 ? 21 : 23 }; fl = new[] { 9, hy, f == 1 ? 11 : 9, f == 1 ? 21 : 23 }; return; }
    if (Move == "jump" || Move == "fall" || Move == "climb" || Move == "drag" || Move == "sit") return;
    armsFront = true; armsBehind = false;
    ba = new[] { 6, sy, 9, 16, 12, 15 + f }; fa = new[] { 10, sy, 12, 16, 14, 16 - f };
  }
}
