// crouch: low, ready to pounce.
using System;
using System.Drawing;

public partial class Cat {
  void crouch() {
    Body(1, Steps(0, 1), false);
  }
}
