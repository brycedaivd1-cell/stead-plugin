// stand: floating in place, arms at its sides.
using System;
using System.Drawing;

public partial class Ghost {
  void stand() {
    int oy = Bob();
    Sheet(oy); Px(2, 15 + oy, C); Px(13, 15 + oy, C); Eyes(oy);
  }
}
