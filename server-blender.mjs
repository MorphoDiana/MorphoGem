// MorphoGem Clean-Room System Settings, Blender Engine Locator & Optional GLB Viewport Proxy
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export const PREVIEW_PROXY_MIN_BYTES = 1024;

export function sameOrigin(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return false;
  const isLocalHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  if (!isLocalHost) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.host.toLowerCase() !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function atomicWrite(destPath, dataBuffer) {
  const abs = path.resolve(destPath);
  const dir = path.dirname(abs);
  await fs.mkdir(dir, {recursive: true});
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.writeFile(tmp, dataBuffer);
  await fs.rename(tmp, abs);
}

export function resolveSettingsFilePath() {
  if (process.env.MORPHOGEM_SETTINGS_FILE) {
    return path.resolve(process.env.MORPHOGEM_SETTINGS_FILE);
  }
  if (process.env.MORPHOGEM_USERDATA_DIR) {
    return path.join(path.resolve(process.env.MORPHOGEM_USERDATA_DIR), 'desktop-settings.json');
  }
  return path.join(root, 'local', 'system-settings.json');
}

export async function readSystemSettings() {
  try {
    return JSON.parse(await fs.readFile(resolveSettingsFilePath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

export async function writeSystemSettings(patch) {
  const current = await readSystemSettings();
  const merged = {...current, ...patch};
  await atomicWrite(resolveSettingsFilePath(), Buffer.from(JSON.stringify(merged, null, 2), 'utf8'));
  return merged;
}

export async function validateBlenderExecutable(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  let cleaned = rawPath.trim().replace(/^"+|"+$/g, '');
  if (!cleaned) return null;
  try {
    const st = await fs.stat(cleaned);
    if (st.isDirectory()) {
      const exeInside = path.join(cleaned, process.platform === 'win32' ? 'blender.exe' : 'blender');
      const stExe = await fs.stat(exeInside);
      if (stExe.isFile()) return path.resolve(exeInside);
      return null;
    }
    if (!st.isFile()) return null;
    const base = path.basename(cleaned).toLowerCase();
    if (process.platform === 'win32' ? base === 'blender.exe' : /^blender(\.app)?$/.test(base)) {
      return path.resolve(cleaned);
    }
    return null;
  } catch {
    return null;
  }
}

export async function findBlender() {
  if (process.env.BLENDER) {
    const envValid = await validateBlenderExecutable(process.env.BLENDER);
    if (envValid) return envValid;
  }
  const settings = await readSystemSettings();
  if (settings.blenderPath) {
    const cfgValid = await validateBlenderExecutable(settings.blenderPath);
    if (cfgValid) return cfgValid;
  }
  const toolsDir = process.env.MORPHOGEM_TOOLS_DIR || path.join(path.resolve(root, '..'), 'tools');
  const portable = path.join(toolsDir, 'blender', process.platform === 'win32' ? 'blender.exe' : 'blender');
  const portValid = await validateBlenderExecutable(portable);
  if (portValid) return portValid;
  return null;
}

export async function findBundledPython() {
  if (process.env.PYTHON && fsSync.existsSync(process.env.PYTHON)) {
    return process.env.PYTHON;
  }
  const blenderExe = await findBlender();
  if (blenderExe) {
    const blenderDir = path.dirname(blenderExe);
    try {
      const entries = await fs.readdir(blenderDir, {withFileTypes: true});
      for (const ent of entries) {
        if (!ent.isDirectory() || !/^\d+\.\d+/.test(ent.name)) continue;
        const pyWin = path.join(blenderDir, ent.name, 'python', 'bin', 'python.exe');
        if (fsSync.existsSync(pyWin)) return pyWin;
        const pyPosix = path.join(blenderDir, ent.name, 'python', 'bin', 'python3');
        if (fsSync.existsSync(pyPosix)) return pyPosix;
      }
    } catch {
      // ignore
    }
  }
  return 'python';
}

export async function scanSystemBlenderCandidates() {
  const found = [];
  const seen = new Set();
  const addIfValid = async p => {
    const v = await validateBlenderExecutable(p);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      found.push(v);
    }
  };

  if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      'C:\\Program Files',
      'D:\\Program Files',
      'E:\\Program Files',
    ].filter(Boolean);

    for (const r of roots) {
      const bf = path.join(r, 'Blender Foundation');
      try {
        const dirs = await fs.readdir(bf, {withFileTypes: true});
        const sorted = dirs
          .filter(d => d.isDirectory() && /^Blender/i.test(d.name))
          .sort((a, b) => b.name.localeCompare(a.name, undefined, {numeric: true}));
        for (const d of sorted) {
          await addIfValid(path.join(bf, d.name, 'blender.exe'));
        }
      } catch {
        // ignore missing dir
      }
      await addIfValid(path.join(r, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'));
    }
  } else if (process.platform === 'darwin') {
    await addIfValid('/Applications/Blender.app/Contents/MacOS/Blender');
  } else {
    await addIfValid('/usr/bin/blender');
    await addIfValid('/snap/bin/blender');
  }
  return found;
}

function previewCacheDir() {
  if (process.env.MORPHOGEM_USERDATA_DIR) {
    return path.join(path.resolve(process.env.MORPHOGEM_USERDATA_DIR), 'preview-glb-cache');
  }
  return path.join(root, 'local', 'preview-glb-cache');
}

export function getPreviewGlbPath(sha256) {
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ''))) return null;
  return path.join(previewCacheDir(), `${sha256.toLowerCase()}.glb`);
}

export async function generatePreviewGlbFromBuffer(sha256, fbxBytes, resources = []) {
  const outGlb = getPreviewGlbPath(sha256);
  if (!outGlb) return null;
  try {
    const st = await fs.stat(outGlb);
    if (st.isFile() && st.size > 128) return outGlb;
  } catch {
    // generate fresh
  }

  const blender = await findBlender();
  if (!blender) return null;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mgem-prev-'));
  try {
    const stagedFbx = path.join(tmp, 'part.fbx');
    const fbmDir = path.join(tmp, 'part.fbm');
    await fs.mkdir(fbmDir, {recursive: true});
    await fs.writeFile(stagedFbx, fbxBytes);
    for (const r of resources) {
      if (!r?.name || !r?.data) continue;
      const safe = path.basename(r.name);
      await fs.writeFile(path.join(tmp, safe), r.data);
      await fs.writeFile(path.join(fbmDir, safe), r.data);
    }
    const tmpOut = path.join(tmp, 'preview.glb');
    const pyFile = path.join(tmp, 'make_glb.py');
    const pyCode = [
      'import bpy, sys',
      'fbx_in, glb_out = sys.argv[sys.argv.index("--") + 1:]',
      'bpy.ops.object.select_all(action="SELECT")',
      'bpy.ops.object.delete(use_global=False)',
      'bpy.ops.import_scene.fbx(filepath=fbx_in, use_image_search=True, use_anim=False)',
      'meshes = [o for o in bpy.data.objects if o.type == "MESH"]',
      'if not meshes: raise RuntimeError("No mesh in FBX")',
      'bpy.ops.object.select_all(action="DESELECT")',
      'for m in meshes: m.select_set(True)',
      'bpy.context.view_layer.objects.active = meshes[0]',
      'bpy.ops.export_scene.gltf(filepath=glb_out, export_format="GLB", use_selection=True, export_apply=True, export_animations=False)',
    ].join('\n');
    await fs.writeFile(pyFile, pyCode, 'utf8');

    await new Promise((resolve, reject) => {
      const child = spawn(
        blender,
        ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', pyFile, '--', stagedFbx, tmpOut],
        {windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']}
      );
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(Error(`Preview GLB exit ${code}`))));
    });

    const glbBuf = await fs.readFile(tmpOut);
    await atomicWrite(outGlb, glbBuf);
    return outGlb;
  } finally {
    await fs.rm(tmp, {recursive: true, force: true}).catch(() => {});
  }
}
