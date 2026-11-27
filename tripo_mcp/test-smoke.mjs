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
import { registerGraphDocument, createNode, connectPorts, nodeStatus, defaultHeightForPartName } from '../public/node-graph.mjs';
import { buildNodeGraphViewsPrompt, computeLockedNodesForViews } from '../public/node-graph-prompts.mjs';
import { SUPPORTED_LOCALES } from '../public/i18n.mjs';
import { encodeRgbaPng } from '../scripts/mask-and-ratio-guides.mjs';

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

  // Verify Custom Parametric Body Proportion Spec (custom shoulder/waist/hip/leg ratios) & Mask-Guided Extraction
  proj.nodeGraph.proportionSpec = {
    enabled: true,
    archetype: 'custom',
    headRatio: 2.5,
    headWidth: 0.96,
    neckLen: 0.08,
    shoulderWidth: 1.88,
    chestWidth: 1.42,
    waistWidth: 0.95,
    hipWidth: 1.24,
    legRatio: 0.58,
    limbThickness: 1.15,
    armSpan: 0.92,
    pose: 't',
  };
  assert.ok(defaultHeightForPartName('无发裸脸', 2.5, 1.5) > 0.55, '2.5H chibi head should be ~0.60m on 1.5m character');
  assert.ok(defaultHeightForPartName('服装身体', 2.5, 1.5) < 1.05, '2.5H chibi headless body should be compact (<1.05m)');

  const maskRgba = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    const isCenter = i === 5 || i === 6 || i === 9 || i === 10;
    maskRgba[i * 4] = isCenter ? 255 : 0;
    maskRgba[i * 4 + 1] = isCenter ? 255 : 0;
    maskRgba[i * 4 + 2] = isCenter ? 255 : 0;
    maskRgba[i * 4 + 3] = 255;
  }
  const maskPng = encodeRgbaPng(4, 4, maskRgba);
  const maskNode = createNode('mask_ref', 60, 380, { note: '白色=披肩外套' });
  const maskDoc = await registerGraphDocument(proj, files, 'cape_mask.png', new Uint8Array(maskPng), 'mask_ref');
  maskNode.data.image = { ...maskDoc, mime: 'image/png', width: 4, height: 4 };
  proj.nodeGraph.nodes.push(maskNode);
  const firstPartNode = proj.nodeGraph.nodes.find(n => n.type === 'part_views');
  firstPartNode.params.maskMode = 'white';
  connectPorts(proj.nodeGraph, maskNode.id, 'mask', firstPartNode.id, 'mask');

  // Verify Smart Mesh UV+Retexture params & standalone `tripo_retexture` node roundtrip
  const smartMeshNode = createNode('tripo_mesh', 500, 120, { quality: 'smart', polyFaces: 18000, smartUv: true, autoRetexture: true });
  assert.equal(smartMeshNode.params.smartUv, true);
  assert.equal(smartMeshNode.params.autoRetexture, true);
  const retexNode = createNode('tripo_retexture', 860, 120, { smartUv: true, retexture: true, textureSize: 8192 });
  proj.nodeGraph.nodes.push(smartMeshNode, retexNode);
  connectPorts(proj.nodeGraph, smartMeshNode.id, 'mesh', retexNode.id, 'mesh');
  assert.equal(nodeStatus(proj.nodeGraph, retexNode.id).state, 'waiting');

  const packed = await packProject(proj, files);
  const unpacked = await unpackProject(packed.bytes);
  assert.equal(unpacked.project.name, 'MorphoDiana');
  assert.equal(unpacked.files.size, 2);

  // Verify `node-graph-cli.mjs export-inputs` generates both `proportion_ruler_2.5H.png` & `<partNodeId>_mask_overlay.png`
  const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'mgem-v22-smoke-'));
  try {
    const tmpMgem = path.join(tmpWork, 'test.mgem');
    const outInputs = path.join(tmpWork, 'graph_inputs');
    await fs.writeFile(tmpMgem, packed.bytes);
    const { stdout: expOut } = await execFileAsync(process.execPath, [
      path.join(appRoot, 'scripts', 'node-graph-cli.mjs'),
      'export-inputs',
      tmpMgem,
      outInputs,
    ]);
    const expJson = JSON.parse(expOut);
    assert.equal(expJson.headBodyRatio, 2.5);
    assert.ok(expJson.proportionRulerPath && expJson.proportionRulerPath.endsWith('proportion_ruler_2.5H.png'));
    assert.equal(expJson.maskGuides.length, 1);
    assert.ok(expJson.maskGuides[0].overlayPath && expJson.maskGuides[0].overlayPath.endsWith(`${firstPartNode.id}_mask_overlay.png`));
  } finally {
    await fs.rm(tmpWork, { recursive: true, force: true });
  }

  const lockInfo = computeLockedNodesForViews(unpacked.project.nodeGraph);
  assert.ok(lockInfo.targetNodeIds.length >= 2, 'Should target dirty part_views nodes');
  assert.ok(lockInfo.lockedNodeIds.includes(srcNode.id), 'Upstream source_image should be locked during AI run');
  assert.ok(lockInfo.lockedNodeIds.includes(maskNode.id), 'Upstream mask_ref should be locked during AI run');

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
    assert.ok(prompt.includes('proportion_ruler_2.5H.png'), `Prompt (${locale}) missing parametric ratio ruler`);
    assert.ok(prompt.includes('1.88'), `Prompt (${locale}) missing custom shoulderWidth 1.88`);
    assert.ok(prompt.includes('58%'), `Prompt (${locale}) missing custom legRatio 58%`);
    assert.ok(prompt.includes(`${firstPartNode.id}_mask_overlay.png`), `Prompt (${locale}) missing mask highlight overlay`);
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
