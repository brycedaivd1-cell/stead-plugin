// wave: one front paw up, batting at the air.
using System;
using System.Drawing;

public partial class Cat {
  void wave() {
    Body(0, new[] { new[] { 4, 20, 4, 23 }, new[] { 6, 20, 6, 23 }, new[] { 10, 20, 10, 23 }, new[] { 12, 18, 15, 14 - (Tick / 5) % 2 } }, false);
  }
}
