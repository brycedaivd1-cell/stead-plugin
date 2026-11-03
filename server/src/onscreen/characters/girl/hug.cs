// hug: sitting with her knees pulled up and her arms round them; she rocks a little now and then.
using System;
using System.Drawing;

public partial class Girl {
  void hug() {
    Below = 0; Pose(Asleep && (Tick / 40) % 2 == 0 ? 4 : 3); legsFront = true;
    bl = new[] { 8, 22, 11, 16, 11, 23 }; fl = new[] { 9, 22, 12, 16, 12, 23 };
    ba = new[] { 6, sy, 9, 18 }; fa = new[] { 10, sy, 13, 18 };
    if (!Asleep && Variant == 1) OffX = (StTicks / 30) % 2;
    if (Variant == 2) eyesUp = true;
  }
}
