// run: running to something she has to do: twice the pace, elbows bent and pumping, ponytail flying.
using System;
using System.Drawing;

public partial class Girl {
  void run() {
    int s = Stride((Tick / 2) % 4);
    ba = new[] { 6, sy, 4 + s, 14, 5 + s, 16 }; fa = new[] { 10, sy, 12 - s, 14, 13 - s, 12 };
    sway = 2;
  }
}
