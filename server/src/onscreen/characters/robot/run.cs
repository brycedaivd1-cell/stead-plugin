// run: stepping along, fast.
using System;
using System.Drawing;

public partial class Robot {
  void run() {
    Steps(Shell(4, 0), (Tick / 2) % 4);
  }
}
