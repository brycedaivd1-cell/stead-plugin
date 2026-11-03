// sleep: powered down: sunk a little, visor eyes shut.
using System;
using System.Drawing;

public partial class Robot {
  void sleep() {
    Legs(Shell(4, 1));
  }
}
