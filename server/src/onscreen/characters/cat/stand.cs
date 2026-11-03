// stand: standing on all fours, tail up and flicking.
using System;
using System.Drawing;

public partial class Cat {
  void stand() {
    Body(0, Steps(0, 0), false);
  }
}
