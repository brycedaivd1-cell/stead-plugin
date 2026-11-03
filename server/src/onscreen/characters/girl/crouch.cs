// crouch: knees bent, about to jump or just landed.
using System;
using System.Drawing;

public partial class Girl {
  void crouch() {
    Pose(2);
    ba = new[] { 6, sy, 6, 19 }; fa = new[] { 10, sy, 11, 19 };
    bl = new[] { 7, hy, 6, 23 }; fl = new[] { 9, hy, 10, 23 };
  }
}
