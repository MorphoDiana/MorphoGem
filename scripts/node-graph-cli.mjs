#!/usr/bin/env node
/**
 * MorphoGem Clean-Room Node-Graph CLI
 *
 * Commands:
 *   node scripts/node-graph-cli.mjs export-inputs <project.mgem> <outDir>
 *   node scripts/node-graph-cli.mjs register-views <config.json> <output.mgem>
 *   node scripts/node-graph-cli.mjs register-meshes <config.json> <output.mgem>
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unpackProject, packProject, checkFBX, inspectImage} from '../public/mgem-project.mjs';
import {
  GRAPH_VIEWS_4,
  GRAPH_VIEWS_3,
  ensureNodeGraph,
  getNode,
  isMeshNodeType,
  resolveUpstreamViewsNode,
  resolveGraphHeadBodyRatio,
  resolveNumericHeadBodyRatio,
  incomingEdges,
  nodeInputStamp,
  defaultPlacementForPartName,
  defaultHeightForPartName,
  registerGraphDocument,
  pruneUnusedGraphDocuments,
} from '../public/node-graph.mjs';
import {
  findBlender,
  atomicWrite,
  generatePreviewGlbFromBuffer,
  PREVIEW_PROXY_MIN_BYTES,
} from '../server-blender.mjs';
import {
  generateRatioRulerGuide,
  generateMaskOverlayGuide,
} from './mask-and-ratio-guides.mjs';

async function measureFbxNormalization(fbxPath, targetHeight) {
  const blender = await findBlender();
  if (!blender) {
    // Graceful fallback when Blender has not been configured yet;
    // the Three.js 3D viewport auto-fits raw FBX geometry when `autoFit` is true.
    return {scale: 1, offset: [0, 0, 0], height: targetHeight, autoFit: true};
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ng-measure-'));
  try {
    const outJson = path.join(tmp, 'norm.json');
    const py = `
import bpy, json, sys
fbx_path, target_h, out_path = sys.argv[sys.argv.index('--') + 1:]
target_h = float(target_h)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(filepath=fbx_path, use_image_search=False, use_anim=False)
bpy.context.view_layer.update()
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError('No mesh in FBX')
pts = []
for o in meshes:
    mw = o.matrix_world
    for v in o.data.vertices:
        p = mw @ v.co
        # Blender (x, y, z) -> Three.js Y-up (x, z, -y)
        pts.append((p.x, p.z, -p.y))
xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; zs = [p[2] for p in pts]
size_y = max(ys) - min(ys)
if size_y < 1e-8:
    raise RuntimeError('Zero height mesh')
cx = (min(xs) + max(xs)) / 2.0
cy = (min(ys) + max(ys)) / 2.0
cz = (min(zs) + max(zs)) / 2.0
scale = target_h / size_y
norm = {'scale': scale, 'offset': [-cx * scale, -cy * scale, -cz * scale], 'height': target_h}
with open(out_path, 'w', encoding='utf-8') as fh:
    json.dump(norm, fh)
`;
    const pyFile = path.join(tmp, 'measure_ng.py');
    await fs.writeFile(pyFile, py, 'utf8');
    await new Promise((resolve, reject) => {
      const child = spawn(
        blender,
        [
          '--background',
          '--factory-startup',
          '--disable-autoexec',
          '--python-exit-code', '1',
          '--python', pyFile,
          '--', path.resolve(fbxPath), String(targetHeight), outJson,
        ],
        {windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']}
      );
      let log = '';
      child.stdout.on('data', d => { log = (log + d).slice(-3000); });
      child.stderr.on('data', d => { log = (log + d).slice(-3000); });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(Error(log || `Blender measure failed (${code})`))));
    });
    return JSON.parse(await fs.readFile(outJson, 'utf8'));
  } finally {
    await fs.rm(tmp, {recursive: true, force: true}).catch(() => {});
  }
}

export async function registerMeshCandidatesIntoNode(p, files, nodeId, specs, {replace = true} = {}) {
  const g = ensureNodeGraph(p);
  const node = getNode(g, nodeId);
  if (!node || !isMeshNodeType(node.type)) throw Error(`Tripo mesh/retexture node not found: ${nodeId}`);

  const pvNode = resolveUpstreamViewsNode(g, node.id);
  const partName = pvNode?.params?.partName || node.params?.title || 'Part';
  const ratioNum = resolveNumericHeadBodyRatio(pvNode?.params?.headBodyRatio, pvNode?.params?.customHeadBodyRatio)
    || resolveGraphHeadBodyRatio(g);
  const totalCharHeight = Number(p.targetHeight) || 1.7;
  const targetH = defaultHeightForPartName(partName, ratioNum, totalCharHeight);

  if (replace) node.data.candidates = [];

  for (const spec of specs) {
    const fbxAbs = path.resolve(spec.fbx);
    const fbxBytes = new Uint8Array(await fs.readFile(fbxAbs));
    checkFBX(fbxBytes);
    const norm = await measureFbxNormalization(fbxAbs, targetH);
    const doc = await registerGraphDocument(p, files, path.basename(fbxAbs), fbxBytes, `mesh-${node.id}`);
    const resDocs = [];
    const rawResForPreview = [];
    for (const rPath of spec.resources || []) {
      const rAbs = path.resolve(rPath);
      const rBytes = new Uint8Array(await fs.readFile(rAbs));
      const rDoc = await registerGraphDocument(p, files, path.basename(rAbs), rBytes, `tex-${node.id}`);
      resDocs.push(rDoc);
      rawResForPreview.push({name: path.basename(rAbs), data: rBytes});
    }
    if (fbxBytes.byteLength >= PREVIEW_PROXY_MIN_BYTES) {
      await generatePreviewGlbFromBuffer(doc.sha256, fbxBytes, rawResForPreview).catch(() => {});
    }
    const cand = {
      id: `cand_${crypto.randomUUID().slice(0, 8)}`,
      name: spec.name || path.basename(fbxAbs),
      path: doc.path,
      sha256: doc.sha256,
      resources: resDocs,
      normalization: norm,
      ...(spec.modelId ? {tripoModelId: spec.modelId} : {}),
    };
    node.data.candidates.push(cand);
  }

  if (node.data.candidates.length) {
    node.data.selectedId = node.data.candidates[0].id;
    node.data.completedStamp = nodeInputStamp(g, node.id);
    p.placements ??= {};
    p.placements[node.id] ??= {
      position: defaultPlacementForPartName(partName, 0, ratioNum, totalCharHeight),
      rotation: [0, 0, 0],
      scale: 1,
    };
  }
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  if (cmd === 'export-inputs') {
    if (!arg1 || !arg2) throw Error('Usage: node scripts/node-graph-cli.mjs export-inputs <project.mgem> <outDir>');
    const kitBytes = await fs.readFile(path.resolve(arg1));
    const {project: p, files} = await unpackProject(kitBytes);
    const g = ensureNodeGraph(p);
    const outDir = path.resolve(arg2);
    await fs.mkdir(outDir, {recursive: true});

    const exported = [];
    const savedByNodeId = new Map();
    for (const n of g.nodes) {
      if (['source_image', 'mask_ref', 'style_ref', 'ratio_ref'].includes(n.type) && n.data?.image?.path) {
        const bytes = files.get(n.data.image.path);
        if (!bytes) continue;
        const ext = path.extname(n.data.image.path) || '.png';
        const outFile = path.join(outDir, `${n.id}${ext}`);
        await fs.writeFile(outFile, bytes);
        savedByNodeId.set(n.id, outFile);
        exported.push({
          nodeId: n.id,
          type: n.type,
          filename: n.data.image.filename,
          note: n.params?.note || '',
          savedPath: outFile,
        });
      }
      if (n.type === 'part_views' && n.data?.maskImage?.path) {
        const bytes = files.get(n.data.maskImage.path);
        if (bytes) {
          const ext = path.extname(n.data.maskImage.path) || '.png';
          const outMaskFile = path.join(outDir, `${n.id}_mask${ext}`);
          await fs.writeFile(outMaskFile, bytes);
          savedByNodeId.set(`${n.id}:inline_mask`, outMaskFile);
          exported.push({
            nodeId: n.id,
            type: 'inline_part_mask',
            partName: n.params?.partName || '',
            filename: n.data.maskImage.filename,
            savedPath: outMaskFile,
          });
        }
      }
    }

    // Generate Mask Highlight Overlays (`<partNodeId>_mask_overlay.png`) for all masked part_views nodes
    const maskGuides = [];
    for (const n of g.nodes) {
      if (n.type !== 'part_views') continue;
      const inEdges = incomingEdges(g, n.id);
      const srcEdge = inEdges.find(e => e.toPort === 'source');
      const mskEdge = inEdges.find(e => e.toPort === 'mask');
      const srcPath = srcEdge ? savedByNodeId.get(srcEdge.fromNode) : null;
      const mskPath = mskEdge
        ? savedByNodeId.get(mskEdge.fromNode)
        : savedByNodeId.get(`${n.id}:inline_mask`);
      if (srcPath && mskPath) {
        const overlayPath = path.join(outDir, `${n.id}_mask_overlay.png`);
        const built = await generateMaskOverlayGuide({
          sourcePath: srcPath,
          maskPath: mskPath,
          mode: n.params?.maskMode || 'auto',
          colorHex: n.params?.maskColor || '#ff3b30',
          outPath: overlayPath,
        });
        maskGuides.push({
          nodeId: n.id,
          partName: n.params?.partName || '',
          maskMode: n.params?.maskMode || 'auto',
          maskColor: n.params?.maskColor || '#ff3b30',
          maskPath: mskPath,
          overlayPath: built || null,
        });
      }
    }

    // Generate Orthographic Head-Body Proportion Ruler PNG when parametric ratio is enabled
    const globalRatio = resolveGraphHeadBodyRatio(g);
    let proportionRulerPath = null;
    if (globalRatio) {
      const primaryPose = g.nodes.find(x => x.type === 'balance_views' || x.type === 'part_views')?.params?.pose || 't';
      const rulerOut = path.join(outDir, `proportion_ruler_${globalRatio}H.png`);
      proportionRulerPath = await generateRatioRulerGuide({
        ratio: globalRatio,
        size: 1024,
        pose: primaryPose,
        outPath: rulerOut,
      });
    }

    console.log(JSON.stringify({
      projectId: p.id,
      projectName: p.name,
      headBodyRatio: globalRatio,
      proportionRulerPath,
      maskGuides,
      inputs: exported,
    }, null, 2));
    return;
  }

  if (cmd === 'register-views') {
    if (!arg1 || !arg2) throw Error('Usage: node scripts/node-graph-cli.mjs register-views <config.json> <output.mgem>');
    const cfgPath = path.resolve(arg1);
    const baseDir = path.dirname(cfgPath);
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    const srcKit = path.resolve(baseDir, cfg.input);
    const outKit = path.resolve(arg2);
    const origBytes = await fs.readFile(srcKit);
    const {project: p, files} = await unpackProject(origBytes);
    const g = ensureNodeGraph(p);

    for (const item of cfg.nodes || []) {
      const node = getNode(g, item.nodeId);
      if (!node || !['part_views', 'balance_views'].includes(node.type)) {
        throw Error(`View node not found: ${item.nodeId}`);
      }
      const keys = node.type === 'balance_views' ? GRAPH_VIEWS_3 : GRAPH_VIEWS_4;
      node.data.views ??= {};
      for (const k of keys) {
        if (!item.views?.[k]) continue;
        const imgAbs = path.resolve(baseDir, item.views[k]);
        const imgBytes = new Uint8Array(await fs.readFile(imgAbs));
        const ext = path.extname(imgAbs).slice(1) || 'png';
        const info = await inspectImage(imgBytes, ext);
        const doc = await registerGraphDocument(p, files, path.basename(imgAbs), imgBytes, `${node.id}-${k}`);
        node.data.views[k] = {...doc, mime: info.mime, width: info.width, height: info.height};
      }
      if (keys.every(k => node.data.views?.[k]?.sha256)) {
        node.data.completedStamp = nodeInputStamp(g, node.id);
      }
    }

    pruneUnusedGraphDocuments(p, files);
    const packed = await packProject(p, files);
    await atomicWrite(outKit, Buffer.from(packed.bytes));
    console.log(outKit);
    return;
  }

  if (cmd === 'register-meshes') {
    if (!arg1 || !arg2) throw Error('Usage: node scripts/node-graph-cli.mjs register-meshes <config.json> <output.mgem>');
    const cfgPath = path.resolve(arg1);
    const baseDir = path.dirname(cfgPath);
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    const srcKit = path.resolve(baseDir, cfg.input);
    const outKit = path.resolve(arg2);
    const origBytes = await fs.readFile(srcKit);
    const {project: p, files} = await unpackProject(origBytes);

    for (const item of cfg.nodes || []) {
      const resolvedCands = (item.candidates || []).map(c => ({
        fbx: path.resolve(baseDir, c.fbx),
        name: c.name,
        resources: (c.resources || []).map(r => path.resolve(baseDir, r)),
      }));
      await registerMeshCandidatesIntoNode(p, files, item.nodeId, resolvedCands, {replace: item.replace !== false});
    }

    pruneUnusedGraphDocuments(p, files);
    const packed = await packProject(p, files);
    await atomicWrite(outKit, Buffer.from(packed.bytes));
    console.log(outKit);
    return;
  }

  throw Error(`Unknown command: ${cmd}`);
}

if (
  import.meta.url === `file:///${(process.argv[1] || '').replace(/\\/g, '/')}` ||
  path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)
) {
  main().catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
