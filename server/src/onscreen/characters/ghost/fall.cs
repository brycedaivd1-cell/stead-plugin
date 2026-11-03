// fall: dropping, both arms up.
using System;
using System.Drawing;

public partial class Ghost {
  void fall() {
    int oy = Bob();
    Sheet(oy); Px(2, 12 + oy, C); Px(1, 11 + oy, C); Px(13, 12 + oy, C); Px(14, 11 + oy, C); Eyes(oy);
  }
}
