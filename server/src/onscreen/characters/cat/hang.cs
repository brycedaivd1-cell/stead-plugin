// hang: hanging by its front paws, head under them, body and tail dangling.
using System;
using System.Drawing;

public partial class Cat {
  void hang() {
    int s1 = Math.Max(-1, Math.Min(1, Swing)), s2 = Swing;
    Line(10, 3, 12, 0, Fur); Line(13, 3, 14, 0, Fur);
    Rect(9, 2, 5, 4, Fur); Px(9, 1, Fur); Px(13, 1, Fur);
    Rect(10, 6, 4, 8, Fur);
    Line(10, 14, 10 + s1, 17, Fur); Line(13, 14, 13 + s1, 17, Fur);
    Line(11, 14, 11 + s2, 20, Fur);
    if (Asleep || Blinking) { Px(10, 4, INK); Px(12, 4, INK); } else { Px(10, 3, EYE); Px(12, 3, EYE); }
  }
}
