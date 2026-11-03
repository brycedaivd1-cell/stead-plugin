// The robot: the original Stead. A little white robot with a dark visor and an antenna light
// (their color for the light, if they picked one).
using System;
using System.Drawing;

public partial class Robot : Character {
  static readonly Color GREY = Color.FromArgb(150, 150, 156);
  static readonly string[] SHELL = {
    ".....KKKKKK.....",
    "...KKWWWWWWKK...",
    "..KWWWWWWWWWWK..",
    ".KWWWWWWWWWWWWK.",
    ".KWWKKKKKKKKWWK.",
    "KWWKKKKKKKKKKWWK",
    "KWWKKKKKKKKKKWWK",
    "KWWKKKKKKKKKKWWK",
    "KWWWKKKKKKKKWWWK",
    "KWWWWWWWWWWWWWGK",
    ".KWWWWWWWWWWWGK.",
    ".KGWWWWWWWWWGGK.",
    "..KKGGGGGGGGKK..",
    "....KKKKKKKK....",
  };

  // The body, with its top at row oy + 4 (dropped dy more): shell, antenna and light, visor eyes.
  // Returns the row its feet start at.
  protected int Shell(int oy, int dy) {
    for (int j = 4; j < 18; j++) for (int i = 0; i < GW; i++) {
      char c = SHELL[j - 4][i];
      if (c == '.') continue;
      Px(i, j + oy + dy, c == 'K' ? INK : c == 'G' ? GREY : PAPER);
    }
    Px(10, 3 + oy + dy, GREY); Px(11, 2 + oy + dy, GREY);
    Rect(11, oy + dy, 2, 2, Lit() ? (Tint.IsEmpty ? GLOW : Tint) : GREY);
    int ey = 9 + oy + dy;
    if (Asleep) { Rect(4, ey + 2, 3, 1, PAPER); Rect(9, ey + 2, 3, 1, PAPER); }
    else if (Blinking) { Rect(5, ey + 2, 2, 1, PAPER); Rect(9, ey + 2, 2, 1, PAPER); }
    else if (Hover || Move == "wave" || Move == "dance" || BubbleUp) foreach (int ex in new[] { 4, 9 }) { Px(ex + 1, ey, PAPER); Px(ex, ey + 1, PAPER); Px(ex + 2, ey + 1, PAPER); }
    else { Rect(5, ey, 2, 3, PAPER); Rect(9, ey, 2, 3, PAPER); }
    // Speaking out loud: a light bar along the bottom of the visor, as wide as the sound.
    if (Mouth > 0) { Color lit = Tint.IsEmpty ? GLOW : Tint; int w = Mouth == 2 ? 6 : Mouth == 4 ? 4 : 2; Rect(8 - w / 2, ey + 3, w, 1, lit); }
    return 18 + oy + dy;
  }
  // Two legs down to the ground from row ft.
  protected void Legs(int ft) { Rect(4, ft, 2, GH - ft, INK); Rect(10, ft, 2, GH - ft, INK); }
  // Feet for a step (0-3) of a walk.
  protected void Steps(int ft, int f) {
    if (f == 0) { Rect(3, ft, 2, 2, INK); Rect(10, ft, 2, 1, INK); }
    else if (f == 2) { Rect(5, ft, 2, 1, INK); Rect(11, ft, 2, 2, INK); }
    else { Rect(4, ft, 2, 2, INK); Rect(10, ft, 2, 2, INK); }
  }
}
