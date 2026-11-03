// Her face as an icon: the look's standing frame, outlined, cropped to head and shoulders on a dark rounded
// tile, at every size Windows asks for, saved as one .ico. The Stead shortcuts (taskbar pin, Start, Desktop)
// point at that file, so whoever they made her to be is what's on their taskbar. Redrawn when the look or
// color changes; a .key file beside it says which look it was drawn for, so nothing is redrawn needlessly.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class Face {
  [DllImport("shell32.dll")] static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);

  public static void Save(string model, Color tint, string ico) {
    var c = Character.Make(model);
    if (c == null) return;
    int R = Character.ResOf(c);
    // How big a square of her makes her face: most of the frame wide, unless the look says otherwise
    // (a FaceCrop property, in its fine pixels, found by name so a look needn't build against this Stead:
    // a tall look's head is a small part of that square). A look's own crop is part of the key.
    int side = 27 * R / 2, own = 0;
    try {
      var fc = c.GetType().GetProperty("FaceCrop", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
      if (fc != null && fc.PropertyType == typeof(int)) own = (int)fc.GetValue(c, null);
    } catch { }
    if (own >= 8 && own <= Character.GW * R) side = own; else own = 0;
    string key = model + "|" + (tint.IsEmpty ? "" : (tint.ToArgb() & 0xFFFFFF).ToString("x6")) + (own > 0 ? "|" + own : "");
    string keyPath = ico + ".key";
    try { if (File.Exists(ico) && File.ReadAllText(keyPath) == key) return; } catch { }
    var frame = new Bitmap(Character.GW * R, Character.GH * R);
    using (var g = Graphics.FromImage(frame)) g.Clear(Character.KEY);
    c.Frame = frame; c.Move = "stand"; c.Facing = 1; c.Mood = ""; c.Tick = 5; c.StTicks = 5; c.Variant = 0; c.Tint = tint;
    c.Render();
    int W = frame.Width, H = frame.Height, keyc = Character.KEY.ToArgb();
    var her = new bool[W, H];
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) her[x, y] = frame.GetPixel(x, y).ToArgb() != keyc;
    // The outline: a see-through pixel beside her becomes ink, as on screen.
    var ink = new bool[W, H];
    int minX = W, maxX = 0, minY = H;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      if (!her[x, y]) ink[x, y] = (x > 0 && her[x - 1, y]) || (x < W - 1 && her[x + 1, y]) || (y > 0 && her[x, y - 1]) || (y < H - 1 && her[x, y + 1]);
      if (her[x, y] || ink[x, y]) { minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); }
    }
    if (minY == H) return;
    // Head and shoulders: a square most of the frame wide, from the top of her down; she runs off the bottom.
    int cx = (minX + maxX + 1) / 2, left = cx - side / 2, top = minY - 1;
    var pngs = new List<byte[]>();
    var sizes = new[] { 16, 24, 32, 48, 64, 256 };
    foreach (int S in sizes) {
      using (var bmp = new Bitmap(S, S, PixelFormat.Format32bppArgb))
      using (var g = Graphics.FromImage(bmp))
      using (var path = new GraphicsPath()) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        float r = S * 0.22f;
        path.AddArc(0, 0, 2 * r, 2 * r, 180, 90); path.AddArc(S - 2 * r - 1, 0, 2 * r, 2 * r, 270, 90);
        path.AddArc(S - 2 * r - 1, S - 2 * r - 1, 2 * r, 2 * r, 0, 90); path.AddArc(0, S - 2 * r - 1, 2 * r, 2 * r, 90, 90); path.CloseFigure();
        using (var bg = new LinearGradientBrush(new Point(0, 0), new Point(0, S), Color.FromArgb(30, 30, 34), Color.FromArgb(10, 10, 12))) g.FillPath(bg, path);
        g.SetClip(path);
        g.SmoothingMode = SmoothingMode.None;
        float px = S * 0.92f / side, ox = (S - side * px) / 2, oy = S * 0.10f;
        for (int y = Math.Max(0, top); y < H; y++) for (int x = Math.Max(0, left); x < Math.Min(W, left + side); x++) {
          if (!her[x, y] && !ink[x, y]) continue;
          using (var b = new SolidBrush(her[x, y] ? frame.GetPixel(x, y) : Character.INK))
            g.FillRectangle(b, ox + (x - left) * px, oy + (y - top) * px, (float)Math.Ceiling(px), (float)Math.Ceiling(px));
        }
        using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); pngs.Add(ms.ToArray()); }
      }
    }
    // An .ico of PNGs: a header, one entry per size, then the images.
    var tmp = ico + ".tmp";
    using (var w = new BinaryWriter(File.Create(tmp))) {
      w.Write((short)0); w.Write((short)1); w.Write((short)pngs.Count);
      int off = 6 + 16 * pngs.Count;
      for (int i = 0; i < pngs.Count; i++) {
        w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i])); w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
        w.Write((byte)0); w.Write((byte)0); w.Write((short)1); w.Write((short)32);
        w.Write(pngs[i].Length); w.Write(off); off += pngs[i].Length;
      }
      foreach (var p in pngs) w.Write(p);
    }
    File.Copy(tmp, ico, true); File.Delete(tmp);
    File.WriteAllText(keyPath, key);
    SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);   // SHCNE_ASSOCCHANGED: Explorer redraws the icons
  }
}
