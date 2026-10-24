// node tools/make-icons.js — extension/icons/icon{16,48,128}.png を生成する（外部ツールなし・zlib のみ）。
// 単色の背景（角丸）に白い階段（ステップ）を描く。ストア提出 zip には含めない（extension/ の外）。
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const BG = [29, 78, 216], FG = [255, 255, 255];
  const r = size * 0.18;   // 角丸半径
  const inRound = (x, y) => {
    const cx = x < r ? r : x > size - 1 - r ? size - 1 - r : x, cy = y < r ? r : y > size - 1 - r ? size - 1 - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // 3段の階段（左下から右上へ）
  const m = size * 0.2, w = (size - 2 * m) / 3, base = size - m;
  const steps = [0, 1, 2].map(i => ({ x0: m + w * i, x1: m + w * (i + 1), y0: base - w * (i + 1) * 1.0, y1: base }));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    if (!inRound(x, y)) { px[o + 3] = 0; continue; }
    const on = steps.some(s => x >= s.x0 && x < s.x1 && y >= s.y0 && y < s.y1);
    const c = on ? FG : BG;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
  return px;
}

const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 48, 128]) {
  const f = path.join(outDir, `icon${s}.png`);
  fs.writeFileSync(f, encodePng(s, draw(s)));
  console.log('wrote', f);
}
