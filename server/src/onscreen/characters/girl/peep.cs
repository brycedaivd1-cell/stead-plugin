// peep: peeking up over the bottom of the screen, both hands on the edge, watching the mouse.
using System;
using System.Drawing;

public partial class Girl : Character {
  void peep() {
    armsFront = true;
    ba = new[] { 6, sy, 4, 13, 5, 12 }; fa = new[] { 10, sy, 12, 13, 11, 12 };
  }
}
