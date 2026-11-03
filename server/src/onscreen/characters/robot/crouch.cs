// crouch: bobbing down on its legs.
using System;
using System.Drawing;

public partial class Robot {
  void crouch() {
    Legs(Shell(4, 1));
  }
}
