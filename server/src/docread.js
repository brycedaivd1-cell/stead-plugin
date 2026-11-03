// Reading the files people actually have: Word, Excel, PowerPoint, PDF, photos and screenshots.
// No libraries: Office files are zip archives of XML (node:zlib inflates them), a PDF's text sits in
// compressed content streams, and an image goes to Claude as an image it can see.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_TEXT = 80000; // characters per answer: enough for a long essay, small enough to leave room to work
const LIMIT = 64e6; // most any one zip entry or PDF stream may inflate to (a zip bomb stops here)

// ---------- small helpers ----------
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()]));
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const cap = (s, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}\n…(cut here: ${s.length - n} more characters)` : s);
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------- zip ----------
// The central directory at the end lists every entry; its end record sits in the last 64 KB.
export function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("it isn't a normal Office file inside: it may be password-protected, damaged, or an older format. Open it with desktop_open_file and read it with desktop_read");
  const entries = new Map();
  let p = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0 && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const nameLen = buf.readUInt16LE(p + 28);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), local: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  const lower = new Map([...entries.keys()].map((k) => [k.toLowerCase(), k]));
  const read = (name) => {
    const e = entries.get(name) ?? entries.get(lower.get(String(name).toLowerCase()));
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const raw = buf.subarray(start, start + e.size);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: LIMIT });
    throw new Error(`a part of it is packed in a way Stead can't open (method ${e.method})`);
  };
  return { names: [...entries.keys()], read, text: (name) => read(name)?.toString('utf8') ?? null };
}

// Relationship files say which part is which (sheet 1 is worksheets/sheet3.xml, and so on).
function rels(zip, file, base) {
  const m = new Map();
  for (const [tag] of (zip.text(file) || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const t = attr(tag, 'Target') || '';
    if (attr(tag, 'TargetMode') === 'External') continue;
    m.set(attr(tag, 'Id'), { type: attr(tag, 'Type') || '', path: t.startsWith('/') ? t.slice(1) : path.posix.normalize(base + t) });
  }
  return m;
}

// ---------- Word ----------
export function docxText(zip) {
  let xml = zip.text('word/document.xml');
  if (xml == null) throw new Error('there is no document inside this .docx (it may be damaged)');
  // Text boxes are stored twice (new and old format); keep one copy.
  xml = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  // Style ids to names, so a heading reads as a heading whatever language Word was set to.
  const styles = new Map();
  for (const [, open, body] of (zip.text('word/styles.xml') || '').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    styles.set(attr(open, 'w:styleId'), (body.match(/<w:name w:val="([^"]*)"/)?.[1] || '').toLowerCase());
  }
  const out = [];
  const paras = []; // paragraphs can nest (a text box inside a paragraph)
  const tables = []; // { row, cell, rows }
  const put = (line) => {
    if (tables.length) tables.at(-1).cell.push(line);
    else out.push(line);
  };
  const re = /<w:(tbl|tr|tc|p)\b[^>]*?(\/?)>|<\/w:(tbl|tr|tc|p)>|<w:pStyle w:val="([^"]*)"|<w:numPr>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\/>|<w:br\s[^>]*\/>/g;
  for (const m of xml.matchAll(re)) {
    const [tag, open, self, close, style, text, brk] = m;
    const para = paras.at(-1);
    if (open === 'p') { if (self) put(''); else paras.push({ text: '', style: '', list: false }); }
    else if (close === 'p' && para) {
      paras.pop();
      const name = styles.get(para.style) || para.style.toLowerCase();
      const h = name.match(/^heading\s*(\d)/);
      const prefix = h ? `${'#'.repeat(Math.min(6, +h[1]))} ` : name === 'title' ? '# ' : para.list || name.startsWith('list') ? '- ' : '';
      const line = para.text.trim() ? prefix + para.text : '';
      if (paras.length) paras.at(-1).text += line ? `${line} ` : ''; // a text box's words join the paragraph around it
      else put(line);
    } else if (open === 'tbl' && !self) {
      if (!tables.length) out.push('');
      tables.push({ row: [], cell: [], rows: 0 });
    }
    else if (close === 'tbl') {
      tables.pop();
      if (!tables.length) out.push('');
    } else if (open === 'tr' && tables.length) tables.at(-1).row = [];
    else if (close === 'tr' && tables.length) {
      const t = tables.at(-1);
      const line = `| ${t.row.join(' | ')} |`;
      if (tables.length > 1) tables.at(-2).cell.push(line);
      else {
        out.push(line);
        if (++t.rows === 1) out.push(`|${' --- |'.repeat(t.row.length)}`);
      }
    } else if (open === 'tc' && tables.length) tables.at(-1).cell = [];
    else if (close === 'tc' && tables.length) { const t = tables.at(-1); t.row.push(t.cell.filter(Boolean).join(' ').replace(/\|/g, '/').trim()); }
    else if (style != null && para) para.style = style;
    else if (tag === '<w:numPr>' && para) para.list = true;
    else if (text != null && para) para.text += unxml(text);
    else if (para && (brk || tag.startsWith('<w:br'))) para.text += brk === 'tab' ? '\t' : '\n';
  }
  return tidy(out.join('\n'));
}

// ---------- Excel ----------
// Excel stores a date as a day count; only the cell's number format says it's a date.
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function dateStyles(zip) {
  const xml = zip.text('xl/styles.xml') || '';
  const custom = new Map([...xml.matchAll(/<numFmt\b[^>]*>/g)].map(([t]) => [+attr(t, 'numFmtId'), unxml(attr(t, 'formatCode') || '')]));
  // 'time' for formats with only hours/minutes/seconds (a value under 1 is then a time of day, not a date).
  const TIME_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);
  const kind = (id) => {
    if (DATE_IDS.has(id)) return TIME_IDS.has(id) ? 'time' : 'date';
    if (!custom.has(id)) return false;
    const f = custom.get(id).replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, '');
    if (!/[dmyhs]/i.test(f)) return false;
    return /[dy]/i.test(f) || /m{3,}/i.test(f) ? 'date' : 'time';
  };
  const xfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map(([t]) => kind(+attr(t, 'numFmtId') || 0));
}
function excelDate(serial, base1904, kind = 'date') {
  const ms = Math.round((serial * 86400) / 60) * 60000; // to the minute, so 0.99999 isn't 23:59
  const d = new Date((base1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + ms);
  const iso = d.toISOString();
  if (kind === 'time' && serial < 1) return iso.slice(11, 16);
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
const colIndex = (ref) => [...(ref.match(/^[A-Z]+/i)?.[0] || '')].reduce((n, ch) => n * 26 + ch.toUpperCase().charCodeAt(0) - 64, 0) - 1;

export function xlsxText(zip, { sheet, from_row = 1, max_rows = 300 } = {}) {
  const wb = zip.text('xl/workbook.xml');
  if (wb == null) throw new Error('there is no workbook inside this .xlsx (it may be damaged)');
  const r = rels(zip, 'xl/_rels/workbook.xml.rels', 'xl/');
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(([t]) => ({ name: unxml(attr(t, 'name') || ''), file: r.get(attr(t, 'r:id'))?.path, hidden: attr(t, 'state') }));
  const base1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb);
  const shared = [...(zip.text('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)]
    .map(([, s = '']) => [...s.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => unxml(t[1])).join(''));
  const dates = dateStyles(zip);
  const pick = sheet ? sheets.filter((s) => s.name.toLowerCase() === String(sheet).toLowerCase()) : sheets;
  if (sheet && !pick.length) throw new Error(`no sheet named "${sheet}". The sheets are: ${sheets.map((s) => s.name).join(', ')}`);
  const out = [];
  let size = 0;
  const skipped = [];
  for (const s of pick) {
    const xml = s.file && zip.text(s.file);
    if (!xml) continue;
    const rows = [...xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)];
    if (size > MAX_TEXT) { skipped.push(`${s.name} (${rows.length} rows)`); continue; }
    const lines = [];
    let shown = 0;
    let last = 0;
    for (const [, rowAttrs, body = ''] of rows) {
      const n = +attr(` ${rowAttrs}`, 'r') || last + 1;
      last = n;
      if (n < from_row) continue;
      const cells = [];
      let next = 0;
      for (const [, a, inner = ''] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(` ${a}`, 'r');
        const i = ref ? colIndex(ref) : next;
        next = i + 1;
        const t = attr(` ${a}`, 't');
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
        let val = '';
        if (t === 's') val = shared[+v] ?? '';
        else if (t === 'inlineStr') val = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => unxml(x[1])).join('');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null && (t === 'str' || t === 'e' || t === 'd')) val = unxml(v);
        else if (v != null && v !== '') {
          const num = Number(v);
          val = dates[+attr(` ${a}`, 's') || 0] && Number.isFinite(num) ? excelDate(num, base1904, dates[+attr(` ${a}`, 's') || 0]) : String(Number.isFinite(num) ? +num.toPrecision(15) : v);
        }
        if (i < 1000) cells[i] = String(val).replace(/[\t\r\n]+/g, ' ');
      }
      if (!cells.some((c) => c)) continue;
      if (shown >= max_rows || size > MAX_TEXT) {
        const left = rows.filter(([, ra]) => +attr(` ${ra}`, 'r') >= n).length || 1;
        lines.push(`…${left} more rows. Call file_read again with sheet "${s.name}" and from_row ${n} for the next part.`);
        break;
      }
      const line = `${n}\t${Array.from(cells, (c) => c ?? '').join('\t').replace(/\t+$/, '')}`;
      lines.push(line.length > 4000 ? `${line.slice(0, 4000)}…` : line);
      size += line.length;
      shown++;
    }
    out.push(`## Sheet: ${s.name}${s.hidden ? ` (${s.hidden})` : ''}\n(first column is the row number; columns are tab-separated)\n${lines.join('\n') || '(empty)'}`);
  }
  if (skipped.length) out.push(`Not shown, to keep this short: ${skipped.join(', ')}. Read one with the sheet argument.`);
  return out.join('\n\n');
}

// ---------- PowerPoint ----------
const drawingText = (xml) => [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\b[^>]*\/>/g)]
  .map(([, p = '']) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\b|<a:tab\/>/g)].map((t) => (t[1] != null ? unxml(t[1]) : t[0] === '<a:br' ? '\n' : '\t')).join(''))
  .filter((l) => l.trim());

export function pptxText(zip) {
  const pres = zip.text('ppt/presentation.xml');
  if (pres == null) throw new Error('there is no presentation inside this .pptx (it may be damaged)');
  const r = rels(zip, 'ppt/_rels/presentation.xml.rels', 'ppt/');
  let slides = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map(([t]) => r.get(attr(t, 'r:id'))?.path).filter(Boolean);
  if (!slides.length) slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.match(/\d+/)[0] - b.match(/\d+/)[0]);
  const out = [];
  slides.forEach((file, i) => {
    let xml = zip.text(file) || '';
    // The title placeholder becomes the slide's heading.
    let title = '';
    xml = xml.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*type="(?:ctrTitle|title)"[\s\S]*?<\/p:sp>/, (sp) => { title = drawingText(sp).join(' '); return ''; });
    const lines = drawingText(xml);
    const dir = path.posix.dirname(file);
    const notesFile = [...rels(zip, `${dir}/_rels/${path.posix.basename(file)}.rels`, `${dir}/`).values()].find((x) => /\/notesSlide$/.test(x.type))?.path;
    const notesXml = notesFile && zip.text(notesFile);
    const notes = notesXml ? [...notesXml.matchAll(/<p:sp>((?:(?!<\/p:sp>)[\s\S])*?)<\/p:sp>/g)].filter(([sp]) => /<p:ph\b[^>]*type="body"/.test(sp)).flatMap(([sp]) => drawingText(sp)) : [];
    out.push(`--- Slide ${i + 1}${title ? `: ${title}` : ''} ---\n${lines.join('\n') || '(no text)'}${notes.length ? `\nSpeaker notes: ${notes.join('\n')}` : ''}`);
  });
  return out.join('\n\n');
}

// ---------- OpenDocument (LibreOffice, Google Docs downloads) ----------
export function odfText(zip) {
  const xml = zip.text('content.xml');
  if (xml == null) throw new Error('there is no content inside this file (it may be damaged)');
  return tidy(unxml(xml
    .replace(/<text:h\b[^>]*text:outline-level="(\d)"[^>]*>/g, (m, n) => `\n${'#'.repeat(+n)} `)
    .replace(/<text:s\b[^>]*text:c="(\d+)"[^>]*\/>/g, (m, n) => ' '.repeat(Math.min(+n, 50))).replace(/<text:s\/>/g, ' ')
    .replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
    .replace(/<\/table:table-cell>/g, ' | ').replace(/<\/(text:p|text:h|table:table-row)>|<draw:page\b[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')));
}

// ---------- pictures inside Office files ----------
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export function officeImages(zip, max = 6) {
  const media = zip.names.filter((n) => /^(word|ppt|xl)\/media\//.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const content = [];
  const skipped = [];
  for (const n of media) {
    const mime = IMAGE_MIME[path.extname(n).toLowerCase()];
    if (!mime) { skipped.push(path.posix.basename(n)); continue; }
    if (content.length >= max) { skipped.push(path.posix.basename(n)); continue; }
    let data = zip.read(n);
    if (data.length > 1.5e6) {
      const tmp = path.join(os.tmpdir(), `stead-img-${process.pid}-${Date.now()}${path.extname(n)}`);
      fs.writeFileSync(tmp, data);
      try { data = shrinkImage(tmp); } finally { fs.rmSync(tmp, { force: true }); }
      if (!data) { skipped.push(path.posix.basename(n)); continue; }
      content.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' });
    } else content.push({ type: 'image', data: data.toString('base64'), mimeType: mime });
  }
  return { content, skipped };
}

// ---------- pictures ----------
// A big photo is shrunk to Claude's working size (1568 px on the long side) before it's sent:
// System.Drawing on Windows, sips on a Mac. Returns JPEG bytes, or null when it can't.
export function shrinkImage(file, edge = 1568) {
  const out = path.join(os.tmpdir(), `stead-shrunk-${process.pid}-${Date.now()}.jpg`);
  try {
    if (process.platform === 'win32') {
      // Phone photos are often stored sideways with a "rotate me" tag (EXIF 274); apply it first.
      const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:STEAD_IMG_IN)
try { $o = $src.GetPropertyItem(274).Value[0]; if ($o -eq 3) { $src.RotateFlip('Rotate180FlipNone') } elseif ($o -eq 6) { $src.RotateFlip('Rotate90FlipNone') } elseif ($o -eq 8) { $src.RotateFlip('Rotate270FlipNone') } } catch {}
$s = [Math]::Min(1.0, ${edge} / [Math]::Max($src.Width, $src.Height)); $w = [Math]::Max(1, [int]($src.Width * $s)); $h = [Math]::Max(1, [int]($src.Height * $s))
$bmp = New-Object System.Drawing.Bitmap $w, $h; $g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($src, 0, 0, $w, $h)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1; $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
$bmp.Save($env:STEAD_IMG_OUT, $codec, $ep); $g.Dispose(); $bmp.Dispose(); $src.Dispose()`;
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, STEAD_IMG_IN: file, STEAD_IMG_OUT: out }, stdio: 'ignore', windowsHide: true, timeout: 60000 });
    } else if (process.platform === 'darwin') {
      spawnSync('sips', ['-Z', String(edge), '-s', 'format', 'jpeg', file, '--out', out], { stdio: 'ignore', timeout: 60000 });
    }
    return fs.existsSync(out) && fs.statSync(out).size > 0 ? fs.readFileSync(out) : null;
  } catch { return null; } finally { fs.rmSync(out, { force: true }); }
}

export function imageContent(file, size) {
  const ext = path.extname(file).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime && size <= 1.5e6) return [{ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: mime }];
  const small = shrinkImage(file);
  if (small) return [{ type: 'image', data: small.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `(${path.basename(file)} is ${Math.round(size / 1024)} KB, so this is a smaller copy; the file itself is unchanged.)` }];
  if (mime && size <= 4e6) return [{ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: mime }];
  return null;
}

// ---------- PDF ----------
// Enough of PDF to pull out the words: objects (including ones packed in object streams), the page
// tree, fonts' ToUnicode maps, and the text operators in each page's content. Scanned pages have no
// words inside, only a picture, and come back empty so Claude knows to look at them instead.

// One PDF value starting at i: [value, next index]. Refs are { ref: n }, operators { op }.
// Sticky regexes, not slices: a long PDF has millions of these tokens.
const SKIP = /(?:[\s\0]+|%[^\r\n]*)*/y;
const NAME = /\/[^\s\0/<>[\]()%{}]*/y;
const TOKEN = /[^\s\0/<>[\]()%{}]+/y;
const REF = /\s+(\d+)\s+R(?![^\s\0/<>[\]()%{}])/y;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const skip = (s, i) => { SKIP.lastIndex = i; SKIP.exec(s); return SKIP.lastIndex; };

function pdfValue(s, i) {
  i = skip(s, i);
  const c = s[i];
  if (c === '<' && s[i + 1] === '<') {
    const d = {};
    i += 2;
    for (;;) {
      i = skip(s, i);
      if ((s[i] === '>' && s[i + 1] === '>') || i >= s.length) return [d, i + 2];
      const [k, j] = pdfValue(s, i);
      if (typeof k !== 'string' || !k.startsWith('/')) return [d, Math.max(j, i + 1)];
      const [v, j2] = pdfValue(s, j);
      d[k.slice(1)] = v;
      i = j2;
    }
  }
  if (c === '[') {
    const a = [];
    i++;
    for (;;) {
      i = skip(s, i);
      if (s[i] === ']' || i >= s.length) return [a, i + 1];
      const [v, j] = pdfValue(s, i);
      a.push(v);
      i = Math.max(j, i + 1);
    }
  }
  if (c === '(') { const [str, j] = pdfString(s, i); return [{ str }, j]; }
  if (c === '<') {
    let j = s.indexOf('>', i);
    if (j < 0) j = s.length;
    const hex = s.slice(i + 1, j).replace(/[^0-9a-f]/gi, '');
    return [{ str: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1') }, j + 1];
  }
  if (c === '/') {
    NAME.lastIndex = i;
    const n = NAME.exec(s)[0];
    return [n.includes('#') ? n.replace(/#([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))) : n, i + n.length];
  }
  TOKEN.lastIndex = i;
  const m = TOKEN.exec(s);
  if (!m) return [null, i + 1];
  const tok = m[0];
  const end = i + tok.length;
  if (NUMBER.test(tok)) {
    if (/^\d+$/.test(tok)) {
      REF.lastIndex = end;
      const ref = REF.exec(s);
      if (ref) return [{ ref: +tok }, REF.lastIndex];
    }
    return [+tok, end];
  }
  return [tok === 'true' ? true : tok === 'false' ? false : tok === 'null' ? null : { op: tok }, end];
}

// A (literal string) with its escapes and balanced parentheses: [bytes as latin1, next index].
function pdfString(s, i) {
  let depth = 0;
  let out = '';
  for (i++; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[++i];
      const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[n];
      if (esc != null) out += esc;
      else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i]; out += String.fromCharCode(parseInt(o, 8) & 255); }
      else if (n === '\r') { if (s[i + 1] === '\n') i++; }
      else if (n !== '\n') out += n;
    } else if (c === '(') { depth++; out += c; }
    else if (c === ')') { if (depth-- === 0) return [out, i + 1]; out += c; }
    else out += c;
  }
  return [out, i];
}

function pdfObjects(buf, s) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[1];
    let [val, i] = pdfValue(s, re.lastIndex);
    const k = /^\s*stream\r?\n?/.exec(s.slice(i, i + 20));
    if (k && val && typeof val === 'object') {
      const start = i + k[0].length;
      let end = typeof val.Length === 'number' && /^\s*endstream/.test(s.slice(start + val.Length, start + val.Length + 20)) ? start + val.Length : s.indexOf('endstream', start);
      if (end < 0) end = s.length;
      val = { dict: val, data: buf.subarray(start, end) };
      re.lastIndex = end;
    } else {
      const e = s.indexOf('endobj', i);
      if (e > 0 && e < i + 1e6) re.lastIndex = e;
    }
    objs.set(num, val); // later copies (edits saved on top) win
  }
  // Newer PDFs pack small objects into compressed object streams.
  for (const o of [...objs.values()]) {
    if (!o?.dict || o.dict.Type !== '/ObjStm') continue;
    const body = pdfDecode(o);
    if (!body) continue;
    const t = body.toString('latin1');
    const head = t.slice(0, o.dict.First).trim().split(/\s+/).map(Number);
    for (let j = 0; j + 1 < head.length && j / 2 < o.dict.N; j += 2) if (!objs.has(head[j])) objs.set(head[j], pdfValue(t, o.dict.First + head[j + 1])[0]);
  }
  return objs;
}

function pdfDecode(o) {
  const f = [].concat(o.dict?.Filter ?? []);
  if (!f.length) return o.data;
  if (f.length === 1 && (f[0] === '/FlateDecode' || f[0] === '/Fl')) {
    try { return zlib.inflateSync(o.data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: LIMIT }); } catch { return null; }
  }
  return null; // images and rare filters: no words in there anyway
}

// A font's ToUnicode map: the codes in the page's strings to the letters they draw.
function parseCMap(t) {
  const map = new Map();
  const range = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(t);
  const bytes = range ? Math.max(1, range[1].length / 2) : 1;
  const uni = (hex) => { const b = Buffer.from(hex.length % 4 ? hex.padStart(Math.ceil(hex.length / 4) * 4, '0') : hex, 'hex'); return b.swap16().toString('utf16le'); };
  for (const [, body] of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, a, b] of body.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(parseInt(a, 16), uni(b));
  }
  for (const [, body] of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, b, dst, arr] of body.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(?:<([0-9a-f]*)>|\[([^\]]*)\])/gi)) {
      const lo = parseInt(a, 16);
      const hi = Math.min(parseInt(b, 16), lo + 65535);
      if (arr != null) [...arr.matchAll(/<([0-9a-f]*)>/gi)].forEach(([, h], k) => { if (lo + k <= hi) map.set(lo + k, uni(h)); });
      else {
        const base = Buffer.from(dst.length % 4 ? dst.padStart(Math.ceil(dst.length / 4) * 4, '0') : dst, 'hex');
        for (let c = lo; c <= hi; c++) {
          const b2 = Buffer.from(base);
          b2.writeUInt16BE((b2.readUInt16BE(b2.length - 2) + c - lo) & 0xffff, b2.length - 2);
          map.set(c, b2.swap16().toString('utf16le'));
        }
      }
    }
  }
  return { map, bytes };
}

// Simple fonts without a map use Windows' Latin encoding; Differences rename a few codes.
const CP1252 = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };
const GLYPHS = { space: ' ', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—', bullet: '•', fi: 'fi', fl: 'fl', ellipsis: '…', hyphen: '-', period: '.', comma: ',', colon: ':', semicolon: ';', parenleft: '(', parenright: ')', quotesingle: "'", quotedbl: '"' };

// How wide each letter is (thousandths of the font size), so the text can be followed across the
// page: simple fonts list Widths from FirstChar, Type0 fonts a W array in their descendant font.
function fontWidths(font, get) {
  const widths = new Map();
  const num = (v) => (typeof get(v) === 'number' ? get(v) : 0);
  if (font.Subtype === '/Type0') {
    const d = get([].concat(get(font.DescendantFonts) ?? [])[0]);
    const desc = d?.dict || d || {};
    const w = get(desc.W);
    if (Array.isArray(w)) {
      for (let i = 0; i < w.length && widths.size < 70000;) {
        const c = w[i];
        const next = get(w[i + 1]);
        if (typeof c !== 'number') { i++; continue; }
        if (Array.isArray(next)) { next.forEach((x, k) => widths.set(c + k, num(x))); i += 2; }
        else { for (let k = c; k <= Math.min(num(next), c + 65535); k++) widths.set(k, num(w[i + 2])); i += 3; }
      }
    }
    return { widths, dw: typeof desc.DW === 'number' ? desc.DW : 1000 };
  }
  const w = get(font.Widths);
  if (Array.isArray(w)) w.forEach((x, k) => widths.set((font.FirstChar || 0) + k, num(x)));
  const fd = get(font.FontDescriptor);
  const missing = (fd?.dict || fd)?.MissingWidth;
  return { widths, dw: typeof missing === 'number' && missing > 0 ? missing : 500 };
}

function pdfFont(objs, f) {
  const get = (v) => (v && v.ref != null ? objs.get(v.ref) : v);
  const font = get(f) || {};
  const simple = font.Subtype !== '/Type0';
  const w = fontWidths(font, get);
  const tu = get(font.ToUnicode);
  if (tu?.dict) { const b = pdfDecode(tu); if (b) return { ...parseCMap(b.toString('latin1')), simple, ...w }; }
  if (!simple) return { map: null, bytes: 2, ...w }; // codes are glyph numbers: unreadable without a map
  const map = new Map();
  const enc = get(font.Encoding);
  if (enc && Array.isArray(enc.Differences)) {
    let code = 0;
    for (const d of enc.Differences) {
      if (typeof d === 'number') code = d;
      else if (typeof d === 'string') {
        const g = d.slice(1);
        const u = /^uni([0-9A-F]{4})$/.exec(g);
        map.set(code++, u ? String.fromCharCode(parseInt(u[1], 16)) : GLYPHS[g] ?? (g.length === 1 ? g : undefined));
      }
    }
  }
  return { map, bytes: 1, simple: true, ...w };
}

// The letters a string draws, and how far it moves along the line (in text units).
function decodeString(str, font, g) {
  let out = '';
  let width = 0;
  const bytes = font?.bytes || 1;
  for (let i = 0; i < str.length; i += bytes) {
    const code = bytes === 2 ? (str.charCodeAt(i) << 8) | (str.charCodeAt(i + 1) || 0) : str.charCodeAt(i);
    const gw = font?.widths?.has(code) ? font.widths.get(code) : font?.dw ?? 500;
    width += (gw / 1000) * g.size + g.tc + (bytes === 1 && code === 32 ? g.tw : 0);
    const m = font?.map?.get(code);
    if (!font) out += String.fromCharCode(code);
    else if (m != null) out += m;
    else if (font.simple) out += CP1252[code] || String.fromCharCode(code);
    else out += '�';
  }
  return { text: out, width: width * g.th };
}

// Runs one content stream's text operators. Words are joined by where they land on the page, not by
// how the file happens to write them: a browser places almost every pair of letters separately (to
// kern them), Word starts a new piece at every change of style, and TeX writes no spaces at all. A
// gap wider than a narrow letter is a space; a move up or down is a new line.
const nums = (ops, n) => ops.slice(-n).map((x) => (typeof x === 'number' ? x : 0));
function runContent(s, ctx, depth = 0, ctm = [1, 1, 0, 0]) {
  const ops = [];
  let i = 0;
  // What q saves and Q restores: font and spacing, and where on the page drawing goes (scale and
  // offset; rotated text is rare and still reads in order).
  let g = { font: null, size: 12, tc: 0, tw: 0, th: 1, lead: 0, ctm };
  const saved = [];
  let tm = [1, 1, 0, 0]; // the text matrix: x scale, y scale, x, y
  let lx = 0; // start of the current line, in text units since the last Tm
  let ly = 0;
  let cx = 0; // where the next letter goes
  const nl = () => { if (ctx.out && !ctx.out.endsWith('\n')) ctx.out += '\n'; };
  const gap = () => { if (ctx.out && !/\s$/.test(ctx.out)) ctx.out += ' '; };
  const page = (x, y) => [g.ctm[2] + g.ctm[0] * (tm[2] + tm[0] * x), g.ctm[3] + g.ctm[1] * (tm[3] + tm[1] * y)];
  const show = (str) => {
    const { text, width } = decodeString(str, g.font, g);
    const [x, y] = page(cx, ly);
    const em = Math.abs(g.size * tm[0] * g.ctm[0]) || 1;
    const emY = Math.abs(g.size * tm[1] * g.ctm[1]) || em;
    if (ctx.pen && text) {
      if (Math.abs(y - ctx.pen.y) > emY * 0.5) nl();
      else if (x - ctx.pen.x > em * 1.5 && !ctx.out.endsWith('\n')) ctx.out = ctx.out.replace(/ *$/, '\t'); // the next column of a table
      else if (x - ctx.pen.x > em * 0.15 || ctx.pen.x - x > em) gap();
    }
    ctx.out += text;
    cx += width;
    if (text) ctx.pen = { x: page(cx, ly)[0], y };
  };
  const nextLine = () => { ly -= g.lead; cx = lx; if (!g.lead) nl(); };
  while (i < s.length) {
    const [v, j] = pdfValue(s, i);
    if (j <= i) { i++; continue; }
    i = j;
    if (!v || v.op == null) { ops.push(v); if (ops.length > 64) ops.shift(); continue; }
    const op = v.op;
    if (op === 'BI') { const e = s.indexOf('EI', s.indexOf('ID', i)); i = e < 0 ? s.length : e + 2; } // inline picture
    else if (op === 'q') saved.push({ ...g });
    else if (op === 'Q') g = saved.pop() || g;
    else if (op === 'cm') { const [a, , , d, e, f] = nums(ops, 6); g.ctm = [a * g.ctm[0], d * g.ctm[1], e * g.ctm[0] + g.ctm[2], f * g.ctm[1] + g.ctm[3]]; }
    else if (op === 'Tf') { g.font = ctx.fontOf(ops.at(-2)); g.size = nums(ops, 1)[0]; }
    else if (op === 'Tc') g.tc = nums(ops, 1)[0];
    else if (op === 'Tw') g.tw = nums(ops, 1)[0];
    else if (op === 'Tz') g.th = nums(ops, 1)[0] / 100;
    else if (op === 'TL') g.lead = nums(ops, 1)[0];
    else if (op === 'BT') { tm = [1, 1, 0, 0]; lx = ly = cx = 0; }
    else if (op === 'Tm') { const [a, , , d, e, f] = nums(ops, 6); tm = [a, d, e, f]; lx = ly = cx = 0; }
    else if (op === 'Td' || op === 'TD') { const [tx, ty] = nums(ops, 2); if (op === 'TD') g.lead = -ty; lx += tx; ly += ty; cx = lx; }
    else if (op === 'T*') nextLine();
    else if (op === 'Tj') show(ops.at(-1)?.str ?? '');
    else if (op === "'" || op === '"') {
      if (op === '"') [g.tw, g.tc] = nums(ops, 3);
      nextLine();
      show(ops.at(-1)?.str ?? '');
    } else if (op === 'TJ') {
      for (const part of ops.at(-1) || []) {
        if (typeof part === 'number') cx -= (part / 1000) * g.size * g.th;
        else if (part?.str != null) show(part.str);
      }
    } else if (op === 'Do' && depth < 3) ctx.form(ops.at(-1), depth, g.ctm);
    ops.length = 0;
  }
}

export function pdfText(buf, { pages } = {}) {
  const s = buf.toString('latin1');
  if (!s.startsWith('%PDF')) throw new Error('it is not a PDF inside, whatever its name says');
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(s)) return { encrypted: true };
  const objs = pdfObjects(buf, s);
  const get = (v) => (v && v.ref != null ? objs.get(v.ref) : v);
  const dictOf = (v) => { const o = get(v); return o?.dict || o; };
  // The page tree, in reading order; Resources pass down from parent to page.
  const list = [];
  const seen = new Set();
  const walk = (node, res) => {
    const n = dictOf(node);
    if (!n || typeof n !== 'object' || seen.has(n) || list.length > 5000) return;
    seen.add(n);
    const r = n.Resources ?? res;
    if (Array.isArray(n.Kids)) n.Kids.forEach((k) => walk(k, r));
    else if (n.Type === '/Page' || n.Contents) list.push({ page: n, res: r });
  };
  const catalog = [...objs.values()].reverse().find((o) => (o?.dict || o)?.Type === '/Catalog');
  walk((catalog?.dict || catalog)?.Pages);
  if (!list.length) [...objs.keys()].sort((a, b) => a - b).forEach((k) => { const o = dictOf({ ref: k }); if (o?.Type === '/Page') list.push({ page: o, res: o.Resources }); });

  const total = list.length;
  const [from, to] = (() => {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(pages ?? ''));
    if (!m) return [1, total];
    return [Math.max(1, +m[1]), Math.min(total, +(m[2] ?? m[1]))];
  })();
  const out = [];
  const fontsByRef = new Map();
  let size = 0;
  let empty = 0;
  const blank = [];
  let last = from - 1;
  for (let p = from; p <= to; p++) {
    if (size > MAX_TEXT) break;
    const { page, res } = list[p - 1];
    const ctx = { out: '' };
    const runWith = (resources, data, depth, ctm) => {
      const fontCache = new Map();
      const fontsDict = dictOf(dictOf(resources)?.Font) || {};
      const xobjs = dictOf(dictOf(resources)?.XObject) || {};
      const saved = [ctx.fontOf, ctx.form];
      ctx.fontOf = (name) => {
        const k = typeof name === 'string' ? name.slice(1) : '';
        if (!fontCache.has(k)) {
          const ref = fontsDict[k]?.ref;
          if (ref != null && !fontsByRef.has(ref)) fontsByRef.set(ref, pdfFont(objs, fontsDict[k])); // shared by every page
          fontCache.set(k, ref != null ? fontsByRef.get(ref) : fontsDict[k] ? pdfFont(objs, fontsDict[k]) : null);
        }
        return fontCache.get(k);
      };
      ctx.form = (name, d, at) => {
        const x = get(xobjs[typeof name === 'string' ? name.slice(1) : '']);
        if (x?.dict?.Subtype !== '/Form') return;
        const b = pdfDecode(x);
        const m = Array.isArray(x.dict.Matrix) && x.dict.Matrix.length === 6 && x.dict.Matrix.every((n) => typeof n === 'number') ? x.dict.Matrix : [1, 0, 0, 1, 0, 0];
        if (b) runWith(x.dict.Resources ?? resources, b.toString('latin1'), d + 1, [m[0] * at[0], m[3] * at[1], m[4] * at[0] + at[2], m[5] * at[1] + at[3]]);
      };
      runContent(data, ctx, depth, ctm);
      [ctx.fontOf, ctx.form] = saved;
    };
    const parts = [].concat(page.Contents ?? []).map((c) => get(c)).flatMap((c) => (Array.isArray(c) ? c.map(get) : [c]));
    const data = parts.map((c) => (c?.dict ? pdfDecode(c)?.toString('latin1') ?? '' : '')).join('\n');
    try { runWith(res, data, 0, [1, 1, 0, 0]); } catch {}
    const text = tidy(ctx.out.replace(/�+/g, ''));
    const bad = (ctx.out.match(/�/g) || []).length;
    // Mostly unreadable codes, or no words at all: a picture of a page, not text.
    const readable = text.replace(/\s/g, '').length > 0 && bad < text.length;
    if (!readable) { empty++; blank.push(p); }
    out.push(`--- Page ${p} of ${total} ---\n${readable ? text : NO_TEXT}`);
    size += text.length;
    last = p;
  }
  return { text: out.join('\n\n'), total, from, last, empty, blank, shown: last - from + 1 };
}
const NO_TEXT = '(no readable text on this page: it is probably a scanned picture)';

// ---------- the one entry point file_read uses ----------
// Returns MCP content for the file, or null when it is plain text (file_read reads that itself).
const OFFICE = { '.docx': docxText, '.docm': docxText, '.dotx': docxText, '.xlsx': xlsxText, '.xlsm': xlsxText, '.pptx': pptxText, '.pptm': pptxText, '.ppsx': pptxText, '.odt': odfText, '.ods': odfText, '.odp': odfText };
const OLD = { '.doc': 'Word', '.xls': 'Excel', '.ppt': 'PowerPoint' };
const BIG = 50e6;
const t = (text) => ({ type: 'text', text });

export function readDocument(file, size, opts = {}) {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  if (OFFICE[ext]) {
    if (size > BIG) return [t(`${name} is ${Math.round(size / 1e6)} MB, too big to read here. Open it with desktop_open_file and read it with desktop_read.`)];
    const zip = unzip(fs.readFileSync(file));
    const body = cap(OFFICE[ext](zip, opts) || '(no text in it)');
    const content = [t(body)];
    if (opts.images) {
      const { content: pics, skipped } = officeImages(zip);
      content.push(...pics);
      if (skipped.length) content.push(t(`(${skipped.length} more pictures not shown: ${skipped.slice(0, 10).join(', ')})`));
    } else {
      const n = zip.names.filter((x) => /^(word|ppt|xl)\/media\//.test(x)).length;
      if (n) content.push(t(`(It has ${n} picture${n > 1 ? 's' : ''}. Call file_read again with images: true to see them.)`));
    }
    return content;
  }
  if (OLD[ext]) return [t(`${name} is in the old ${OLD[ext]} format (before 2007), which Stead can't read directly. Open it with desktop_open_file and read it with desktop_read, or save it as ${ext}x in ${OLD[ext]} first.`)];
  if (ext === '.pdf') {
    if (size > BIG) return [t(`${name} is ${Math.round(size / 1e6)} MB, too big to read here: ${pdfOpen(file)}.`)];
    return pdfReply(file, pdfText(fs.readFileSync(file), opts));
  }
  if (IMAGE_MIME[ext] || ['.bmp', '.tif', '.tiff'].includes(ext)) {
    const c = imageContent(file, size);
    return c || [t(`${name} is too big to send as a picture (${Math.round(size / 1e6)} MB) and couldn't be shrunk here. Open it with desktop_open_file and take a desktop_screenshot.`)];
  }
  if (['.heic', '.heif'].includes(ext)) return [t(`${name} is an iPhone photo (HEIC), which Stead can't send as a picture. Open it with desktop_open_file and take a desktop_screenshot.`)];
  return null;
}

const pdfOpen = (file) => `open it in the browser instead (browser_navigate to ${new URL(`file:///${file.replace(/\\/g, '/').replace(/^\/+/, '')}`).href}) and take a screenshot of each page`;
function pdfReply(file, r) {
  const name = path.basename(file), open = pdfOpen(file);
  if (r.encrypted) return [t(`${name} is password-protected or locked, so its text can't be read here: ${open}.`)];
  if (!r.total) return [t(`Couldn't find any pages in ${name} (it may be damaged): ${open}.`)];
  if (r.empty === r.shown) return [t(`${name} has ${r.total} page${r.total > 1 ? 's' : ''} but no text inside: it is scanned pictures of pages. To read it, ${open}.`)];
  const more = r.last < r.total ? `\n\n(Pages ${r.from}-${r.last} of ${r.total} shown. Call file_read again with pages: "${r.last + 1}-${Math.min(r.total, r.last + 30)}" for more.)` : '';
  const pics = r.empty ? `\n\n(${r.empty} page${r.empty > 1 ? 's have' : ' has'} no text, only a picture: to see ${r.empty > 1 ? 'them' : 'it'}, ${open}.)` : '';
  const ocr = r.ocred ? `\n\n(Page${r.ocred > 1 ? 's' : ''} marked "read from the picture" were scanned: their words came from text recognition and can have mistakes.)` : '';
  return [t(cap(r.text) + more + pics + ocr)];
}

// Same as readDocument, but on Windows a scanned PDF page is read with Windows' own text recognition
// (about half a second a page) instead of coming back empty. Anything going wrong there just leaves
// the page as it was: the plain answer still says how to look at it.
const OCR_PAGES = 20;
export async function readDocumentAsync(file, size, opts = {}) {
  if (process.platform !== 'win32' || path.extname(file).toLowerCase() !== '.pdf' || size > BIG) return readDocument(file, size, opts);
  const r = pdfText(fs.readFileSync(file), opts);
  const want = (r.blank || []).slice(0, OCR_PAGES);
  if (!r.encrypted && want.length) {
    try {
      const { call } = await import('./desktop/desktop.js');
      const got = (await call('ocr_pdf', { path: path.resolve(file), pages: want }, 20000 + want.length * 4000)) || {};
      for (const p of want) {
        const words = String(got[p] ?? '').trim();
        if (!words) continue;
        r.text = r.text.replace(`--- Page ${p} of ${r.total} ---\n${NO_TEXT}`, () => `--- Page ${p} of ${r.total} (read from the picture) ---\n${words}`);
        r.empty--; r.ocred = (r.ocred || 0) + 1;
      }
    } catch {}
  }
  return pdfReply(file, r);
}
