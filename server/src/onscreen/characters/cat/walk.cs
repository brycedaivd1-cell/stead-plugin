// walk: padding along.
using System;
using System.Drawing;

public partial class Cat {
  void walk() {
    Body(0, Steps((Tick / 4) % 4, 0), false);
  }
}
