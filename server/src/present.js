// "Tell me about the project": a slide deck instead of a wall of text. Claude gathers the facts and
// hands over a title and 5-9 slides; this writes one self-contained HTML file (no fonts, scripts or
// images from the internet: a picture is read from disk and embedded) to presentations/ in Stead's
// folder, and opens it in their everyday browser. Arrows or a click to move on. The colors are theirs:
// what they asked for, else what they told the brain they like, else black and white and dark.
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, BRAIN_DIR } from './paths.js';
import { openInBrowser } from './panel.js';

export const PRESENT_DIR = path.join(HOME_DIR, 'presentations');
const MAX_SLIDES = 30;
const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// Everything they or a page wrote goes through here before it reaches the HTML.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function slugOf(title) {
  const s = String(title || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60).replace(/-+$/, '');
  return s || 'presentation';
}

// A picture on disk, embedded so the deck works offline and can be sent as one file. A web address
// or anything else is left out: the deck never reaches the network.
function imageData(p) {
  const f = String(p || '').trim();
  if (!f || /^[a-z][a-z0-9+.-]*:/i.test(f) && !/^[a-z]:[\\/]/i.test(f)) return null;
  const type = IMAGE_TYPES[path.extname(f).toLowerCase()];
  if (!type) return null;
  try {
    const st = fs.statSync(f);
    if (!st.isFile() || st.size > MAX_IMAGE) return null;
    return `data:${type};base64,${fs.readFileSync(f).toString('base64')}`;
  } catch { return null; }
}

// ---------- colors ----------
// A theme is three colors: background, text, accent (the progress bar, the rules, the bullets, the
// kickers). The rest (muted text, lines, code boxes) is mixed from those, so any three work.
export const PRESETS = {
  mono: { background: '#0a0a0a', text: '#f2f2f2', accent: '#f2f2f2' },
  paper: { background: '#faf8f3', text: '#1b1b1b', accent: '#b4441c' },
  midnight: { background: '#0b1020', text: '#e8ecf5', accent: '#7aa2ff' },
  forest: { background: '#0f1a14', text: '#e9f1ea', accent: '#7cc49a' },
  sunset: { background: '#1c1016', text: '#fbeee6', accent: '#ff8a5c' },
  ocean: { background: '#06202a', text: '#e6f6fa', accent: '#3cc7d6' },
  rose: { background: '#fff5f6', text: '#2a1418', accent: '#d6336c' },
};
// The default's in-between shades, kept exactly as they were.
const MONO_MIX = { dim: '#8a8a8a', line: '#262626', card: '#141414' };
// The color names a deck takes, with their CSS values (for the contrast check).
const NAMED_HEX = {
  black: '000000', white: 'ffffff', gray: '808080', grey: '808080', silver: 'c0c0c0', red: 'ff0000', maroon: '800000', crimson: 'dc143c',
  tomato: 'ff6347', coral: 'ff7f50', salmon: 'fa8072', orange: 'ffa500', gold: 'ffd700', yellow: 'ffff00', khaki: 'f0e68c', olive: '808000',
  lime: '00ff00', green: '008000', forestgreen: '228b22', seagreen: '2e8b57', teal: '008080', turquoise: '40e0d0', aqua: '00ffff', cyan: '00ffff',
  navy: '000080', blue: '0000ff', royalblue: '4169e1', steelblue: '4682b4', skyblue: '87ceeb', indigo: '4b0082', purple: '800080', violet: 'ee82ee',
  plum: 'dda0dd', orchid: 'da70d6', magenta: 'ff00ff', fuchsia: 'ff00ff', pink: 'ffc0cb', hotpink: 'ff69b4', brown: 'a52a2a', chocolate: 'd2691e',
  tan: 'd2b48c', beige: 'f5f5dc', ivory: 'fffff0', linen: 'faf0e6', lavender: 'e6e6fa', mintcream: 'f5fffa', whitesmoke: 'f5f5f5', gainsboro: 'dcdcdc',
  slategray: '708090', darkslategray: '2f4f4f', midnightblue: '191970', darkblue: '00008b', darkgreen: '006400', darkred: '8b0000', goldenrod: 'daa520',
};
const NAMED = new Set(Object.keys(NAMED_HEX));
const RGB = /^rgba?\(\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*(?:,\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/;
// A color, or null: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba() of plain numbers, or a common color name.
// Nothing else ever reaches the CSS, so a "color" can't close the rule and add its own.
export function safeColor(v) {
  const c = String(v ?? '').trim().toLowerCase();
  if (!c || c.length > 40) return null;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(c)) return c;
  if (RGB.test(c)) return c.replace(/\s+/g, '');
  if (NAMED.has(c)) return c;
  return null;
}
const COLOR_WORDS = /#[0-9a-f]{3,8}\b|rgba?\([^)]{0,40}\)|[a-z]+/gi;

// What they told the brain about deck colors ("Deck colors: midnight", "Presentation colors: #111,
// #eee, gold", "Favorite color: teal"). The newest line wins. {} when there's nothing.
export function savedTheme(dir = BRAIN_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).map((f) => path.join(dir, f)); } catch { return {}; }
  let deck = null, fav = null;
  for (const f of files) {
    let t = '';
    try { if (fs.statSync(f).size > 512 * 1024) continue; t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of t.split('\n')) {
      const d = line.match(/\b(?:deck|slides?|presentations?)\s*(?:colou?rs?|theme)\s*[:=-]\s*(.+)/i);
      if (d) deck = d[1];
      const v = line.match(/\bfavou?rite\s+colou?rs?\s*[:=-]\s*(.+)/i);
      if (v) fav = v[1];
    }
  }
  const words = (s) => s.match(COLOR_WORDS) || [];
  if (deck) {
    const preset = words(deck).map((w) => w.toLowerCase()).find((w) => PRESETS[w]);
    if (preset) return { preset };
    const cs = words(deck).map(safeColor).filter(Boolean);
    if (cs.length >= 2) return { background: cs[0], text: cs[1], ...(cs[2] ? { accent: cs[2] } : {}) };
    if (cs.length === 1) return { accent: cs[0] };
  }
  if (fav) { const c = words(fav).map(safeColor).find(Boolean); if (c) return { accent: c }; }
  return {};
}

// The colors a deck gets: what was asked for (a preset and/or colors), else what they saved, else
// mono. Something that isn't a color is dropped (and named in rejected), never passed through.
export function resolveTheme(theme, { brainDir = BRAIN_DIR } = {}) {
  let t = typeof theme === 'string' ? { preset: theme } : theme && typeof theme === 'object' ? { ...theme } : {};
  const rejected = [];
  let source = 'asked';
  if (!['preset', 'background', 'text', 'accent'].some((k) => t[k])) { t = savedTheme(brainDir); source = Object.keys(t).length ? 'saved' : 'default'; }
  const name = String(t.preset || '').trim().toLowerCase();
  if (name && !PRESETS[name]) rejected.push(`preset "${String(t.preset).slice(0, 40)}"`);
  const out = { ...(PRESETS[name] || PRESETS.mono) };
  const ok = {};
  for (const k of ['background', 'text', 'accent']) {
    if (t[k] == null || t[k] === '') continue;
    const c = safeColor(t[k]);
    if (c) { out[k] = c; ok[k] = true; } else rejected.push(`${k} "${String(t[k]).slice(0, 40)}"`);
  }
  // New text on no preset: the accent follows it unless one was picked.
  if (!PRESETS[name] && ok.text && !ok.accent) out.accent = out.text;
  // Readable, whatever was saved or asked: text that doesn't stand off the background (white on white)
  // becomes near-white or near-black, whichever reads; an accent that vanishes into it (a favorite
  // color of navy on the dark default) follows the text. Said in the reply, so nobody's surprised.
  const fixed = [];
  if (contrast(out.text, out.background) < 4.5) {
    const t = contrast('#f2f2f2', out.background) >= contrast('#1b1b1b', out.background) ? '#f2f2f2' : '#1b1b1b';
    fixed.push(`text ${out.text} -> ${t}`); out.text = t;
  }
  if (contrast(out.accent, out.background) < 3) { fixed.push(`accent ${out.accent} -> ${out.text}`); out.accent = out.text; }
  const same = (p) => out.background === p.background && out.text === p.text && out.accent === p.accent;
  const preset = Object.keys(PRESETS).find((n) => same(PRESETS[n])) || 'custom';
  return { ...out, preset, source, rejected, fixed };
}

// The theme as CSS variables. Every value passed safeColor; esc is belt and braces.
export function themeCss(th) {
  const mono = th.background === PRESETS.mono.background && th.text === PRESETS.mono.text;
  const mix = (p) => `color-mix(in srgb,var(--fg) ${p}%,var(--bg))`;
  const v = mono ? MONO_MIX : { dim: mix(58), line: mix(16), card: mix(7) };
  return `:root{--bg:${esc(th.background)};--fg:${esc(th.text)};--accent:${esc(th.accent)};--dim:${v.dim};--line:${v.line};--card:${v.card}}`;
}

// A color's red, green and blue (0..1) from anything safeColor lets through; null if it can't tell.
function rgbOf(c) {
  c = String(c || '');
  if (NAMED_HEX[c]) c = `#${NAMED_HEX[c]}`;
  let m = /^#([0-9a-f]{3,8})$/.exec(c);
  if (m) {
    let h = m[1]; if (h.length <= 4) h = h.split('').map((x) => x + x).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  m = /^rgba?\(([\d.]+)(%?),([\d.]+)(%?),([\d.]+)(%?)/.exec(c);
  if (m) return [[m[1], m[2]], [m[3], m[4]], [m[5], m[6]]].map(([v, p]) => Math.min(1, +v / (p ? 100 : 255)));
  return null;
}
// Roughly how light a color is (0 dark .. 1 light), for the page's color-scheme.
function lightness(c) {
  const v = rgbOf(c);
  return v ? 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] : 0.1;
}
// The WCAG contrast ratio of two colors (1 the same .. 21 black on white); 21 if either can't be read.
export function contrast(a, b) {
  const lum = (c) => { const v = rgbOf(c); return v ? v.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0) : null; };
  const x = lum(a), y = lum(b);
  if (x == null || y == null) return 21;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function slideHtml(s, i) {
  const parts = [];
  if (s.kicker) parts.push(`<p class="kicker">${esc(s.kicker)}</p>`);
  parts.push(`<h2>${esc(s.heading || `Slide ${i + 1}`)}</h2>`);
  if (s.stat) parts.push(`<div class="stat"><span class="num">${esc(s.stat)}</span>${s.stat_label ? `<span class="label">${esc(s.stat_label)}</span>` : ''}</div>`);
  if (s.text) parts.push(`<p class="text">${esc(s.text)}</p>`);
  const bullets = Array.isArray(s.bullets) ? s.bullets.filter((b) => String(b ?? '').trim()) : [];
  if (bullets.length) parts.push(`<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
  if (s.code) parts.push(`<pre><code>${esc(s.code)}</code></pre>`);
  const img = s.image ? imageData(s.image) : null;
  if (img) parts.push(`<figure><img src="${img}" alt="${esc(s.image_caption || s.heading || '')}">${s.image_caption ? `<figcaption>${esc(s.image_caption)}</figcaption>` : ''}</figure>`);
  return `<section class="slide" aria-label="Slide ${i + 2}">${parts.join('\n')}</section>`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--fg)}
body{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;overflow:hidden;-webkit-font-smoothing:antialiased}
.deck{height:100%;position:relative}
.slide{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;padding:clamp(24px,8vw,120px);max-width:1200px;margin:0 auto;overflow-y:auto}
.slide.on{display:flex;animation:in .35s ease}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.kicker,.meta,.label,figcaption,.bar{font-family:ui-sans-serif,system-ui,"Segoe UI",Helvetica,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;font-size:clamp(11px,1.1vw,13px);color:var(--dim)}
.kicker{margin-bottom:1.2em;color:var(--accent)}
h1{font-weight:400;font-size:clamp(36px,7vw,88px);line-height:1.02;letter-spacing:-.02em}
h2{font-weight:400;font-size:clamp(28px,4.6vw,56px);line-height:1.08;letter-spacing:-.015em;margin-bottom:.7em}
.sub{font-size:clamp(17px,2.2vw,26px);color:var(--dim);margin-top:1.1em;max-width:36em;line-height:1.4}
.title .rule{width:64px;height:2px;background:var(--accent);margin:2em 0 1.2em}
.text{font-size:clamp(17px,2vw,24px);line-height:1.5;max-width:38em;margin-bottom:1em}
ul{list-style:none;max-width:40em}
li{font-size:clamp(16px,1.9vw,23px);line-height:1.45;padding:.55em 0 .55em 1.4em;border-top:1px solid var(--line);position:relative}
li:last-child{border-bottom:1px solid var(--line)}
li::before{content:"";position:absolute;left:0;top:1.15em;width:.55em;height:2px;background:var(--accent)}
.stat{display:flex;flex-direction:column;gap:.4em;margin-bottom:1.2em}
.num{font-size:clamp(56px,11vw,140px);line-height:1;letter-spacing:-.03em}
pre{background:var(--card);border:1px solid var(--line);padding:1em 1.2em;overflow:auto;max-height:45vh;margin-top:.6em;border-radius:4px}
code{font-family:ui-monospace,"Cascadia Code",Consolas,Menlo,monospace;font-size:clamp(12px,1.3vw,15px);line-height:1.55;color:var(--fg)}
figure{margin-top:1em}
img{max-width:100%;max-height:50vh;display:block;border:1px solid var(--line)}
figcaption{margin-top:.8em}
.bar{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:space-between;align-items:center;padding:14px clamp(16px,4vw,40px);pointer-events:none}
.bar button{pointer-events:auto;background:none;border:1px solid var(--line);color:var(--fg);font:inherit;padding:8px 14px;cursor:pointer;border-radius:2px}
.bar button:hover,.bar button:focus-visible{border-color:var(--fg);outline:none}
.progress{position:fixed;left:0;top:0;height:3px;background:var(--accent);transition:width .3s ease}
@media (max-width:600px){.bar .hint{display:none}}
@media (prefers-reduced-motion:reduce){.slide.on{animation:none}.progress{transition:none}}
@media print{body{overflow:visible}.slide{position:relative;display:flex;page-break-after:always;min-height:100vh}.bar,.progress{display:none}}
`;

const JS = `
(function(){var s=[].slice.call(document.querySelectorAll('.slide')),i=0,n=document.getElementById('n'),p=document.getElementById('p');
function go(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach(function(e,j){e.classList.toggle('on',j===i)});n.textContent=(i+1)+' / '+s.length;p.style.width=((i+1)/s.length*100)+'%';if(location.hash!=='#'+(i+1))history.replaceState(null,'','#'+(i+1))}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '||e.key==='Enter'){e.preventDefault();go(i+1)}else if(e.key==='ArrowLeft'||e.key==='PageUp'||e.key==='Backspace'){e.preventDefault();go(i-1)}else if(e.key==='Home'){go(0)}else if(e.key==='End'){go(s.length-1)}});
document.querySelector('.deck').addEventListener('click',function(e){if(e.target.closest('a,pre,button'))return;go(e.clientX<innerWidth/3?i-1:i+1)});
document.getElementById('prev').onclick=function(){go(i-1)};document.getElementById('next').onclick=function(){go(i+1)};
var t0=null;document.addEventListener('touchstart',function(e){t0=e.touches[0].clientX},{passive:true});document.addEventListener('touchend',function(e){if(t0===null)return;var d=e.changedTouches[0].clientX-t0;if(Math.abs(d)>50)go(d<0?i+1:i-1);t0=null});
go((parseInt(location.hash.slice(1),10)||1)-1)})();
`;

// The deck as one HTML string. deck: { title, subtitle?, slides: [{ heading, kicker?, text?, bullets?, code?, stat?, stat_label?, image?, image_caption? }] }
export function deckHtml({ title, subtitle = '', date = '', slides = [], theme = null } = {}) {
  const th = theme && theme.source && Array.isArray(theme.rejected) ? theme : resolveTheme(theme);
  const list = (Array.isArray(slides) ? slides : []).filter((s) => s && typeof s === 'object').slice(0, MAX_SLIDES);
  const when = date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const cover = `<section class="slide title" aria-label="Slide 1"><p class="kicker">${esc(when)}</p><h1>${esc(title || 'Untitled')}</h1>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}<div class="rule"></div><p class="meta">Made with Stead</p></section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${lightness(th.background) > 0.5 ? 'light' : 'dark'}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(title || 'Presentation')}</title>
<style>${themeCss(th)}${CSS}</style>
</head>
<body>
<div class="progress" id="p"></div>
<main class="deck">
${cover}
${list.map(slideHtml).join('\n')}
</main>
<nav class="bar"><button id="prev" aria-label="Previous slide">&larr;</button><span><span class="hint">Arrow keys or click &middot; </span><span id="n"></span></span><button id="next" aria-label="Next slide">&rarr;</button></nav>
<script>${JS}</script>
</body>
</html>
`;
}

// Writes the deck and returns its path. A deck with the same title is replaced (the newest telling).
export function writeDeck(deck, { dir = PRESENT_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slugOf(deck?.title)}.html`);
  fs.writeFileSync(file, deckHtml(deck));
  return file;
}

const S = { type: 'string' };
export const presentTools = [{
  name: 'stead_present',
  description: 'Show them a project as a slide deck in their browser instead of a wall of text: a title and 5-9 slides (heading, plus bullets, short text, a stat, code or an image file). Opens it; then sum it up in 2-3 sentences.',
  inputSchema: {
    type: 'object',
    properties: {
      title: S,
      subtitle: S,
      slides: {
        type: 'array',
        items: { type: 'object', properties: { heading: S, kicker: S, text: S, bullets: { type: 'array', items: S }, stat: S, stat_label: S, code: S, image: { type: 'string', description: 'A picture file on this computer' }, image_caption: S }, required: ['heading'] },
      },
      theme: { type: 'object', description: 'Optional; omit for their saved colors', properties: { preset: { type: 'string', enum: Object.keys(PRESETS) }, background: S, text: S, accent: S } },
      open: { type: 'boolean', description: 'Default true' },
    },
    required: ['title', 'slides'],
  },
  run: async ({ title, subtitle, slides, theme, open = true } = {}) => {
    if (!title || !Array.isArray(slides) || !slides.length) return { content: [{ type: 'text', text: 'Needs a title and at least one slide.' }], isError: true };
    const th = resolveTheme(theme);
    const file = writeDeck({ title, subtitle, slides, theme: th });
    const colors = ` Colors: ${th.preset === 'custom' ? `${th.background} / ${th.text} / ${th.accent}` : th.preset} (${th.source === 'saved' ? 'their saved choice' : th.source === 'asked' ? 'as asked' : 'default'}).${th.rejected.length ? ` Not colors, left out: ${th.rejected.join(', ')}.` : ''}${th.fixed.length ? ` Changed so it reads: ${th.fixed.join(', ')}.` : ''}`;
    const shown = open !== false && process.env.STEAD_NO_OPEN !== '1' && process.env.STEAD_UNATTENDED !== '1' && process.env.STEAD_PHONE !== '1';
    if (shown) openInBrowser(file);
    return { content: [{ type: 'text', text: `${shown ? 'Opened the deck in their browser' : 'Saved the deck'}: ${file} (${Math.min(slides.length, MAX_SLIDES) + 1} slides with the cover; arrow keys or a click move on).${colors}${process.env.STEAD_PHONE === '1' ? ' They are on their phone: send it with phone_send.' : ''} Now give them the gist in 2-3 spoken sentences.` }] };
  },
}];
