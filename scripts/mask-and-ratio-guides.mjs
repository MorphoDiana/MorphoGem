/**
 * MorphoGem Clean-Room Mask Overlay & Orthographic Ratio Ruler Guide Helper (MIT License).
 *
 * Uses `scripts/prepare_guides.py` (Pillow) when Python + PIL is available (supporting PNG/JPG/WebP),
 * with a 100% pure Node.js (`node:zlib`) PNG encoder/decoder fallback so `export-inputs`
 * ALWAYS generates orthographic proportion ruler grids and PNG mask overlays even without Python!
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findBundledPython} from '../server-blender.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREPARE_GUIDES_PY = path.join(__dirname, 'prepare_guides.py');

// --- CRC32 & Pure Node.js PNG Encoder / Decoder ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, dataBuf])), 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

export function encodeRgbaPng(width, height, rgbaUint8) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter 0 (None)
    Buffer.from(rgbaUint8.buffer, rgbaUint8.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, {level: 6});
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePngToRgba(buf) {
  if (buf.length < 32 || buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) {
    throw Error('Not a PNG buffer');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idatParts = [];

  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) {
    throw Error('Unsupported PNG variant for pure-JS fallback');
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : colorType === 3 ? 1 : 0;
  if (!channels) throw Error('Unsupported PNG colorType');

  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const bpp = channels;
  const rowBytes = width * bpp;
  const recon = new Uint8Array(height * rowBytes);

  for (let y = 0; y < height; y++) {
    const fType = inflated[y * (rowBytes + 1)];
    const srcOff = y * (rowBytes + 1) + 1;
    const dstOff = y * rowBytes;
    const prevOff = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const rawByte = inflated[srcOff + x];
      const a = x >= bpp ? recon[dstOff + x - bpp] : 0;
      const b = y > 0 ? recon[prevOff + x] : 0;
      const c = (y > 0 && x >= bpp) ? recon[prevOff + x - bpp] : 0;
      let val = rawByte;
      if (fType === 1) val = (rawByte + a) & 0xff;
      else if (fType === 2) val = (rawByte + b) & 0xff;
      else if (fType === 3) val = (rawByte + ((a + b) >> 1)) & 0xff;
      else if (fType === 4) val = (rawByte + paethPredictor(a, b, c)) & 0xff;
      recon[dstOff + x] = val;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (colorType === 6) {
      rgba[o] = recon[o]; rgba[o + 1] = recon[o + 1]; rgba[o + 2] = recon[o + 2]; rgba[o + 3] = recon[o + 3];
    } else if (colorType === 2) {
      const s = i * 3;
      rgba[o] = recon[s]; rgba[o + 1] = recon[s + 1]; rgba[o + 2] = recon[s + 2]; rgba[o + 3] = 255;
    } else if (colorType === 4) {
      const s = i * 2;
      rgba[o] = recon[s]; rgba[o + 1] = recon[s]; rgba[o + 2] = recon[s]; rgba[o + 3] = recon[s + 1];
    } else if (colorType === 0) {
      const v = recon[i];
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    } else if (colorType === 3 && palette) {
      const idx = recon[i];
      rgba[o] = palette[idx * 3] || 0;
      rgba[o + 1] = palette[idx * 3 + 1] || 0;
      rgba[o + 2] = palette[idx * 3 + 2] || 0;
      rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return {width, height, rgba};
}

function runPythonHelper(args) {
  return new Promise(async resolve => {
    const pyCmd = await findBundledPython();
    if (!pyCmd) {
      resolve(false);
      return;
    }
    const child = spawn(pyCmd, [PREPARE_GUIDES_PY, ...args], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

// --- Pure-JS Fallback Proportion Ruler ---
export function renderPureJsRatioRulerPng(ratioNumeric, size = 1024, pose = 't') {
  const r = Math.max(1.5, Math.min(9.5, Number(ratioNumeric) || 6.8));
  const s = Math.max(512, Math.min(2048, Math.round(size)));
  const rgba = new Uint8Array(s * s * 4);
  rgba.fill(255);

  const setPx = (x, y, cr, cg, cb) => {
    if (x < 0 || x >= s || y < 0 || y >= s) return;
    const i = (y * s + x) * 4;
    rgba[i] = cr; rgba[i + 1] = cg; rgba[i + 2] = cb; rgba[i + 3] = 255;
  };
  const fillRect = (x0, y0, x1, y1, cr, cg, cb) => {
    const ax = Math.max(0, Math.min(x0, x1));
    const bx = Math.min(s - 1, Math.max(x0, x1));
    const ay = Math.max(0, Math.min(y0, y1));
    const by = Math.min(s - 1, Math.max(y0, y1));
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) setPx(x, y, cr, cg, cb);
    }
  };
  const fillEllipse = (cx, cy, rx, ry, cr, cg, cb) => {
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1.0) {
          setPx(cx + dx, cy + dy, cr, cg, cb);
        }
      }
    }
  };
  const drawThickSeg = (x0, y0, x1, y1, rad, cr, cg, cb) => {
    const steps = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
    for (let t = 0; t <= steps; t++) {
      const px = Math.round(x0 + ((x1 - x0) * t) / steps);
      const py = Math.round(y0 + ((y1 - y0) * t) / steps);
      fillEllipse(px, py, rad, rad, cr, cg, cb);
    }
  };

  const topY = Math.round(s * 0.06);
  const botY = Math.round(s * 0.94);
  const spanH = botY - topY;
  const headH = spanH / r;
  const chinY = Math.round(topY + headH);
  const cx = s >> 1;

  fillRect(Math.round(s * 0.14), topY, Math.round(s * 0.86), chinY, 232, 250, 255);
  fillRect(Math.round(s * 0.14), chinY, Math.round(s * 0.86), botY, 245, 248, 252);

  const headRx = Math.max(14, Math.round(headH * (r <= 3.5 ? 0.44 : 0.37)));
  const headRy = Math.max(16, Math.round(headH * 0.49));
  fillEllipse(cx, Math.round(topY + headH * 0.5), headRx + 2, headRy + 2, 14, 116, 144);
  fillEllipse(cx, Math.round(topY + headH * 0.5), headRx, headRy, 186, 230, 253);

  const chibi = Math.max(0, Math.min(1, (4.2 - r) / 2.2));
  const neckH = Math.max(4, Math.round(headH * (r <= 3.2 ? 0.08 : 0.16)));
  const shoulderY = chinY + neckH;
  const torsoFrac = 0.48 * chibi + 0.37 * (1 - chibi);
  const crotchY = Math.round(shoulderY + (botY - shoulderY) * torsoFrac);
  const shoulderHw = Math.round(headRx * (0.95 * chibi + 1.55 * (1 - chibi)));
  const hipHw = Math.round(headRx * (0.92 * chibi + 1.18 * (1 - chibi)));

  fillRect(cx - Math.max(6, Math.round(headRx * 0.3)), chinY, cx + Math.max(6, Math.round(headRx * 0.3)), shoulderY + 4, 203, 213, 225);
  for (let y = shoulderY; y <= crotchY; y++) {
    const u = (y - shoulderY) / Math.max(1, crotchY - shoulderY);
    const hw = Math.round(shoulderHw * (1 - u) + hipHw * u);
    fillRect(cx - hw, y, cx + hw, y, 203, 213, 225);
  }

  const bodyTotal = Math.max(24, spanH - headH);
  const armLen = Math.round(bodyTotal * (0.36 * chibi + 0.42 * (1 - chibi)));
  const armRad = Math.max(4, Math.round(headRx * (0.21 * chibi + 0.15 * (1 - chibi))));
  const ang = ((pose || 't').toLowerCase() === 'a' ? 42 : 4) * (Math.PI / 180);
  for (const sign of [-1, 1]) {
    const sx0 = cx + sign * shoulderHw;
    const sy0 = shoulderY + armRad;
    drawThickSeg(sx0, sy0, Math.round(sx0 + sign * Math.cos(ang) * armLen), Math.round(sy0 + Math.sin(ang) * armLen), armRad, 180, 194, 212);
  }

  const legRad = Math.max(5, Math.round(hipHw * (0.36 * chibi + 0.29 * (1 - chibi))));
  const legOff = Math.max(legRad + 3, Math.round(hipHw * 0.56));
  for (const sign of [-1, 1]) {
    drawThickSeg(cx + sign * legOff, crotchY, cx + sign * legOff, botY - legRad, legRad, 180, 194, 212);
  }

  const wholeSteps = Math.floor(r + 1e-6);
  for (let k = 0; k <= wholeSteps; k++) {
    const yk = Math.round(topY + k * headH);
    const isMajor = k === 0 || k === 1;
    fillRect(Math.round(s * 0.06), yk - 1, Math.round(s * 0.94), yk + (isMajor ? 1 : 0), isMajor ? 225 : 100, isMajor ? 29 : 116, isMajor ? 72 : 139);
  }
  fillRect(Math.round(s * 0.06), botY - 1, Math.round(s * 0.94), botY + 1, 225, 29, 72);

  return encodeRgbaPng(s, s, rgba);
}

// --- Pure-JS Fallback Mask Overlay ---
function parseHexRgbJs(hex) {
  const s = String(hex || '#ff3b30').trim().replace(/^#/, '');
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (!Number.isNaN(r + g + b)) return [r, g, b];
  }
  return [255, 59, 48];
}

export function renderPureJsMaskOverlayPng(srcDecoded, mskDecoded, mode = 'auto', colorHex = '#ff3b30') {
  const {width: w, height: h, rgba: srcPx} = srcDecoded;
  const {width: mw, height: mh, rgba: mskRaw} = mskDecoded;
  const n = w * h;

  // Nearest-neighbor resample mask if dimensions differ
  const mskPx = (mw === w && mh === h) ? mskRaw : (() => {
    const out = new Uint8Array(n * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(mh - 1, Math.floor((y * mh) / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(mw - 1, Math.floor((x * mw) / w));
        const si = (sy * mw + sx) * 4;
        const di = (y * w + x) * 4;
        out[di] = mskRaw[si]; out[di + 1] = mskRaw[si + 1]; out[di + 2] = mskRaw[si + 2]; out[di + 3] = mskRaw[si + 3];
      }
    }
    return out;
  })();

  let effMode = (mode || 'auto').toLowerCase();
  if (effMode === 'auto') {
    let trans = 0;
    let opaq = 0;
    let sat = 0;
    for (let i = 0; i < n; i += 16) {
      const o = i * 4;
      const r = mskPx[o]; const g = mskPx[o + 1]; const b = mskPx[o + 2]; const a = mskPx[o + 3];
      if (a < 128) trans++; else opaq++;
      if (a >= 64 && (Math.max(r, g, b) - Math.min(r, g, b)) > 45) sat++;
    }
    const tot = Math.max(1, trans + opaq);
    if (trans > 0 && opaq / tot >= 0.03 && opaq / tot <= 0.94) effMode = 'alpha';
    else if (sat / tot > 0.04) effMode = 'painted';
    else effMode = 'white';
  }

  const fg = new Uint8Array(n);
  const [tr, tg, tb] = parseHexRgbJs(colorHex);
  const tolSq = 68 * 68;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = mskPx[o]; const g = mskPx[o + 1]; const b = mskPx[o + 2]; const a = mskPx[o + 3];
    if (effMode === 'alpha') {
      if (a >= 96) fg[i] = 1;
    } else if (effMode === 'color') {
      if (a >= 48 && ((r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2) <= tolSq) fg[i] = 1;
    } else if (effMode === 'painted') {
      if (a >= 64 && (Math.max(r, g, b) - Math.min(r, g, b)) > 40) fg[i] = 1;
    } else {
      if (a >= 64 && (r + g + b) >= 360) fg[i] = 1;
    }
  }

  const out = new Uint8Array(n * 4);
  const rad = Math.max(2, Math.min(4, Math.round(Math.max(w, h) / 360)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const af = srcPx[o + 3] / 255;
      const r = Math.round(srcPx[o] * af + 24 * (1 - af));
      const g = Math.round(srcPx[o + 1] * af + 28 * (1 - af));
      const b = Math.round(srcPx[o + 2] * af + 38 * (1 - af));

      if (fg[i]) {
        let edge = false;
        for (const dy of [-rad, 0, rad]) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) { edge = true; break; }
          for (const dx of [-rad, 0, rad]) {
            const nx = x + dx;
            if (nx < 0 || nx >= w || !fg[ny * w + nx]) { edge = true; break; }
          }
          if (edge) break;
        }
        if (edge) {
          out[o] = 0; out[o + 1] = 240; out[o + 2] = 255; out[o + 3] = 255;
        } else {
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        }
      } else {
        out[o] = Math.round(r * 0.20 + 10);
        out[o + 1] = Math.round(g * 0.20 + 14);
        out[o + 2] = Math.round(b * 0.22 + 22);
        out[o + 3] = 255;
      }
    }
  }
  return encodeRgbaPng(w, h, out);
}

export async function generateRatioRulerGuide({ratio, size = 1024, pose = 't', outPath}) {
  const ok = await runPythonHelper([
    'ratio-ruler',
    '--ratio', String(ratio),
    '--size', String(size),
    '--pose', String(pose || 't'),
    '--out', outPath,
  ]);
  if (ok) return outPath;
  const pngBuf = renderPureJsRatioRulerPng(ratio, size, pose);
  await fs.mkdir(path.dirname(outPath), {recursive: true});
  await fs.writeFile(outPath, pngBuf);
  return outPath;
}

export async function generateMaskOverlayGuide({sourcePath, maskPath, mode = 'auto', colorHex = '#ff3b30', outPath}) {
  const ok = await runPythonHelper([
    'mask-overlay',
    '--source', sourcePath,
    '--mask', maskPath,
    '--mode', String(mode || 'auto'),
    '--color', String(colorHex || '#ff3b30'),
    '--out', outPath,
  ]);
  if (ok) return outPath;

  // Fallback to pure-JS PNG decoder if both files are PNG
  try {
    const [srcBuf, mskBuf] = await Promise.all([fs.readFile(sourcePath), fs.readFile(maskPath)]);
    const srcDec = decodePngToRgba(srcBuf);
    const mskDec = decodePngToRgba(mskBuf);
    const overlayBuf = renderPureJsMaskOverlayPng(srcDec, mskDec, mode, colorHex);
    await fs.mkdir(path.dirname(outPath), {recursive: true});
    await fs.writeFile(outPath, overlayBuf);
    return outPath;
  } catch {
    return null;
  }
}
