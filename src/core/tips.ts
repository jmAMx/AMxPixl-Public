import { ctx2d, newCanvas } from './layers';

/**
 * Brush tips: the shape of one dab. 'round' is the classic soft/hard round brush (drawn from hardness). The others
 * are textures (alpha = how much paint lands): built-ins are generated here, custom ones come from an image the
 * user picks (dark = paint) and are kept in localStorage.
 */

export interface TipInfo { id: string; label: string }

const SIZE = 128;
const CUSTOM_KEY = 'amxpixl.tips';

/** Small seeded random so built-in tips look the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function draw(fn: (x: CanvasRenderingContext2D, r: () => number) => void, seed: number) {
  const c = newCanvas(SIZE, SIZE);
  const x = ctx2d(c);
  x.fillStyle = '#000';
  fn(x, rng(seed));
  return c;
}

const BUILTIN: { id: string; label: string; make: () => HTMLCanvasElement }[] = [
  {
    id: 'chalk', label: 'Chalk', make: () => draw((x, r) => {
      // A round dab broken up by grain.
      for (let i = 0; i < 2600; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 60;
        x.globalAlpha = 0.25 + r() * 0.6;
        x.fillRect(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 1 + r() * 2.2, 1 + r() * 2.2);
      }
    }, 7),
  },
  {
    id: 'spray', label: 'Spray', make: () => draw((x, r) => {
      // Fine dots, denser in the middle.
      for (let i = 0; i < 520; i++) {
        const a = r() * Math.PI * 2, d = (r() * r()) * 62;
        x.globalAlpha = 0.5 + r() * 0.5;
        x.beginPath(); x.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 0.6 + r() * 1.4, 0, 7); x.fill();
      }
    }, 11),
  },
  {
    id: 'charcoal', label: 'Charcoal', make: () => draw((x, r) => {
      // Streaky, wider than tall.
      for (let i = 0; i < 140; i++) {
        const y = 64 + (r() - 0.5) * 70, w = 40 + r() * 70;
        x.globalAlpha = 0.08 + r() * 0.25;
        x.fillRect(64 - w / 2 + (r() - 0.5) * 20, y, w, 1 + r() * 3);
      }
    }, 23),
  },
  {
    id: 'grain', label: 'Grain', make: () => draw((x, r) => {
      // Rough paper texture in a soft square.
      for (let y = 0; y < SIZE; y += 2) for (let xx = 0; xx < SIZE; xx += 2) {
        const e = Math.min(xx, y, SIZE - xx, SIZE - y) / 24;
        if (r() > Math.min(1, e) * 0.7) continue;
        x.globalAlpha = 0.3 + r() * 0.7;
        x.fillRect(xx, y, 2, 2);
      }
    }, 31),
  },
  {
    id: 'splatter', label: 'Splatter', make: () => draw((x, r) => {
      // A few blobs of different sizes.
      for (let i = 0; i < 26; i++) {
        const a = r() * Math.PI * 2, d = r() * 52, s = 2 + r() * r() * 16;
        x.globalAlpha = 0.85;
        x.beginPath(); x.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, s, 0, 7); x.fill();
      }
    }, 43),
  },
  {
    id: 'square', label: 'Square', make: () => draw((x) => { x.fillRect(8, 8, 112, 112); }, 1),
  },
];

const cache = new Map<string, HTMLCanvasElement>();

function customTips(): Record<string, { label: string; data: string }> {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}'); } catch { return {}; }
}

export function listTips(): TipInfo[] {
  return [
    { id: 'round', label: 'Round' },
    ...BUILTIN.map(({ id, label }) => ({ id, label })),
    ...Object.entries(customTips()).map(([id, t]) => ({ id, label: t.label })),
  ];
}

/** The tip's texture (alpha = paint), or null for the plain round brush. Custom tips load asynchronously the first
 * time; until then this returns null and `onLoaded` fires when it's ready. */
export function getTip(id: string | undefined, onLoaded?: () => void): HTMLCanvasElement | null {
  if (!id || id === 'round') return null;
  const hit = cache.get(id);
  if (hit) return hit;
  const b = BUILTIN.find((t) => t.id === id);
  if (b) { const c = b.make(); cache.set(id, c); return c; }
  const custom = customTips()[id];
  if (!custom) return null;
  const img = new Image();
  img.onload = () => {
    const c = newCanvas(img.width, img.height);
    ctx2d(c).drawImage(img, 0, 0);
    cache.set(id, c);
    onLoaded?.();
  };
  img.src = custom.data;
  return null;
}

/** Turns a picked image into a tip: dark areas paint, light/transparent don't. Returns the new tip's id. */
export async function addCustomTip(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  // Square it up so dabs keep their proportions.
  const n = Math.max(w, h);
  const c = newCanvas(n, n);
  const x = ctx2d(c, true);
  x.drawImage(bmp, (n - w) / 2, (n - h) / 2, w, h);
  const d = x.getImageData(0, 0, n, n);
  for (let i = 0; i < d.data.length; i += 4) {
    const lum = (0.2126 * d.data[i] + 0.7152 * d.data[i + 1] + 0.0722 * d.data[i + 2]) / 255;
    d.data[i + 3] = Math.round((1 - lum) * d.data[i + 3]);
    d.data[i] = d.data[i + 1] = d.data[i + 2] = 0;
  }
  x.putImageData(d, 0, 0);
  const id = `custom-${Date.now().toString(36)}`;
  const all = customTips();
  all[id] = { label: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Custom', data: c.toDataURL('image/png') };
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(all)); } catch { throw new Error('There is no room left to store more brush tips. Remove one first.'); }
  cache.set(id, c);
  return id;
}

export function removeCustomTip(id: string) {
  const all = customTips();
  delete all[id];
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(all)); } catch { /* ignore */ }
  cache.delete(id);
}

/** A tip coloured `color`, `d` pixels across, at `flow` (cached). */
const stampCache = new Map<string, HTMLCanvasElement>();
export function tipStamp(id: string, tip: HTMLCanvasElement, color: string, d: number, flow: number) {
  const size = Math.max(2, Math.min(2048, Math.ceil(d)));
  const key = `${id}|${color}|${size}|${flow.toFixed(2)}`;
  const hit = stampCache.get(key);
  if (hit) return hit;
  if (stampCache.size > 24) stampCache.clear();
  const c = newCanvas(size, size);
  const x = ctx2d(c);
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(tip, 0, 0, size, size);
  x.globalCompositeOperation = 'source-in';
  x.globalAlpha = flow;
  x.fillStyle = color;
  x.fillRect(0, 0, size, size);
  stampCache.set(key, c);
  return c;
}
