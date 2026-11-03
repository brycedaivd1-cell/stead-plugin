// hang: holding on to an edge above with both stubby arms, sheet dangling.
using System;
using System.Drawing;

public partial class Ghost {
  void hang() {
    int oy = -7;
    Sheet(oy); Line(11, 12 + oy, 13, 0, C); Line(10, 13 + oy, 14, 0, C); Eyes(oy);
  }
}
