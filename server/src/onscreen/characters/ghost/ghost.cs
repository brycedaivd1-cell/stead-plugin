// The ghost: a little sheet with a wavy hem, two eyes and stubby arms. Their color, if they picked one.
using System;
using System.Drawing;

public partial class Ghost : Character {
  protected Color C { get { return Tint.IsEmpty ? PAPER : Tint; } }
  // How high it floats: a slow bob (resting low asleep).
  protected int Bob() { return Asleep ? 1 : (int)Math.Round((Math.Sin(Tick * 0.08) + 1) * 0.8); }

  // The sheet, lifted by oy rows, with its hem rippling.
  protected void Sheet(int oy) {
    Color sh = Mix(C, Color.Black, 0.22);
    int[][] rows = { new[] { 6, 9 }, new[] { 5, 10 }, new[] { 4, 11 } };
    for (int r = 0; r < 3; r++) for (int i = rows[r][0]; i <= rows[r][1]; i++) Px(i, 9 + r + oy, C);
    for (int j = 12; j <= 20; j++) for (int i = 3; i <= 12; i++) Px(i, j + oy, i == 12 || j == 20 ? sh : C);
    int wave = (Tick / 6) % 3;
    for (int i = 3; i <= 12; i++) {
      if ((i + wave) % 3 != 0) Px(i, 21 + oy, sh);
      if ((i + wave) % 3 == 1) Px(i, 22 + oy, sh);
    }
  }
  // Two eyes: blinking, shut asleep, tall and round when falling.
  protected void Eyes(int oy) {
    int cy = 14 + oy, a = 7, b = 10;
    if (Asleep || Blinking) { Px(a, cy + 1, INK); Px(b, cy + 1, INK); }
    else if (Move == "fall") { Rect(a, cy, 1, 3, INK); Rect(b, cy, 1, 3, INK); }
    else { Rect(a, cy, 1, 2, INK); Rect(b, cy, 1, 2, INK); }
    // Speaking out loud: a mouth between and below the eyes, wide, tall or round with the sound.
    if (Mouth == 1) Px(8, cy + 3, INK);
    else if (Mouth == 2) Rect(8, cy + 3, 2, 2, INK);
    else if (Mouth == 3) { Px(8, cy + 3, INK); Px(9, cy + 4, INK); Px(8, cy + 4, INK); Px(9, cy + 3, INK); }
    else if (Mouth == 4) Rect(7, cy + 3, 4, 1, INK);
  }
}
