// Why she does what she does. Every move she makes on her own is the visible end of a reason: what the
// person is up to, what the AI is up to, the time, how long since anyone touched her. The engine (Stead.cs)
// fills in Signals from what it can see, asks Next for a move, tries it, and emits the reason ("why") so
// the daemon can log it. Nothing here touches the screen: it's a plain class, run offscreen by a test
// harness over tables of situations.
//
// The situations, checked top to bottom (the first that applies decides):
//
//   situation                                   drive        what she does (first that's off cooldown and possible)
//   ------------------------------------------- ------------ ---------------------------------------------------------
//   walking turned off                          -            stand
//   full screen / game / call / Focus           quiet        stand, minimal motion
//   her bubble or menu is up                    attention    stand facing them
//   the AI is asking them something             social       wave at them (turned toward them)
//   the AI's last step failed (once)            dismay       trip (a stumble), then back to the job
//   the AI is at work / coding                  duty         stand and watch the target (director drives the rest)
//   the AI just finished a real job well (once) joy          jump, or a short dance for a long job
//   they just came back (she woke up)           social       wave hello (after the waking stretch)
//   just put down / thrown and landed           orientation  look around
//   a look that stays put (the orb), placed     -            stand right there (sleep when tired); nothing that moves it
//   a "calm" look                               -            drift a few steps, stand
//   idle long, or late at night                 tiredness    stretch -> yawn -> (evening, at home: campfire) -> sit -> sleep
//   person active (input < 10s)                 calm         away from home and untouched: go home; else stand / sit /
//                                                             glance at what they're doing. Never dance, trip, grab,
//                                                             chase, camp, climb.
//   idle 10-60s                                 curiosity    look at what they were on, wander a little toward it, peep
//   idle 60s up to tired                        boredom      explore: climb, hang off a window edge, ceiling swing, hop
//                                                             onto a window, a little dance, play with the mouse (only
//                                                             when nothing important is on screen), walk about
//   a window just opened                        curiosity    peep over it, only if they've paused 10s+ or the AI is working
//
// Late = 23:00-06:00 (tired after 60s idle), otherwise tired after 5 minutes idle. Evening = 19:00 on.
// Every move has a cooldown (COOL) so nothing spams, and a move she just did is never picked twice
// running unless it's a resting one (stand, sit, sleep).
using System;
using System.Collections.Generic;

public struct Signals {
  public double IdleSec;          // since the person last touched the keyboard or mouse
  public bool Quiet;              // full screen, a game, a call, Focus: keep still
  public bool Talking;            // her bubble or menu is up
  public bool Asking;             // the AI is waiting on their answer
  public bool Working;            // the AI has a job on (the director is driving her)
  public bool Coding;             // at her laptop
  public string Outcome;          // the AI's last job, not yet reacted to: "ok", "error", or null
  public int Steps;               // how many steps that job took
  public bool JustWoke;           // she was asleep and they came back
  public bool JustLanded;         // they put her down or threw her, and she's back on her feet
  public bool Roam, Calm;
  public bool Placed;             // a look that stays put (the orb) and they've put it somewhere: it doesn't move on its own
  public int Hour;                // 0-23, local
  public bool AtHome, OnWindow;
  public double UntouchedSec;     // since they last clicked or carried her
  public bool FieldFocused;       // a text box has the keyboard: something they care about is on screen
  public double RestSec;          // how long she's been standing or sitting where she is
  public string Last;             // the move she chose last time
}

public struct Choice {
  public string Move, Reason; public int Ticks;
  public Choice(string m, string r, int t) { Move = m; Reason = r; Ticks = t; }
  public override string ToString() { return Move + " (" + Reason + ")"; }
}

public class Motive {
  // Seconds before a move can come round again. Resting moves have none.
  public static readonly Dictionary<string, double> COOL = new Dictionary<string, double> {
    { "stand", 0 }, { "sit", 0 }, { "sleep", 0 }, { "home", 20 }, { "look", 15 }, { "glance", 25 }, { "wander", 20 },
    { "wave", 30 }, { "greet", 60 }, { "jump", 20 }, { "dance", 180 }, { "trip", 20 }, { "stretch", 60 }, { "yawn", 60 },
    { "peep", 240 }, { "climb", 90 }, { "hang", 120 }, { "ceiling", 300 }, { "hop", 45 }, { "grab", 900 }, { "camp", 900 },
    { "walk", 40 }, { "creep", 60 }, { "turn", 4 }, { "shy", 30 }, { "peek", 120 } };
  static readonly HashSet<string> RESTING = new HashSet<string> { "stand", "sit", "sleep" };

  public double Now;              // seconds, the caller's clock
  readonly Dictionary<string, double> used = new Dictionary<string, double>();
  readonly Random rnd;
  public string Last = "";
  public Motive(int seed) { rnd = new Random(seed); }
  public Motive() { rnd = new Random(); }

  public bool Ready(string m) {
    double t, c;
    if (!used.TryGetValue(m, out t)) return true;
    if (!COOL.TryGetValue(m, out c)) c = 30;
    return Now - t >= c;
  }
  public void Used(string m) { used[m] = Now; Last = m; }
  public void Stamp(string m) { used[m] = Now; }   // a reaction on the spot: starts its cooldown, isn't "the last move"

  // A window just opened: peek over it only when it can't get in their way: they've paused (10s+), or
  // the AI is the one at work. Never while they're typing or clicking, never when they want quiet.
  public static bool PeekOk(Signals s) { return !s.Quiet && !s.Talking && (s.Working || s.IdleSec >= 10); }

  public static bool Late(int hour) { return hour >= 23 || hour < 6; }
  public static double TiredAfter(int hour) { return Late(hour) ? 60 : 300; }

  // The moves that would make sense right now, best first, each with its reason. Pure but for the
  // shuffle among equally good ideas when she's bored.
  public List<Choice> Options(Signals s) {
    var o = new List<Choice>();
    if (!s.Roam) { o.Add(new Choice("stand", "told to stay put", 150)); return o; }
    if (s.Quiet) { o.Add(new Choice("stand", "they're in full screen, a call or Focus: keeping still", 300)); return o; }
    if (s.Talking) { o.Add(new Choice("stand", "they're talking to me", 30)); return o; }
    if (s.Asking) { o.Add(new Choice("wave", "the AI is asking them something: getting their attention", 45)); o.Add(new Choice("stand", "waiting on their answer", 60)); return o; }
    if (s.Outcome == "error") { o.Add(new Choice("trip", "that step failed", 30)); o.Add(new Choice("stand", "that step failed; back to it", 40)); return o; }
    if (s.Working || s.Coding) { o.Add(new Choice("stand", s.Coding ? "at my laptop till the code's done" : "the AI is at work: watching the job", 60)); return o; }
    if (s.Outcome == "ok") {
      if (s.Steps >= 6) o.Add(new Choice("dance", "a long job just finished well", 64));
      o.Add(new Choice("jump", "the job just finished well", 30));
      o.Add(new Choice("wave", "the job just finished well", 45));
      return o;
    }
    if (s.JustWoke) { o.Add(new Choice("greet", "they're back: hello!", 45)); o.Add(new Choice("stand", "they're back", 60)); return o; }
    if (s.JustLanded) { o.Add(new Choice("look", "just put down somewhere new: looking around", 70)); o.Add(new Choice("stand", "getting my bearings", 40)); return o; }
    if (s.Placed) {
      // They put it here, so here it stays: resting in place, nothing that walks, hops or drifts it away.
      if (s.IdleSec >= TiredAfter(s.Hour)) o.Add(new Choice("sleep", "nobody about: dozing right where they put me", 300));
      o.Add(new Choice("stand", "they put me here: staying exactly where they left me", 180));
      return o;
    }
    if (s.Calm) {
      if (s.IdleSec >= 10 && s.RestSec > 8) o.Add(new Choice("wander", "a calm look drifts a little", 60));
      o.Add(new Choice("stand", "a calm look, resting", 180));
      return o;
    }

    // ---- what the person is up to ----
    double tired = TiredAfter(s.Hour);
    bool evening = s.Hour >= 19 || Late(s.Hour);
    if (s.IdleSec >= tired) {
      string why = Late(s.Hour) ? "it's late and they've stepped away: winding down" : "they've been away a long while: getting sleepy";
      string last = s.Last ?? Last ?? "";
      if (last == "sleep") { o.Add(new Choice("sleep", why, 300)); return o; }
      if (last == "sit" || last == "camp") { o.Add(new Choice("sleep", why, 300)); return o; }
      if (last == "yawn") {
        if (evening && s.AtHome) o.Add(new Choice("camp", "evening, at home, nobody about: a little fire", 900));
        o.Add(new Choice("sit", why, 200));
        return o;
      }
      if (last == "stretch") { o.Add(new Choice("yawn", why, 45)); o.Add(new Choice("sit", why, 200)); return o; }
      o.Add(new Choice("stretch", why, 50)); o.Add(new Choice("yawn", why, 45)); o.Add(new Choice("sit", why, 200));
      return o;
    }
    if (s.IdleSec < 10) {
      // They're working: calm, unobtrusive, near home.
      if (!s.AtHome && s.UntouchedSec > 30) o.Add(new Choice("home", "they're working: back to my corner, out of the way", 0));
      if (s.RestSec > 25) o.Add(new Choice("sit", "they're working: settling in", 240));
      if (s.RestSec > 6) o.Add(new Choice("glance", "they're working: glancing at what they're doing", 40));
      o.Add(new Choice("stand", "they're working: staying out of the way", 120 + rnd.Next(120)));
      return o;
    }
    if (s.IdleSec < 60) {
      // They paused: what were they looking at?
      o.Add(new Choice("look", "they paused: what's on their screen?", 70));
      o.Add(new Choice("wander", "they paused: reading over their shoulder", 0));
      if (s.UntouchedSec > 240) o.Add(new Choice("peep", "nobody's touched me in a while: peeking up to see what's going on", 0));
      o.Add(new Choice("stand", "they paused: waiting", 90));
      return o;
    }
    // Idle a minute or more, not yet tired: bored, so she explores and plays.
    var play = new List<Choice> {
      new Choice("climb", "bored: climbing a window", 200),
      new Choice("hang", "bored: hanging off a window edge", 0),
      new Choice("ceiling", "bored: swinging along the top of the screen", 0),
      new Choice("hop", "bored: hopping onto a window", 0),
      new Choice("dance", "bored, nobody watching: a little dance", 96),
      new Choice("walk", "bored: walking about", 0),
      new Choice("creep", "bored: sneaking about", 90),
    };
    if (!s.FieldFocused && !s.OnWindow) play.Add(new Choice("grab", "bored, nothing important on screen: playing with the mouse", 0));
    if (evening && s.AtHome) play.Add(new Choice("camp", "evening, at home: a little fire", 900));
    for (int i = play.Count - 1; i > 0; i--) { int j = rnd.Next(i + 1); var t = play[i]; play[i] = play[j]; play[j] = t; }
    o.AddRange(play);
    o.Add(new Choice("stand", "bored, but nothing to do here", 90));
    return o;
  }

  // The first option that's off cooldown, not a repeat of the last move (unless resting), and that the
  // engine can actually do here (can: tries it, true if it happened). Always returns something.
  public Choice Next(Signals s, Func<Choice, bool> can) {
    foreach (var c in Options(s)) {
      if (!Ready(c.Move)) continue;
      if (c.Move == Last && !RESTING.Contains(c.Move) && c.Move != "greet") continue;
      if (can != null && !can(c)) continue;
      Used(c.Move);
      return c;
    }
    var d = new Choice("stand", "nothing calls for anything", 90);
    if (can != null) can(d);
    Used("stand");
    return d;
  }
}

// Where a look that stays put (the orb) lives once they've put it down: exactly that point, kept across
// restarts (pos.json), until they move it again or reset it (menu, `stead onscreen reset`). Pure, so the
// motive harness checks it.
public static class Spot {
  // A point clamped onto a work area (l, t, r, b): mx in from each side, at least top below its top edge
  // (her body hangs up from the point), and never under its bottom (the taskbar).
  public static double[] Clamp(double x, double y, double l, double t, double r, double b, double mx, double top) {
    double cx = r - l < 2 * mx ? (l + r) / 2 : Math.Max(l + mx, Math.Min(r - mx, x));
    double cy = b - t < top ? b : Math.Max(t + top, Math.Min(b, y));
    return new[] { cx, cy };
  }
  // Is she at her spot (within a pixel and a half)?
  public static bool At(double x, double y, double px, double py) { return Math.Abs(x - px) <= 1.5 && Math.Abs(y - py) <= 1.5; }
  // Pop back to the spot now? Only when it's placed, she's away from it, and nothing has her: no job
  // the AI is doing for them, no click she's heading to, not being carried, not hauling the chat up.
  public static bool GoBack(bool placed, bool atSpot, bool onJob, bool held) { return placed && !atSpot && !onJob && !held; }
}
