// A character: what Stead looks like, one move at a time. Each one is a folder in
// src/onscreen/characters/<name>/ (or, for one made on this computer, ~/.hands/onscreen/characters/<name>/):
// <name>.cs holds what every move shares, and each move is its own file with one method named after it
// (stand.cs has `void stand()`, walk.cs has `void walk()`, ...). The engine (Stead.cs) does the physics and
// says which move she's in; the character only draws it on a 16x24 pixel grid. See characters/README.md.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;

public abstract class Character {
  public const int GW = 16, GH = 24;
  public static readonly Color KEY = Color.FromArgb(255, 0, 255);   // see-through: leave a pixel alone to keep it so
  public static readonly Color INK = Color.FromArgb(12, 12, 14), PAPER = Color.FromArgb(246, 246, 242),
    SHADE = Color.FromArgb(150, 150, 156), GLOW = Color.FromArgb(120, 220, 255);

  // ---- what's going on, set by the engine before every frame ----
  public Bitmap Frame;
  public string Move = "stand";      // the move being drawn (see MOVES)
  public int Tick, StTicks;          // frames since start (30 a second), frames in this move
  public int Facing = 1;             // 1 right, -1 left: draw facing right, it's mirrored for you
  public int LookX;                  // the mouse is ahead (1), behind (-1) or neither (0)
  public bool LookUp;                // the mouse is above her head
  public double Vy;                  // up/down speed (negative: going up)
  public double Lean;                // how hard she's being dragged sideways
  public int Swing;                  // hanging: how far her body has swung, -2 (behind her) to 2 (ahead)
  public int Variant;                // 0-3, picked fresh each time a move starts: which take on it to draw
  public int Held;                   // dragged: frames the mouse has held her still (she starts kicking)
  public string Mood = "";           // how she feels, from what she's saying (see MOODS); "" is neutral
  public bool Asleep, Thinking, Talking, BubbleUp, Hover, Blinking, Typing, Busy, Perching;
  public bool Writing;               // typing into a blank: a look can put a pencil in her hand
  public bool Coding;                // working on code: glasses on and a laptop of green rain in front, for a look that has them (Code)
  public Color Tint = Color.Empty;   // the color they picked, if any
  // Speaking out loud (voice on): the mouth shape for this frame, from what she's saying. -1 when she
  // isn't speaking (draw the usual Talking flap); 0 closed, 1 small, 2 open, 3 round (o, w), 4 wide (s, ee, f).
  public int Mouth = -1;

  // Every move the engine asks for. A character only needs `stand`; anything it lacks falls back.
  public static readonly string[] MOVES = { "stand", "walk", "run", "jump", "fall", "crouch", "sit", "sleep", "hang", "climb",
    "drag", "pull", "wave", "stretch", "dance", "look", "type", "peep",
    "thrown", "trip", "sprawl", "dangle", "hug", "ceiling", "creep", "yawn",
    "press", "kindle", "camp", "grab", "throw" };
  static readonly Dictionary<string, string> NEXT = new Dictionary<string, string> {
    { "run", "walk" }, { "pull", "hang" }, { "climb", "hang" }, { "hang", "stand" }, { "drag", "stand" }, { "peep", "stand" },
    { "thrown", "fall" }, { "trip", "crouch" }, { "sprawl", "sit" }, { "dangle", "sit" }, { "hug", "sit" }, { "ceiling", "hang" },
    { "creep", "walk" }, { "yawn", "stretch" },
    { "press", "crouch" }, { "kindle", "crouch" }, { "camp", "hug" }, { "grab", "wave" }, { "throw", "wave" } };

  // ---- the look's own settings ----
  public virtual bool Outline { get { return true; } }     // a dark edge so it reads on any background
  public virtual bool Calm { get { return false; } }       // true: drifts quietly, no tricks on its own
  public virtual bool Stays { get { return false; } }      // true: put down, it stays exactly there (no falling, no wandering home) till moved or reset
  public virtual int ZzzY { get { return 2; } }            // where sleep z's go; -1 for none
  public virtual int MoodY { get { return ZzzY >= 0 ? ZzzY : 2; } }   // where the mood mark goes (heart, !, ?...); -1 for none
  public virtual Color Edge { get { return GLOW; } }       // the glow when it breaks up into pixels (teleport)
  // Detail: 1 draws the 16x24 grid as is; 2 gives a 32x48 frame. Poses stay on the 16x24 grid (Px fills a
  // 2x2 block), and Fx reaches the fine pixels in between for faces, shading and outlines.
  // 4 gives 64x96, for a look drawn at its own fine detail (Fx), not on the grid.
  public virtual int Res { get { return 1; } }
  public static int ResOf(Character c) { int r = c.Res; return r >= 4 ? 4 : r >= 2 ? 2 : 1; }
  // How big it is on screen: 1 is the usual size, 1.25 a quarter bigger.
  public virtual double Scale { get { return 1; } }

  // One frame: the move, then the typing overlay while it types. Override to wrap moves in shared drawing.
  public virtual void Draw() { OffX = 0; Shear = 0; Below = -1; Run(Move); if (Typing) Do("type"); }
  // Rows of the sprite that go below where she stands (sitting with legs over an edge). A move sets it;
  // -1 leaves it to the engine (2 for sitting, 0 otherwise).
  public int Below = -1;

  // ---- moves, found by name ----
  Dictionary<string, Action> moves;
  public void Run(string m) {
    for (int i = 0; i < 8 && m != null; i++) {
      if (Do(m)) return;
      string n; m = NEXT.TryGetValue(m, out n) ? n : m == "stand" ? null : "stand";
    }
  }
  public bool Do(string m) { Load(); Action a; if (!moves.TryGetValue(m, out a)) return false; a(); return true; }
  public bool Has(string m) { Load(); return moves.ContainsKey(m); }
  void Load() {
    if (moves != null) return;
    moves = new Dictionary<string, Action>();
    foreach (var mi in GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)) {
      if (mi.DeclaringType == typeof(Character) || mi.DeclaringType == typeof(object)) continue;
      if (mi.GetParameters().Length != 0 || mi.ReturnType != typeof(void) || Array.IndexOf(MOVES, mi.Name) < 0) continue;
      moves[mi.Name] = (Action)Delegate.CreateDelegate(typeof(Action), this, mi);
    }
  }

  // ---- every look there is: each non-abstract Character, by its lowercase class name ----
  static SortedDictionary<string, Type> all;
  public static SortedDictionary<string, Type> All() {
    if (all != null) return all;
    all = new SortedDictionary<string, Type>();
    foreach (var t in Assembly.GetExecutingAssembly().GetTypes())
      if (!t.IsAbstract && t.IsSubclassOf(typeof(Character))) all[t.Name.ToLowerInvariant()] = t;
    return all;
  }
  public static Character Make(string name) {
    Type t;
    if (name == null || !All().TryGetValue(name, out t)) return null;
    try { return (Character)Activator.CreateInstance(t); } catch { return null; }
  }

  // ---- drawing, on the grid, facing right ----
  protected int OffX;                // shifts everything drawn sideways (a move resets it to 0 each frame)
  protected double Shear;            // and each row by Shear * row: a lean pivoting on row 0 (hands, when hanging)
  public void Px(int cx, int cy, Color c) {
    int R = ResOf(this);
    if (R == 1) {
      cx += OffX + (int)Math.Round(Shear * cy, MidpointRounding.AwayFromZero);
      if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) return;
      if (Facing < 0) cx = GW - 1 - cx;
      Set(cx, cy, c);
      return;
    }
    for (int i = 0; i < R; i++) for (int j = 0; j < R; j++) Fx(cx * R + i, cy * R + j, c);
  }
  // A fine pixel (Res > 1), facing right; OffX and Shear still count in grid units.
  public void Fx(int fx, int fy, Color c) {
    int R = ResOf(this), W = GW * R, H = GH * R;
    fx += OffX * R + (int)Math.Round(Shear * fy, MidpointRounding.AwayFromZero);
    if (fx < 0 || fy < 0 || fx >= W || fy >= H) return;
    if (Facing < 0) fx = W - 1 - fx;
    Set(fx, fy, c);
  }
  // A fine pixel tinted toward c by t (0 none, 1 all the way) instead of painted over: a lens, a glow.
  // Nothing drawn there yet stays see-through.
  public void Glaze(int fx, int fy, Color c, double t) {
    int R = ResOf(this), W = GW * R, H = GH * R;
    fx += OffX * R + (int)Math.Round(Shear * fy, MidpointRounding.AwayFromZero);
    if (fx < 0 || fy < 0 || fx >= W || fy >= H || buf == null) return;
    if (Facing < 0) fx = W - 1 - fx;
    int was = buf[fy * bw + fx];
    if (was == KEY.ToArgb()) return;
    Set(fx, fy, Mix(Color.FromArgb(was), c, t));
  }
  void Set(int x, int y, Color c) {
    if (buf == null) { Frame.SetPixel(x, y, c); return; }
    buf[y * bw + x] = c.ToArgb();
    if (layer != null) layer[y * bw + x] = true;
  }

  // One frame, drawn into memory and copied to Frame in one go (SetPixel per pixel is slow at 32x48).
  // The engine calls this, not Draw.
  int[] buf; int bw, bh;
  public void Render() {
    bw = Frame.Width; bh = Frame.Height;
    if (buf == null || buf.Length != bw * bh) buf = new int[bw * bh];
    int key = KEY.ToArgb();
    for (int i = 0; i < buf.Length; i++) buf[i] = key;
    try { Draw(); if (Coding) Code(); }
    finally {
      layer = null;
      var d = Frame.LockBits(new Rectangle(0, 0, bw, bh), System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
      for (int y = 0; y < bh; y++) System.Runtime.InteropServices.Marshal.Copy(buf, y * bw, d.Scan0 + y * d.Stride, bw);
      Frame.UnlockBits(d);
    }
  }

  // Layers: whatever's drawn between Layer() and EndLayer() gets a dark edge over anything already
  // there, so an arm in front of her body (or a body in front of an arm) still reads as its own shape.
  bool[] layer;
  public void Layer() { if (buf != null) layer = new bool[bw * bh]; }
  public void EndLayer() {
    var m = layer; layer = null;
    if (m == null) return;
    int W = bw, H = bh, key = KEY.ToArgb(), ink = INK.ToArgb();
    var edge = new List<int>();
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      int i = y * W + x;
      if (m[i] || buf[i] == key) continue;
      if ((x > 0 && m[i - 1]) || (x + 1 < W && m[i + 1]) || (y > 0 && m[i - W]) || (y + 1 < H && m[i + W])) edge.Add(i);
    }
    foreach (int i in edge) buf[i] = ink;
  }
  public void Rect(int x0, int y0, int w, int h, Color c) { for (int i = 0; i < w; i++) for (int j = 0; j < h; j++) Px(x0 + i, y0 + j, c); }
  public void Line(int x0, int y0, int x1, int y1, Color c) { int n = 0; Line(x0, y0, x1, y1, c, c, ref n, 0); }
  // A run of pixels (Bresenham): the first `sleeve` in one color, the rest in another; n counts across calls.
  public void Line(int x0, int y0, int x1, int y1, Color a, Color b, ref int n, int sleeve) {
    int dx = Math.Abs(x1 - x0), dy = -Math.Abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (; ; ) {
      Px(x0, y0, n++ < sleeve ? a : b);
      if (x0 == x1 && y0 == y1) break;
      int e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  public static Color Mix(Color a, Color b, double t) {
    return Color.FromArgb((int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));
  }
  // ---- working on code: glasses, and a laptop raining green ----
  // A look takes part with either or both of these, found by name the way moves are, so a look that
  // has them still builds on a Stead from before coding (where they're just unused methods):
  //   void glasses()        her glasses, drawn over her face once the rest of her is, where its eyes are
  //   Rectangle laptop()    where the laptop's screen goes, in grid cells facing right: in front of her,
  //                         below her chin, so her face shows over the top and her hands are behind it
  // A look without glasses() codes bare-eyed, and one without laptop() gets no laptop: on a small cat,
  // orb, ghost or robot one would cover the whole face.
  Action glasses; Func<Rectangle> laptopAt; bool coded;
  void Code() {
    if (!coded) {
      coded = true;
      var f = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
      var g = GetType().GetMethod("glasses", f, null, Type.EmptyTypes, null);
      if (g != null && g.ReturnType == typeof(void)) glasses = (Action)Delegate.CreateDelegate(typeof(Action), this, g);
      var l = GetType().GetMethod("laptop", f, null, Type.EmptyTypes, null);
      if (l != null && l.ReturnType == typeof(Rectangle)) laptopAt = (Func<Rectangle>)Delegate.CreateDelegate(typeof(Func<Rectangle>), this, l);
    }
    if (glasses != null) glasses();
    if (laptopAt != null) Laptop(laptopAt());
  }
  static readonly Color LAPEDGE = Color.FromArgb(54, 56, 62), LAPBASE = Color.FromArgb(120, 122, 130), LAPTOP = Color.FromArgb(168, 170, 178),
    RAINBG = Color.FromArgb(4, 10, 6), RAINHEAD = Color.FromArgb(214, 255, 220), RAIN = Color.FromArgb(70, 255, 110), RAINDK = Color.FromArgb(0, 70, 24);
  // The laptop, facing you, with its keyboard edge under it: a dark screen with green code falling down
  // it the way it does in the Matrix. Each column of glyphs falls at its own speed (fixed per column, not
  // random each frame), a bright head with a trail fading out behind it; the glyphs flicker as they change.
  // In the look's own pixels, so it's as fine as the look is.
  public void Laptop(Rectangle at) {
    int R = ResOf(this);
    int x0 = at.X * R, y0 = at.Y * R, w = at.Width * R, h = at.Height * R;
    Layer();
    for (int i = 0; i < w; i++) { Fx(x0 + i, y0, LAPEDGE); Fx(x0 + i, y0 + h - 1, LAPEDGE); }
    for (int j = 0; j < h; j++) { Fx(x0, y0 + j, LAPEDGE); Fx(x0 + w - 1, y0 + j, LAPEDGE); }
    int ix = x0 + 1, iy = y0 + 1, iw = w - 2, ih = h - 2;
    for (int i = 0; i < iw; i++) for (int j = 0; j < ih; j++) Fx(ix + i, iy + j, RAINBG);
    int pitch = R >= 2 ? 2 : 1;
    for (int col = 0; col * pitch < iw; col++) {
      int step = 2 + Hash(col, 1) % 3, len = ih / 2 + Hash(col, 2) % (ih / 2 + 1), period = ih + len / 2 + Hash(col, 3) % (ih / 2 + 1);
      int head = (Tick / step + Hash(col, 4)) % period;
      for (int j = 0; j < ih; j++) {
        int d = head - j;
        if (d < 0 || d >= len) continue;
        if (d > 0 && Hash(col * 131 + j, Tick / 6 + col) % 5 == 0) continue;   // a gap between glyphs
        Color g = d == 0 ? RAINHEAD : Mix(RAIN, RAINDK, (double)d / len);
        if (d > 0 && Hash(col + j * 17, Tick / 4) % 7 == 0) g = Mix(g, RAINHEAD, 0.5);   // a glyph changing
        Fx(ix + col * pitch, iy + j, g);
      }
    }
    // the keyboard half, seen edge on: a thin slab under the screen, a little wider toward her
    int by = y0 + h;
    for (int i = -R; i < w; i++) { Fx(x0 + i, by, LAPTOP); for (int j = 1; j < Math.Max(1, R / 2) + 1; j++) Fx(x0 + i, by + j, LAPBASE); }
    EndLayer();
  }
  static int Hash(int a, int b) {
    unchecked {
      int h = a * 374761393 + b * 668265263;
      h = (h ^ (h >> 13)) * 1274126177;
      return (h ^ (h >> 16)) & 0x7fffffff;
    }
  }

  // The little light most looks have: fast while typing, quick while thinking, slow while talking, a rare blink otherwise.
  public bool Lit() { return Typing ? (Tick / 2) % 2 == 0 : Thinking ? (Tick / 4) % 2 == 0 : BubbleUp ? (Tick / 8) % 2 == 0 : (Tick / 45) % 4 == 0; }
}
