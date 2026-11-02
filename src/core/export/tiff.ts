import { ctx2d } from '../layers';

/**
 * A TIFF of the picture: 8 bits a channel, RGB with transparency (unassociated alpha), compressed with Deflate and
 * the horizontal predictor (each pixel stored as its difference from the one before), which every TIFF reader takes.
 */
export async function encodeTiff(c: HTMLCanvasElement): Promise<Blob> {
  const w = c.width, h = c.height;
  const px = ctx2d(c, true).getImageData(0, 0, w, h).data;
  // Strips of about 256 KB each, compressed one by one.
  const rows = Math.max(1, Math.floor(262144 / (w * 4)));
  const strips: Uint8Array[] = [];
  for (let y = 0; y < h; y += rows) {
    const n = Math.min(rows, h - y);
    const d = new Uint8Array(px.buffer, px.byteOffset + y * w * 4, n * w * 4).slice();
    for (let r = 0; r < n; r++) for (let x = w - 1; x > 0; x--) for (let k = 0; k < 4; k++) {
      const i = (r * w + x) * 4 + k;
      d[i] = (d[i] - d[i - 4]) & 255;
    }
    strips.push(new Uint8Array(await new Response(new Blob([d as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()));
  }

  // Header, then the strips, then the tag values too big to sit in a tag, then the tags (IFD).
  const le = (n: number, bytes: number) => { const b = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) b[i] = (n >>> (8 * i)) & 255; return b; };
  let at = 8;
  const offsets = strips.map((s) => { const o = at; at += s.length + (s.length % 2); return o; });
  const extra: Uint8Array[] = [];
  const put = (b: Uint8Array) => { const o = at; extra.push(b); at += b.length; return o; };
  const bits = put(new Uint8Array([8, 0, 8, 0, 8, 0, 8, 0]));
  const res = put(new Uint8Array([...le(72, 4), ...le(1, 4)]));
  const many = strips.length > 1;
  const offs = many ? put(new Uint8Array(offsets.flatMap((o) => [...le(o, 4)]))) : offsets[0];
  const lens = many ? put(new Uint8Array(strips.flatMap((s) => [...le(s.length, 4)]))) : strips[0].length;
  const SHORT = 3, LONG = 4, RATIONAL = 5;
  const tags: [number, number, number, number][] = [
    [256, LONG, 1, w], [257, LONG, 1, h], [258, SHORT, 4, bits], [259, SHORT, 1, 8], [262, SHORT, 1, 2],
    [273, LONG, strips.length, offs], [277, SHORT, 1, 4], [278, LONG, 1, rows], [279, LONG, strips.length, lens],
    [282, RATIONAL, 1, res], [283, RATIONAL, 1, res], [284, SHORT, 1, 1], [296, SHORT, 1, 2], [317, SHORT, 1, 2], [338, SHORT, 1, 2],
  ];
  const ifd = new Uint8Array(2 + tags.length * 12 + 4);
  ifd.set(le(tags.length, 2), 0);
  tags.forEach(([tag, type, count, value], i) => {
    const o = 2 + i * 12;
    ifd.set(le(tag, 2), o); ifd.set(le(type, 2), o + 2); ifd.set(le(count, 4), o + 4);
    ifd.set(type === SHORT && count === 1 ? le(value, 2) : le(value, 4), o + 8);
  });
  const header = new Uint8Array([0x49, 0x49, 42, 0, ...le(at, 4)]);
  const parts: Uint8Array[] = [header];
  for (const s of strips) { parts.push(s); if (s.length % 2) parts.push(new Uint8Array(1)); }
  return new Blob([...parts, ...extra, ifd] as BlobPart[], { type: 'image/tiff' });
}
