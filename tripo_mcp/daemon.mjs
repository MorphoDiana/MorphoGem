#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TripoController } from './src/tripo-controller.mjs';
import { runSegmentation, runSmartUvOnly, runRetexture, runRigging } from './src/tripo-postprocess.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DAEMON_STATE_FILE = process.env.TRIPO_DAEMON_STATE_FILE
  ? path.resolve(process.env.TRIPO_DAEMON_STATE_FILE)
  : path.join(__dirname, '.daemon-state.json');

const IDLE_TIMEOUT_MS = 45 * 60 * 1000; // 45 min auto-shutdown (disabled in embedded desktop mode)

export function createTripoDispatcher(controller, { onStop } = {}) {
  return async function dispatch(action, params = {}) {
    switch (action) {
      case 'ping': return { ok: true, pid: process.pid, embedded: Boolean(process.env.TRIPO_EMBEDDED === '1') };
      case 'status': return controller.status(params);
      case 'generate': return controller.generate(params);
      case 'wait': return controller.waitForModels(params);
      case 'export': return controller.exportModels(params);
      case 'generate_and_export': {
        const gen = await controller.generate({ ...params, mode: params.mode || 'multiview', wait: true });
        const modelIds = gen.models.map(m => m.modelId);

        // Smart Mesh post-pipeline: optional Smart UV Unwrap + Multi-View Retexture before FBX export
        if (params.smartMesh && (params.smartUV || params.retextureAfterGenerate)) {
          const exports = [];
          const updatedModels = [];
          for (let i = 0; i < modelIds.length; i++) {
            const sub = Array.isArray(params.subdirs) && params.subdirs[i]
              ? path.join(path.resolve(params.outputDir), params.subdirs[i])
              : path.resolve(params.outputDir);
            if (params.retextureAfterGenerate) {
              const ret = await runRetexture(controller, {
                modelId: modelIds[i],
                smartUV: Boolean(params.smartUV),
                frontPng: params.front,
                leftPng: params.left,
                rightPng: params.right,
                backPng: params.back,
                textureQuality: params.textureQuality || '4K',
                pbr: params.pbr !== false,
                removeLighting: Boolean(params.removeLighting),
                outputDir: sub,
              });
              updatedModels.push({ ...gen.models[i], modelId: ret.modelId });
              exports.push({ ...ret.export, modelId: ret.modelId });
            } else {
              const uvRes = await runSmartUvOnly(controller, {
                modelId: modelIds[i],
                outputDir: sub,
              });
              updatedModels.push({ ...gen.models[i], modelId: uvRes.modelId });
              exports.push({ ...uvRes.export, modelId: uvRes.modelId });
            }
          }
          return {
            status: 'generated_and_exported',
            creditsRemaining: gen.creditsRemaining,
            models: updatedModels,
            exports,
          };
        }

        const exp = await controller.exportModels({
          modelIds,
          format: params.format || 'FBX',
          preset: params.preset || 'Blender',
          textureResolution: String(params.textureQuality || '4k').toLowerCase(),
          outputDir: params.outputDir,
          subdirs: params.subdirs,
        });
        const exportsWithIds = (exp.items || []).map((item, idx) => ({
          ...item,
          modelId: item.modelId || modelIds[idx] || '',
        }));
        return { status: 'generated_and_exported', creditsRemaining: gen.creditsRemaining, models: gen.models, exports: exportsWithIds };
      }
      case 'upload_model': return controller.uploadModel(params);
      case 'segment': return runSegmentation(controller, params);
      case 'smart_uv': return runSmartUvOnly(controller, params);
      case 'retexture': return runRetexture(controller, params);
      case 'rig': return runRigging(controller, params);
      case 'stop':
        if (onStop) setImmediate(() => onStop());
        return { stopped: true };
      default: throw new Error(`Unknown action: ${action}`);
    }
  };
}

/**
 * Starts an authenticated 127.0.0.1 RPC server for TripoController and writes `.daemon-state.json`.
 * Used both by standalone `daemon.mjs` and in-process inside the Electron Desktop app (`MorphoGem.exe`).
 */
export async function startTripoRpcDaemon({
  wsEndpoint,
  browserURL,
  embedded = false,
  idleTimeoutMs = embedded ? 0 : IDLE_TIMEOUT_MS,
  stateFile = DAEMON_STATE_FILE,
  extraStateFiles = [],
  onActivity,
  onBlocked,
  onUnblocked,
  onSelfStop,
} = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const controller = new TripoController({
    wsEndpoint,
    browserURL,
    embedded,
    onActivity,
    onBlocked,
    onUnblocked,
  });

  let idleTimer = null;
  const resetIdle = () => {
    if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close(), idleTimeoutMs);
  };

  const allStateFiles = [stateFile, ...extraStateFiles].filter(Boolean).map(f => path.resolve(f));

  async function close() {
    if (idleTimer) clearTimeout(idleTimer);
    for (const f of allStateFiles) {
      try { await fs.rm(f, { force: true }); } catch { /* ignore */ }
    }
    await controller.disconnect();
    await new Promise(resolve => srv.close(() => resolve()));
    onSelfStop?.();
  }

  const dispatch = createTripoDispatcher(controller, {
    onStop: embedded ? null : () => close(),
  });

  const srv = http.createServer(async (req, res) => {
    resetIdle();
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers['x-tripo-token'] !== token) return send(403, { error: 'Forbidden' });
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { error: 'Not found' });
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { action, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await dispatch(action, params);
      send(200, { ok: true, result });
    } catch (err) {
      send(500, { ok: false, error: err?.message || String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });

  const { port } = srv.address();
  const payload = JSON.stringify({
    pid: process.pid,
    port,
    token,
    embedded,
    startedAt: new Date().toISOString(),
  }, null, 2);

  for (const f of allStateFiles) {
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, payload, 'utf8');
  }
  resetIdle();

  return { controller, port, token, stateFiles: allStateFiles, close };
}

if (import.meta.url === `file:///${(process.argv[1] || '').replace(/\\/g, '/')}` || path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const instance = await startTripoRpcDaemon({
    onSelfStop: () => process.exit(0),
  });
  const handleSig = () => {
    instance.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', handleSig);
  process.on('SIGTERM', handleSig);
}
