// thrown: flung: spread-eagle and tumbling, arms and legs swapping every few frames.
using System;
using System.Drawing;

public partial class Girl {
  void thrown() {
    scared = true;
    if ((Tick / 3) % 2 == 0) { ba = new[] { 6, sy, 2, 8 }; fa = new[] { 10, sy, 14, 8 }; bl = new[] { 7, hy, 3, 22 }; fl = new[] { 9, hy, 13, 22 }; }
    else { ba = new[] { 6, sy, 1, 13 }; fa = new[] { 10, sy, 15, 13 }; bl = new[] { 7, hy, 4, 23 }; fl = new[] { 9, hy, 12, 20 }; }
  }
}
