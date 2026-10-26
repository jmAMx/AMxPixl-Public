/** Big-endian binary reader shared by the PSD and XCF importers. */
export class Reader {
  private v: DataView;
  pos = 0;
  constructor(readonly buf: ArrayBuffer, pos = 0) { this.v = new DataView(buf); this.pos = pos; }
  get length() { return this.buf.byteLength; }
  u8() { return this.v.getUint8(this.pos++); }
  i8() { return this.v.getInt8(this.pos++); }
  u16() { const x = this.v.getUint16(this.pos); this.pos += 2; return x; }
  i16() { const x = this.v.getInt16(this.pos); this.pos += 2; return x; }
  u32() { const x = this.v.getUint32(this.pos); this.pos += 4; return x; }
  i32() { const x = this.v.getInt32(this.pos); this.pos += 4; return x; }
  f32() { const x = this.v.getFloat32(this.pos); this.pos += 4; return x; }
  /** 64-bit unsigned as a JS number (fine for file offsets). */
  u64() { const hi = this.u32(), lo = this.u32(); return hi * 2 ** 32 + lo; }
  str(n: number) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
  bytes(n: number) { const b = new Uint8Array(this.buf, this.pos, n); this.pos += n; return b; }
  skip(n: number) { this.pos += n; }
}

/** Inflates a zlib stream with the browser's built-in decompressor. */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const halfToFloat = (h: number) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
};

const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * Converts one big-endian sample of `bytes` size (8/16/32-bit integer, 16/32/64-bit float) at `p` to 0..255.
 * Linear-light data is converted to sRGB (alpha stays linear).
 */
export function sampleTo8(b: Uint8Array, p: number, bytes: number, float: boolean, linear: boolean): number {
  let v: number;
  if (!float) {
    if (bytes === 1) v = b[p] / 255;
    else if (bytes === 2) v = ((b[p] << 8) | b[p + 1]) / 65535;
    else v = ((b[p] * 2 ** 24) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]) / 4294967295;
  } else {
    const dv = new DataView(b.buffer, b.byteOffset + p, bytes);
    v = bytes === 2 ? halfToFloat(dv.getUint16(0)) : bytes === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
  }
  if (!(v >= 0)) v = 0;
  if (v > 1) v = 1;
  if (linear) v = toSrgb(v);
  return Math.round(v * 255);
}
