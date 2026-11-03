// creep: sneaking: low on tiptoe, hands up in front like paws, big slow steps, eyes darting.
using System;
using System.Drawing;

public partial class Girl {
  void creep() {
    int w = (Tick / 8) % 4, s = w == 0 ? 2 : w == 2 ? -2 : 0;
    Pose(w % 2 == 0 ? 2 : 3);
    armsFront = true;
    ba = new[] { 6, sy, 9, sy + 2, 10, sy }; fa = new[] { 10, sy, 13, sy + 2, 14, sy };
    bl = new[] { 7, hy, 7 - s, 23 }; fl = new[] { 9, hy, 9 + s, w == 3 ? 22 : 23 };
    lookAt = (Tick / 48) % 2 == 0 ? 1 : -1;
  }
}
