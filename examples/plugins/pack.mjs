// Packs a plugin folder into a .pixlplugin (a zip), with nothing to install first:
//   node pack.mjs <plugin folder> [out.pixlplugin]
// The zip holds the folder (plugin.json and everything beside it, subfolders too). Without an output name it's
// written next to the folder, named after it.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const [dir, outArg] = process.argv.slice(2);
if (!dir) { console.error('usage: node pack.mjs <plugin folder> [out.pixlplugin]'); process.exit(1); }
const root = resolve(dir), top = basename(root), out = outArg ?? `${root}.pixlplugin`;
if (!statSync(join(root, 'plugin.json'), { throwIfNoEntry: false })) { console.error(`there's no plugin.json in ${root}`); process.exit(1); }

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const files = (d, rel = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name.startsWith('.') ? []
  : e.isDirectory() ? files(join(d, e.name), `${rel}${e.name}/`) : [[join(d, e.name), `${rel}${e.name}`]]);

const parts = [], central = [];
let off = 0, n = 0;
for (const [path, rel] of files(root)) {
  const data = readFileSync(path), comp = deflateRawSync(data), name = Buffer.from(`${top}/${rel}`), crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  parts.push(local, name, comp);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10);
  c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
  central.push(c, name);
  off += 30 + name.length + comp.length; n++;
}
const cd = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
writeFileSync(out, Buffer.concat([...parts, cd, end]));
console.log(`packed ${n} file${n === 1 ? '' : 's'} into ${out}`);
