import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sameOrigin} from './server-blender.mjs';
import {unzip, zipStore} from './public/mgem-project.mjs';
import {NODE_SPECS} from './public/node-graph.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const enc = new TextEncoder();
const dec = new TextDecoder();

export function resolveUserModsDir() {
  if (process.env.MORPHOGEM_MODS_DIR) return path.resolve(process.env.MORPHOGEM_MODS_DIR);
  if (path.basename(root) === 'app-core' && path.basename(path.dirname(root)) === 'resources') {
    return path.resolve(root, '..', '..', 'Mods');
  }
  return path.join(root, 'Mods');
}

export function resolveBuiltinModsDir() {
  return path.join(root, 'builtin-mods');
}

function resolveModsStateFile() {
  if (process.env.MORPHOGEM_USERDATA_DIR) {
    return path.join(path.resolve(process.env.MORPHOGEM_USERDATA_DIR), 'mods-state.json');
  }
  if (path.basename(root) === 'app-core' && path.basename(path.dirname(root)) === 'resources') {
    return path.resolve(root, '..', '..', 'userdata', 'local', 'mods-state.json');
  }
  return path.join(root, 'local', 'mods-state.json');
}

export function sanitizeModId(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || `mod-${Date.now().toString(36)}`;
}

async function readModsState() {
  try {
    const parsed = JSON.parse(await fs.readFile(resolveModsStateFile(), 'utf8'));
    return {
      disabledModIds: Array.isArray(parsed?.disabledModIds)
        ? parsed.disabledModIds.filter(x => typeof x === 'string')
        : [],
    };
  } catch {
    return {disabledModIds: []};
  }
}

async function writeModsState(state) {
  const file = resolveModsStateFile();
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
}

function normalizeCustomNodes(arr, modId, modName) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr.slice(0, 64)) {
    if (!item || typeof item !== 'object') continue;
    const baseType = NODE_SPECS[item.baseType] ? item.baseType : 'part_views';
    const id = sanitizeModId(item.id || item.title || 'node');
    const title = String(item.title || item.params?.partName || 'Mod 专属节点').trim().slice(0, 80);
    const craftRules = Array.isArray(item.craftRules)
      ? item.craftRules.map(r => String(r || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    out.push({
      id: `${modId}:${id}`,
      localId: id,
      modId,
      modName,
      baseType,
      badge: String(item.badge || 'Mod 节点').trim().slice(0, 18),
      title,
      description: String(item.description || '').trim().slice(0, 200),
      params: {
        ...(item.params && typeof item.params === 'object' ? item.params : {}),
        modId,
        modName,
        modBadge: String(item.badge || 'Mod').trim().slice(0, 18),
        ...(craftRules.length ? {modCraftRules: craftRules} : {}),
      },
      craftRules,
    });
  }
  return out;
}

function normalizeTemplates(arr, modId, modName, modPromptRules) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(t => t && typeof t === 'object' && Array.isArray(t.nodes))
    .slice(0, 32)
    .map((t, idx) => {
      const localId = sanitizeModId(t.id || t.name || `tpl-${idx + 1}`);
      return {
        ...t,
        id: `mod:${modId}:${localId}`,
        localId,
        modId,
        modName,
        name: String(t.name || `Mod 模板 ${idx + 1}`).trim().slice(0, 80),
        description: String(t.description || '').trim().slice(0, 200),
        promptRules: String(t.promptRules || modPromptRules || '').trim().slice(0, 4000),
      };
    });
}

function normalizeBranches(arr, modId, modName) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(b => b && typeof b === 'object' && Array.isArray(b.nodes) && b.nodes.length > 0)
    .slice(0, 64)
    .map((b, idx) => {
      const localId = sanitizeModId(b.id || b.name || `branch-${idx + 1}`);
      const craftRules = Array.isArray(b.craftRules)
        ? b.craftRules.map(r => String(r || '').trim()).filter(Boolean).slice(0, 12)
        : [];
      const nodes = b.nodes.map(n => ({
        ...n,
        params: {
          ...(n.params || {}),
          modId,
          modName,
          modBadge: String(b.badge || n.params?.modBadge || 'Mod').trim().slice(0, 18),
          ...(craftRules.length && (n.type === 'part_views' || n.type === 'balance_views')
            ? {modCraftRules: craftRules}
            : {}),
        },
      }));
      return {
        ...b,
        id: `mod:${modId}:${localId}`,
        localId,
        modId,
        modName,
        name: String(b.name || `Mod 分支 ${idx + 1}`).trim().slice(0, 80),
        description: String(b.description || '').trim().slice(0, 200),
        craftRules,
        nodes,
      };
    });
}

async function parseModFromDirectory(dirPath, source, disabledSet) {
  const manifestPath = path.join(dirPath, 'manifest.json');
  const rawManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!rawManifest || typeof rawManifest !== 'object') return null;

  const id = sanitizeModId(rawManifest.id || path.basename(dirPath));
  const name = String(rawManifest.name || id).trim().slice(0, 80);
  const version = String(rawManifest.version || '1.0.0').trim().slice(0, 24);
  const author = String(rawManifest.author || '社区创作者').trim().slice(0, 60);
  const description = String(rawManifest.description || '').trim().slice(0, 300);
  const tags = Array.isArray(rawManifest.tags)
    ? rawManifest.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 8)
    : [];

  let promptRules = String(rawManifest.promptRules || '').trim();
  const rulesFile = rawManifest.promptRulesFile || 'prompt-rules.md';
  if (typeof rulesFile === 'string' && !rulesFile.includes('..') && !path.isAbsolute(rulesFile)) {
    try {
      const fileText = (await fs.readFile(path.join(dirPath, rulesFile), 'utf8')).trim();
      if (fileText) promptRules = promptRules ? `${promptRules}\n\n${fileText}` : fileText;
    } catch {
      // optional file
    }
  }
  promptRules = promptRules.slice(0, 6000);

  return {
    format: 'morphogem-mod-v1',
    id,
    name,
    version,
    author,
    description,
    tags,
    source, // 'builtin' | 'user'
    folderName: path.basename(dirPath),
    enabled: !disabledSet.has(id),
    promptRules,
    templates: normalizeTemplates(rawManifest.templates, id, name, promptRules),
    branches: normalizeBranches(rawManifest.branches, id, name),
    customNodes: normalizeCustomNodes(rawManifest.customNodes, id, name),
  };
}

async function extractMgmodArchiveToModsDir(zipBytes, userModsDir) {
  const entries = await unzip(zipBytes, {maxBytes: 64 * 1024 * 1024, maxEntries: 128});
  const paths = Object.keys(entries);
  let prefix = '';
  if (!entries['manifest.json']) {
    const nested = paths.find(p => /^[^/]+\/manifest\.json$/.test(p));
    if (!nested) throw Error('无效的 .mgmod 包：缺少 manifest.json 清单文件。');
    prefix = nested.slice(0, nested.indexOf('/') + 1);
  }
  const manifestRaw = JSON.parse(dec.decode(entries[`${prefix}manifest.json`]));
  if (!manifestRaw || typeof manifestRaw !== 'object' || !manifestRaw.name) {
    throw Error('无效的 .mgmod 清单：manifest.json 必须包含名称 (name)。');
  }
  const modId = sanitizeModId(manifestRaw.id || manifestRaw.name);
  manifestRaw.id = modId;

  const targetDir = path.join(userModsDir, modId);
  await fs.rm(targetDir, {recursive: true, force: true}).catch(() => {});
  await fs.mkdir(targetDir, {recursive: true});

  for (const [entryName, data] of Object.entries(entries)) {
    if (prefix && !entryName.startsWith(prefix)) continue;
    const rel = prefix ? entryName.slice(prefix.length) : entryName;
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    const dest = path.resolve(targetDir, rel);
    if (!dest.startsWith(path.resolve(targetDir) + path.sep)) continue;
    await fs.mkdir(path.dirname(dest), {recursive: true});
    if (rel === 'manifest.json') {
      await fs.writeFile(dest, JSON.stringify(manifestRaw, null, 2), 'utf8');
    } else {
      await fs.writeFile(dest, data);
    }
  }
  return modId;
}

export async function loadAllMods() {
  const userModsDir = resolveUserModsDir();
  const builtinModsDir = resolveBuiltinModsDir();
  await fs.mkdir(userModsDir, {recursive: true}).catch(() => {});

  // Auto-unpack any standalone .mgmod files dropped directly into userModsDir
  try {
    const userEntries = await fs.readdir(userModsDir, {withFileTypes: true});
    for (const ent of userEntries) {
      if (ent.isFile() && /\.mgmod$/i.test(ent.name)) {
        const fullPkg = path.join(userModsDir, ent.name);
        try {
          const bytes = await fs.readFile(fullPkg);
          await extractMgmodArchiveToModsDir(bytes, userModsDir);
          await fs.rm(fullPkg, {force: true}).catch(() => {});
        } catch {
          // keep invalid file untouched
        }
      }
    }
  } catch {
    // ignore
  }

  const state = await readModsState();
  const disabledSet = new Set(state.disabledModIds);
  const byId = new Map();

  for (const [dirRoot, source] of [[builtinModsDir, 'builtin'], [userModsDir, 'user']]) {
    try {
      const entries = await fs.readdir(dirRoot, {withFileTypes: true});
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        try {
          const mod = await parseModFromDirectory(path.join(dirRoot, ent.name), source, disabledSet);
          if (mod) byId.set(mod.id, mod);
        } catch {
          // skip malformed mod folder
        }
      }
    } catch {
      // directory may not exist
    }
  }

  return {
    modsDir: userModsDir,
    mods: [...byId.values()],
  };
}

export async function packModDirectoryAsMgmod(modDir) {
  const entries = {};
  async function walk(curDir, relPrefix = '') {
    const list = await fs.readdir(curDir, {withFileTypes: true});
    for (const item of list) {
      const full = path.join(curDir, item.name);
      const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await walk(full, rel);
      } else if (item.isFile()) {
        entries[rel] = new Uint8Array(await fs.readFile(full));
      }
    }
  }
  await walk(modDir, '');
  const blob = zipStore(entries);
  return Buffer.from(await blob.arrayBuffer());
}

export function buildModPackageEntries(payload) {
  const id = sanitizeModId(payload.id || payload.name);
  const name = String(payload.name || '未命名 Mod').trim().slice(0, 80);
  const version = String(payload.version || '1.0.0').trim().slice(0, 24);
  const author = String(payload.author || 'MorphoGem 创作者').trim().slice(0, 60);
  const description = String(payload.description || '').trim().slice(0, 300);
  const tags = Array.isArray(payload.tags)
    ? payload.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 8)
    : [];
  const promptRules = String(payload.promptRules || '').trim().slice(0, 6000);

  const manifest = {
    format: 'morphogem-mod-v1',
    id,
    name,
    version,
    author,
    description,
    tags,
    ...(promptRules ? {promptRulesFile: 'prompt-rules.md'} : {}),
    templates: Array.isArray(payload.templates) ? payload.templates.slice(0, 32) : [],
    branches: Array.isArray(payload.branches) ? payload.branches.slice(0, 64) : [],
    customNodes: Array.isArray(payload.customNodes) ? payload.customNodes.slice(0, 64) : [],
    createdAt: new Date().toISOString(),
  };

  const entries = {
    'manifest.json': enc.encode(JSON.stringify(manifest, null, 2)),
    'README.txt': enc.encode(
      `${name} (v${version}) by ${author}\n\n` +
      `安装方式：\n` +
      `1. 打开 MorphoGem -> 点击节点画布工具栏的「🧩 Mod 扩展」-> 点击「导入 .mgmod 包」选择本文件；\n` +
      `2. 或直接将本文件（或解压后的文件夹）放入 MorphoGem 安装目录下的 Mods 文件夹中。\n`
    ),
  };
  if (promptRules) {
    entries['prompt-rules.md'] = enc.encode(promptRules + '\n');
  }
  return {id, version, manifest, entries};
}

async function readBodyBuffer(req, maxBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw Error('Mod 包体积超出上限 (64MB)');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function handleModsRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/mods')) return false;
  const sendJson = (code, obj) => {
    res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(obj));
  };

  if (!sameOrigin(req)) {
    sendJson(403, {error: 'Local same-origin requests only'});
    return true;
  }

  try {
    if (pathname === '/api/mods' && req.method === 'GET') {
      sendJson(200, await loadAllMods());
      return true;
    }

    if (pathname === '/api/mods/toggle' && req.method === 'POST') {
      const {id, enabled} = JSON.parse((await readBodyBuffer(req, 65536)).toString('utf8'));
      const modId = sanitizeModId(id);
      const st = await readModsState();
      const set = new Set(st.disabledModIds);
      if (enabled) set.delete(modId);
      else set.add(modId);
      await writeModsState({disabledModIds: [...set]});
      sendJson(200, await loadAllMods());
      return true;
    }

    if (pathname === '/api/mods/import' && req.method === 'POST') {
      const buf = await readBodyBuffer(req);
      const userModsDir = resolveUserModsDir();
      await fs.mkdir(userModsDir, {recursive: true});
      const modId = await extractMgmodArchiveToModsDir(buf, userModsDir);
      const st = await readModsState();
      st.disabledModIds = st.disabledModIds.filter(x => x !== modId);
      await writeModsState(st);
      const loaded = await loadAllMods();
      sendJson(200, {ok: true, importedId: modId, ...loaded});
      return true;
    }

    if (pathname === '/api/mods/create' && req.method === 'POST') {
      const payload = JSON.parse((await readBodyBuffer(req, 16 * 1024 * 1024)).toString('utf8'));
      const {id, version, entries} = buildModPackageEntries(payload);

      if (payload.installLocal) {
        const userModsDir = resolveUserModsDir();
        const targetDir = path.join(userModsDir, id);
        await fs.mkdir(targetDir, {recursive: true});
        for (const [rel, data] of Object.entries(entries)) {
          const dest = path.join(targetDir, rel);
          await fs.mkdir(path.dirname(dest), {recursive: true});
          await fs.writeFile(dest, data);
        }
        const st = await readModsState();
        st.disabledModIds = st.disabledModIds.filter(x => x !== id);
        await writeModsState(st);
      }

      if (payload.downloadBlob) {
        const zipBlob = zipStore(entries);
        const zipBuf = Buffer.from(await zipBlob.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${id}-v${version}.mgmod"`,
          'Cache-Control': 'no-store',
        });
        res.end(zipBuf);
        return true;
      }

      sendJson(200, {ok: true, createdId: id, ...(await loadAllMods())});
      return true;
    }

    if (pathname === '/api/mods/export' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const id = sanitizeModId(url.searchParams.get('id') || '');
      const userDir = path.join(resolveUserModsDir(), id);
      const builtinDir = path.join(resolveBuiltinModsDir(), id);
      let dirToPack = null;
      try { if ((await fs.stat(path.join(userDir, 'manifest.json'))).isFile()) dirToPack = userDir; } catch {}
      if (!dirToPack) {
        try { if ((await fs.stat(path.join(builtinDir, 'manifest.json'))).isFile()) dirToPack = builtinDir; } catch {}
      }
      if (!dirToPack) {
        sendJson(404, {error: '未找到对应的 Mod 目录'});
        return true;
      }
      const zipBuf = await packModDirectoryAsMgmod(dirToPack);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${id}.mgmod"`,
        'Cache-Control': 'no-store',
      });
      res.end(zipBuf);
      return true;
    }

    if (pathname === '/api/mods/delete' && req.method === 'POST') {
      const {id} = JSON.parse((await readBodyBuffer(req, 65536)).toString('utf8'));
      const modId = sanitizeModId(id);
      const targetDir = path.resolve(resolveUserModsDir(), modId);
      if (!targetDir.startsWith(path.resolve(resolveUserModsDir()) + path.sep)) {
        sendJson(400, {error: '非法 Mod 路径'});
        return true;
      }
      try {
        await fs.stat(targetDir);
      } catch {
        sendJson(400, {error: '官方内置示例 Mod 无需删除（可通过右侧开关直接禁用）'});
        return true;
      }
      await fs.rm(targetDir, {recursive: true, force: true});
      sendJson(200, {ok: true, ...(await loadAllMods())});
      return true;
    }

    sendJson(404, {error: 'Unknown mods endpoint'});
    return true;
  } catch (e) {
    sendJson(400, {error: e.message || String(e)});
    return true;
  }
}
