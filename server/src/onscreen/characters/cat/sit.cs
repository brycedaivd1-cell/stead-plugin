// sit: sitting up, tail curled round its paws (a loaf when asleep).
using System;
using System.Drawing;

public partial class Cat {
  void sit() {
    if (Asleep) { sleep(); return; }
    Rect(4, 18, 7, 5, Fur); Rect(9, 13, 5, 4, Fur); Px(9, 12, Fur); Px(13, 12, Fur); Rect(9, 17, 3, 6, Fur);
    Rect(2, 23, 4, 1, Fur); Px(1, 22, Fur);
    if (Blinking) { Px(10, 15, INK); Px(12, 15, INK); } else { Px(10, 14, EYE); Px(12, 14, EYE); Px(10, 15, EYE); Px(12, 15, EYE); }
    Px(13, 16, NOSE);
  }
}
