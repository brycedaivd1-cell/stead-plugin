// wave: waving one arm.
using System;
using System.Drawing;

public partial class Ghost {
  void wave() {
    int oy = Bob();
    Sheet(oy); Px(13, 13 + oy, C); Px(14, 12 + oy - (Tick / 5) % 2, C); Px(2, 15 + oy, C); Eyes(oy);
  }
}
