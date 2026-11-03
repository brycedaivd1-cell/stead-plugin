// stretch: a big stretch: elbows out, hands up over her head, then arms out wide.
using System;
using System.Drawing;

public partial class Girl {
  void stretch() {
    if (StTicks < 30) { ba = new[] { 6, sy, 1, 6, 4, 0 }; fa = new[] { 10, sy, 14, 6, 11, 0 }; happy = true; }
    else { ba = new[] { 6, sy, 1, 10 }; fa = new[] { 10, sy, 15, 10 }; }
  }
}
