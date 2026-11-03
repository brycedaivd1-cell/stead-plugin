// walk: a stroll. Legs step through four frames, arms swing against them, the ponytail bobs.
using System;
using System.Drawing;

public partial class Girl {
  void walk() {
    Stride((Tick / 4) % 4);
    sway = (Tick / 6) % 2;
  }
}
