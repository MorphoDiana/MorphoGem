import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const inflateRawAsync = promisify(zlib.inflateRaw);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Pure Node.js ZIP Central Directory extractor (Store=0 & Deflate=8, ZIP64-aware)
 * with strict Zip-Slip path traversal protection — zero external Python dependency.
 */
async function extractZipNative(zipPath, outDir) {
  const buf = await fs.readFile(zipPath);
  const outAbs = path.resolve(outDir);
  const minEocdPos = Math.max(0, buf.length - 65558);
  let eocdPos = -1;
  for (let p = buf.length - 22; p >= minEocdPos; p--) {
    if (buf.readUInt32LE(p) === 0x06054b50) {
      eocdPos = p;
      break;
    }
  }
  if (eocdPos < 0) throw new Error('Invalid ZIP archive: End of Central Directory not found');

  let totalEntries = buf.readUInt16LE(eocdPos + 10);
  let cdSize = buf.readUInt32LE(eocdPos + 12);
  let cdOffset = buf.readUInt32LE(eocdPos + 16);

  // Check for ZIP64 End of Central Directory Locator right before EOCD
  if (eocdPos >= 20 && buf.readUInt32LE(eocdPos - 20) === 0x07064b50) {
    const zip64EocdOffset = Number(buf.readBigUInt64LE(eocdPos - 12));
    if (zip64EocdOffset >= 0 && zip64EocdOffset + 56 <= buf.length && buf.readUInt32LE(zip64EocdOffset) === 0x06064b50) {
      totalEntries = Number(buf.readBigUInt64LE(zip64EocdOffset + 32));
      cdSize = Number(buf.readBigUInt64LE(zip64EocdOffset + 40));
      cdOffset = Number(buf.readBigUInt64LE(zip64EocdOffset + 48));
    }
  }

  const items = [];
  let ptr = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let idx = 0; idx < totalEntries && ptr + 46 <= cdEnd && ptr + 46 <= buf.length; idx++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`Corrupt Central Directory entry signature at offset ${ptr}`);
    }
    const flags = buf.readUInt16LE(ptr + 8);
    const method = buf.readUInt16LE(ptr + 10);
    let compSize = buf.readUInt32LE(ptr + 20);
    let uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    let localHeaderOffset = buf.readUInt32LE(ptr + 42);

    const nameBuf = buf.subarray(ptr + 46, ptr + 46 + nameLen);
    const isUtf8 = (flags & 0x0800) !== 0;
    const rawName = nameBuf.toString(isUtf8 ? 'utf8' : 'latin1');

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const extraStart = ptr + 46 + nameLen;
      let ep = extraStart;
      while (ep + 4 <= extraStart + extraLen) {
        const headerId = buf.readUInt16LE(ep);
        const dataSize = buf.readUInt16LE(ep + 2);
        if (headerId === 0x0001) {
          let zp = ep + 4;
          if (uncompSize === 0xffffffff && zp + 8 <= ep + 4 + dataSize) { uncompSize = Number(buf.readBigUInt64LE(zp)); zp += 8; }
          if (compSize === 0xffffffff && zp + 8 <= ep + 4 + dataSize) { compSize = Number(buf.readBigUInt64LE(zp)); zp += 8; }
          if (localHeaderOffset === 0xffffffff && zp + 8 <= ep + 4 + dataSize) { localHeaderOffset = Number(buf.readBigUInt64LE(zp)); zp += 8; }
          break;
        }
        ep += 4 + dataSize;
      }
    }

    ptr += 46 + nameLen + extraLen + commentLen;

    const normalizedRel = rawName.replace(/\\/g, '/');
    if (!normalizedRel || normalizedRel.endsWith('/') || normalizedRel.startsWith('__MACOSX/')) continue;

    const target = path.resolve(outAbs, normalizedRel);
    if (!(target === outAbs || target.startsWith(outAbs + path.sep))) {
      throw new Error(`Blocked unsafe zip entry: ${rawName}`);
    }

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid Local File Header for ${rawName}`);
    }
    const lfNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
    const compSlice = buf.subarray(dataStart, dataStart + compSize);

    let outBytes;
    if (method === 0) {
      outBytes = compSlice;
    } else if (method === 8) {
      outBytes = await inflateRawAsync(compSlice);
    } else {
      throw new Error(`UNSUPPORTED_ZIP_METHOD_${method}`);
    }
    if (uncompSize >= 0 && outBytes.length !== uncompSize) {
      throw new Error(`ZIP size mismatch for ${rawName}: expected ${uncompSize}, got ${outBytes.length}`);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, outBytes);
    items.push({ relPath: normalizedRel, absPath: target });
  }
  return items;
}

export function defaultDownloadsDir() {
  if (process.env.TRIPO_DOWNLOAD_DIR) return path.resolve(process.env.TRIPO_DOWNLOAD_DIR);
  return path.join(os.homedir(), 'Downloads');
}

export async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function verifyFbxHeader(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(27);
    const { bytesRead } = await fh.read(buf, 0, 27, 0);
    if (bytesRead < 27) throw new Error(`FBX file too small (${bytesRead} bytes): ${filePath}`);
    const magic = buf.subarray(0, 21).toString('utf8');
    if (magic !== 'Kaydara FBX Binary  \x00') {
      throw new Error(`Invalid FBX binary header in ${path.basename(filePath)}`);
    }
    const version = buf.readUInt32LE(23);
    if (version < 7100 || version >= 8000) {
      throw new Error(`Unsupported FBX version ${version} in ${path.basename(filePath)} (expected 7100..7999)`);
    }
    return version;
  } finally {
    await fh.close();
  }
}

export async function verifyGlbHeader(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    if (bytesRead < 12 || buf.toString('utf8', 0, 4) !== 'glTF') {
      throw new Error(`Invalid GLB header in ${path.basename(filePath)}`);
    }
    return buf.readUInt32LE(4);
  } finally {
    await fh.close();
  }
}

export async function snapshotDownloads(downloadsDir = defaultDownloadsDir()) {
  const entries = await fs.readdir(downloadsDir, { withFileTypes: true });
  const map = new Map();
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      const st = await fs.stat(path.join(downloadsDir, e.name));
      map.set(e.name, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // ignore transient files
    }
  }
  return { downloadsDir, startedAtMs: Date.now(), files: map };
}

/**
 * Waits for a newly completed file (.zip, .fbx, .glb) in Chrome's Downloads folder
 * after `baseline` was captured, ensuring no active `.crdownload` remains for it
 * and its size has stabilized.
 */
export async function waitForCompletedDownload(baseline, { timeoutMs = 600000, pollMs = 1000 } = {}) {
  const { downloadsDir, startedAtMs, files: before } = baseline;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const names = await fs.readdir(downloadsDir);
    const hasTemp = names.some(n => /\.(crdownload|tmp|part)$/i.test(n));
    const candidates = [];

    for (const name of names) {
      if (/\.(crdownload|tmp|part)$/i.test(name)) continue;
      const isWrong3D = /\.(stl|obj|usdz|3mf)$/i.test(name);
      if (!isWrong3D && !/\.(zip|fbx|glb)$/i.test(name)) continue;
      const fullPath = path.join(downloadsDir, name);
      let st;
      try {
        st = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      const prev = before.get(name);
      const isNew = !prev || st.mtimeMs > prev.mtimeMs + 50;
      if (isNew && st.mtimeMs >= startedAtMs - 2000) {
        if (isWrong3D && !hasTemp) {
          throw new Error(`检测到意外导出的非预期格式文件 "${name}"（可能导出格式被选成了 ${path.extname(name).toUpperCase()}），已立即中止，请检查导出格式需为 FBX/GLB。`);
        }
        if (!isWrong3D) {
          candidates.push({ name, fullPath, mtimeMs: st.mtimeMs, size: st.size });
        }
      }
    }

    if (candidates.length > 0 && !hasTemp) {
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const picked = candidates[0];
      await sleep(1200);
      try {
        const st2 = await fs.stat(picked.fullPath);
        if (st2.size === picked.size && st2.size > 0) {
          return picked.fullPath;
        }
      } catch {
        // file moved/renamed, continue polling
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Tripo export file in ${downloadsDir}`);
}

/**
 * Safely extracts a `.zip` archive (or copies a direct `.fbx` / `.glb` file) into `outputDir`
 * using Python's built-in `zipfile` with strict zip-slip path validation, verifies binary headers,
 * and writes `download-record.json`.
 */
export async function extractAndVerifyDownload(downloadedPath, outputDir, metadata = {}) {
  const absDownload = path.resolve(downloadedPath);
  const absOut = path.resolve(outputDir);
  await fs.mkdir(absOut, { recursive: true });

  const ext = path.extname(absDownload).toLowerCase();
  const extractedFiles = [];

  if (ext === '.zip') {
    let parsed;
    try {
      parsed = await extractZipNative(absDownload, absOut);
    } catch (nativeErr) {
      if (!String(nativeErr?.message || '').startsWith('UNSUPPORTED_ZIP_METHOD_')) {
        throw nativeErr;
      }
      const pyScript = `
import zipfile, os, sys, json
zip_path, out_dir = sys.argv[1], sys.argv[2]
out_abs = os.path.abspath(out_dir)
items = []
with zipfile.ZipFile(zip_path, 'r') as zf:
    for info in zf.infolist():
        if info.is_dir():
            continue
        target = os.path.abspath(os.path.join(out_abs, info.filename))
        if not (target == out_abs or target.startswith(out_abs + os.sep)):
            raise RuntimeError(f'Blocked unsafe zip entry: {info.filename}')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(info) as src, open(target, 'wb') as dst:
            dst.write(src.read())
        items.append({'relPath': info.filename.replace('\\\\', '/'), 'absPath': target})
print(json.dumps(items))
`;
      const pythonCmd = process.env.PYTHON || 'python';
      const { stdout } = await execFileAsync(pythonCmd, ['-c', pyScript, absDownload, absOut], { windowsHide: true });
      parsed = JSON.parse(stdout.trim());
    }
    for (const item of parsed) {
      const st = await fs.stat(item.absPath);
      extractedFiles.push({
        relPath: item.relPath,
        absPath: item.absPath,
        size: st.size,
        sha256: await sha256File(item.absPath),
      });
    }
  } else if (ext === '.fbx' || ext === '.glb') {
    const dest = path.join(absOut, path.basename(absDownload));
    await fs.copyFile(absDownload, dest);
    const st = await fs.stat(dest);
    extractedFiles.push({
      relPath: path.basename(dest),
      absPath: dest,
      size: st.size,
      sha256: await sha256File(dest),
    });
  } else {
    throw new Error(`Unsupported downloaded file extension: ${ext}`);
  }

  const fbxFiles = extractedFiles.filter(f => f.absPath.toLowerCase().endsWith('.fbx'));
  const glbFiles = extractedFiles.filter(f => f.absPath.toLowerCase().endsWith('.glb'));
  const resources = extractedFiles
    .filter(f => /\.(png|jpe?g|webp)$/i.test(f.absPath))
    .map(f => f.absPath);

  for (const f of fbxFiles) await verifyFbxHeader(f.absPath);
  for (const g of glbFiles) await verifyGlbHeader(g.absPath);

  const wantFmt = String(metadata?.format || '').trim().toUpperCase();
  if (wantFmt === 'FBX' && fbxFiles.length === 0) {
    const foundList = extractedFiles.map(f => f.relPath).join(', ') || '(empty)';
    throw new Error(`导出包 "${path.basename(absDownload)}" 中未找到 .fbx 文件（实际包含: ${foundList}），已拒绝接收错误格式导出物。`);
  }
  if (wantFmt === 'GLB' && glbFiles.length === 0) {
    const foundList = extractedFiles.map(f => f.relPath).join(', ') || '(empty)';
    throw new Error(`导出包 "${path.basename(absDownload)}" 中未找到 .glb 文件（实际包含: ${foundList}），已拒绝接收错误格式导出物。`);
  }

  const srcStat = await fs.stat(absDownload);
  const record = {
    ...metadata,
    receivedAt: new Date().toISOString(),
    sourceDownload: absDownload,
    sourceSize: srcStat.size,
    sourceSha256: await sha256File(absDownload),
    outputDir: absOut,
    fbx: fbxFiles[0]?.absPath || null,
    glb: glbFiles[0]?.absPath || null,
    resources,
    files: extractedFiles,
  };

  const recordPath = path.join(absOut, 'download-record.json');
  await fs.writeFile(recordPath, JSON.stringify(record, null, 2), 'utf8');
  if (process.env.TRIPO_AUTO_CLEAN_STAGING === '1' && path.dirname(absDownload) !== absOut) {
    await fs.rm(absDownload, { force: true }).catch(() => {});
  }
  return { ...record, recordPath };
}
