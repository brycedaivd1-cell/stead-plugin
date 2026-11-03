// fall: coming down: arms flailing up, legs apart, round eyes, ponytail up.
using System;
using System.Drawing;

public partial class Girl {
  void fall() {
    int f = (Tick / 3) % 2;
    ba = new[] { 6, sy, 4, 9, 3, 6 + f }; fa = new[] { 10, sy, 13, 9, 14, 7 - f };
    bl = new[] { 7, hy, 5, 22 }; fl = new[] { 9, hy, 11, 21 };
    scared = true;
  }
}
