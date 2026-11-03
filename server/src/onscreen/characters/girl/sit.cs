// sit: sitting on a ledge, three ways (Variant): kicking a foot, leaning back on her hands looking
// up, or hands in her lap watching the mouse.
using System;
using System.Drawing;

public partial class Girl {
  void sit() {
    // Thighs out level, shins hanging from the knee; the feet take turns swinging forward from the knee.
    int k = Asleep ? -1 : (Tick / 14) % 2;
    ba = new[] { 6, sy, 7, 17 }; fa = new[] { 10, sy, 12, 17 };
    bl = new[] { 7, 20, 9, 21, k == 1 ? 11 : 9, k == 1 ? 22 : 23 }; fl = new[] { 9, 20, 11, 21, k == 0 ? 13 : 11, k == 0 ? 22 : 23 };
    if (Variant == 1) { ba = new[] { 6, sy, 4, 18 }; fa = new[] { 10, sy, 9, 17, 8, 19 }; eyesUp = !Asleep; fl = new[] { 9, 20, 11, 21, 11, 23 }; }
    else if (Variant == 2) { fa = new[] { 10, sy, 11, 16, 9, 17 }; fl = new[] { 9, 20, 11, 21, 11, 23 }; }
  }
}
