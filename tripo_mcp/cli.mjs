#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_STATE_FILE = path.join(__dirname, '.daemon-state.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureDependencies() {
  try {
    await fs.access(path.join(__dirname, 'node_modules', 'puppeteer-core'));
  } catch {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    console.error('[tripo_mcp] Installing dependencies on first run...');
    execFileSync(npmCmd, ['ci', '--no-audit', '--no-fund'], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
}

function rpcCall(port, token, payload, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          'x-tripo-token': token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`RPC timed out after ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function readDaemonState() {
  try {
    const state = JSON.parse(await fs.readFile(DAEMON_STATE_FILE, 'utf8'));
    const { statusCode, body } = await rpcCall(state.port, state.token, { action: 'ping' }, 1500);
    if (statusCode === 200 && body?.ok) return state;
  } catch {
    // daemon not running
  }
  return null;
}

async function ensureDaemon() {
  await ensureDependencies();
  let state = await readDaemonState();
  if (state) return state;

  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.mjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(200);
    state = await readDaemonState();
    if (state) return state;
  }
  throw new Error('Failed to start tripo_mcp background daemon');
}

function parseFlags(args) {
  if (args.length === 1 && args[0].trim().startsWith('{')) {
    return JSON.parse(args[0]);
  }
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json-file' && args[i + 1]) {
      return { __jsonFile: args[++i] };
    }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      i++;
      if (next === 'true') out[key] = true;
      else if (next === 'false') out[key] = false;
      else if (/^-?\d+$/.test(next)) out[key] = Number.parseInt(next, 10);
      else if (key === 'modelIds' || key === 'subdirs') out[key] = next.split(',').map(s => s.trim()).filter(Boolean);
      else out[key] = next;
    }
  }
  return out;
}

const USAGE = `Usage:
  node tripo_mcp/cli.mjs <action> [options | JSON | --json-file config.json]

Actions:
  status [--screenshot-path out.png]
  generate --front F.png --left L.png --right R.png --back B.png [--smart-mesh false|true] [--topology Quad|Triangle] [--ai-model H3.5|P2.0] [--polycount 25000] [--texture-quality 4K|8K] [--count 1] [--wait true]
  wait [--model-ids id1,id2] [--screenshot-dir dir]
  export [--model-ids id1,id2] --output-dir dir [--subdirs c1,c2] [--format FBX] [--preset Blender] [--texture-resolution 4k|8k]
  generate_and_export --front F.png --left L.png --right R.png --back B.png [--smart-mesh false|true] [--topology Quad|Triangle] [--polycount 25000] [--texture-quality 4K|8K] --count 1 --output-dir dir
  upload_model --file-path model.fbx [--rotate-y 90]
  segment --file-path model.glb --output-dir dir
  retexture --file-path part.fbx --front-png f.png --back-png b.png [--smart-u-v true] [--texture-quality 4K|8K] --output-dir dir
  rig --file-path rig-input.fbx --output-dir dir
  stop`;

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!action || action === '--help' || action === '-h') {
    console.log(USAGE);
    return;
  }

  let params = parseFlags(rest);
  if (params.__jsonFile) {
    params = JSON.parse(await fs.readFile(path.resolve(params.__jsonFile), 'utf8'));
  }
  if (params.smartUV === undefined && params.smartUV !== false && Object.hasOwn(params, 'smartUv')) {
    params.smartUV = params.smartUv;
    delete params.smartUv;
  }

  const state = await ensureDaemon();
  const { statusCode, body } = await rpcCall(state.port, state.token, { action, params }, 45 * 60 * 1000);
  if (statusCode !== 200 || !body.ok) {
    console.error(body?.error || `HTTP ${statusCode}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(body.result, null, 2));
}

main().catch(err => {
  console.error(err?.message || err);
  process.exitCode = 1;
});
