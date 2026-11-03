// Her voice, for Stead (Stead.cs): Windows' own speech (SAPI, System.Speech from the .NET GAC), so
// nothing is downloaded. Off unless they turn it on in the menu. It speaks only a bubble's words (never
// a status line), only while they're free (the brain marks each say with speak; a call or a full-screen
// app stops it here too), and any click, dismiss or new message cuts it off mid-word.
//
// A streamed reply arrives as the same bubble id with more text each time: each finished sentence is
// queued as it lands, and the rest when the brain says the reply is done (voice-flush). The synthesizer
// lives on its own thread; the UI reads Mouth (0-4, -1 not speaking) and RevealFor(id) every frame,
// so the bubble types out in step with what she says and her mouth follows the visemes.
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading;
#if VOICE
using System.Speech.Synthesis;
#endif

class Voice {
  // SAPI's 22 visemes, down to five shapes: 0 closed, 1 small, 2 open, 3 round, 4 wide (teeth).
  static readonly int[] SHAPE = { 0, 2, 2, 3, 1, 3, 4, 3, 3, 2, 3, 2, 1, 3, 1, 4, 4, 4, 4, 1, 1, 0 };
  public static int ShapeOf(int viseme) { return viseme >= 0 && viseme < SHAPE.Length ? SHAPE[viseme] : 0; }

  // What she says out loud: mood tags and markdown become spaces, so every character keeps its place
  // and the speech position still points into the bubble's own text.
  static readonly Regex TAG = new Regex(@"\[[a-zA-Z][a-zA-Z ]{1,15}\]"), MARK = new Regex(@"[*_`#>|~]");
  public static string Spoken(string t) {
    t = TAG.Replace(t ?? "", m => new string(' ', m.Length));
    return MARK.Replace(t, " ");
  }
  // Where the last whole sentence in t ends (after `from`), or -1.
  public static int SentenceEnd(string t, int from) {
    int end = -1;
    for (int i = Math.Max(0, from); i < t.Length; i++) {
      char c = t[i];
      if ((c == '.' || c == '!' || c == '?' || c == (char)0x2026 || c == ':' || c == ';') && (i + 1 == t.Length || char.IsWhiteSpace(t[i + 1]))) end = i + 1;
      else if (c == '\n') end = i + 1;
    }
    return end;
  }

  class Chunk { public string Text; public int At, Gen; }
  readonly object gate = new object(), speakLock = new object();
  int gen, playing = -1;               // gen: bumped on every cut; playing: the gen of the chunk being said (-1 none)
  readonly Queue<Chunk> q = new Queue<Chunk>();
  readonly AutoResetEvent wake = new AutoResetEvent(false), done = new AutoResetEvent(false);
  string id = "", text = "";
  int queued;                          // how much of text is queued to be said
  volatile int reveal = -1;            // how much of text she's said (or is saying now)
  volatile bool speaking;
  public volatile int Mouth = -1;
  public volatile bool Ok = true;             // false: no speech on this computer (she stays a bubble)
#if VOICE
  SpeechSynthesizer syn;
#endif

  public Voice() {
#if VOICE
    var th = new Thread(Run) { IsBackground = true, Name = "voice" };
    th.Start();
#else
    Ok = false;
#endif
  }

  // Ok false (no speech here, or it failed to start): never "speaking", so the bubble types out as usual.
  public bool Speaking { get { return Ok && (speaking || Pending); } }
  bool Pending { get { lock (gate) return q.Count > 0; } }
  // How far the bubble with this id may type itself out: -1 for as far as it likes.
  public int RevealFor(string bubbleId) { lock (gate) return Speaking && bubbleId == id && id.Length > 0 ? Math.Max(0, reveal) : -1; }

  // A bubble's text (all of it so far). final: the reply is complete, say whatever's left.
  public void Say(string msgId, string t, bool final) {
    if (!Ok) return;
    t = t ?? "";
    bool cancel = false;
    lock (gate) {
      // A new bubble, or this one rewritten (a new paragraph replaces it): start over on it.
      if (msgId != id || msgId.Length == 0 || !t.StartsWith(text, StringComparison.Ordinal)) { cancel = Cut(); id = msgId; queued = 0; reveal = 0; }
      text = t;
      int end = final ? t.Length : SentenceEnd(t, queued);
      if (end > queued) {
        string part = Spoken(t.Substring(queued, end - queued));
        if (part.Trim().Length > 0) q.Enqueue(new Chunk { Text = part, At = queued, Gen = gen });
        queued = end;
      }
    }
    if (cancel) CancelSpeech();
    wake.Set();
  }
  public void Flush(string msgId) { string t; lock (gate) { if (msgId != id) return; t = text; } Say(msgId, t, true); }

  // Stop now. Returns what she'd got through, for the brain ("[interrupted after: ...]"), or null if
  // she wasn't speaking.
  public string Stop() {
    bool was, cancel; string said;
    lock (gate) {
      was = Speaking;
      said = was && reveal > 0 ? text.Substring(0, Math.Min(text.Length, reveal)) : null;
      cancel = Cut(); id = ""; text = ""; queued = 0;
    }
    if (cancel) CancelSpeech();
    return was ? (said ?? "") : null;
  }
  // Drops what's queued and makes whatever is being said stale; true if a chunk is mid-speech and must be
  // cancelled. The cancel itself runs outside gate (CancelSpeech), since the synthesizer's progress events
  // take gate. speakLock keeps it from landing on a fresh chunk that started in between.
  bool Cut() { q.Clear(); reveal = -1; Mouth = -1; gen++; return playing >= 0; }
  void CancelSpeech() {
#if VOICE
    lock (speakLock) {
      bool stale; lock (gate) stale = playing >= 0 && playing != gen;
      try { if (stale && syn != null) syn.SpeakAsyncCancelAll(); } catch { }
    }
#endif
  }

#if VOICE
  void Run() {
    try {
      syn = new SpeechSynthesizer();
      syn.SetOutputToDefaultAudioDevice();
      try { syn.SelectVoiceByHints(VoiceGender.Female); } catch { }
      syn.Rate = 1;
      syn.VisemeReached += (s, e) => { Mouth = ShapeOf(e.Viseme); };
      syn.SpeakCompleted += (s, e) => { done.Set(); };
    } catch { lock (gate) { Ok = false; q.Clear(); reveal = -1; } Mouth = -1; return; }
    while (true) {
      Chunk c = null; EventHandler<SpeakProgressEventArgs> prog = null;
      lock (speakLock) {
        lock (gate) if (q.Count > 0) { c = q.Dequeue(); playing = c.Gen; }
        if (c != null) {
          var cc = c;
          speaking = true; Mouth = 0;
          done.Reset();
          prog = (s, e) => { lock (gate) if (cc.Gen == gen && reveal >= 0) reveal = Math.Max(reveal, cc.At + e.CharacterPosition + e.CharacterCount); };
          syn.SpeakProgress += prog;
          try { syn.SpeakAsync(c.Text); } catch { done.Set(); }
        }
      }
      if (c == null) { speaking = false; Mouth = -1; wake.WaitOne(); continue; }
      done.WaitOne(60000);
      syn.SpeakProgress -= prog;
      lock (gate) { if (c.Gen == gen && reveal >= 0) reveal = Math.Max(reveal, c.At + c.Text.Length); playing = -1; }
      Mouth = 0;
    }
  }
#endif
}
