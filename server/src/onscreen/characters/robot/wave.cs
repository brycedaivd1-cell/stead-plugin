// wave: waving a little arm.
using System;
using System.Drawing;

public partial class Robot {
  void wave() {
    int ft = Shell(4, 0);
    Rect(4, ft, 2, 2, INK); Rect(10, ft, 2, 2, INK); Rect(15, 12 - (Tick / 5) % 2, 1, 4, INK);
  }
}
