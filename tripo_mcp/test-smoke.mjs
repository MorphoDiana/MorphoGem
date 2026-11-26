import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { verifyFbxHeader } from './src/downloads.mjs';
import { createNewProject, packProject, unpackProject, checkFBX } from '../public/mgem-project.mjs';
import { registerGraphDocument } from '../public/node-graph.mjs';
import { buildNodeGraphViewsPrompt, computeLockedNodesForViews } from '../public/node-graph-prompts.mjs';
import { SUPPORTED_LOCALES } from '../public/i18n.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function testMcpHandshake() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, 'server.mjs')],
  });
  const client = new Client({ name: 'smoke-test-client', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    const expected = [
      'tripo_status',
      'tripo_generate',
      'tripo_wait',
      'tripo_export',
      'tripo_generate_and_export',
      'tripo_upload_model',
      'tripo_segment',
      'tripo_retexture',
      'tripo_rig',
    ];
    for (const exp of expected) {
      assert.ok(names.includes(exp), `Missing MCP tool: ${exp}`);
    }
    console.log(`[PASS] MCP handshake & listTools (${names.length} tools verified): ${names.join(', ')}`);
  } finally {
    await client.close();
  }
}

async function testCliAndDaemon() {
  const cliPath = path.join(__dirname, 'cli.mjs');
  const { stdout: helpOut } = await execFileAsync(process.execPath, [cliPath, '--help']);
  assert.ok(helpOut.includes('generate_and_export'), 'CLI help should list generate_and_export');

  const { stdout: stopOut } = await execFileAsync(process.execPath, [cliPath, 'stop']);
  const parsed = JSON.parse(stopOut);
  assert.equal(parsed.stopped, true);
  console.log('[PASS] Persistent daemon auto-spawn + authenticated RPC + clean shutdown verified');
}

async function testMgemArchiveAndBilingualPrompts() {
  assert.deepEqual([...SUPPORTED_LOCALES], ['zh-CN', 'en'], 'Only zh-CN and en locales should be supported');

  const appRoot = path.resolve(__dirname, '..');
  const files = new Map();
  const proj = createNewProject({ name: 'MorphoDiana', locale: 'zh-CN' });

  // Attach a minimal 1x1 PNG to source_image node and verify .mgem pack/unpack roundtrip
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const srcNode = proj.nodeGraph.nodes.find(n => n.type === 'source_image');
  const doc = await registerGraphDocument(proj, files, 'concept.png', new Uint8Array(png1x1), 'src');
  srcNode.data.image = { ...doc, mime: 'image/png', width: 1, height: 1 };

  const packed = await packProject(proj, files);
  const unpacked = await unpackProject(packed.bytes);
  assert.equal(unpacked.project.name, 'MorphoDiana');
  assert.equal(unpacked.files.size, 1);

  const lockInfo = computeLockedNodesForViews(unpacked.project.nodeGraph);
  assert.ok(lockInfo.targetNodeIds.length >= 2, 'Should target dirty part_views nodes');
  assert.ok(lockInfo.lockedNodeIds.includes(srcNode.id), 'Upstream source_image should be locked during AI run');

  for (const locale of ['zh-CN', 'en']) {
    const prompt = buildNodeGraphViewsPrompt(
      { id: 'req-clean-1' },
      appRoot,
      'http://127.0.0.1:8766',
      unpacked.project,
      null,
      locale
    );
    assert.ok(prompt.includes('scripts/mgem-session.mjs'), `Prompt (${locale}) missing mgem-session.mjs`);
    assert.ok(prompt.includes('scripts/align_views.py'), `Prompt (${locale}) missing align_views.py`);
    assert.ok(prompt.includes('skills/morphogem-orthographic-views/SKILL.md'), `Prompt (${locale}) missing orthographic skill`);
    assert.ok(prompt.includes('skills/morphogem-albedo-shading/SKILL.md'), `Prompt (${locale}) missing albedo skill`);
    assert.ok(prompt.includes('skills/morphogem-alpha-alignment/SKILL.md'), `Prompt (${locale}) missing alpha-alignment skill`);
    if (locale === 'en') {
      assert.ok(prompt.includes('Report progress and results in **English**'), 'English prompt header check');
    } else {
      assert.ok(prompt.includes('简体中文'), 'Chinese prompt header check');
    }
  }
  console.log('[PASS] Clean-room .mgem archive roundtrip + granular node lock + zh-CN/en prompt generation verified');
}

async function testFbxVerifier() {
  const tmpFile = path.join(os.tmpdir(), `smoke-fbx-${Date.now()}.fbx`);
  const buf = Buffer.alloc(72);
  buf.write('Kaydara FBX Binary  \x00', 0, 'utf8');
  buf.writeUInt32LE(7400, 23);
  await fs.writeFile(tmpFile, buf);
  try {
    const ver = await verifyFbxHeader(tmpFile);
    assert.equal(ver, 7400);
    assert.equal(checkFBX(new Uint8Array(buf)), 7400);
    console.log('[PASS] FBX binary header verifier passed (v7400)');
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

await testMcpHandshake();
await testCliAndDaemon();
await testMgemArchiveAndBilingualPrompts();
await testFbxVerifier();
console.log('ALL_SMOKE_TESTS_PASSED');
