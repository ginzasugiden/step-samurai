// node tools/build-extension.js — extension/ の中身を dist/step-samurai-review-ext-<version>.zip にまとめる。
// manifest.json が zip のルート。tests/ や tools/ は含めない。エントリはスラッシュ区切り（外部ツール不使用）。
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const OUT = path.join(ROOT, 'dist', `step-samurai-review-ext-${manifest.version}.zip`);

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function walk(dir, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    if (e.name.startsWith('.')) return [];
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), r) : [r];
  });
}

const files = walk(SRC);
const DOS_TIME = (0 << 11) | (0 << 5) | 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;   // 固定（再現性のため）
const locals = [], centrals = [];
let offset = 0;
for (const name of files) {
  const data = fs.readFileSync(path.join(SRC, name));
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = comp.length < data.length;
  const body = useDeflate ? comp : data, method = useDeflate ? 8 : 0;
  const nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14); cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(offset, 42);
  locals.push(lh, nameBuf, body); centrals.push(cd, nameBuf);
  offset += lh.length + nameBuf.length + body.length;
}
const cdBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...locals, cdBuf, end]));
console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes, ${files.length} entries)`);
files.forEach(f => console.log('  ' + f));
