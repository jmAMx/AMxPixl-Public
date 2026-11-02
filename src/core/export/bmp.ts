import { ctx2d, newCanvas } from '../layers';

/** A BMP of the picture: 32 bits a pixel with transparency (a BITMAPV4HEADER with channel masks), rows bottom up. */
export function encodeBmp(c: HTMLCanvasElement): Blob {
  const w = c.width, h = c.height;
  const px = ctx2d(c, true).getImageData(0, 0, w, h).data;
  const HEAD = 14 + 108, size = HEAD + w * h * 4;
  const b = new Uint8Array(size), v = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4d; v.setUint32(2, size, true); v.setUint32(10, HEAD, true);
  v.setUint32(14, 108, true); v.setInt32(18, w, true); v.setInt32(22, h, true);
  v.setUint16(26, 1, true); v.setUint16(28, 32, true); v.setUint32(30, 3, true); // BI_BITFIELDS
  v.setUint32(34, w * h * 4, true); v.setUint32(38, 2835, true); v.setUint32(42, 2835, true); // 72 pixels an inch
  v.setUint32(54, 0x00ff0000, true); v.setUint32(58, 0x0000ff00, true); v.setUint32(62, 0x000000ff, true); v.setUint32(66, 0xff000000, true);
  v.setUint32(70, 0x73524742, true); // 'sRGB'
  for (let y = 0; y < h; y++) {
    let o = HEAD + (h - 1 - y) * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      const i = (y * w + x) * 4;
      b[o] = px[i + 2]; b[o + 1] = px[i + 1]; b[o + 2] = px[i]; b[o + 3] = px[i + 3];
    }
  }
  return new Blob([b], { type: 'image/bmp' });
}

/** The sizes an icon holds (those up to the picture's own size, and always 16). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * A Windows icon (.ico) of the picture: one square PNG image per size in ICO_SIZES (up to the picture's own size),
 * the picture fitted in each and centred. `nearest` keeps pixel art blocky.
 */
export async function encodeIco(c: HTMLCanvasElement, nearest = false): Promise<Blob> {
  const most = Math.max(c.width, c.height);
  const sizes = ICO_SIZES.filter((s) => s <= Math.max(16, most));
  const pngs: Uint8Array[] = [];
  for (const s of sizes) {
    const k = s / most, w = Math.max(1, Math.round(c.width * k)), h = Math.max(1, Math.round(c.height * k));
    // Halving in steps keeps a big picture from shimmering when it's shrunk a long way.
    let src = c;
    while (!nearest && src.width / 2 >= w && src.height / 2 >= h) {
      const half = newCanvas(Math.ceil(src.width / 2), Math.ceil(src.height / 2));
      const hx = ctx2d(half); hx.imageSmoothingQuality = 'high'; hx.drawImage(src, 0, 0, half.width, half.height);
      src = half;
    }
    const sq = newCanvas(s, s);
    const x = ctx2d(sq);
    x.imageSmoothingEnabled = !nearest; x.imageSmoothingQuality = 'high';
    x.drawImage(src, Math.floor((s - w) / 2), Math.floor((s - h) / 2), w, h);
    const blob = await new Promise<Blob>((res, rej) => sq.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), 'image/png'));
    pngs.push(new Uint8Array(await blob.arrayBuffer()));
  }
  const head = new Uint8Array(6 + sizes.length * 16), v = new DataView(head.buffer);
  v.setUint16(2, 1, true); v.setUint16(4, sizes.length, true);
  let at = head.length;
  sizes.forEach((s, i) => {
    const o = 6 + i * 16;
    head[o] = s >= 256 ? 0 : s; head[o + 1] = s >= 256 ? 0 : s;
    v.setUint16(o + 4, 1, true); v.setUint16(o + 6, 32, true);
    v.setUint32(o + 8, pngs[i].length, true); v.setUint32(o + 12, at, true);
    at += pngs[i].length;
  });
  return new Blob([head, ...pngs] as BlobPart[], { type: 'image/x-icon' });
}
