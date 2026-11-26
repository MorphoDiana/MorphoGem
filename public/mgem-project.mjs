// MorphoGem Clean-Room Project Archive & Binary Inspector (.mgem ZIP container)
import {zipSync, unzipSync} from './vendor/fflate.module.js';
import {ensureNodeGraph, validateNodeGraph} from './node-graph.mjs';
import {normalizeLocale} from './i18n.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const FBX_MAGIC = 'Kaydara FBX Binary  \0';

export const PROJECT_EXT = '.mgem';
export const DEFAULT_PROJECT_NAMES = new Set([
  '新角色',
  '未命名角色',
  'New Character',
  'Untitled Character',
]);

export function safePath(relPath) {
  const p = String(relPath || '');
  if (!p || p.length > 240 || p.startsWith('/') || p.includes('\\') || /[\x00-\x1f]/.test(p)) {
    throw Error(`Invalid archive path: ${p}`);
  }
  const parts = p.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') {
      throw Error(`Unsafe archive path segment: ${p}`);
    }
  }
  return p;
}

export async function sha256(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : enc.encode(String(input));
  const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuf), b => b.toString(16).padStart(2, '0')).join('');
}

export function checkFBX(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 64) {
    throw Error('Invalid FBX file: file is too small.');
  }
  const header = dec.decode(u8.subarray(0, 21));
  if (header !== FBX_MAGIC) {
    throw Error('Invalid FBX file: binary Kaydara FBX header is required.');
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return view.getUint32(23, true);
}

export async function inspectImage(inputBytes, fallbackExt = 'png') {
  const u8 = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  if (u8.byteLength < 16) {
    throw Error('Invalid image file: file is too small.');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR at offset 16..24
  if (
    u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
    u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a &&
    u8.byteLength >= 24
  ) {
    const width = dv.getUint32(16, false);
    const height = dv.getUint32(20, false);
    if (width > 0 && height > 0) return {mime: 'image/png', width, height};
  }

  // JPEG: FF D8 ... scan SOF markers
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < u8.byteLength) {
      if (u8[offset] !== 0xff) { offset++; continue; }
      const marker = u8[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segLen = dv.getUint16(offset + 2, false);
      if (segLen < 2 || offset + 2 + segLen > u8.byteLength) break;
      const isSof = (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 9 <= u8.byteLength) {
        const height = dv.getUint16(offset + 5, false);
        const width = dv.getUint16(offset + 7, false);
        if (width > 0 && height > 0) return {mime: 'image/jpeg', width, height};
      }
      offset += 2 + segLen;
    }
  }

  // WebP: RIFF....WEBP
  if (
    u8.byteLength >= 30 &&
    u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
    u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50
  ) {
    const chunk = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (chunk === 'VP8X') {
      const width = 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16));
      const height = 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16));
      return {mime: 'image/webp', width, height};
    }
    if (chunk === 'VP8 ' && u8.byteLength >= 30) {
      const width = dv.getUint16(26, true) & 0x3fff;
      const height = dv.getUint16(28, true) & 0x3fff;
      return {mime: 'image/webp', width, height};
    }
    if (chunk === 'VP8L' && u8.byteLength >= 25) {
      const b0 = u8[21], b1 = u8[22], b2 = u8[23], b3 = u8[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return {mime: 'image/webp', width, height};
    }
  }

  const ext = String(fallbackExt || '').toLowerCase();
  throw Error(`Unsupported or corrupted image file (${ext || 'unknown'}). Use PNG, JPEG, or WebP.`);
}

export function zipStore(entriesObj) {
  const clean = {};
  for (const [rawKey, rawVal] of Object.entries(entriesObj || {})) {
    const key = safePath(rawKey);
    const u8 = rawVal instanceof Uint8Array ? rawVal : new Uint8Array(rawVal);
    clean[key] = [u8, {level: 0}];
  }
  const zipped = zipSync(clean, {level: 0});
  return new Blob([zipped], {type: 'application/octet-stream'});
}

export async function unzip(input, {maxBytes = 1536 * 1024 * 1024, maxEntries = 2048} = {}) {
  let u8;
  if (input instanceof Uint8Array) {
    u8 = input;
  } else if (input instanceof ArrayBuffer) {
    u8 = new Uint8Array(input);
  } else if (input && typeof input.arrayBuffer === 'function') {
    u8 = new Uint8Array(await input.arrayBuffer());
  } else {
    throw Error('Unsupported archive buffer type.');
  }

  let totalBytes = 0;
  let entryCount = 0;
  const raw = unzipSync(u8, {
    filter(file) {
      if (file.name.endsWith('/')) return false;
      entryCount += 1;
      if (entryCount > maxEntries) throw Error('Archive contains too many entries.');
      totalBytes += file.originalSize || 0;
      if (totalBytes > maxBytes) throw Error('Archive uncompressed size exceeds limit.');
      return true;
    },
  });

  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[safePath(k)] = v;
  }
  return out;
}

export function createNewProject({name = '', locale = 'zh-CN', preset = 'outfit_hair_body'} = {}) {
  const normLoc = normalizeLocale(locale);
  const now = new Date().toISOString();
  const project = {
    format: 'morphogem-project',
    version: 2,
    id: crypto.randomUUID(),
    name: String(name || '').trim() || (normLoc === 'en' ? 'New Character' : '新角色'),
    createdAt: now,
    updatedAt: now,
    targetHeight: 1.60,
    documents: [],
    placements: {},
  };
  ensureNodeGraph(project, preset);
  return project;
}

export function validateProject(p) {
  if (!p || typeof p !== 'object') {
    throw Error('Invalid MorphoGem project data.');
  }
  if (typeof p.id !== 'string' || !p.id.trim()) {
    throw Error('Project is missing a valid ID.');
  }
  p.name = String(p.name || '新角色').trim().slice(0, 120) || '新角色';
  if (!Number.isFinite(p.targetHeight) || p.targetHeight <= 0.05 || p.targetHeight > 20) {
    p.targetHeight = 1.60;
  }
  p.documents = Array.isArray(p.documents) ? p.documents : [];
  for (const doc of p.documents) {
    safePath(doc?.path);
    if (typeof doc?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(doc.sha256)) {
      throw Error(`Invalid SHA-256 digest for document: ${doc?.path}`);
    }
  }
  p.placements = (p.placements && typeof p.placements === 'object') ? p.placements : {};
  ensureNodeGraph(p);
  validateNodeGraph(p);
  return p;
}

export async function packProject(project, filesMap = new Map()) {
  const cloned = structuredClone(project);
  cloned.format = 'morphogem-project';
  cloned.version = 2;
  cloned.updatedAt = new Date().toISOString();
  validateProject(cloned);

  const entries = {};
  for (const doc of cloned.documents) {
    const bytes = filesMap.get(doc.path);
    if (!bytes) {
      throw Error(`Missing binary payload for referenced document: ${doc.path}`);
    }
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    entries[doc.path] = u8;
  }
  entries['project.json'] = enc.encode(JSON.stringify(cloned, null, 2));

  const blob = zipStore(entries);
  const archiveBytes = new Uint8Array(await blob.arrayBuffer());
  const archiveHash = await sha256(archiveBytes);
  return {blob, bytes: archiveBytes, sha256: archiveHash, project: cloned};
}

export async function unpackProject(input) {
  const entries = await unzip(input);
  if (!entries['project.json']) {
    throw Error('Invalid .mgem archive: missing project.json.');
  }
  const project = JSON.parse(dec.decode(entries['project.json']));
  validateProject(project);

  const files = new Map();
  for (const doc of project.documents || []) {
    const bytes = entries[doc.path];
    if (!bytes) {
      throw Error(`Corrupted .mgem archive: missing file ${doc.path}`);
    }
    const actualHash = await sha256(bytes);
    if (actualHash !== doc.sha256.toLowerCase()) {
      throw Error(`Integrity check failed for ${doc.path}`);
    }
    files.set(doc.path, bytes);
  }

  return {project, files};
}
