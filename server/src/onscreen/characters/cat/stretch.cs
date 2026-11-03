// stretch: a long cat stretch, front paws pushed out ahead.
using System;
using System.Drawing;

public partial class Cat {
  void stretch() {
    Body(0, new[] { new[] { 4, 20, 4, 23 }, new[] { 6, 20, 6, 23 }, new[] { 10, 20, 14, 23 }, new[] { 11, 20, 15, 23 } }, false);
  }
}
