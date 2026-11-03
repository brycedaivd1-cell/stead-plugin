// crouch: sinking low for a moment.
using System;
using System.Drawing;

public partial class Ghost {
  void crouch() {
    Sheet(1); Px(2, 16, C); Px(13, 16, C); Eyes(1);
  }
}
