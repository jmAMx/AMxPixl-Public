import type opentype from 'opentype.js';
import { corner } from './paths';
import { isDesktop, readPath } from './platform';
import { layoutText, pathLetters } from './text';
import type { PathPoint, SubPath, TextProps } from './types';

/**
 * Text to outlines: the letters' actual shapes from the font file, as editable paths. On the desktop the font file is
 * found through Windows' list of installed fonts; in a browser, through Local Font Access.
 */

let installed: [string, string][] | null = null;

/** Words in a font's style name and how heavy they are (400 = regular). */
const WEIGHTS: [RegExp, number][] = [
  [/\b(thin|hairline)\b/i, 100], [/\b(extra|ultra)\s?light\b/i, 200], [/\blight\b/i, 300], [/\bsemi\s?light\b/i, 350],
  [/\bmedium\b/i, 500], [/\b(semi|demi)\s?bold\b/i, 600], [/\b(extra|ultra)\s?bold\b/i, 800], [/\bbold\b/i, 700], [/\b(black|heavy)\b/i, 900],
];
const weightOf = (style: string) => { for (const [re, w] of WEIGHTS) if (re.test(style)) return w; return 400; };

/** The best match among (style words, value) pairs for a weight and italic, or null if none. */
function bestMatch<T>(cands: { style: string; v: T }[], weight: number, italic: boolean): T | null {
  let best: T | null = null, score = Infinity;
  for (const c of cands) {
    const it = /\b(italic|oblique)\b/i.test(c.style);
    const s = Math.abs(weightOf(c.style) - weight) + (it === italic ? 0 : 1000);
    if (s < score) { score = s; best = c.v; }
  }
  return best;
}

async function fontFileFromWindows(family: string, weight: number, italic: boolean): Promise<ArrayBuffer | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  installed ??= await invoke<[string, string][]>('font_files');
  const path = pickFontFile(installed, family, weight, italic);
  return path ? (await readPath(path)).arrayBuffer() : null;
}

/** From Windows' font list ([name, file path] pairs), the file for a family, weight and italic; null if none. */
export function pickFontFile(list: [string, string][], family: string, weight: number, italic: boolean): string | null {
  const fam = family.toLowerCase();
  const cands: { style: string; v: string | null }[] = [];
  for (const [name, path] of list) {
    // "Segoe UI Bold Italic (TrueType)" -> family "Segoe UI", style "Bold Italic" ("SPOTNIK-Bold" works too). One
    // file can hold several ("Cambria & Cambria Math").
    for (const clean of name.replace(/\s*\([^)]*\)\s*$/, '').split(/\s*&\s*/)) {
      if (!clean.toLowerCase().startsWith(fam)) continue;
      const style = clean.slice(family.length).replace(/^[\s\-_,]+/, '').trim();
      // "Segoe UI Emoji" isn't a style of "Segoe UI": only style words may follow the family name.
      if (style && !/^((thin|hairline|extra|ultra|semi|demi|light|regular|normal|book|medium|bold|black|heavy|italic|oblique)[\s\-_]*)+$/i.test(style)) continue;
      // (A font collection, .ttc, is read too: fontFromFile picks the right font inside it.)
      cands.push({ style, v: path });
    }
  }
  return bestMatch(cands, weight, italic);
}

async function fontFileFromBrowser(family: string, weight: number, italic: boolean): Promise<ArrayBuffer | null> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string; style: string; blob(): Promise<Blob> }[]> }).queryLocalFonts;
  if (!q) return null;
  const all = await q();
  const f = bestMatch(all.filter((x) => x.family.toLowerCase() === family.toLowerCase()).map((x) => ({ style: x.style, v: x })), weight, italic);
  return f ? (await f.blob()).arrayBuffer() : null;
}

const loaded = new Map<string, opentype.Font | null>();

/**
 * The font file reader, loaded the first time it's needed: it's large (about a third of the app's own code), and
 * only Text to Outlines uses it, so leaving it out of start-up makes Pixl open faster.
 */
const reader = () => import('opentype.js').then((m) => m.default);

/**
 * The fonts in a font collection (.ttc: several fonts in one file, sharing tables), each as a standalone font file:
 * its table directory, with the tables it uses copied after it.
 */
function collectionFonts(buf: ArrayBuffer): ArrayBuffer[] {
  const dv = new DataView(buf);
  const out: ArrayBuffer[] = [];
  for (let f = 0, n = dv.getUint32(8); f < n; f++) {
    const at = dv.getUint32(12 + f * 4), count = dv.getUint16(at + 4);
    const tables = Array.from({ length: count }, (_, t) => {
      const r = at + 12 + t * 16;
      return { tag: dv.getUint32(r), sum: dv.getUint32(r + 4), off: dv.getUint32(r + 8), len: dv.getUint32(r + 12) };
    });
    const head = 12 + count * 16;
    const font = new ArrayBuffer(tables.reduce((s, t) => s + ((t.len + 3) & ~3), head));
    const fv = new DataView(font), fb = new Uint8Array(font);
    fb.set(new Uint8Array(buf, at, 12), 0);
    let pos = head;
    tables.forEach((t, i) => {
      const r = 12 + i * 16;
      fv.setUint32(r, t.tag); fv.setUint32(r + 4, t.sum); fv.setUint32(r + 8, pos); fv.setUint32(r + 12, t.len);
      fb.set(new Uint8Array(buf, t.off, t.len), pos);
      pos += (t.len + 3) & ~3;
    });
    out.push(font);
  }
  return out;
}

/**
 * A font from a font file's bytes (.ttf / .otf / .woff, or a .ttc collection: then the one in it that best matches
 * `want`, by its family and style names).
 */
export async function fontFromFile(buf: ArrayBuffer, want?: { family: string; weight: number; italic: boolean }): Promise<opentype.Font> {
  const ot = await reader();
  if (new DataView(buf).getUint32(0) !== 0x74746366 /* "ttcf" */) return ot.parse(buf);
  const fonts = collectionFonts(buf).map((b) => ot.parse(b));
  if (!want) return fonts[0];
  const name = (f: opentype.Font, k: string) => (f.names as unknown as Record<string, { en?: string } | undefined>)[k]?.en ?? '';
  const fam = want.family.toLowerCase();
  const famOf = (f: opentype.Font) => (name(f, 'typographicFamily') || name(f, 'preferredFamily') || name(f, 'fontFamily')).toLowerCase();
  const styleOf = (f: opentype.Font) => name(f, 'typographicSubfamily') || name(f, 'preferredSubfamily') || name(f, 'fontSubfamily');
  const same = fonts.filter((f) => famOf(f) === fam);
  const cands = (same.length ? same : fonts.filter((f) => famOf(f).startsWith(fam) || fam.startsWith(famOf(f))));
  return bestMatch((cands.length ? cands : fonts).map((f) => ({ style: styleOf(f), v: f })), want.weight, want.italic) ?? fonts[0];
}

/** The font for a text style, or null if its file can't be found or read. */
export async function loadFont(family: string, weight: number, italic: boolean): Promise<opentype.Font | null> {
  const key = `${family}|${weight}|${italic}`;
  if (loaded.has(key)) return loaded.get(key)!;
  let font: opentype.Font | null = null;
  try {
    const buf = isDesktop ? await fontFileFromWindows(family, weight, italic) : await fontFileFromBrowser(family, weight, italic);
    font = buf ? await fontFromFile(buf, { family, weight, italic }) : null;
  } catch { font = null; }
  loaded.set(key, font);
  return font;
}

/** opentype's drawing commands as paths with absolute handles (quadratic curves raised to cubic). */
function commandsToSubs(cmds: opentype.PathCommand[]): SubPath[] {
  const subs: SubPath[] = [];
  let cur: PathPoint[] = [];
  const near = (a: PathPoint, b: PathPoint) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  for (const c of cmds) {
    if (c.type === 'M') { cur = [corner(c.x, c.y)]; subs.push({ closed: false, pts: cur }); continue; }
    const p = cur[cur.length - 1];
    if (!p && c.type !== 'Z') continue;
    if (c.type === 'L') cur.push(corner(c.x, c.y));
    else if (c.type === 'C') {
      p.ox = c.x1; p.oy = c.y1;
      cur.push({ x: c.x, y: c.y, ix: c.x2, iy: c.y2, ox: c.x, oy: c.y });
    } else if (c.type === 'Q') {
      p.ox = p.x + (2 / 3) * (c.x1 - p.x); p.oy = p.y + (2 / 3) * (c.y1 - p.y);
      cur.push({ x: c.x, y: c.y, ix: c.x + (2 / 3) * (c.x1 - c.x), iy: c.y + (2 / 3) * (c.y1 - c.y), ox: c.x, oy: c.y });
    } else if (c.type === 'Z' && subs.length) {
      subs[subs.length - 1].closed = true;
      // Fonts often end a contour back on its first point: keep one point there, with the incoming curve.
      const f = cur[0], l = cur[cur.length - 1];
      if (cur.length > 1 && near(f, l)) { f.ix = l.ix; f.iy = l.iy; cur.pop(); }
    }
  }
  return subs.filter((s) => s.pts.length > 1);
}

/**
 * The text's letters as paths, in the text layer's own pixels, lined up as it's drawn (same lines, alignment,
 * baseline and letter spacing).
 */
export function outlineText(tp: TextProps, font: opentype.Font): SubPath[] {
  if (tp.onPath) return outlineOnPath(tp, font);
  const lay = layoutText(tp);
  const opts = { kerning: true, letterSpacing: tp.tracking / tp.size };
  const subs: SubPath[] = [];
  lay.lines.forEach((line, i) => {
    if (!line) return;
    const adv = font.getAdvanceWidth(line, tp.size, opts);
    const x = tp.align === 'center' ? (lay.w - adv) / 2 : tp.align === 'right' ? lay.w - adv : 0;
    subs.push(...commandsToSubs(font.getPath(line, x, i * lay.lineH + lay.ascent, tp.size, opts).commands));
  });
  return subs;
}

/** Text on a path as outlines: each letter's shape placed and turned exactly as the letter is drawn on the path. */
function outlineOnPath(tp: TextProps, font: opentype.Font): SubPath[] {
  const subs: SubPath[] = [];
  for (const l of pathLetters(tp)) {
    const c = Math.cos(l.angle), s = Math.sin(l.angle);
    const at = (x: number, y: number) => ({ x: l.x + c * x - s * y, y: l.y + s * x + c * y });
    // The letter's own shape, standing on its foot at the middle, then turned and moved onto the path.
    const cmds = font.getPath(l.ch, -l.w / 2 + tp.tracking / 2, 0, tp.size).commands.map((cmd) => {
      const o = { ...cmd } as opentype.PathCommand & Record<string, number>;
      for (const [kx, ky] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2']] as const) {
        if (typeof o[kx] === 'number') { const p = at(o[kx], o[ky]); o[kx] = p.x; o[ky] = p.y; }
      }
      return o;
    });
    subs.push(...commandsToSubs(cmds));
  }
  return subs;
}
