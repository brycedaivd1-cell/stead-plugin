// stand: just standing there, four ways (Variant): arms at her sides tapping a foot, hands behind
// her back, hands on her hips, or glancing about. Thinking: a hand on her chin. Talking: she gestures.
using System;
using System.Drawing;

public partial class Girl {
  void stand() {
    if (Thinking) { fa = new[] { 10, sy, 13, 14, 12, 11 }; return; }
    if (Talking) { if ((Tick / 16) % 3 == 0) fa = new[] { 10, sy, 13, 14, 14, 12 }; return; }
    switch (Variant) {
      case 0: if (StTicks > 60 && (StTicks / 90) % 2 == 1) fl = new[] { 9, hy, 10, (Tick / 6) % 2 == 0 ? 22 : 23 }; break;
      case 1: armsBehind = true; ba = new[] { 6, sy, 7, 16 }; fa = new[] { 10, sy, 8, 16 }; break;
      case 2: ba = new[] { 6, sy, 4, 14, 6, 16 }; fa = new[] { 10, sy, 12, 14, 10, 16 }; break;
      default: if (StTicks > 20) lookAt = (StTicks / 40) % 2 == 0 ? -1 : 1; break;
    }
  }
}
