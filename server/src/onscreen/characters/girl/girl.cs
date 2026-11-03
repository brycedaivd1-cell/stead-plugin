// The girl: Stead's first look. A pixel girl with a dark ponytail, a white shirt and a pleated skirt (in
// their color, if they picked one). Each move (its own file here) only sets her pose on the 16x24 grid:
// where her arms and legs go, how far she's crouched, what her face does. Draw() below puts her together
// from that pose at double detail (32x48): shaded hair, a face with real eyes, and arms and legs that are
// two pixels thick with their own dark edge, so a hand in front of her shirt still reads as a hand (the
// way Shimeji sprites keep their limbs readable).
using System;
using System.Drawing;

public partial class Girl : Character {
  public override int Res { get { return 2; } }

  static readonly Color HAIR = Color.FromArgb(52, 36, 33), HAIRMID = Color.FromArgb(82, 57, 49), HAIRHI = Color.FromArgb(128, 94, 78),
    SKIN = Color.FromArgb(250, 216, 190), SKINSH = Color.FromArgb(232, 186, 160), BLUSH = Color.FromArgb(244, 156, 156),
    SHIRTSH = Color.FromArgb(212, 212, 222), SKIRT = Color.FromArgb(72, 74, 90), SHOE = Color.FromArgb(34, 34, 40),
    SHOEHI = Color.FromArgb(96, 96, 108), MOUTH = Color.FromArgb(170, 74, 78), CLIPBACK = Color.FromArgb(26, 20, 26), EYE = Color.FromArgb(44, 34, 58);

  // Her head and body at full detail, facing right: H hair edge, M hair, h its shine, S skin, s skin in
  // shade, W shirt, w shirt in shade, D skirt, d its pleats and hem, . nothing. Rows 0-3 are room for
  // raised hands; arms, legs, ponytail, face and the hair clip (her light) are drawn per pose.
  static readonly string[] BODY = {
    "................................",
    "................................",
    "................................",
    "................................",
    "............HHHHHHHH............",
    ".........HHHMMMMMMMMHHH.........",
    ".......HHMMMMMhhhhMMMMMHH.......",
    "......HMMMMMhhhhhhhhMMMMMH......",
    ".....HMMMMMMMhhhhhhMMMMMMMH.....",
    "....HMMMMMMMMMMMMMMMMMMMMMMH....",
    "....HMMMMMMMMMMMMMMMMMMMMMMMH...",
    "...HMMMMMMMMMMMMMMMMMMMMMMMMH...",
    "...HMMMMMMMMMMMMMMMMMMMMMMMMH...",
    "...HMMMMMMMMMMMMSMMMMMMSMMMMH...",
    "...HMMMMMMMMMMMSSMMMMMSSSMMMH...",
    "...HMMMMMMMMMHSSSSMMMSSSSSMMH...",
    "...HMMMMMMMMHSSSSSSMSSSSSSSMH...",
    "...HMMMMMMMMHSSSSSSSSSSSSSSMH...",
    "...HMMMMMMMMHSSSSSSSSSSSSSSMH...",
    "....HMMMMMMMHSSSSSSSSSSSSSSMH...",
    "....HMMMMMMHSSSSSSSSSSSSSSSMH...",
    ".....HMMMMHsSSSSSSSSSSSSSSMH....",
    "......HMMHHssSSSSSSSSSSSsH......",
    ".......HH...sssSSSSSSss.........",
    "..........wWWWWsSsWWWW..........",
    "..........wWWWWWsWWWWW..........",
    "..........wWWWWWWWWWWW..........",
    "..........wWWWWWWWWWWW..........",
    "..........wwWWWWWWWWWW..........",
    "..........dddddddddddd..........",
    "..........DDDDDDDDDDDD..........",
    ".........DDdDDDdDDDdDDD.........",
    "........DDDdDDDdDDDDdDDD........",
    "........DDdDDDDdDDDDdDDD........",
    ".......DDDdDDDDdDDDDDdDDD.......",
    ".......DDdDDDDDdDDDDDdDDD.......",
    "......DDDdDDDDDdDDDDDDdDDD......",
    "......dddddddddddddddddddd......",
  };

  // ---- the pose a move sets ----
  // Arms are shoulder, maybe an elbow, then the hand; legs are hip, maybe a knee, then the foot. x, y pairs.
  protected int[] ba, fa, bl, fl;        // back arm, front arm, back leg, front leg
  protected int dy, sy, hy;              // how far down she is (crouch, step), shoulder row, hip row
  protected int sway;                    // ponytail: 0 still, 1/-1 swinging, 2 flying out behind
  protected bool armsBehind;             // both arms behind her body (hands up behind her head)
  protected bool armsFront;              // both arms in front of her body
  protected bool scared;                 // falling: round eyes, open mouth, ponytail up
  protected bool hangs;                  // hanging by her hands (feet tap instead of hands when typing)
  protected bool eyesUp;                 // looking up at what she's holding
  protected bool happy;                  // smiling eyes and a blush
  protected int? lookAt;                 // eyes forced ahead (1) or behind (-1)
  protected bool legsFront;              // legs drawn over her body (knees hugged, legs out in front)
  protected bool eyesShut, mouthOpen;    // squeezed shut; a yawn or a yell
  protected bool dizzy;                  // seeing stars

  // Standing straight, dropped by d rows; every move starts from this.
  protected void Pose(int d) {
    dy = d; sy = 12 + dy; hy = 19 + dy;
    ba = new[] { 6, sy, 5, 17 + dy }; fa = new[] { 10, sy, 11, 17 + dy }; bl = new[] { 7, hy, 7, 23 }; fl = new[] { 9, hy, 9, 23 };
  }

  // One leg cycle step (0-3): legs apart, together, apart the other way, together; returns the swing.
  protected int Stride(int w4) {
    int s = w4 == 0 ? 2 : w4 == 2 ? -2 : 0;
    Pose(w4 % 2 == 0 ? 1 : 0);
    ba = new[] { 6, sy, 5 + s, 17 }; fa = new[] { 10, sy, 11 - s, 17 };
    bl = new[] { 7, hy, 7 - s, w4 == 1 ? 22 : 23 }; fl = new[] { 9, hy, 9 + s, w4 == 3 ? 22 : 23 };
    return s;
  }

  public override void Draw() {
    armsBehind = armsFront = scared = hangs = eyesUp = happy = legsFront = eyesShut = mouthOpen = dizzy = false;
    sway = 0; lookAt = null; OffX = 0; Shear = 0; Below = -1;
    Pose(0);
    Run(Move);
    if (Typing) Do("type");
    int fy = 2 * dy;   // her drop, in fine rows

    // ---- behind her: back arm, legs, ponytail ----
    if (!armsFront) Arm(ba);
    if (armsBehind) Arm(fa);
    if (!legsFront) { Leg(bl); Leg(fl); }
    Ponytail(fy);

    // ---- her: head, shirt, skirt ----
    Color skirt = Tint.IsEmpty ? SKIRT : Tint, pleat = Mix(skirt, INK, 0.38);
    Layer();
    for (int j = 4; j < BODY.Length; j++) for (int i = 0; i < 32; i++) {
      char c = BODY[j][i];
      if (c == '.') continue;
      Fx(i, j + fy, c == 'H' ? HAIR : c == 'M' ? HAIRMID : c == 'h' ? HAIRHI : c == 'S' ? SKIN : c == 's' ? SKINSH
        : c == 'W' ? PAPER : c == 'w' ? SHIRTSH : c == 'd' ? pleat : skirt);
    }
    EndLayer();
    if (legsFront) { Leg(bl); Leg(fl); }

    // her hair clip is her light
    bool lit = Lit();
    // a dark half-circle behind it, so it reads against any hair color
    Layer();
    for (int i = 21; i < 25; i++) Fx(i, 5 + fy, CLIPBACK);
    for (int j = 6; j < 9; j++) for (int i = 20; i < 26; i++) Fx(i, j + fy, CLIPBACK);
    for (int i = 21; i < 25; i++) for (int j = 6; j < 8; j++) Fx(i, j + fy, lit ? GLOW : PAPER);
    EndLayer();

    Face(fy);

    // ---- in front: the front arm ----
    if (!armsBehind) Arm(fa);
    if (armsFront) Arm(ba);
  }

  // ---- face: eyes at fine columns 16 and 22, mouth at 19-20 ----
  void Face(int fy) {
    int look = LookX, ey = (LookUp ? 15 : 16) + fy;
    if (eyesUp) { ey = 15 + fy; look = 1; }
    if (lookAt.HasValue) look = lookAt.Value;
    if (Thinking) { ey = 15 + fy; look = (Tick / 10) % 3 - 1; }
    bool smile = Hover || happy || (BubbleUp && (Tick / 12) % 3 != 2);
    int[] eyes = { 16, 22 };
    int my = 20 + fy;
    if (Asleep) foreach (int e in eyes) { Fx(e - 1, ey + 1, INK); Fx(e, ey + 2, INK); Fx(e + 1, ey + 2, INK); Fx(e + 2, ey + 1, INK); }
    else if (eyesShut) {
      Fx(16, ey, INK); Fx(17, ey + 1, INK); Fx(16, ey + 2, INK);   // > <
      Fx(23, ey, INK); Fx(22, ey + 1, INK); Fx(23, ey + 2, INK);
    }
    else if (scared) foreach (int e in eyes) { for (int j = 0; j < 4; j++) { Fx(e, ey - 1 + j, INK); Fx(e + 1, ey - 1 + j, INK); } Fx(e + 1, ey, PAPER); }
    else if (dizzy) {
      // eyes rolling round, stars circling her head
      int t = (Tick / 4) % 4;
      foreach (int e in eyes) {
        int ox = t == 1 ? 1 : t == 3 ? -1 : 0, oy = t == 0 ? -1 : t == 2 ? 1 : 0;
        Fx(e + ox, ey + 1 + oy, INK); Fx(e + 1 + ox, ey + 1 + oy, INK);
      }
      int a = (Tick / 6) % 3;
      for (int i = 0; i < 3; i++) Px(4 + i * 4, dy + (i == a ? 0 : 1), i == a ? GLOW : PAPER);
    }
    else if (Blinking) foreach (int e in eyes) { Fx(e + look, ey + 2, INK); Fx(e + 1 + look, ey + 2, INK); }
    else if (smile) foreach (int e in eyes) { Fx(e - 1, ey + 2, INK); Fx(e, ey + 1, INK); Fx(e + 1, ey + 1, INK); Fx(e + 2, ey + 2, INK); }
    else foreach (int e in eyes) {
      int x0 = e + look;
      Fx(x0, ey, INK); Fx(x0 + 1, ey, INK);                 // lid
      Fx(x0, ey + 1, EYE); Fx(x0 + 1, ey + 1, PAPER);       // the shine
      Fx(x0, ey + 2, EYE); Fx(x0 + 1, ey + 2, EYE);
      Fx(e == 22 ? x0 + 2 : x0 - 1, ey, INK);               // lashes at the outer corners
    }

    if (mouthOpen || (scared && !dizzy)) { for (int i = 18; i < 21; i++) for (int j = my; j < my + (scared ? 2 : 3); j++) Fx(i, j, MOUTH); Fx(19, my + 1, Mix(MOUTH, INK, 0.5)); }
    else if (Mouth >= 0) {
      // Speaking out loud: the shape of the sound she's making.
      Color dark = Mix(MOUTH, INK, 0.5);
      if (Mouth == 0) { Fx(19, my + 1, MOUTH); Fx(20, my + 1, MOUTH); }
      else if (Mouth == 1) { Fx(19, my, MOUTH); Fx(20, my, MOUTH); Fx(19, my + 1, dark); Fx(20, my + 1, MOUTH); }
      else if (Mouth == 2) { for (int i = 18; i < 22; i++) { Fx(i, my, MOUTH); Fx(i, my + 2, MOUTH); } Fx(18, my + 1, MOUTH); Fx(19, my + 1, dark); Fx(20, my + 1, dark); Fx(21, my + 1, MOUTH); }
      else if (Mouth == 3) { Fx(19, my, MOUTH); Fx(20, my, MOUTH); Fx(18, my + 1, MOUTH); Fx(19, my + 1, dark); Fx(20, my + 1, dark); Fx(21, my + 1, MOUTH); Fx(19, my + 2, MOUTH); Fx(20, my + 2, MOUTH); }
      else { for (int i = 17; i < 23; i++) Fx(i, my + 1, MOUTH); Fx(18, my, MOUTH); Fx(21, my, MOUTH); }
    }
    else if (Talking && (Tick / 3) % 2 == 0) { Fx(19, my, MOUTH); Fx(20, my, MOUTH); Fx(19, my + 1, MOUTH); Fx(20, my + 1, MOUTH); }
    else if (smile) { Fx(18, my, MOUTH); Fx(19, my + 1, MOUTH); Fx(20, my + 1, MOUTH); Fx(21, my, MOUTH); }
    else { Fx(19, my + 1, MOUTH); Fx(20, my + 1, MOUTH); }
    if (smile || Move == "sit" || Move == "hug" || Move == "dangle") { Fx(13, my, BLUSH); Fx(14, my, BLUSH); Fx(24, my, BLUSH); Fx(25, my, BLUSH); }
  }

  // ---- coding: glasses over her eyes (fine columns 15-18 and 21-24), the laptop in front of her chest ----
  static readonly Color RIM = Color.FromArgb(30, 26, 34), LENS = Color.FromArgb(170, 210, 255);
  void glasses() {
    int fy = 2 * dy, top = 15 + fy, bot = 19 + fy;
    foreach (int e in new[] { 16, 22 }) {
      int l = e - 1, r = e + 2;
      for (int i = l + 1; i < r; i++) { Fx(i, top, RIM); Fx(i, bot, RIM); }
      for (int j = top + 1; j < bot; j++) { Fx(l, j, RIM); Fx(r, j, RIM); }
      for (int i = l + 1; i < r; i++) for (int j = top + 1; j < bot; j++) Glaze(i, j, LENS, 0.16);
      Glaze(r - 1, top + 1, PAPER, 0.6);                    // the shine
    }
    Fx(19, top + 1, RIM); Fx(20, top + 1, RIM);             // the bridge
    Fx(14, top + 1, RIM); Fx(13, top + 1, RIM);             // the arm, back to her ear
  }
  Rectangle laptop() { return new Rectangle(8, 11 + dy, 8, 6); }

  // ---- the ponytail, tied at the back of her head: still, swinging, flying out, or straight up when scared ----
  void Ponytail(int fy) {
    Layer();
    for (int t = 0; t < 13; t++) {
      int x, y;
      if (scared) { x = 4 - t / 3; y = 9 - (t * 2) / 3; }
      else if (sway == 2) { x = 4 - t; y = 10 + t / 4; }
      else { x = 4 - t / 5 - (t > 3 ? sway * (t - 3) / 3 : 0); y = 10 + t; }
      int w = t < 3 ? 4 : t < 8 ? 3 : t < 11 ? 2 : 1;
      for (int i = 0; i < w; i++) {
        bool vertical = !scared && sway != 2;
        int px = vertical ? x - w / 2 + i : x, py = vertical ? y : y - w / 2 + i;
        Fx(px, py + fy, i == 0 ? HAIR : (t % 4 == 1 && i == 1) ? HAIRHI : HAIRMID);
      }
    }
    EndLayer();
    Layer(); Fx(4, 9 + fy, Tint.IsEmpty ? GLOW : Tint); Fx(5, 9 + fy, Tint.IsEmpty ? GLOW : Tint); Fx(4, 10 + fy, Tint.IsEmpty ? GLOW : Tint); EndLayer();   // her hair tie
  }

  // ---- limbs: two fine pixels thick, each with its own dark edge ----
  // Every arm and leg is the same two bones in every move: a move says where the hand or foot is
  // headed (and, with a middle point, which way the elbow or knee points) and Limb works out the
  // joint. A target out of reach is pulled in along the same line, so no move can stretch a limb.
  // The one exception is a hand reaching up over her head to grip something, which may reach further.
  const double ARM = 2.8, LEG = 2.2;     // upper and lower bone, in grid cells
  int[] Limb(int[] p, bool arm) {
    int L = p.Length;
    double sx = p[0], sy0 = p[1], tx = p[L - 2], ty = p[L - 1];
    double U = arm ? ARM : LEG, dx = tx - sx, dy2 = ty - sy0, d = Math.Sqrt(dx * dx + dy2 * dy2);
    if (d < 0.01) return new[] { p[0] * 2, p[1] * 2, p[0] * 2, p[1] * 2 };
    if (arm && ty < sy0 - 5 && d > 2 * U) {   // gripping overhead: exactly as the move draws it, elbow clear of her face
      var r = new int[L]; for (int i = 0; i < L; i++) r[i] = p[i] * 2; return r;
    }
    if (d > 2 * U) { tx = sx + dx / d * 2 * U; ty = sy0 + dy2 / d * 2 * U; d = 2 * U; }
    var hand = new[] { (int)Math.Round(sx * 2), (int)Math.Round(sy0 * 2), (int)Math.Round(tx * 2), (int)Math.Round(ty * 2) };
    // No joint asked for: straight unless it's folded right up (a crouch).
    if (L < 6 && d >= 1.1 * U) return hand;
    double a = d / 2, h = Math.Sqrt(Math.Max(0, U * U - a * a));
    double px = sx + dx / 2, py = sy0 + dy2 / 2, nx = -dy2 / d, ny = dx / d;
    double e1x = px + h * nx, e1y = py + h * ny, e2x = px - h * nx, e2y = py - h * ny;
    bool one;
    if (L >= 6) one = Sq(e1x - p[2], e1y - p[3]) <= Sq(e2x - p[2], e2y - p[3]);   // the way the move bent it
    else if (arm) one = Math.Abs(e1x - 8) >= Math.Abs(e2x - 8);                     // elbows out, away from her
    else one = e1x >= e2x;                                                             // knees forward
    double ex = one ? e1x : e2x, ey = one ? e1y : e2y;
    return new[] { hand[0], hand[1], (int)Math.Round(ex * 2), (int)Math.Round(ey * 2), hand[2], hand[3] };
  }
  static double Sq(double x, double y) { return x * x + y * y; }

  // A stroke through fine points p (x, y pairs) with a 2x2 pen; the first `first` steps in color a,
  // the rest in b.
  void Stroke(int[] p, Color a, Color b, int first) {
    int n = 0;
    for (int i = 0; i + 3 < p.Length; i += 2) {
      int x0 = p[i], y0 = p[i + 1], x1 = p[i + 2], y1 = p[i + 3];
      int dx = Math.Abs(x1 - x0), dyy = -Math.Abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy2 = y0 < y1 ? 1 : -1, err = dx + dyy;
      for (; ; ) {
        Color c = n++ < first ? a : b;
        Fx(x0, y0, c); Fx(x0 + 1, y0, c); Fx(x0, y0 + 1, c); Fx(x0 + 1, y0 + 1, c);
        if (x0 == x1 && y0 == y1) break;
        int e2 = 2 * err;
        if (e2 >= dyy) { err += dyy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy2; }
      }
    }
  }
  // An arm: a short sleeve, then skin, and a hand a little bigger than the wrist.
  void Arm(int[] g) {
    var p = Limb(g, true);
    Layer();
    Stroke(p, PAPER, SKIN, 4);
    int L = p.Length, hx = p[L - 2], hy2 = p[L - 1];
    int ox = p[L - 2] < p[L - 4] ? -1 : 0, oy = p[L - 1] < p[L - 3] ? -1 : 0;
    for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) Fx(hx + ox + i, hy2 + oy + j, SKIN);
    EndLayer();
  }
  // A leg, with a white sock and a shoe pointing the way she faces.
  void Leg(int[] g) {
    var p = Limb(g, false);
    Layer();
    int L = p.Length;
    Stroke(p, SKIN, SKIN, 0);
    int fx = p[L - 2], fy2 = p[L - 1];
    Fx(fx, fy2 - 1, PAPER); Fx(fx + 1, fy2 - 1, PAPER); Fx(fx, fy2 - 2, PAPER); Fx(fx + 1, fy2 - 2, PAPER);
    for (int i = 0; i < 4; i++) { Fx(fx + i, fy2, SHOE); Fx(fx + i, fy2 + 1, SHOE); }
    Fx(fx + 2, fy2, SHOEHI);
    EndLayer();
  }
}
