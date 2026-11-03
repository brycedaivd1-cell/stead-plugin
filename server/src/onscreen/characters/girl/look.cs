// look: looking around: eyes one way, then the other.
using System;
using System.Drawing;

public partial class Girl {
  void look() {
    lookAt = (StTicks / 12) % 2 == 0 ? 1 : -1;
  }
}
