// MorphoGem Clean-Room Project Persistence & Granular Node-Locked AI Session Engine
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sameOrigin, atomicWrite, sha256Hex} from './server-blender.mjs';
import {unpackProject} from './public/mgem-project.mjs';
import {computeLockedNodesForViews, buildNodeGraphViewsPrompt} from './public/node-graph-prompts.mjs';
import {normalizeLocale} from './public/i18n.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

function sanitizeFolderStem(name) {
  const cleaned = String(name || 'character')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned || 'character';
}

async function readBodyBuffer(req, maxBytes = 1536 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Error('Payload exceeds maximum allowed size.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createSessionManager(options = {}) {
  const projectsDir = path.resolve(
    options.directory || process.env.MORPHOGEM_PROJECTS_ROOT || path.join(root, 'Projects')
  );
  const stateFile = path.resolve(
    options.stateFile ||
      process.env.MORPHOGEM_SESSION_FILE ||
      (process.env.MORPHOGEM_USERDATA_DIR
        ? path.join(path.resolve(process.env.MORPHOGEM_USERDATA_DIR), 'session.json')
        : path.join(root, 'local', 'session.json'))
  );

  fsSync.mkdirSync(projectsDir, {recursive: true});
  fsSync.mkdirSync(path.dirname(stateFile), {recursive: true});

  let state = {
    version: 2,
    active: null, // { id, name, path, directory, sha256, updatedAt }
    request: null, // { id, projectId, status, locale, targetNodeIds, lockedNodeIds, progress, error, createdAt, updatedAt, completedSha256 }
  };

  try {
    if (fsSync.existsSync(stateFile)) {
      const loaded = JSON.parse(fsSync.readFileSync(stateFile, 'utf8'));
      if (loaded && typeof loaded === 'object') {
        state = {
          version: 2,
          active: loaded.active || null,
          request: loaded.request || null,
        };
      }
    }
  } catch {
    // start clean
  }

  async function persistState() {
    await atomicWrite(stateFile, Buffer.from(JSON.stringify(state, null, 2), 'utf8'));
  }

  async function resolveProjectFileForSave(project) {
    if (
      state.active &&
      state.active.id === project.id &&
      state.active.path &&
      path.resolve(state.active.path).startsWith(projectsDir + path.sep)
    ) {
      return state.active.path;
    }
    const shortId = String(project.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'proj';
    try {
      const entries = await fs.readdir(projectsDir, {withFileTypes: true});
      const existingDir = entries.find(e => e.isDirectory() && e.name.endsWith(`_${shortId}`));
      if (existingDir) {
        return path.join(projectsDir, existingDir.name, 'project.mgem');
      }
    } catch {
      // ignore
    }
    const folderName = `${sanitizeFolderStem(project.name)}_${shortId}`;
    return path.join(projectsDir, folderName, 'project.mgem');
  }

  async function saveArchiveBytes(rawBuffer) {
    const {project} = await unpackProject(rawBuffer);
    const destFile = await resolveProjectFileForSave(project);
    const projFolder = path.dirname(destFile);
    await fs.mkdir(path.join(projFolder, 'work'), {recursive: true});
    await fs.mkdir(path.join(projFolder, 'images'), {recursive: true});
    await fs.mkdir(path.join(projFolder, 'exports'), {recursive: true});
    await atomicWrite(destFile, rawBuffer);
    const digest = sha256Hex(rawBuffer);
    state.active = {
      id: project.id,
      name: project.name,
      path: destFile,
      directory: projFolder,
      sha256: digest,
      updatedAt: new Date().toISOString(),
    };
    await persistState();
    return {project, active: state.active};
  }

  async function listRecentProjects() {
    const items = [];
    try {
      const dirs = await fs.readdir(projectsDir, {withFileTypes: true});
      for (const ent of dirs) {
        if (!ent.isDirectory()) continue;
        const mgemPath = path.join(projectsDir, ent.name, 'project.mgem');
        try {
          const st = await fs.stat(mgemPath);
          if (!st.isFile()) continue;
          const buf = await fs.readFile(mgemPath);
          const {project} = await unpackProject(buf);
          const nodes = project.nodeGraph?.nodes || [];
          const meshCount = nodes.filter(
            n => (n.type === 'tripo_mesh' || n.type === 'tripo_retexture') && Array.isArray(n.data?.candidates) && n.data.candidates.length > 0
          ).length;
          items.push({
            id: project.id,
            name: project.name,
            folderName: ent.name,
            path: mgemPath,
            sizeBytes: st.size,
            updatedAt: project.updatedAt || st.mtime.toISOString(),
            mtimeMs: st.mtimeMs,
            nodeCount: nodes.length,
            meshCount,
          });
        } catch {
          // skip invalid folder
        }
      }
    } catch {
      // ignore
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return items.slice(0, 50);
  }

  async function handleSessionRequest(req, res, pathname) {
    if (pathname !== '/api/session' && !pathname.startsWith('/api/session/')) return false;

    const sendJson = (code, payload) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(payload));
    };

    if (!sameOrigin(req)) {
      sendJson(403, {error: 'Localhost access only'});
      return true;
    }

    try {
      // 1. Poll current session & active project status
      if (pathname === '/api/session' && req.method === 'GET') {
        if (state.active?.path && !fsSync.existsSync(state.active.path)) {
          state.active = null;
          state.request = null;
          await persistState();
        }
        sendJson(200, {
          ok: true,
          directory: projectsDir,
          active: state.active,
          request: state.request,
        });
        return true;
      }

      // 2. Read binary bytes of the active .mgem project
      if (pathname === '/api/session/file' && req.method === 'GET') {
        if (!state.active?.path || !fsSync.existsSync(state.active.path)) {
          sendJson(404, {error: 'No active saved project'});
          return true;
        }
        const bytes = await fs.readFile(state.active.path);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.length,
          'X-Project-Sha256': sha256Hex(bytes),
          'Cache-Control': 'no-store',
        });
        res.end(bytes);
        return true;
      }

      // 3. Save current frontend project to disk (`Projects/<Name>_<id8>/project.mgem`)
      if (pathname === '/api/session/save' && (req.method === 'PUT' || req.method === 'POST')) {
        const raw = await readBodyBuffer(req);
        const {active} = await saveArchiveBytes(raw);
        sendJson(200, {ok: true, active, request: state.request});
        return true;
      }

      // 4. Import / Open an external `.mgem` file and make it active
      if (pathname === '/api/session/open' && req.method === 'POST') {
        const raw = await readBodyBuffer(req);
        state.request = null;
        const {active} = await saveArchiveBytes(raw);
        sendJson(200, {ok: true, active, request: null});
        return true;
      }

      // 5. List recent projects inside `<InstallDir>/Projects`
      if (pathname === '/api/session/projects' && req.method === 'GET') {
        const projects = await listRecentProjects();
        sendJson(200, {ok: true, directory: projectsDir, activeId: state.active?.id || null, projects});
        return true;
      }

      // 6. Switch active project to a chosen recent project
      if (pathname === '/api/session/open-recent' && req.method === 'POST') {
        const body = JSON.parse((await readBodyBuffer(req, 65536)).toString('utf8'));
        const targetPath = path.resolve(String(body.path || ''));
        if (!targetPath.startsWith(projectsDir + path.sep) || !fsSync.existsSync(targetPath)) {
          sendJson(404, {error: 'Project file not found in Projects directory'});
          return true;
        }
        const raw = await fs.readFile(targetPath);
        const {project} = await unpackProject(raw);
        state.active = {
          id: project.id,
          name: project.name,
          path: targetPath,
          directory: path.dirname(targetPath),
          sha256: sha256Hex(raw),
          updatedAt: new Date().toISOString(),
        };
        state.request = null;
        await persistState();
        sendJson(200, {ok: true, active: state.active});
        return true;
      }

      // 7. Request an AI Multi-View Decomposition Session (saves latest .mgem & locks target nodes)
      if (pathname === '/api/session/request' && req.method === 'POST') {
        const raw = await readBodyBuffer(req);
        const locale = normalizeLocale(req.headers['x-locale'] || 'zh-CN');
        const targetHeader = String(req.headers['x-target-nodes'] || '').trim();
        const requestedTargets = targetHeader
          ? targetHeader.split(',').map(s => s.trim()).filter(Boolean)
          : null;

        const {project, active} = await saveArchiveBytes(raw);
        const {targetNodeIds, lockedNodeIds} = computeLockedNodesForViews(project.nodeGraph, requestedTargets);
        const reqId = crypto.randomUUID();
        const origin = `http://${req.headers.host || '127.0.0.1:8766'}`;

        const reqObj = {
          id: reqId,
          projectId: project.id,
          status: 'pending', // 'pending' | 'running' | 'completed' | 'failed'
          locale,
          targetNodeIds,
          lockedNodeIds,
          progress: '',
          error: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedSha256: null,
        };
        state.request = reqObj;
        await persistState();

        const prompt = buildNodeGraphViewsPrompt(reqObj, root, origin, project, targetNodeIds, locale);
        sendJson(200, {
          ok: true,
          active,
          request: reqObj,
          prompt,
        });
        return true;
      }

      // 8. CLI Agent begins execution (`mgem-session.mjs begin`)
      if (pathname === '/api/session/begin' && req.method === 'POST') {
        const body = JSON.parse((await readBodyBuffer(req, 65536)).toString('utf8'));
        const reqId = String(body.id || '').trim();
        if (!state.active?.path || !fsSync.existsSync(state.active.path)) {
          sendJson(400, {error: 'No active saved MorphoGem project on disk.'});
          return true;
        }
        if (state.request && (!reqId || state.request.id === reqId)) {
          state.request.status = 'running';
          state.request.progress = state.request.locale === 'en'
            ? 'AI session connected — exporting reference inputs...'
            : 'AI 会话已连接，正在读取参考立绘与节点契约…';
          state.request.updatedAt = new Date().toISOString();
          await persistState();
        }
        sendJson(200, {
          ok: true,
          saved: true,
          requestId: state.request?.id || reqId || null,
          projectId: state.active.id,
          projectName: state.active.name,
          path: state.active.path,
          directory: state.active.directory,
          targetNodeIds: state.request?.targetNodeIds || [],
          lockedNodeIds: state.request?.lockedNodeIds || [],
        });
        return true;
      }

      // 9. CLI Agent progress report (`mgem-session.mjs progress`)
      if (pathname === '/api/session/progress' && req.method === 'POST') {
        const body = JSON.parse((await readBodyBuffer(req, 65536)).toString('utf8'));
        const reqId = String(body.id || '').trim();
        if (state.request && (!reqId || state.request.id === reqId)) {
          state.request.status = 'running';
          state.request.progress = String(body.message || '').trim().slice(0, 240);
          state.request.updatedAt = new Date().toISOString();
          await persistState();
        }
        sendJson(200, {ok: true, request: state.request});
        return true;
      }

      // 10. CLI Agent completes execution (`mgem-session.mjs complete`)
      if (pathname === '/api/session/complete' && req.method === 'POST') {
        const body = JSON.parse((await readBodyBuffer(req, 65536)).toString('utf8'));
        const reqId = String(body.id || '').trim();
        if (!state.active?.path || !fsSync.existsSync(state.active.path)) {
          sendJson(400, {error: 'Active project file missing on completion'});
          return true;
        }
        const diskBytes = await fs.readFile(state.active.path);
        const {project} = await unpackProject(diskBytes);
        const newSha = sha256Hex(diskBytes);
        state.active.sha256 = newSha;
        state.active.name = project.name;
        state.active.updatedAt = new Date().toISOString();

        if (state.request && (!reqId || state.request.id === reqId)) {
          state.request.status = 'completed';
          state.request.completedSha256 = newSha;
          state.request.progress = '';
          state.request.updatedAt = new Date().toISOString();
        }
        await persistState();
        sendJson(200, {ok: true, completed: true, path: state.active.path, sha256: newSha});
        return true;
      }

      // 11. CLI Agent fails execution (`mgem-session.mjs fail`)
      if (pathname === '/api/session/fail' && req.method === 'POST') {
        const body = JSON.parse((await readBodyBuffer(req, 65536)).toString('utf8'));
        const reason = String(body.reason || body.message || 'Unknown error').trim().slice(0, 300);
        state.request = null;
        await persistState();
        sendJson(200, {ok: true, unlocked: true, reason});
        return true;
      }

      // 12. Frontend acknowledges merge or user cancels lock (`cancel` / `ack`)
      if ((pathname === '/api/session/cancel' || pathname === '/api/session/ack') && req.method === 'POST') {
        state.request = null;
        await persistState();
        sendJson(200, {ok: true, request: null});
        return true;
      }

      sendJson(404, {error: 'Unknown session endpoint'});
      return true;
    } catch (err) {
      sendJson(400, {error: err?.message || String(err)});
      return true;
    }
  }

  return {
    projectsDir,
    stateFile,
    getState: () => state,
    handleSessionRequest,
  };
}
