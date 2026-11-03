// wave: waving hello with her front hand.
using System;
using System.Drawing;

public partial class Girl {
  void wave() {
    int f = (Tick / 5) % 2;
    fa = new[] { 10, sy, 13, 11, 14 + f, 7 + f };
    happy = true;
  }
}
