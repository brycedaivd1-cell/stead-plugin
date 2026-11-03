// stand: floating just off the ground, bobbing.
using System;
using System.Drawing;

public partial class Orb {
  void stand() {
    Ball(7.5, 19.5 - Bob(), 3.6, 3.6);
  }
}
