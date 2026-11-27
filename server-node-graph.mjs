import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findBlender, sameOrigin, atomicWrite} from './server-blender.mjs';
import {unpackProject, packProject, zipStore} from './public/mgem-project.mjs';
import {
  GRAPH_VIEWS_4,
  ensureNodeGraph,
  getNode,
  isMeshNodeType,
  resolveUpstreamViewsNode,
  incomingEdges,
  nodeInputStamp,
  connectedAssemblyMeshes,
  pruneUnusedGraphDocuments,
} from './public/node-graph.mjs';
import {registerMeshCandidatesIntoNode} from './scripts/node-graph-cli.mjs';
import {DAEMON_STATE_FILE} from './tripo_mcp/daemon.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

function callTripoDaemon(port, token, action, params) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({action, params}), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'x-tripo-token': token,
        },
        timeout: 25 * 60 * 1000,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode === 200 && parsed.ok) resolve(parsed.result);
            else reject(Error(parsed?.error || `Tripo RPC failed (${res.statusCode})`));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('Tripo RPC timed out')));
    req.write(body);
    req.end();
  });
}

async function ensureTripoDaemonState() {
  const candidates = [
    process.env.TRIPO_DAEMON_STATE_FILE,
    DAEMON_STATE_FILE,
    process.env.MORPHOGEM_USERDATA_DIR ? path.join(process.env.MORPHOGEM_USERDATA_DIR, 'tripo-daemon-state.json') : null,
  ].filter(Boolean);

  for (const f of candidates) {
    try {
      const st = JSON.parse(await fs.readFile(f, 'utf8'));
      const ping = await callTripoDaemon(st.port, st.token, 'ping', {});
      if (ping?.ok) return st;
    } catch {
      // try next
    }
  }
  throw Error('未检测到运行中的 Tripo 守护服务。请使用 MorphoGem.exe 桌面端打开并在「Tripo 账号工作区」登录邮箱账号后再试。');
}

async function readBodyBuffer(req, maxBytes = 2 * 1024 ** 3 - 65536) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw Error('请求内容过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function runGraphExportBlender(kitBytes, assemblyNodeId = '') {
  const blender = await findBlender();
  if (!blender) throw Error('尚未配置 Blender 路径！请点击右上角「⚙ 设置」（或桌面端顶栏的 Blender 按钮）指定本机的 blender.exe 后再导出。');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ng-export-'));
  try {
    const inputKit = path.join(tmp, 'input.mgem');
    await fs.writeFile(inputKit, kitBytes);
    await new Promise((resolve, reject) => {
      const args = [
        '--background',
        '--factory-startup',
        '--disable-autoexec',
        '--python-exit-code', '1',
        '--python', path.join(root, 'scripts/export-node-graph.py'),
        '--', inputKit, tmp,
      ];
      if (assemblyNodeId) args.push('--assembly-node', assemblyNodeId);
      const child = spawn(blender, args, {windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
      let log = '';
      const collect = d => { log = (log + d).slice(-6000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('最终模型合并导出超时'));
      }, 600000);
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(Error(log || `Blender export failed (${code})`));
      });
    });

    const [fbxBytes, glbBytes, blendBytes] = await Promise.all([
      fs.readFile(path.join(tmp, 'merged.fbx')),
      fs.readFile(path.join(tmp, 'merged.glb')),
      fs.readFile(path.join(tmp, 'merged.blend')),
    ]);
    return {fbxBytes, glbBytes, blendBytes};
  } finally {
    await fs.rm(tmp, {recursive: true, force: true}).catch(() => {});
  }
}

function presetsFilePath() {
  if (process.env.MORPHOGEM_USERDATA_DIR) {
    return path.join(path.resolve(process.env.MORPHOGEM_USERDATA_DIR), 'node-presets.json');
  }
  return path.join(root, 'local', 'node-presets.json');
}

async function loadPresetsFile() {
  try {
    const raw = JSON.parse(await fs.readFile(presetsFilePath(), 'utf8'));
    return {
      version: 1,
      templates: Array.isArray(raw?.templates) ? raw.templates.slice(0, 100) : [],
      branches: Array.isArray(raw?.branches) ? raw.branches.slice(0, 200) : [],
    };
  } catch {
    return {version: 1, templates: [], branches: []};
  }
}

export async function handleNodeGraphRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/node-graph/')) return false;
  const sendJson = (code, obj) => {
    res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(obj));
  };
  if (!sameOrigin(req)) {
    sendJson(403, {error: 'Local access only'});
    return true;
  }

  try {
    // 0. Persistent User Templates & Custom Branch Presets Store
    if (pathname === '/api/node-graph/presets' && req.method === 'GET') {
      sendJson(200, await loadPresetsFile());
      return true;
    }
    if (pathname === '/api/node-graph/presets' && req.method === 'PUT') {
      const buf = await readBodyBuffer(req, 4 * 1024 * 1024);
      const parsed = JSON.parse(buf.toString('utf8'));
      const clean = {
        version: 1,
        templates: Array.isArray(parsed?.templates) ? parsed.templates.slice(0, 100) : [],
        branches: Array.isArray(parsed?.branches) ? parsed.branches.slice(0, 200) : [],
      };
      const file = presetsFilePath();
      await fs.mkdir(path.dirname(file), {recursive: true});
      await atomicWrite(file, Buffer.from(JSON.stringify(clean, null, 2), 'utf8'));
      sendJson(200, {ok: true, ...clean});
      return true;
    }

    // 1. Direct local execution of a `tripo_mesh` or `tripo_retexture` node using the embedded Tripo Studio browser
    if (pathname === '/api/node-graph/run-tripo' && req.method === 'POST') {
      const nodeId = req.headers['x-node-id'];
      if (!nodeId) throw Error('缺少目标节点 ID');
      const rawKit = await readBodyBuffer(req);
      const {project: p, files} = await unpackProject(rawKit);
      const g = ensureNodeGraph(p);
      const meshNode = getNode(g, nodeId);
      if (!meshNode || !isMeshNodeType(meshNode.type)) throw Error('目标 Tripo 节点不存在');

      // Branch A: Standalone `tripo_retexture` (Smart UV Unwrap + Multi-View Retexture on upstream mesh)
      if (meshNode.type === 'tripo_retexture') {
        const mEdge = incomingEdges(g, meshNode.id, 'mesh')[0];
        const upMeshNode = mEdge ? getNode(g, mEdge.fromNode) : null;
        const upCands = upMeshNode?.data?.candidates || [];
        const upCand = upCands.find(c => c.id === upMeshNode?.data?.selectedId) || upCands[0] || null;
        if (!upCand?.path || !files.has(upCand.path)) {
          throw Error('请先生成或连接上游的 3D 网格白模/原模后再执行重展开 UV 与上色');
        }

        const needRetex = meshNode.params.retexture !== false;
        const pvNode = resolveUpstreamViewsNode(g, meshNode.id);
        if (needRetex && (!pvNode || !GRAPH_VIEWS_4.every(k => pvNode.data?.views?.[k]?.path && files.has(pvNode.data.views[k].path)))) {
          throw Error('上色需要完整的四方向视图（请接入上游拆图节点，或取消勾选自动上色仅执行 Smart UV 重展开）');
        }
        if (!needRetex && meshNode.params.smartUv === false) {
          throw Error('请至少勾选「重展开 Smart UV」或「四视图上色」中的一项');
        }

        const daemon = await ensureTripoDaemonState();
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ng-retex-'));
        try {
          // Check if upstream candidate's tripoModelId is still live in Tripo workspace to avoid re-upload
          let reusableModelId = '';
          if (upCand.tripoModelId) {
            try {
              const st = await callTripoDaemon(daemon.port, daemon.token, 'status', {});
              if (Array.isArray(st?.assets) && st.assets.some(a => a.modelId === upCand.tripoModelId)) {
                reusableModelId = upCand.tripoModelId;
              }
            } catch { /* fallback to file upload */ }
          }

          let localFbxPath = '';
          if (!reusableModelId) {
            localFbxPath = path.join(tmp, path.basename(upCand.path) || 'input.fbx');
            await fs.writeFile(localFbxPath, files.get(upCand.path));
          }

          const viewPaths = {};
          if (needRetex && pvNode) {
            for (const k of GRAPH_VIEWS_4) {
              const vDoc = pvNode.data.views[k];
              const ext = path.extname(vDoc.path) || '.png';
              const outImg = path.join(tmp, `${k}${ext}`);
              await fs.writeFile(outImg, files.get(vDoc.path));
              viewPaths[k] = outImg;
            }
          }

          const outModelsDir = path.join(tmp, 'exported');
          let expItem = null;
          let finalModelId = '';

          if (needRetex) {
            const retRes = await callTripoDaemon(daemon.port, daemon.token, 'retexture', {
              ...(reusableModelId ? {modelId: reusableModelId} : {filePath: localFbxPath, rotateY: 90}),
              smartUV: meshNode.params.smartUv !== false,
              frontPng: viewPaths.front,
              leftPng: viewPaths.left,
              rightPng: viewPaths.right,
              backPng: viewPaths.back,
              textureQuality: meshNode.params.textureSize === 8192 ? '8K' : '4K',
              pbr: meshNode.params.pbr !== false,
              removeLighting: Boolean(meshNode.params.removeLighting),
              outputDir: outModelsDir,
            });
            expItem = retRes.export;
            finalModelId = retRes.modelId || '';
          } else {
            const uvRes = await callTripoDaemon(daemon.port, daemon.token, 'smart_uv', {
              ...(reusableModelId ? {modelId: reusableModelId} : {filePath: localFbxPath, rotateY: 90}),
              outputDir: outModelsDir,
            });
            expItem = uvRes.export;
            finalModelId = uvRes.modelId || '';
          }

          if (!expItem?.fbx) throw Error('Tripo 未返回重展 UV / 上色后的有效 FBX 文件');
          const specs = [{
            fbx: expItem.fbx,
            name: `${pvNode?.params?.partName || 'part'}_uv_tex.fbx`,
            resources: expItem.resources || [],
            modelId: finalModelId,
          }];

          await registerMeshCandidatesIntoNode(p, files, meshNode.id, specs, {replace: true});
          pruneUnusedGraphDocuments(p, files);
          const packed = await packProject(p, files);
          const outBytes = Buffer.from(packed.bytes);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': outBytes.length,
            'Cache-Control': 'no-store',
          });
          res.end(outBytes);
          return true;
        } finally {
          await fs.rm(tmp, {recursive: true, force: true}).catch(() => {});
        }
      }

      // Branch B: `tripo_mesh` generation (with integrated Smart UV + Retexture support when `quality === 'smart'`)
      const vEdge = incomingEdges(g, meshNode.id, 'views')[0];
      const pvNode = vEdge ? getNode(g, vEdge.fromNode) : null;
      if (!pvNode || !GRAPH_VIEWS_4.every(k => pvNode.data?.views?.[k]?.path && files.has(pvNode.data.views[k].path))) {
        throw Error('请先完成上游节点的四方向视图拆图');
      }

      const daemon = await ensureTripoDaemonState();
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ng-tripo-'));
      try {
        const viewPaths = {};
        for (const k of GRAPH_VIEWS_4) {
          const vDoc = pvNode.data.views[k];
          const ext = path.extname(vDoc.path) || '.png';
          const outImg = path.join(tmp, `${k}${ext}`);
          await fs.writeFile(outImg, files.get(vDoc.path));
          viewPaths[k] = outImg;
        }

        const isSmart = meshNode.params.quality === 'smart';
        const wantSmartUv = isSmart && (meshNode.params.smartUv !== false);
        const wantAutoRetex = isSmart && (meshNode.params.autoRetexture !== false);
        const count = [1, 2, 3, 4].includes(meshNode.params.candidateCount) ? meshNode.params.candidateCount : 1;
        const subdirs = Array.from({length: count}, (_, i) => `cand-${i + 1}`);
        const outModelsDir = path.join(tmp, 'exported');

        const genRes = await callTripoDaemon(daemon.port, daemon.token, 'generate_and_export', {
          mode: 'multiview',
          front: viewPaths.front,
          left: viewPaths.left,
          right: viewPaths.right,
          back: viewPaths.back,
          smartMesh: isSmart,
          smartUV: wantSmartUv,
          retextureAfterGenerate: wantAutoRetex,
          aiModel: isSmart ? 'P2.0' : (meshNode.params.aiModel === 'H3.1' ? 'H3.1' : 'H3.5'),
          topology: isSmart ? (meshNode.params.smartTopology === 'triangle' ? 'Triangle' : 'Quad') : undefined,
          polycount: meshNode.params.polyFaces,
          ultraMesh: !isSmart,
          texture: !isSmart || wantAutoRetex,
          textureQuality: meshNode.params.textureSize === 8192 ? '8K' : '4K',
          pbr: meshNode.params.pbr !== false,
          removeLighting: Boolean(meshNode.params.removeLighting),
          count,
          format: 'FBX',
          preset: 'Blender',
          outputDir: outModelsDir,
          subdirs,
        });

        const specs = (genRes.exports || []).map((item, idx) => ({
          fbx: item.fbx,
          name: `${pvNode.params?.partName || 'part'}_c${idx + 1}.fbx`,
          resources: item.resources || [],
          modelId: item.modelId || '',
        }));
        if (!specs.length) throw Error('Tripo 未返回有效 FBX 导出结果');

        await registerMeshCandidatesIntoNode(p, files, meshNode.id, specs, {replace: true});
        pruneUnusedGraphDocuments(p, files);
        const packed = await packProject(p, files);
        const outBytes = Buffer.from(await packed.blob.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': outBytes.length,
          'Cache-Control': 'no-store',
        });
        res.end(outBytes);
        return true;
      } finally {
        await fs.rm(tmp, {recursive: true, force: true}).catch(() => {});
      }
    }

    // 2. Merge & export all connected custom parts from an Assembly node as a ZIP (FBX + GLB + Blend)
    if (pathname === '/api/node-graph/export' && req.method === 'POST') {
      const assemblyNodeId = req.headers['x-assembly-node'] || '';
      const rawKit = await readBodyBuffer(req);
      const {project: p} = await unpackProject(rawKit);
      const g = ensureNodeGraph(p);
      const parts = connectedAssemblyMeshes(g, assemblyNodeId || null);
      if (!parts.length) throw Error('合体导出节点尚未接入任何已生成的 3D 部件');

      const {fbxBytes, glbBytes, blendBytes} = await runGraphExportBlender(rawKit, assemblyNodeId);
      const safeBase = ((p.name || 'character').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 80) || 'character');

      // Also persist to active session's project exports/ folder on disk if session.json is present
      const sessCandidates = [
        process.env.MORPHOGEM_SESSION_FILE,
        process.env.MORPHOGEM_USERDATA_DIR ? path.join(process.env.MORPHOGEM_USERDATA_DIR, 'session.json') : null,
        path.join(root, 'local', 'session.json'),
      ].filter(Boolean);
      for (const sf of sessCandidates) {
        try {
          const sess = JSON.parse(await fs.readFile(sf, 'utf8'));
          if (sess?.active?.id === p.id && sess?.active?.path) {
            const expDir = path.join(path.dirname(sess.active.path), 'exports');
            await fs.mkdir(expDir, {recursive: true});
            await Promise.all([
              atomicWrite(path.join(expDir, `${safeBase}.fbx`), fbxBytes),
              atomicWrite(path.join(expDir, `${safeBase}.glb`), glbBytes),
              atomicWrite(path.join(expDir, `${safeBase}.blend`), blendBytes),
            ]);
            break;
          }
        } catch {
          // ignore if unsaved project
        }
      }

      const zipBlob = zipStore({
        [`${safeBase}.fbx`]: new Uint8Array(fbxBytes),
        [`${safeBase}.glb`]: new Uint8Array(glbBytes),
        [`${safeBase}.blend`]: new Uint8Array(blendBytes),
      });
      const zipBuf = Buffer.from(await zipBlob.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zipBuf.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeBase}-assets.zip`)}`,
        'Cache-Control': 'no-store',
      });
      res.end(zipBuf);
      return true;
    }

    sendJson(404, {error: 'Not found'});
    return true;
  } catch (err) {
    sendJson(500, {error: err?.message || String(err)});
    return true;
  }
}
