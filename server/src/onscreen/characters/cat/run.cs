// run: trotting fast.
using System;
using System.Drawing;

public partial class Cat {
  void run() {
    Body(0, Steps((Tick / 2) % 4, 0), false);
  }
}
