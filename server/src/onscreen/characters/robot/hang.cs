// hang: holding an edge above with two thin arms, feet swinging.
using System;
using System.Drawing;

public partial class Robot {
  void hang() {
    int ft = Shell(1, 0);
    Rect(14, 0, 1, 7, INK); Rect(12, 0, 1, 5, INK);
    int s1 = Swing;
    Rect(4 + s1, ft, 2, 2, INK); Rect(10 + s1, ft, 2, 2, INK);
  }
}
