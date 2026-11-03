// The cat: a black cat with bright yellow eyes (their color for the fur, if they picked one).
using System;
using System.Drawing;

public partial class Cat : Character {
  protected static readonly Color EYE = Color.FromArgb(255, 214, 92), NOSE = Color.FromArgb(232, 140, 150);
  protected Color Fur { get { return Tint.IsEmpty ? Color.FromArgb(44, 44, 50) : Tint; } }
  public override int ZzzY { get { return 13; } }

  // On four legs, dropped dy rows: body, head and ears, tail up, the given legs, eyes (open lower in the air).
  protected void Body(int dy, int[][] legs, bool air) {
    int tail = (Tick / 8) % 2;
    Rect(3, 16 + dy, 9, 4, Fur);
    Rect(10, 13 + dy, 5, 4, Fur); Px(10, 12 + dy, Fur); Px(14, 12 + dy, Fur);
    Line(3, 16 + dy, 1, 13 + dy - tail, Fur); Px(2 - tail, 12 + dy - tail, Fur);
    foreach (var l in legs) Line(l[0], l[1], l[2], l[3], Fur);
    if (Blinking) { Px(11, 15 + dy, INK); Px(13, 15 + dy, INK); }
    else { Px(11, 14 + dy, EYE); Px(13, 14 + dy, EYE); if (!air) { Px(11, 15 + dy, EYE); Px(13, 15 + dy, EYE); } }
    Px(14, 16 + dy, NOSE);
    // Speaking out loud: a little mouth under the nose, its jaw dropping for open sounds.
    if (Mouth > 0) { Px(13, 16 + dy, INK); if (Mouth == 2 || Mouth == 3) Px(13, 17 + dy, Mouth == 3 ? NOSE : INK); }
  }
  // The four legs at a step (0-3) of a walk: hips at row 20, paws on the ground at 23.
  protected int[][] Steps(int w4, int dy) {
    int s = w4 == 0 ? 1 : w4 == 2 ? -1 : 0;
    return new[] { new[] { 4, 20 + dy, 4 - s, 23 }, new[] { 6, 20 + dy, 6 + s, 23 }, new[] { 10, 20 + dy, 10 + s, 23 }, new[] { 12, 20 + dy, 12 - s, 23 } };
  }
}
