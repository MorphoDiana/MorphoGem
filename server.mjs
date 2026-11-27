// MorphoGem Clean-Room Local Studio HTTP Server
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  sameOrigin,
  readSystemSettings,
  writeSystemSettings,
  validateBlenderExecutable,
  findBlender,
  findBundledPython,
  scanSystemBlenderCandidates,
  getPreviewGlbPath,
} from './server-blender.mjs';
import {createSessionManager} from './server-ai-session.mjs';
import {handleModsRequest} from './server-mods.mjs';
import {handleNodeGraphRequest} from './server-node-graph.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
});

async function readJsonBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw Error('JSON body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function startMorphoGemServer({
  port = Number(process.env.PORT || 8766),
  host = '127.0.0.1',
  sessionOptions = {},
} = {}) {
  const sessionMgr = createSessionManager(sessionOptions);

  const server = http.createServer(async (req, res) => {
    const sendJson = (code, obj) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(obj));
    };

    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = decodeURIComponent(parsedUrl.pathname);

      // --- System & Blender Configuration Endpoints ---
      if (pathname === '/api/capabilities' && req.method === 'GET') {
        if (!sameOrigin(req)) return sendJson(403, {error: 'Local access only'});
        const blenderPath = await findBlender();
        return sendJson(200, {
          ok: true,
          version: '2.1.2',
          blenderAvailable: Boolean(blenderPath),
          blenderPath: blenderPath || null,
        });
      }

      if (pathname === '/api/system/settings' && req.method === 'GET') {
        if (!sameOrigin(req)) return sendJson(403, {error: 'Local access only'});
        const rawCfg = await readSystemSettings();
        const blenderPath = await findBlender();
        return sendJson(200, {
          ok: true,
          configuredRaw: rawCfg.blenderPath || '',
          blenderPath: blenderPath || '',
          blenderValid: Boolean(blenderPath),
        });
      }

      if (pathname === '/api/system/settings' && req.method === 'PUT') {
        if (!sameOrigin(req)) return sendJson(403, {error: 'Local access only'});
        const body = await readJsonBody(req);
        const rawInput = String(body.blenderPath || '').trim();
        if (!rawInput) {
          delete process.env.BLENDER;
          await writeSystemSettings({blenderPath: ''});
          return sendJson(200, {ok: true, blenderPath: '', blenderValid: false});
        }
        const validated = await validateBlenderExecutable(rawInput);
        if (!validated) {
          return sendJson(400, {
            error: 'Invalid Blender path: please select blender.exe (Blender 4.2 ~ 5.2 recommended). / 无效的 Blender 路径：请选择本机安装的 blender.exe 可执行文件。',
          });
        }
        process.env.BLENDER = validated;
        const py = await findBundledPython();
        if (py) process.env.PYTHON = py;
        await writeSystemSettings({blenderPath: validated});
        return sendJson(200, {ok: true, blenderPath: validated, blenderValid: true});
      }

      if (pathname === '/api/system/scan-blender' && req.method === 'GET') {
        if (!sameOrigin(req)) return sendJson(403, {error: 'Local access only'});
        const candidates = await scanSystemBlenderCandidates();
        return sendJson(200, {ok: true, candidates});
      }

      // --- Cached GLB Viewport Proxy ---
      if (pathname.startsWith('/api/preview-glb/') && req.method === 'GET') {
        if (!sameOrigin(req)) return sendJson(403, {error: 'Local access only'});
        const hash = pathname.slice('/api/preview-glb/'.length).replace(/\.glb$/i, '');
        const glbPath = getPreviewGlbPath(hash);
        if (!glbPath) return sendJson(404, {error: 'Invalid hash'});
        try {
          const buf = await fs.readFile(glbPath);
          res.writeHead(200, {
            'Content-Type': 'model/gltf-binary',
            'Content-Length': buf.length,
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(buf);
          return;
        } catch {
          return sendJson(404, {error: 'No cached GLB proxy'});
        }
      }

      // --- Mods, Node-Graph, and Session Routers ---
      if (await handleModsRequest(req, res, pathname)) return;
      if (await handleNodeGraphRequest(req, res, pathname)) return;
      if (await sessionMgr.handleSessionRequest(req, res, pathname)) return;

      // --- Static Frontend Assets (`public/`) ---
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(405, {error: 'Method not allowed'});
      }
      const relReq = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const resolvedFile = path.resolve(publicDir, relReq);
      if (resolvedFile !== publicDir && !resolvedFile.startsWith(publicDir + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      try {
        const st = await fs.stat(resolvedFile);
        if (!st.isFile()) throw Error('Not a file');
        const ext = path.extname(resolvedFile).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        const data = await fs.readFile(resolvedFile);
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': data.length,
          'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(data);
      } catch {
        res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('Not Found');
      }
    } catch (err) {
      if (!res.headersSent) {
        sendJson(500, {error: err?.message || String(err)});
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;
  return {server, port: actualPort, url, sessionMgr};
}

if (
  import.meta.url === `file:///${(process.argv[1] || '').replace(/\\/g, '/')}` ||
  path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)
) {
  startMorphoGemServer().then(({url}) => {
    console.log(`MorphoGem Studio running at ${url}`);
  });
}
