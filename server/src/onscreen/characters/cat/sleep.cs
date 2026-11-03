// sleep: curled up in a loaf, tail wrapped round, eyes shut.
using System;
using System.Drawing;

public partial class Cat {
  void sleep() {
    Rect(4, 19, 9, 5, Fur); Rect(10, 18, 4, 4, Fur); Px(10, 17, Fur); Px(13, 17, Fur);
    Rect(2, 23, 3, 1, Fur); Px(1, 22, Fur);
    Px(11, 20, INK); Px(13, 20, INK);
  }
}
