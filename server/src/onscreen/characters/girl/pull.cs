// pull: hauling the chat window up from the bottom of the screen by its corner: hanging on, knees up with the effort.
using System;
using System.Drawing;

public partial class Girl {
  void pull() {
    hang();
    int f = (Tick / 4) % 2;
    bl = new[] { 7, hy, 9, 21, 8, 23 - f }; fl = new[] { 9, hy, 11, 20, 11, 22 - f };
    happy = true;
  }
}
