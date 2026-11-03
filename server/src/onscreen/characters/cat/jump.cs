// jump: leaping: front paws reaching, back legs pushing off.
using System;
using System.Drawing;

public partial class Cat {
  void jump() {
    Body(0, new[] { new[] { 4, 20, 2, 22 }, new[] { 6, 20, 4, 22 }, new[] { 10, 20, 13, 21 }, new[] { 11, 20, 14, 20 } }, true);
  }
}
