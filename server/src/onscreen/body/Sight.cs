// What's behind her: how much text and how many buttons sit in each strip of the screen. Edges are what
// text, icons and controls are made of, so a column's "busyness" is the share of its pixels that sit on
// a sharp light/dark edge. A blank page, a photo's smooth sky or an empty title bar scores near zero.
// She is excluded from screen capture (Native.HideFromCapture), so she never sees herself.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

static class Sight {
  public const int Col = 8;   // screen pixels per column

  // The busyness of each Col-wide column of r, 0 (clear) to about 0.5 (dense text).
  public static double[] Columns(Rectangle r) {
    r = Rectangle.Intersect(r, System.Windows.Forms.SystemInformation.VirtualScreen);
    int n = r.Width / Col;
    var res = new double[Math.Max(0, n)];
    if (n <= 0 || r.Height < 4) return res;
    using (var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppRgb)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Location, Point.Empty, r.Size);
      var d = bmp.LockBits(new Rectangle(0, 0, r.Width, r.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      var px = new byte[d.Stride * r.Height];
      Marshal.Copy(d.Scan0, px, 0, px.Length);
      bmp.UnlockBits(d);
      int st = d.Stride;
      for (int i = 0; i < n; i++) {
        int hits = 0, all = 0;
        for (int y = 0; y + 2 < r.Height; y += 2)
          for (int x = i * Col; x < (i + 1) * Col && x + 1 < r.Width; x++) {
            int o = y * st + x * 4;
            int l = Lum(px, o), lr = Lum(px, o + 4), ld = Lum(px, o + 2 * st);
            if (Math.Abs(l - lr) > 60 || Math.Abs(l - ld) > 60) hits++;
            all++;
          }
        res[i] = all == 0 ? 0 : (double)hits / all;
      }
    }
    return res;
  }

  static int Lum(byte[] p, int o) { return (p[o + 2] * 3 + p[o + 1] * 6 + p[o]) / 10; }

  // The mean busyness of the columns covering [x0, x1) (screen x), given the strip's left edge.
  public static double Over(double[] cols, int left, double x0, double x1) {
    int a = Math.Max(0, (int)((x0 - left) / Col)), b = Math.Min(cols.Length, (int)Math.Ceiling((x1 - left) / Col));
    if (b <= a) return 0;
    double s = 0;
    for (int i = a; i < b; i++) s += cols[i];
    return s / (b - a);
  }
}
