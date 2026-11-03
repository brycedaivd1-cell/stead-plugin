// walk: stepping along.
using System;
using System.Drawing;

public partial class Robot {
  void walk() {
    Steps(Shell(4, 0), (Tick / 4) % 4);
  }
}
