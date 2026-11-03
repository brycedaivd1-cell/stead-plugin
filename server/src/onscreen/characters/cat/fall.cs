// fall: dropping, paws out to land.
using System;
using System.Drawing;

public partial class Cat {
  void fall() {
    Body(0, new[] { new[] { 4, 20, 2, 21 }, new[] { 6, 20, 5, 22 }, new[] { 10, 20, 12, 23 }, new[] { 11, 20, 13, 22 } }, true);
  }
}
