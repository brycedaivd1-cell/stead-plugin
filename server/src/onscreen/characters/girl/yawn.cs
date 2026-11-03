// yawn: a big yawn: one arm up, the other hand by her mouth, eyes squeezed shut.
using System;
using System.Drawing;

public partial class Girl {
  void yawn() {
    if (StTicks < 6 || StTicks > 38) { eyesShut = StTicks > 38; return; }
    eyesShut = true; mouthOpen = true;
    ba = new[] { 6, sy, 4, 6, 5, 1 }; fa = new[] { 10, sy, 13, 14, 12, 11 };
  }
}
