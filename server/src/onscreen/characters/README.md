# Looks

Each folder here is a look Stead on screen can have. A look made on someone's computer (when they
ask her for a new one) lives in `~/.stead/onscreen/characters/<name>/` instead, and one with the
same name as a folder here replaces it.

## The rules

- The folder name is the look's name: lowercase letters and digits, starting with a letter (`girl`, `cat2`).
- The class is the folder name with a capital first letter: `girl` → `Girl`, `cat2` → `Cat2`.
- `<name>.cs` declares it and holds what every move shares:
  `public partial class Girl : Character { ... }`
- Every move is its own file named after it, holding one method with the same name, no
  parameters, returning void: `stand.cs` → `void stand() { ... }` inside `public partial class Girl { }`.
- C# 5 (the compiler built into Windows): no `$"..."` strings, no `?.`, no `=>` method bodies on
  properties with setters. `using System; using System.Drawing;` at the top of each file.
- Only `stand` is required. A move a look doesn't have falls back (run/creep → walk, pull/climb/ceiling → hang,
  thrown → fall, trip/press/kindle → crouch, sprawl/dangle/hug → sit, camp → hug, grab/throw → wave, yawn → stretch, everything else → stand), but a look made for someone should have
  every move, each one drawn for that look.

## The moves

| move | when | what to draw |
|---|---|---|
| stand | idle | standing; breathe or blink with `Tick` |
| walk | walking along a window or the taskbar | a 4-step stride (`Tick / 4 % 4`) |
| run | going somewhere fast | a longer, quicker stride, leaning forward |
| jump | going up (`Vy < 0`) | legs tucked, arms up |
| fall | coming down, or thrown | arms out, `Vy` says how fast |
| crouch | about to jump, landing | squashed down a row or two |
| sit | resting on a ledge | sitting, legs over the edge |
| sleep | idle a long time (`Asleep`) | lying or curled up (z's are drawn for you at `ZzzY`) |
| hang | hanging off the side of a window, by her hands (`Swing` -2..2 = how far she has swung) | hands on the edge, body below; shift the body and more the legs by `Swing` (never rotate) |
| climb | pulling up onto a window | arms up, body lifting |
| drag | being dragged with the mouse (`Lean` = how hard) | dangling, swinging the other way |
| pull | hauling the chat window up from the bottom | arms up, straining, leaning back |
| wave | saying hi | the front hand up, waving |
| stretch | a little stretch | arms up high, on tiptoe |
| dance | a happy dance | bounce and swap arms on a beat |
| look | looking around | head turning, `LookX` / `LookUp` say where the mouse is |
| type | typing for them (drawn on top of whatever move she's in) | hands moving fast, low in front |
| peep | peeking up over the bottom of the screen | only the top of her shows: eyes and hands at the edge |
| thrown | flung with the mouse | spread-eagle, tumbling: swap limbs every few frames |
| trip | a hard landing, or tripping while walking (`StTicks` < 14) | tipping over, then flat on the floor |
| sprawl | getting over it, after `trip` | sat on the floor, legs out, dazed |
| dangle | sitting right on an edge | legs hanging over it (set `Below` = rows below the edge), kicking |
| hug | sitting | knees up, arms round them |
| ceiling | going hand over hand along the top of the screen (moves while `StTicks % 20 >= 14`) | hands up, a hand swinging forward |
| creep | sneaking instead of walking | low, slow, on tiptoe |
| yawn | before falling asleep, or just because | an arm up, eyes shut, mouth open |
| press | opening an app: standing beside its taskbar button, leaning over and pressing it (it's pressed at `StTicks` 12) | front hand reaching down to her feet, ahead of her |
| kindle | the first second and a half of a campfire: getting it lit | kneeling, both hands low out front, rubbing |
| camp | sitting by her campfire (the engine draws the fire beside her) | sitting, hands out to the warmth |
| grab | she's stolen the mouse pointer and is waving it about (it sits at her raised front hand: 6 columns ahead, row 2) | front hand high |
| throw | flinging the pointer: winding up for 10 ticks, then the throw | arm back behind her head, then out in front |

## Drawing

The grid is 16 wide by 24 tall, `(0,0)` top left, feet on row 23 (override `Res` to 2 for a 32x48 frame: `Px` then fills 2x2 blocks, `Fx` draws single fine pixels, and `Layer()`/`EndLayer()` give whatever is drawn between them its own dark edge). Always draw facing right; the
engine mirrors it when she faces left, adds the dark outline (`Outline`), and tints it (`Tint`).

- `Px(x, y, color)`: one pixel. `Rect(x, y, w, h, color)`, `Line(x0, y0, x1, y1, color)`.
- `Mix(a, b, t)` blends two colors (t from 0 to 1). `Lit()` is true on the frames a light on her should be on (fast while typing or thinking, slow otherwise).
- Colors: `INK` (near black), `PAPER` (near white), `SHADE` (gray), `GLOW` (cyan), or your own
  `Color.FromArgb(r, g, b)`. Leave a pixel alone and it stays see-through.
- What's going on: `Tick` (30 a second), `StTicks` (frames in this move), `Vy`, `Lean`, `Swing`, `Variant` (0-3, picked fresh each time a move starts: draw a different take on it),
  `Held` (dragged: frames held still), `LookX`,
  `LookUp`, `Asleep`, `Thinking`, `Talking`, `BubbleUp`, `Hover` (the mouse is on her),
  `Blinking`, `Typing`, `Writing` (typing into a blank: put a pencil in her hand), `Busy`, `Perching`, `Coding` (working on code: see below), `Mood` (see Moods).
- A look can override `Outline`, `Calm` (true: she drifts quietly and does no tricks on her own), `Stays` (true: put down, it stays exactly there, no falling or wandering, till moved again or reset; the orb),
  `ZzzY` (row for the sleep z's, -1 for none), `Edge` (the glow color when she teleports), and
  `Draw()` (to draw shared parts around every move; the girl does this: her moves only set pose
  fields and `girl.cs` draws the body from them).

- Coding: while she works on code (`Coding`), she types. Give the look a `Rectangle laptop()` (where
  the screen goes, in grid cells facing right, below her chin) and a laptop raining green code is drawn
  in front of her for you; without one there's no laptop, so a small look's face never disappears
  behind it. Give it a `void glasses()` to put glasses on her: it's called after `Draw()`, so draw them
  over the eyes wherever this frame's pose put them. Both are found by name like the moves, not
  overridden, so a look that has them still builds on an older Stead. `Glaze(fx, fy, color, t)` tints
  what's already there (a lens) instead of covering it.

`girl` is the full example: copy how it's split up.

## Moods

`Mood` is how she feels right now, from what she's saying: one of happy, excited, love, laughing,
proud, smug, relieved, calm, curious, thinking, confused, surprised, shocked, scared, worried,
nervous, embarrassed, shy, sad, crying, angry, annoyed, disgusted, bored, sleepy, determined,
mischievous, sympathetic, idea; `""` when neutral. The engine already draws a small mark over the
head for every look (a heart, `!`, `?`, a sweat drop, an anger vein, sparkles, gloom lines, a
lightbulb...) at `MoodY` (defaults to `ZzzY`; return -1 for none). A look with a face should also
show the mood on it:

- Eyes: `^ ^` happy, `> <` laughing or embarrassed, round and dark when shocked, a tiny pupil in
  white when surprised, half-lidded for bored, smug, annoyed; hearts for love; looking away for shy.
- Brows (in the hair color, on the row above the eyes): inner ends low for angry or determined,
  outer ends low for worried, sad, sympathetic; one brow for curious or confused.
- Mouth: open for excited and laughing, `o` for surprised, a frown for sad, a wavy line for
  nervous, a smirk for smug, gritted for angry.
- Cheeks: blush for happy, love, shy, embarrassed; tears for crying.
- While `Talking`, alternate the mood's mouth with an open one so she still talks.
- `Mouth`: with her voice on, the shape of the sound she's making right now: `0` closed, `1` small,
  `2` open (aa), `3` round (o, w), `4` wide (s, ee, f). It is `-1` whenever she isn't speaking out
  loud: then draw the usual `Talking` flap, so a look without voice support still works. A look with
  a mouth draws the five shapes; one without (the orb) can pulse its glow instead.
- Moves win: if the move sets its own face (falling, dizzy, asleep), draw that instead.

## Bodies that look human

Anything with a human body follows real proportions, or it looks wrong in a way people feel before
they can say why (arms too long reads as creepy). Segment lengths as a fraction of standing height
H, from Drillis & Contini (1966), as given in Winter, *Biomechanics and Motor Control of Human
Movement*:

| landmark (height above the soles) | ×H | segment | ×H |
|---|---|---|---|
| chin | 0.870 | upper arm (shoulder to elbow) | 0.186 |
| shoulder | 0.818 | forearm (elbow to wrist) | 0.146 |
| elbow | 0.630 | hand | 0.108 |
| hip joint | 0.530 | thigh (hip to knee) | 0.245 |
| wrist | 0.485 | shin (knee to ankle) | 0.246 |
| knee | 0.285 | foot length | 0.152 |
| ankle | 0.039 | shoulder width / hip width | 0.259 / 0.191 |

- A cute look has a big head, so measure the body from the chin down: take the chin's height
  above the soles and scale every landmark below it by (chin height) / 0.87. The head can be any size;
  the body under it keeps human ratios.
- Checks that catch most mistakes: hanging straight down, the elbow sits at the waist, the wrist at
  the crotch, and the fingertips at mid-thigh. The knee is halfway from hip to floor. The legs are
  about half the body.
- Limbs bend. Elbows and knees are joints: draw each limb as two segments, never one straight stick.
- A walk is 8 frames, not 4: contact, down, passing, up, for each leg. The stance foot slides back
  exactly as far per frame as she moves forward, so it stays planted instead of skating. Arms swing
  opposite the legs, and the body bobs down a pixel on contact. Running leans forward, bends the arms
  more, and has frames with both feet off the ground.
