// Composable DAG Node-Graph workflow for arbitrary part extraction & per-part 3D generation.
import {safePath, sha256} from './mgem-project.mjs';
import {
  PROPORTION_ARCHETYPES,
  createProportionSpecFromArchetype,
  normalizeProportionSpec,
  proportionSpecStamp,
} from './proportion-mannequin.mjs';

export {PROPORTION_ARCHETYPES, createProportionSpecFromArchetype, normalizeProportionSpec, proportionSpecStamp};

export const GRAPH_VIEWS_4 = Object.freeze(['front', 'left', 'right', 'back']);
export const GRAPH_VIEWS_3 = Object.freeze(['front', 'side', 'back']);

export const HEAD_BODY_RATIO_PRESETS = PROPORTION_ARCHETYPES;

export function resolveNumericHeadBodyRatio(presetVal, customVal = 6.8) {
  if (!presetVal || presetVal === 'keep') return null;
  const matched = PROPORTION_ARCHETYPES.find(a => a.id === presetVal);
  if (matched && matched.id !== 'custom' && matched.id !== 'keep') return matched.headRatio;
  if (presetVal === 'custom') {
    const c = Number(customVal);
    return Number.isFinite(c) ? Math.max(1.5, Math.min(9.5, c)) : 6.8;
  }
  const n = Number(presetVal);
  return Number.isFinite(n) && n >= 1.5 && n <= 9.5 ? n : null;
}

export function ensureGraphProportionSpec(graph) {
  if (!graph) return createProportionSpecFromArchetype('keep');
  graph.proportionSpec = normalizeProportionSpec(graph.proportionSpec, graph.headBodyRatio, graph.customHeadBodyRatio);
  graph.headBodyRatio = graph.proportionSpec.enabled ? graph.proportionSpec.archetype : 'keep';
  graph.customHeadBodyRatio = graph.proportionSpec.headRatio;
  return graph.proportionSpec;
}

export const NODE_SPECS = Object.freeze({
  source_image: {
    type: 'source_image',
    category: 'input',
    badge: '输入',
    defaultTitle: '主立绘（目标原画）',
    inputs: [],
    outputs: [{id: 'image', label: '主设计图', kind: 'image'}],
  },
  mask_ref: {
    type: 'mask_ref',
    category: 'input',
    badge: 'Mask遮罩',
    defaultTitle: 'Mask 分区遮罩图',
    inputs: [],
    outputs: [{id: 'mask', label: '部件 Mask', kind: 'mask'}],
  },
  style_ref: {
    type: 'style_ref',
    category: 'input',
    badge: '参考',
    defaultTitle: '画风参考立绘',
    inputs: [],
    outputs: [{id: 'style', label: '画风与上色', kind: 'style'}],
  },
  ratio_ref: {
    type: 'ratio_ref',
    category: 'input',
    badge: '旧版兼容',
    defaultTitle: '头身比参考图',
    inputs: [],
    outputs: [{id: 'ratio', label: '头身比例', kind: 'ratio'}],
  },
  part_views: {
    type: 'part_views',
    category: 'views',
    badge: 'AI 拆图',
    defaultTitle: '新拆分部件',
    inputs: [
      {id: 'source', label: '主设计图', kind: 'image'},
      {id: 'mask', label: 'Mask 遮罩（可选）', kind: 'mask'},
      {id: 'style', label: '画风参考（可选）', kind: 'style'},
    ],
    outputs: [{id: 'views', label: '四方向视图', kind: 'views'}],
  },
  balance_views: {
    type: 'balance_views',
    category: 'views',
    badge: '比例尺',
    defaultTitle: '全身合体比例三视图',
    inputs: [
      {id: 'source', label: '主设计图', kind: 'image'},
      {id: 'style', label: '画风参考（可选）', kind: 'style'},
    ],
    outputs: [{id: 'guide', label: '三视图参考尺', kind: 'guide'}],
  },
  tripo_mesh: {
    type: 'tripo_mesh',
    category: 'mesh',
    badge: '3D 建模',
    defaultTitle: 'Tripo 3D 建模',
    inputs: [{id: 'views', label: '四方向视图', kind: 'views'}],
    outputs: [{id: 'mesh', label: '部件 3D 网格', kind: 'mesh'}],
  },
  tripo_retexture: {
    type: 'tripo_retexture',
    category: 'mesh',
    badge: 'UV·上色',
    defaultTitle: 'UV 重展开与贴图上色',
    inputs: [
      {id: 'mesh', label: '输入 3D 网格', kind: 'mesh'},
      {id: 'views', label: '上色四视图（可选）', kind: 'views'},
    ],
    outputs: [{id: 'mesh', label: '已上色 3D 网格', kind: 'mesh'}],
  },
  assembly_export: {
    type: 'assembly_export',
    category: 'output',
    badge: '合体导出',
    defaultTitle: '3D 合体对位与最终导出',
    inputs: [
      {id: 'meshes', label: '部件网格（可多连）', kind: 'mesh', multi: true},
      {id: 'guide', label: '三视图参考尺', kind: 'guide'},
    ],
    outputs: [],
  },
});

const uid = prefix => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

export function defaultPlacementForPartName(name = '', index = 0, ratioNumeric = null, totalHeight = 1.65) {
  const n = String(name).toLowerCase();
  const r = Number.isFinite(ratioNumeric) && ratioNumeric >= 1.5 ? ratioNumeric : 6.6;
  const h = Number.isFinite(totalHeight) && totalHeight > 0.1 ? totalHeight : 1.65;
  const headH = h / r;
  const bodyH = Math.max(0.15, h - headH * 0.82);

  if (/裸脸|裸头|脸|面部|head|face/.test(n) && !/发|hair/.test(n)) return [0, 0, Number((h - headH * 0.5).toFixed(3))];
  if (/发|hair|头饰|帽|冠/.test(n)) return [0, 0, Number((h - headH * 0.52).toFixed(3))];
  if (/上衣|上身|上半身|胸甲|披风|upper/.test(n)) return [0, 0, Number((bodyH * 0.76).toFixed(3))];
  if (/下裙|下装|下半身|裤|腿|靴|skirt|lower/.test(n)) return [0, 0, Number((bodyH * 0.34).toFixed(3))];
  if (/翼|翅膀|背饰|法环|光环|wing/.test(n)) return [0, 0.16, Number((bodyH * 0.75).toFixed(3))];
  if (/剑|刀|枪|弓|杖|盾|武器|weapon/.test(n)) return [0.55, 0, Number((h * 0.52).toFixed(3))];
  if (/身|体|服装|汉服|素体|body|char/.test(n)) return [0, 0, Number((bodyH * 0.5).toFixed(3))];
  return [index * 0.02, 0, Number((h * 0.52).toFixed(3))];
}

export function defaultHeightForPartName(name = '', ratioNumeric = null, totalHeight = 1.65) {
  const n = String(name).toLowerCase();
  const r = Number.isFinite(ratioNumeric) && ratioNumeric >= 1.5 ? ratioNumeric : 6.6;
  const h = Number.isFinite(totalHeight) && totalHeight > 0.1 ? totalHeight : 1.65;
  const headH = h / r;
  const bodyH = Math.max(0.15, h - headH * 0.82);

  if (/裸脸|裸头|脸|面部|head|face/.test(n) && !/发|hair/.test(n)) return Number(headH.toFixed(3));
  if (/发|hair/.test(n)) return Number(Math.min(h * 0.82, headH * (r <= 3.5 ? 1.35 : 2.3)).toFixed(3));
  if (/帽|冠|头饰/.test(n)) return Number((headH * 1.1).toFixed(3));
  if (/上衣|上身|上半身|upper/.test(n)) return Number((bodyH * 0.54).toFixed(3));
  if (/下裙|下装|下半身|skirt|lower/.test(n)) return Number((bodyH * 0.68).toFixed(3));
  if (/翼|翅膀|wing/.test(n)) return Number((h * 0.80).toFixed(3));
  if (/剑|刀|枪|弓|杖|武器|weapon/.test(n)) return Number((h * 0.70).toFixed(3));
  if (/身|体|服装|汉服|素体|body/.test(n)) return Number(bodyH.toFixed(3));
  return 1.0;
}

export function resolveGraphHeadBodyRatio(graph) {
  if (!graph) return null;
  if (graph.proportionSpec && typeof graph.proportionSpec === 'object') {
    const ps = normalizeProportionSpec(graph.proportionSpec, graph.headBodyRatio, graph.customHeadBodyRatio);
    if (ps.enabled) return ps.headRatio;
  }
  const gRatio = resolveNumericHeadBodyRatio(graph.headBodyRatio, graph.customHeadBodyRatio);
  if (gRatio) return gRatio;
  const bal = (graph.nodes || []).find(n => n.type === 'balance_views');
  if (bal?.params?.headBodyRatio) {
    const bRatio = resolveNumericHeadBodyRatio(bal.params.headBodyRatio, bal.params.customHeadBodyRatio);
    if (bRatio) return bRatio;
  }
  for (const n of graph.nodes || []) {
    if (n.type === 'part_views' && n.params?.headBodyRatio && n.params.headBodyRatio !== 'keep') {
      const pRatio = resolveNumericHeadBodyRatio(n.params.headBodyRatio, n.params.customHeadBodyRatio);
      if (pRatio) return pRatio;
    }
  }
  return null;
}

export function createNode(type, x = 80, y = 80, overrides = {}) {
  const spec = NODE_SPECS[type];
  if (!spec) throw Error(`未知节点类型: ${type}`);
  const id = overrides.id || uid(type);
  const base = {id, type, x: Math.round(x), y: Math.round(y), params: {}, data: {}};

  if (type === 'source_image' || type === 'mask_ref' || type === 'style_ref' || type === 'ratio_ref') {
    base.params = {
      title: overrides.title || spec.defaultTitle,
      note: overrides.note || (
        type === 'style_ref'
          ? '参考此图的赛璐璐/二次元上色质感与线条细节'
          : type === 'mask_ref'
            ? '白色/涂色高亮区域代表要拆出的目标部件（支持多色 ID Mask 分区）'
            : ''
      ),
    };
    base.data = {image: null}; // { path, filename, mime, sha256, width, height }
  } else if (type === 'part_views') {
    base.params = {
      partName: overrides.partName || '新部件',
      promptHint: overrides.promptHint || '',
      pose: overrides.pose || 't', // 't' | 'a' | 'natural'
      resolution: overrides.resolution === 2048 ? 2048 : 1024,
      headBodyRatio: overrides.headBodyRatio || 'keep',
      customHeadBodyRatio: Number.isFinite(overrides.customHeadBodyRatio) ? overrides.customHeadBodyRatio : 6.8,
      maskMode: overrides.maskMode || 'auto', // 'auto' | 'white' | 'alpha' | 'color'
      maskColor: overrides.maskColor || '#ff2d55',
      maskNote: overrides.maskNote || '',
    };
    base.data = {
      maskImage: null,
      views: {front: null, left: null, right: null, back: null},
      completedStamp: '',
    };
  } else if (type === 'balance_views') {
    base.params = {
      partName: overrides.partName || '全身比例参考三视图',
      promptHint: overrides.promptHint || '用于最终 3D 合体时的全身比例对齐参考',
      pose: overrides.pose || 't',
      resolution: 1024,
      headBodyRatio: overrides.headBodyRatio || 'keep',
      customHeadBodyRatio: Number.isFinite(overrides.customHeadBodyRatio) ? overrides.customHeadBodyRatio : 6.8,
    };
    base.data = {
      views: {front: null, side: null, back: null},
      completedStamp: '',
    };
  } else if (type === 'tripo_mesh') {
    const quality = overrides.quality === 'smart' ? 'smart' : 'high';
    base.params = {
      title: overrides.title || spec.defaultTitle,
      quality, // 'high' | 'smart'
      aiModel: overrides.aiModel || (quality === 'smart' ? 'P2.0' : 'H3.5'),
      smartTopology: overrides.smartTopology === 'triangle' ? 'triangle' : 'quad',
      smartUv: overrides.smartUv !== undefined ? Boolean(overrides.smartUv) : true,
      autoRetexture: overrides.autoRetexture !== undefined ? Boolean(overrides.autoRetexture) : true,
      polyFaces: Number.isInteger(overrides.polyFaces) ? overrides.polyFaces : (quality === 'smart' ? 20000 : 2000000),
      textureSize: overrides.textureSize === 8192 ? 8192 : 4096,
      pbr: overrides.pbr !== false,
      removeLighting: Boolean(overrides.removeLighting),
      candidateCount: [1, 2, 3, 4].includes(overrides.candidateCount) ? overrides.candidateCount : 1,
    };
    base.data = {
      candidates: [],
      selectedId: '',
      completedStamp: '',
      runtimeStatus: '',
    };
  } else if (type === 'tripo_retexture') {
    base.params = {
      title: overrides.title || spec.defaultTitle,
      smartUv: overrides.smartUv !== undefined ? Boolean(overrides.smartUv) : true,
      retexture: overrides.retexture !== undefined ? Boolean(overrides.retexture) : true,
      textureSize: overrides.textureSize === 8192 ? 8192 : 4096,
      pbr: overrides.pbr !== false,
      removeLighting: overrides.removeLighting !== undefined ? Boolean(overrides.removeLighting) : true,
    };
    base.data = {
      candidates: [],
      selectedId: '',
      completedStamp: '',
      runtimeStatus: '',
    };
  } else if (type === 'assembly_export') {
    base.params = {
      title: overrides.title || spec.defaultTitle,
      materialMode: overrides.materialMode === 'mtoon' ? 'mtoon' : 'pbr',
      targetHeight: Number.isFinite(overrides.targetHeight) ? overrides.targetHeight : 1.7,
    };
    base.data = {
      exportRecord: null,
    };
  }
  return base;
}

export function createTemplateGraph(preset = 'standard_split') {
  const nodes = [];
  const edges = [];
  const connect = (fromNode, fromPort, toNode, toPort) => {
    edges.push({id: uid('edge'), fromNode, fromPort, toNode, toPort});
  };

  const src = createNode('source_image', 50, 90);
  const maskNode = preset === 'mask_custom_split' ? createNode('mask_ref', 50, 350) : null;
  const style = createNode('style_ref', 50, maskNode ? 620 : 360);
  nodes.push(src);
  if (maskNode) nodes.push(maskNode);
  nodes.push(style);

  const assembly = createNode('assembly_export', 1170, 260, {
    materialMode: preset === 'standard_split' ? 'mtoon' : 'pbr',
    targetHeight: preset === 'single_prop' ? 1.0 : 1.65,
  });

  const partDefs = preset === 'single_prop'
    ? [
        {partName: '主体物件', promptHint: '保持正交无透视四视图，上下像素高度严格对齐', pose: 'natural', quality: 'high', polyFaces: 2000000, tex: 4096},
      ]
    : preset === 'mask_custom_split'
      ? [
          {partName: 'Mask拆出部件 A', promptHint: '严格仅拆出 Mask 高亮/指定颜色覆盖的独立部件，补全被遮挡背面', pose: 'natural', quality: 'high', polyFaces: 2000000, tex: 4096, removeLighting: true, wireMask: true, maskMode: 'auto'},
          {partName: '剩余主体部件 B', promptHint: '剥离已由部件 A 拆出的外层部件，补全内层完整结构', pose: 't', quality: 'high', polyFaces: 3000000, tex: 8192, removeLighting: true},
        ]
      : preset === 'deluxe_composite'
        ? [
            {partName: '无发裸脸', promptHint: '剥离全部头发与刘海遮挡，保留完整光头头骨、五官与双耳', pose: 'natural', quality: 'high', polyFaces: 1000000, tex: 4096, removeLighting: true},
            {partName: '独立头发与发饰', promptHint: '仅保留前后完整发型与发饰，内部头模挖空不画脸部皮肤', pose: 'natural', quality: 'high', polyFaces: 3000000, tex: 8192, removeLighting: true},
            {partName: '上衣与肩甲', promptHint: 'T姿势展开双臂，剥离头发与下裙遮挡', pose: 't', quality: 'high', polyFaces: 2000000, tex: 8192},
            {partName: '下裙与鞋履', promptHint: '完整下装与鞋靴结构', pose: 't', quality: 'high', polyFaces: 2000000, tex: 4096},
            {partName: '背部翅膀', promptHint: '独立拆出对称完整的翅膀结构，去除人物身体遮挡', pose: 'natural', quality: 'high', polyFaces: 2000000, tex: 4096},
            {partName: '主武器', promptHint: '独立垂直或水平正交摆放，结构清晰对称', pose: 'natural', quality: 'smart', polyFaces: 15000, tex: 4096},
          ]
        : [
            {partName: '无发裸脸', promptHint: '剥离全部头发与刘海遮挡，保留完整光头头骨、精致二次元五官与双耳', pose: 'natural', quality: 'high', polyFaces: 1000000, tex: 4096, removeLighting: true},
            {partName: '独立头发与发饰', promptHint: '仅保留完整前后发与头饰，挖空脸部与颈部皮肤', pose: 'natural', quality: 'high', polyFaces: 3000000, tex: 4096, removeLighting: true},
            {partName: '服装身体', promptHint: '无头T姿势完整服装与躯干四肢（含颈部柱体以便衔接头部）', pose: 't', quality: 'high', polyFaces: 3000000, tex: 8192, removeLighting: true},
          ];

  const rowGap = 285;
  partDefs.forEach((def, i) => {
    const y = 60 + i * rowGap;
    const pv = createNode('part_views', 410, y, {
      partName: def.partName,
      promptHint: def.promptHint,
      pose: def.pose,
      resolution: def.polyFaces >= 3000000 ? 2048 : 1024,
      maskMode: def.maskMode || 'auto',
    });
    const tm = createNode('tripo_mesh', 790, y, {
      title: `Tripo · ${def.partName}`,
      quality: def.quality,
      polyFaces: def.polyFaces,
      textureSize: def.tex || 4096,
      removeLighting: Boolean(def.removeLighting),
    });
    nodes.push(pv, tm);
    connect(src.id, 'image', pv.id, 'source');
    if (maskNode && def.wireMask) {
      connect(maskNode.id, 'mask', pv.id, 'mask');
    }
    connect(style.id, 'style', pv.id, 'style');
    connect(pv.id, 'views', tm.id, 'views');
    connect(tm.id, 'mesh', assembly.id, 'meshes');
  });

  if (preset !== 'single_prop') {
    const balY = 60 + partDefs.length * rowGap;
    const bal = createNode('balance_views', 410, balY, {pose: 't'});
    nodes.push(bal);
    connect(src.id, 'image', bal.id, 'source');
    connect(style.id, 'style', bal.id, 'style');
    connect(bal.id, 'guide', assembly.id, 'guide');
    assembly.y = Math.round((60 + (partDefs.length - 1) * rowGap) / 2);
  }

  nodes.push(assembly);
  return {
    version: 1,
    preset,
    headBodyRatio: 'keep',
    customHeadBodyRatio: 6.8,
    proportionSpec: createProportionSpecFromArchetype('keep'),
    activeWorkspace: 'canvas', // 'canvas' | 'viewport'
    viewport: {panX: 24, panY: 20, zoom: 0.86},
    nodes,
    edges,
  };
}

export function ensureNodeGraph(p) {
  if (!p.nodeGraph || p.nodeGraph.version !== 1 || !Array.isArray(p.nodeGraph.nodes)) {
    const mode = p?.workflow?.subjectMode === 'prop' ? 'single_prop' : p?.workflow?.subjectMode === 'composite' ? 'deluxe_composite' : 'standard_split';
    p.nodeGraph = createTemplateGraph(mode);
  }
  ensureGraphProportionSpec(p.nodeGraph);
  return p.nodeGraph;
}

export function isMeshNodeType(type) {
  return type === 'tripo_mesh' || type === 'tripo_retexture';
}

export function resolveUpstreamViewsNode(graph, nodeId, visited = new Set()) {
  if (!nodeId || visited.has(nodeId)) return null;
  visited.add(nodeId);
  const node = getNode(graph, nodeId);
  if (!node) return null;
  if (node.type === 'part_views') return node;
  const vEdge = incomingEdges(graph, nodeId, 'views')[0];
  if (vEdge) {
    const vn = getNode(graph, vEdge.fromNode);
    if (vn?.type === 'part_views') return vn;
  }
  const mEdge = incomingEdges(graph, nodeId, 'mesh')[0];
  if (mEdge) {
    return resolveUpstreamViewsNode(graph, mEdge.fromNode, visited);
  }
  return null;
}

export function getNode(graph, id) {
  return graph?.nodes?.find(n => n.id === id) || null;
}

export function incomingEdges(graph, nodeId, portId = null) {
  return (graph?.edges || []).filter(e => e.toNode === nodeId && (portId === null || e.toPort === portId));
}

export function outgoingEdges(graph, nodeId, portId = null) {
  return (graph?.edges || []).filter(e => e.fromNode === nodeId && (portId === null || e.fromPort === portId));
}

function wouldCreateCycle(graph, fromNodeId, toNodeId) {
  if (fromNodeId === toNodeId) return true;
  const visited = new Set();
  const stack = [toNodeId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === fromNodeId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const e of outgoingEdges(graph, cur)) {
      stack.push(e.toNode);
    }
  }
  return false;
}

export function canConnectPorts(graph, fromNodeId, fromPortId, toNodeId, toPortId) {
  const fn = getNode(graph, fromNodeId);
  const tn = getNode(graph, toNodeId);
  if (!fn || !tn) return {ok: false, reason: '节点不存在'};
  const fSpec = NODE_SPECS[fn.type]?.outputs?.find(o => o.id === fromPortId);
  const tSpec = NODE_SPECS[tn.type]?.inputs?.find(i => i.id === toPortId);
  if (!fSpec || !tSpec) return {ok: false, reason: '端口不存在'};
  if (fSpec.kind !== tSpec.kind) return {ok: false, reason: `端口类型不匹配（需要 ${tSpec.label}）`};
  if (wouldCreateCycle(graph, fromNodeId, toNodeId)) return {ok: false, reason: '不能形成循环连线'};
  return {ok: true, multi: Boolean(tSpec.multi)};
}

export function connectPorts(graph, fromNodeId, fromPortId, toNodeId, toPortId) {
  const check = canConnectPorts(graph, fromNodeId, fromPortId, toNodeId, toPortId);
  if (!check.ok) throw Error(check.reason);
  if (graph.edges.some(e => e.fromNode === fromNodeId && e.fromPort === fromPortId && e.toNode === toNodeId && e.toPort === toPortId)) {
    return graph;
  }
  if (!check.multi) {
    graph.edges = graph.edges.filter(e => !(e.toNode === toNodeId && e.toPort === toPortId));
  }
  graph.edges.push({id: uid('edge'), fromNode: fromNodeId, fromPort: fromPortId, toNode: toNodeId, toPort: toPortId});
  return graph;
}

export function disconnectEdge(graph, edgeId) {
  graph.edges = (graph.edges || []).filter(e => e.id !== edgeId);
}

export function removeNode(graph, p, nodeId) {
  const n = getNode(graph, nodeId);
  if (!n) return;
  if (n.type === 'assembly_export' && graph.nodes.filter(x => x.type === 'assembly_export').length <= 1) {
    throw Error('至少保留一个「3D 合体对位与导出」终点节点');
  }
  graph.nodes = graph.nodes.filter(x => x.id !== nodeId);
  graph.edges = graph.edges.filter(e => e.fromNode !== nodeId && e.toNode !== nodeId);
  if (p?.placements) delete p.placements[nodeId];
}

export function addPartPipelineBranch(graph, {partName = '新拆分部件', promptHint = '', pose = 'natural', resolution = 1024, quality = 'high', aiModel = '', smartTopology = 'quad', polyFaces = 2000000, textureSize = 4096, pbr = true, removeLighting = false, candidateCount = 1, x = null, y = null} = {}) {
  const partNodes = graph.nodes.filter(n => n.type === 'part_views' || n.type === 'balance_views');
  const maxY = partNodes.reduce((m, n) => Math.max(m, n.y), -180);
  const baseX = Number.isFinite(x) ? Math.round(x) : 410;
  const nextY = Number.isFinite(y) ? Math.round(y) : Math.max(60, maxY + 270);

  const pv = createNode('part_views', baseX, nextY, {partName, promptHint, pose, resolution});
  const tm = createNode('tripo_mesh', baseX + 380, nextY, {
    title: `Tripo · ${partName}`,
    quality,
    aiModel: aiModel || (quality === 'smart' ? 'P2.0' : 'H3.5'),
    smartTopology,
    polyFaces,
    textureSize,
    pbr,
    removeLighting,
    candidateCount,
  });
  graph.nodes.push(pv, tm);

  const src = graph.nodes.find(n => n.type === 'source_image');
  const style = graph.nodes.find(n => n.type === 'style_ref');
  const ratio = graph.nodes.find(n => n.type === 'ratio_ref');
  const asm = graph.nodes.find(n => n.type === 'assembly_export');

  if (src) connectPorts(graph, src.id, 'image', pv.id, 'source');
  if (style) connectPorts(graph, style.id, 'style', pv.id, 'style');
  if (ratio && pose !== 'natural') connectPorts(graph, ratio.id, 'ratio', pv.id, 'ratio');
  connectPorts(graph, pv.id, 'views', tm.id, 'views');
  if (asm) connectPorts(graph, tm.id, 'mesh', asm.id, 'meshes');
  return {partViewsNode: pv, tripoMeshNode: tm};
}

export const BUILTIN_BRANCH_PRESETS = Object.freeze([
  {
    id: 'builtin_face_hd',
    builtin: true,
    name: '无发裸脸（HD 100万面 · 去高光）',
    description: '剥离刘海与头发遮挡的完整裸头五官四视图 + H3.5 高精度建模',
    nodes: [
      {relId: 'n0', type: 'part_views', dx: 0, dy: 0, params: {partName: '无发裸脸', promptHint: '剥离全部头发与刘海遮挡，保留完整光头头骨、精致二次元五官与双耳', pose: 'natural', resolution: 1024}},
      {relId: 'n1', type: 'tripo_mesh', dx: 380, dy: 0, params: {title: 'Tripo · 无发裸脸', quality: 'high', aiModel: 'H3.5', smartTopology: 'quad', polyFaces: 1000000, textureSize: 4096, pbr: true, removeLighting: true, candidateCount: 1}},
    ],
    edges: [{from: 'n0', fromPort: 'views', to: 'n1', toPort: 'views'}],
    autoWire: {connectSource: true, connectStyle: true, connectRatio: false, connectAssembly: true},
  },
  {
    id: 'builtin_hair_hd8k',
    builtin: true,
    name: '高精独立头发（HD 300万面 · 8K去高光）',
    description: '2K 四视图挖空脸部皮肤，保留复杂发丝与发饰 + 300万面 8K 贴图',
    nodes: [
      {relId: 'n0', type: 'part_views', dx: 0, dy: 0, params: {partName: '独立头发与发饰', promptHint: '仅保留完整前后发与发饰，内部头模挖空不画脸部与颈部皮肤', pose: 'natural', resolution: 2048}},
      {relId: 'n1', type: 'tripo_mesh', dx: 380, dy: 0, params: {title: 'Tripo · 独立头发与发饰', quality: 'high', aiModel: 'H3.5', smartTopology: 'quad', polyFaces: 3000000, textureSize: 8192, pbr: true, removeLighting: true, candidateCount: 1}},
    ],
    edges: [{from: 'n0', fromPort: 'views', to: 'n1', toPort: 'views'}],
    autoWire: {connectSource: true, connectStyle: true, connectRatio: false, connectAssembly: true},
  },
  {
    id: 'builtin_outfit_body',
    builtin: true,
    name: 'T-Pose 服装身体（HD 300万面 · 8K）',
    description: '无头 T-Pose 服装躯干四肢（关联头身比参考）+ 300万面 8K 建模',
    nodes: [
      {relId: 'n0', type: 'part_views', dx: 0, dy: 0, params: {partName: '服装身体', promptHint: '无头T姿势完整服装与躯干四肢，保留颈部衔接柱体', pose: 't', resolution: 2048}},
      {relId: 'n1', type: 'tripo_mesh', dx: 380, dy: 0, params: {title: 'Tripo · 服装身体', quality: 'high', aiModel: 'H3.5', smartTopology: 'quad', polyFaces: 3000000, textureSize: 8192, pbr: true, removeLighting: true, candidateCount: 1}},
    ],
    edges: [{from: 'n0', fromPort: 'views', to: 'n1', toPort: 'views'}],
    autoWire: {connectSource: true, connectStyle: true, connectRatio: true, connectAssembly: true},
  },
  {
    id: 'builtin_smart_weapon',
    builtin: true,
    name: '硬表面武器/道具（Smart 四边面 1.5万面 + 重展UV上色）',
    description: '独立对称正交道具视图 + P2.0 智能四边面低模拓扑 + 自动重展开 Smart UV 与 4K 上色',
    nodes: [
      {relId: 'n0', type: 'part_views', dx: 0, dy: 0, params: {partName: '主武器', promptHint: '独立垂直正交摆放，去除人物手部遮挡，上下像素高度严格对齐', pose: 'natural', resolution: 1024}},
      {relId: 'n1', type: 'tripo_mesh', dx: 380, dy: 0, params: {title: 'Tripo · 主武器', quality: 'smart', aiModel: 'P2.0', smartTopology: 'quad', smartUv: true, autoRetexture: true, polyFaces: 15000, textureSize: 4096, pbr: true, removeLighting: false, candidateCount: 1}},
    ],
    edges: [{from: 'n0', fromPort: 'views', to: 'n1', toPort: 'views'}],
    autoWire: {connectSource: true, connectStyle: true, connectRatio: false, connectAssembly: true},
  },
  {
    id: 'builtin_smart_uv_retex_pipeline',
    builtin: true,
    name: '智能低模 → 独立重展开 UV 与上色（显式三阶分支）',
    description: '先生成 P2.0 纯四边面白模，再经独立「UV 重展开与上色」节点烘焙 4K 贴图（支持多皮肤换色）',
    nodes: [
      {relId: 'n0', type: 'part_views', dx: 0, dy: 0, params: {partName: '低模服装部件', promptHint: '正交无透视四视图，上下高度像素严格对齐', pose: 't', resolution: 1024}},
      {relId: 'n1', type: 'tripo_mesh', dx: 360, dy: 0, params: {title: 'Smart 四边面白模', quality: 'smart', aiModel: 'P2.0', smartTopology: 'quad', smartUv: false, autoRetexture: false, polyFaces: 20000, textureSize: 4096, pbr: true, removeLighting: true, candidateCount: 1}},
      {relId: 'n2', type: 'tripo_retexture', dx: 720, dy: 0, params: {title: 'UV 重展开与上色', smartUv: true, retexture: true, textureSize: 4096, pbr: true, removeLighting: true}},
    ],
    edges: [
      {from: 'n0', fromPort: 'views', to: 'n1', toPort: 'views'},
      {from: 'n1', fromPort: 'mesh', to: 'n2', toPort: 'mesh'},
      {from: 'n0', fromPort: 'views', to: 'n2', toPort: 'views'},
    ],
    autoWire: {connectSource: true, connectStyle: true, connectRatio: true, connectAssembly: true},
  },
]);

/**
 * Serializes the entire current graph structure & parameters (stripping project-specific image/mesh blobs)
 * into a reusable custom template definition.
 */
export function serializeGraphAsTemplate(graph, {id = '', name = '自定义模板', description = ''} = {}) {
  const idMap = new Map();
  const cleanNodes = (graph?.nodes || []).map((n, idx) => {
    const relId = `t_${idx}_${n.type}`;
    idMap.set(n.id, relId);
    return {
      relId,
      type: n.type,
      x: Math.round(n.x),
      y: Math.round(n.y),
      params: structuredClone(n.params || {}),
    };
  });
  const cleanEdges = (graph?.edges || [])
    .filter(e => idMap.has(e.fromNode) && idMap.has(e.toNode))
    .map(e => ({
      from: idMap.get(e.fromNode),
      fromPort: e.fromPort,
      to: idMap.get(e.toNode),
      toPort: e.toPort,
    }));
  return {
    id: id || `tpl_${crypto.randomUUID().slice(0, 8)}`,
    name: String(name || '自定义模板').trim().slice(0, 60),
    description: String(description || '').trim().slice(0, 160),
    createdAt: new Date().toISOString(),
    proportionSpec: graph?.proportionSpec ? normalizeProportionSpec(graph.proportionSpec) : undefined,
    viewport: structuredClone(graph?.viewport || {panX: 24, panY: 20, zoom: 0.86}),
    nodes: cleanNodes,
    edges: cleanEdges,
  };
}

/**
 * Instantiates a fresh nodeGraph from a custom saved template definition.
 */
export function instantiateGraphFromTemplate(tplDef) {
  if (!tplDef || !Array.isArray(tplDef.nodes) || !tplDef.nodes.length) {
    return createTemplateGraph('standard_split');
  }
  const nodes = [];
  const edges = [];
  const realIdMap = new Map();

  for (const item of tplDef.nodes) {
    if (!NODE_SPECS[item.type]) continue;
    const created = createNode(item.type, item.x ?? 80, item.y ?? 80, item.params || {});
    created.params = {...created.params, ...structuredClone(item.params || {})};
    realIdMap.set(item.relId, created.id);
    nodes.push(created);
  }
  const propSpec = normalizeProportionSpec(tplDef.proportionSpec);
  const graph = {
    version: 1,
    preset: tplDef.id || 'custom',
    headBodyRatio: propSpec.enabled ? propSpec.archetype : 'keep',
    customHeadBodyRatio: propSpec.headRatio,
    proportionSpec: propSpec,
    activeWorkspace: 'canvas',
    viewport: structuredClone(tplDef.viewport || {panX: 24, panY: 20, zoom: 0.86}),
    nodes,
    edges,
  };
  for (const e of tplDef.edges || []) {
    const fn = realIdMap.get(e.from);
    const tn = realIdMap.get(e.to);
    if (fn && tn) {
      try { connectPorts(graph, fn, e.fromPort, tn, e.toPort); } catch { /* ignore invalid edge */ }
    }
  }
  if (!graph.nodes.some(n => n.type === 'assembly_export')) {
    graph.nodes.push(createNode('assembly_export', 1170, 260));
  }
  return graph;
}

/**
 * Extracts selected nodes (optionally auto-pairing connected part_views <-> tripo_mesh) into a reusable Branch Preset.
 */
export function extractBranchPreset(graph, selectedIds = [], {id = '', name = '', description = '', autoPair = true} = {}) {
  const chosenSet = new Set(selectedIds.filter(nid => getNode(graph, nid)));
  if (!chosenSet.size) throw Error('请先在画布中点击或框选至少一个要保存的分支节点');

  // If user selected just a single part_views or tripo_mesh and autoPair is enabled, include its paired neighbor!
  if (autoPair && chosenSet.size === 1) {
    const onlyId = [...chosenSet][0];
    const onlyNode = getNode(graph, onlyId);
    if (onlyNode?.type === 'part_views') {
      for (const e of outgoingEdges(graph, onlyId, 'views')) {
        const dn = getNode(graph, e.toNode);
        if (dn?.type === 'tripo_mesh') chosenSet.add(dn.id);
      }
    } else if (onlyNode?.type === 'tripo_mesh') {
      for (const e of incomingEdges(graph, onlyId, 'views')) {
        const un = getNode(graph, e.fromNode);
        if (un?.type === 'part_views') chosenSet.add(un.id);
      }
    }
  }

  // Never include global singleton assembly_export unless user explicitly selected multiple custom nodes? Keep non-assembly/non-source nodes clean
  if (chosenSet.size > 1) {
    for (const nid of [...chosenSet]) {
      const n = getNode(graph, nid);
      if (n?.type === 'assembly_export' || n?.type === 'source_image') chosenSet.delete(nid);
    }
  }

  const pickedNodes = graph.nodes.filter(n => chosenSet.has(n.id));
  if (!pickedNodes.length) throw Error('所选节点不包含可保存为分支的拆件或建模节点');

  const minX = Math.min(...pickedNodes.map(n => n.x));
  const minY = Math.min(...pickedNodes.map(n => n.y));
  const idMap = new Map();

  let connectSource = false;
  let connectStyle = false;
  let connectRatio = false;
  let connectAssembly = false;

  const branchNodes = pickedNodes.map((n, idx) => {
    const relId = `b_${idx}`;
    idMap.set(n.id, relId);
    for (const ie of incomingEdges(graph, n.id)) {
      if (!chosenSet.has(ie.fromNode)) {
        const up = getNode(graph, ie.fromNode);
        if (up?.type === 'source_image') connectSource = true;
        if (up?.type === 'style_ref') connectStyle = true;
        if (up?.type === 'ratio_ref') connectRatio = true;
      }
    }
    for (const oe of outgoingEdges(graph, n.id)) {
      if (!chosenSet.has(oe.toNode)) {
        const dn = getNode(graph, oe.toNode);
        if (dn?.type === 'assembly_export') connectAssembly = true;
      }
    }
    return {
      relId,
      type: n.type,
      dx: Math.round(n.x - minX),
      dy: Math.round(n.y - minY),
      params: structuredClone(n.params || {}),
    };
  });

  const branchEdges = graph.edges
    .filter(e => idMap.has(e.fromNode) && idMap.has(e.toNode))
    .map(e => ({
      from: idMap.get(e.fromNode),
      fromPort: e.fromPort,
      to: idMap.get(e.toNode),
      toPort: e.toPort,
    }));

  const firstPart = pickedNodes.find(n => n.type === 'part_views');
  const fallbackName = firstPart?.params?.partName
    ? `${firstPart.params.partName} 分支`
    : `${NODE_SPECS[pickedNodes[0].type]?.defaultTitle || '自定义'} 分支`;

  return {
    id: id || `br_${crypto.randomUUID().slice(0, 8)}`,
    name: String(name || fallbackName).trim().slice(0, 60),
    description: String(description || '').trim().slice(0, 160),
    createdAt: new Date().toISOString(),
    nodes: branchNodes,
    edges: branchEdges,
    autoWire: {
      connectSource: connectSource || branchNodes.some(n => n.type === 'part_views' || n.type === 'balance_views'),
      connectStyle,
      connectRatio,
      connectAssembly: connectAssembly || branchNodes.some(n => isMeshNodeType(n.type) || n.type === 'balance_views'),
    },
  };
}

/**
 * Inserts a saved Branch Preset into `graph` at (anchorX, anchorY) or auto-stacked below existing branches,
 * automatically wiring upstream references & downstream assembly_export!
 */
export function insertBranchPreset(graph, branchDef, {x = null, y = null, autoWire = true} = {}) {
  if (!branchDef || !Array.isArray(branchDef.nodes) || !branchDef.nodes.length) {
    throw Error('无效的分支预设数据');
  }
  const existingMid = graph.nodes.filter(n => n.type === 'part_views' || n.type === 'balance_views' || isMeshNodeType(n.type));
  const maxY = existingMid.reduce((m, n) => Math.max(m, n.y), -180);
  const baseX = Number.isFinite(x) ? Math.round(x) : 410;
  const baseY = Number.isFinite(y) ? Math.round(y) : Math.max(60, maxY + 270);

  const realIdMap = new Map();
  const createdNodes = [];

  for (const item of branchDef.nodes) {
    if (!NODE_SPECS[item.type]) continue;
    const node = createNode(item.type, baseX + (item.dx || 0), baseY + (item.dy || 0), item.params || {});
    node.params = {...node.params, ...structuredClone(item.params || {})};
    realIdMap.set(item.relId, node.id);
    graph.nodes.push(node);
    createdNodes.push(node);
  }

  for (const e of branchDef.edges || []) {
    const fn = realIdMap.get(e.from);
    const tn = realIdMap.get(e.to);
    if (fn && tn) {
      try { connectPorts(graph, fn, e.fromPort, tn, e.toPort); } catch { /* ignore */ }
    }
  }

  if (autoWire && branchDef.autoWire) {
    const src = graph.nodes.find(n => n.type === 'source_image');
    const style = graph.nodes.find(n => n.type === 'style_ref');
    const ratio = graph.nodes.find(n => n.type === 'ratio_ref');
    const asm = graph.nodes.find(n => n.type === 'assembly_export');

    for (const node of createdNodes) {
      if (node.type === 'part_views' || node.type === 'balance_views') {
        if (branchDef.autoWire.connectSource && src && !incomingEdges(graph, node.id, 'source').length) {
          try { connectPorts(graph, src.id, 'image', node.id, 'source'); } catch {}
        }
        if (branchDef.autoWire.connectStyle && style && !incomingEdges(graph, node.id, 'style').length) {
          try { connectPorts(graph, style.id, 'style', node.id, 'style'); } catch {}
        }
        if (branchDef.autoWire.connectRatio && ratio && !incomingEdges(graph, node.id, 'ratio').length) {
          try { connectPorts(graph, ratio.id, 'ratio', node.id, 'ratio'); } catch {}
        }
      }
      if (branchDef.autoWire.connectAssembly && asm) {
        if (isMeshNodeType(node.type) && !outgoingEdges(graph, node.id, 'mesh').length) {
          try { connectPorts(graph, node.id, 'mesh', asm.id, 'meshes'); } catch {}
        } else if (node.type === 'balance_views' && !incomingEdges(graph, asm.id, 'guide').length) {
          try { connectPorts(graph, node.id, 'guide', asm.id, 'guide'); } catch {}
        }
      }
    }
  }

  return createdNodes;
}

/**
 * Clones selected nodes in-place (Blender Shift+D style), keeping internal edges & upstream input links,
 * while resetting generated output caches so cloned branches start clean.
 */
export function cloneNodesInGraph(graph, nodeIds = [], offsetX = 40, offsetY = 60) {
  const validIds = nodeIds.filter(id => {
    const n = getNode(graph, id);
    return n && n.type !== 'assembly_export';
  });
  if (!validIds.length) return [];
  const chosen = new Set(validIds);
  const idMap = new Map();
  const cloned = [];

  for (const oldId of validIds) {
    const orig = getNode(graph, oldId);
    const copy = createNode(orig.type, orig.x + offsetX, orig.y + offsetY, orig.params || {});
    copy.params = {...copy.params, ...structuredClone(orig.params || {})};
    if (copy.type === 'part_views' && copy.params.partName) {
      copy.params.partName = `${copy.params.partName}_副本`;
    }
    if (orig.type === 'source_image' || orig.type === 'style_ref' || orig.type === 'ratio_ref') {
      copy.data = structuredClone(orig.data || {image: null});
    }
    idMap.set(oldId, copy.id);
    graph.nodes.push(copy);
    cloned.push(copy);
  }

  // Copy internal edges between cloned nodes AND upstream incoming edges from non-cloned inputs
  const currentEdges = [...graph.edges];
  for (const e of currentEdges) {
    if (chosen.has(e.fromNode) && chosen.has(e.toNode)) {
      try { connectPorts(graph, idMap.get(e.fromNode), e.fromPort, idMap.get(e.toNode), e.toPort); } catch {}
    } else if (!chosen.has(e.fromNode) && chosen.has(e.toNode)) {
      try { connectPorts(graph, e.fromNode, e.fromPort, idMap.get(e.toNode), e.toPort); } catch {}
    } else if (chosen.has(e.fromNode) && !chosen.has(e.toNode)) {
      const target = getNode(graph, e.toNode);
      if (target?.type === 'assembly_export' && e.toPort === 'meshes') {
        try { connectPorts(graph, idMap.get(e.fromNode), e.fromPort, e.toNode, 'meshes'); } catch {}
      }
    }
  }
  return cloned;
}

/**
 * Computes deterministic dependency stamp for incremental execution caching.
 */
export function nodeInputStamp(graph, nodeId, visited = new Set()) {
  if (visited.has(nodeId)) return 'cycle';
  visited.add(nodeId);
  const node = getNode(graph, nodeId);
  if (!node) return '';

  if (node.type === 'source_image' || node.type === 'mask_ref' || node.type === 'style_ref' || node.type === 'ratio_ref') {
    return JSON.stringify([node.type, node.data?.image?.sha256 || null, node.params?.note || '']);
  }
  if (node.type === 'part_views' || node.type === 'balance_views') {
    const srcEdge = incomingEdges(graph, nodeId, 'source')[0];
    const maskEdge = incomingEdges(graph, nodeId, 'mask')[0];
    const styleEdge = incomingEdges(graph, nodeId, 'style')[0];
    const effPropStamp = node.params?.headBodyRatio && node.params.headBodyRatio !== 'keep'
      ? [node.params.headBodyRatio, node.params.customHeadBodyRatio || 6.8]
      : proportionSpecStamp(ensureGraphProportionSpec(graph));
    return JSON.stringify([
      node.type,
      node.params?.partName || '',
      node.params?.promptHint || '',
      node.params?.pose || 't',
      node.params?.resolution || 1024,
      effPropStamp,
      node.params?.maskMode || 'auto',
      node.params?.maskColor || '',
      node.data?.maskImage?.sha256 || null,
      node.params?.modCraftRules || null,
      graph.modMeta?.promptRules || null,
      srcEdge ? nodeInputStamp(graph, srcEdge.fromNode, new Set(visited)) : null,
      maskEdge ? nodeInputStamp(graph, maskEdge.fromNode, new Set(visited)) : null,
      styleEdge ? nodeInputStamp(graph, styleEdge.fromNode, new Set(visited)) : null,
    ]);
  }
  if (node.type === 'tripo_mesh') {
    const viewsEdge = incomingEdges(graph, nodeId, 'views')[0];
    const upstreamViewsNode = viewsEdge ? getNode(graph, viewsEdge.fromNode) : null;
    const viewHashes = upstreamViewsNode?.data?.views
      ? GRAPH_VIEWS_4.map(v => upstreamViewsNode.data.views[v]?.sha256 || null)
      : [null, null, null, null];
    const isSmart = node.params?.quality === 'smart';
    return JSON.stringify([
      'tripo_mesh',
      viewHashes,
      node.params?.quality || 'high',
      node.params?.aiModel || 'H3.5',
      node.params?.smartTopology || 'quad',
      isSmart ? (node.params?.smartUv !== false) : false,
      isSmart ? (node.params?.autoRetexture !== false) : true,
      node.params?.polyFaces || 0,
      node.params?.textureSize || 4096,
      Boolean(node.params?.pbr),
      Boolean(node.params?.removeLighting),
      node.params?.candidateCount || 1,
    ]);
  }
  if (node.type === 'tripo_retexture') {
    const mEdge = incomingEdges(graph, nodeId, 'mesh')[0];
    const upMesh = mEdge ? getNode(graph, mEdge.fromNode) : null;
    const selMesh = upMesh?.data?.candidates?.find(c => c.id === upMesh?.data?.selectedId) || upMesh?.data?.candidates?.[0] || null;
    const pvNode = resolveUpstreamViewsNode(graph, nodeId);
    const viewHashes = pvNode?.data?.views
      ? GRAPH_VIEWS_4.map(v => pvNode.data.views[v]?.sha256 || null)
      : [null, null, null, null];
    return JSON.stringify([
      'tripo_retexture',
      selMesh?.sha256 || null,
      node.params?.retexture !== false ? viewHashes : null,
      node.params?.smartUv !== false,
      node.params?.retexture !== false,
      node.params?.textureSize || 4096,
      node.params?.pbr !== false,
      Boolean(node.params?.removeLighting),
    ]);
  }

  if (node.type === 'assembly_export') {
    const meshEdges = incomingEdges(graph, nodeId, 'meshes');
    const selectedMeshes = meshEdges.map(e => {
      const mn = getNode(graph, e.fromNode);
      const sel = mn?.data?.candidates?.find(c => c.id === mn?.data?.selectedId) || mn?.data?.candidates?.[0] || null;
      return [e.fromNode, sel?.id || null, sel?.sha256 || null];
    });
    return JSON.stringify(['assembly_export', node.params?.materialMode || 'pbr', selectedMeshes]);
  }
  return '';
}

export function nodeStatus(graph, nodeId) {
  const node = getNode(graph, nodeId);
  if (!node) return {state: 'empty', label: '未知'};

  if (node.type === 'source_image' || node.type === 'mask_ref' || node.type === 'style_ref' || node.type === 'ratio_ref') {
    return node.data?.image?.sha256
      ? {state: 'ready', label: node.type === 'mask_ref' ? '已载入 Mask' : '已载入图片'}
      : {state: 'empty', label: node.type === 'source_image' ? '请上传主立绘' : node.type === 'mask_ref' ? '请上传遮罩图' : '可选（未上传）'};
  }

  if (node.type === 'part_views' || node.type === 'balance_views') {
    const keys = node.type === 'balance_views' ? GRAPH_VIEWS_3 : GRAPH_VIEWS_4;
    const hasAll = keys.every(k => node.data?.views?.[k]?.sha256);
    const srcEdge = incomingEdges(graph, nodeId, 'source')[0];
    const srcNode = srcEdge ? getNode(graph, srcEdge.fromNode) : null;
    if (!srcNode?.data?.image?.sha256) {
      return hasAll ? {state: 'ready', label: '视图已就绪'} : {state: 'waiting', label: '等待主立绘输入'};
    }
    if (!hasAll) return {state: 'dirty', label: '待 AI 拆图'};
    const curStamp = nodeInputStamp(graph, nodeId);
    if (node.data?.completedStamp && node.data.completedStamp !== curStamp) {
      return {state: 'dirty', label: '上游已改 · 待重拆'};
    }
    return {state: 'ready', label: '视图已就绪'};
  }

  if (node.type === 'tripo_mesh') {
    if (node.data?.runtimeStatus) {
      return {state: 'running', label: node.data.runtimeStatus};
    }
    const viewsEdge = incomingEdges(graph, nodeId, 'views')[0];
    const pv = viewsEdge ? getNode(graph, viewsEdge.fromNode) : null;
    const viewsReady = pv && pv.type === 'part_views' && GRAPH_VIEWS_4.every(k => pv.data?.views?.[k]?.sha256);
    const hasMesh = Array.isArray(node.data?.candidates) && node.data.candidates.length > 0;
    if (!viewsReady && !hasMesh) return {state: 'waiting', label: '等待上游四视图'};
    if (!hasMesh) return {state: 'dirty', label: '四视图就绪 · 待建模'};
    const curStamp = nodeInputStamp(graph, nodeId);
    if (node.data?.completedStamp && node.data.completedStamp !== curStamp) {
      return {state: 'dirty', label: '参数/视图已改 · 待重跑'};
    }
    return {state: 'ready', label: `已生成 (${node.data.candidates.length} 候选)`};
  }

  if (node.type === 'tripo_retexture') {
    if (node.data?.runtimeStatus) {
      return {state: 'running', label: node.data.runtimeStatus};
    }
    const mEdge = incomingEdges(graph, nodeId, 'mesh')[0];
    const upMesh = mEdge ? getNode(graph, mEdge.fromNode) : null;
    const upHasMesh = Array.isArray(upMesh?.data?.candidates) && upMesh.data.candidates.length > 0;
    const pv = resolveUpstreamViewsNode(graph, nodeId);
    const viewsReady = pv && GRAPH_VIEWS_4.every(k => pv.data?.views?.[k]?.sha256);
    const needViews = node.params?.retexture !== false;
    const hasOut = Array.isArray(node.data?.candidates) && node.data.candidates.length > 0;
    if (!upHasMesh && !hasOut) return {state: 'waiting', label: '等待上游 3D 白模/原模'};
    if (needViews && !viewsReady && !hasOut) return {state: 'waiting', label: '等待上色四视图'};
    if (!hasOut) return {state: 'dirty', label: '待重展 UV / 上色'};
    const curStamp = nodeInputStamp(graph, nodeId);
    if (node.data?.completedStamp && node.data.completedStamp !== curStamp) {
      return {state: 'dirty', label: '上游/参数已改 · 待重跑'};
    }
    return {state: 'ready', label: 'UV与贴图已完成'};
  }

  if (node.type === 'assembly_export') {
    const readyMeshes = connectedAssemblyMeshes(graph, nodeId);
    if (!readyMeshes.length) return {state: 'waiting', label: '等待部件 3D 网格接入'};
    if (node.data?.exportRecord?.sourceStamp === nodeInputStamp(graph, nodeId)) {
      return {state: 'ready', label: '已导出最终资产'};
    }
    return {state: 'dirty', label: `已接入 ${readyMeshes.length} 个部件 · 可对位导出`};
  }

  return {state: 'empty', label: ''};
}

/**
 * Lists all Tripo mesh nodes wired into the Assembly node that currently have a valid 3D candidate.
 */
export function connectedAssemblyMeshes(graph, assemblyNodeId = null) {
  const asm = assemblyNodeId ? getNode(graph, assemblyNodeId) : graph?.nodes?.find(n => n.type === 'assembly_export');
  if (!asm) return [];
  const edges = incomingEdges(graph, asm.id, 'meshes');
  const out = [];
  for (const [idx, e] of edges.entries()) {
    const mn = getNode(graph, e.fromNode);
    if (!mn || !isMeshNodeType(mn.type)) continue;
    const cands = mn.data?.candidates || [];
    if (!cands.length) continue;
    const chosen = cands.find(c => c.id === mn.data.selectedId) || cands[0];
    const pvNode = resolveUpstreamViewsNode(graph, mn.id);
    const partLabel = pvNode?.params?.partName || mn.params?.title || `部件 ${idx + 1}`;
    out.push({
      meshNodeId: mn.id,
      partLabel,
      candidate: chosen,
      index: idx,
    });
  }
  return out;
}

export function connectedAssemblyGuide(graph, assemblyNodeId = null) {
  const asm = assemblyNodeId ? getNode(graph, assemblyNodeId) : graph?.nodes?.find(n => n.type === 'assembly_export');
  if (!asm) return null;
  const edge = incomingEdges(graph, asm.id, 'guide')[0];
  const bn = edge ? getNode(graph, edge.fromNode) : null;
  if (!bn || bn.type !== 'balance_views') return null;
  if (!GRAPH_VIEWS_3.every(k => bn.data?.views?.[k]?.sha256)) return null;
  return bn.data.views;
}

export async function registerGraphDocument(p, files, filename, bytes, folderTag = 'node') {
  p.documents ??= [];
  const cleanName = String(filename || 'file.bin').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100) || 'file.bin';
  const docPath = `documents/node-graph/${folderTag}-${crypto.randomUUID()}/${cleanName}`;
  safePath(docPath);
  const digestHex = await sha256(bytes);
  const doc = {path: docPath, sha256: digestHex};
  p.documents.push(doc);
  files.set(docPath, bytes);
  return {path: docPath, sha256: digestHex, filename: cleanName};
}

export function collectReferencedGraphPaths(graph) {
  const used = new Set();
  for (const n of graph?.nodes || []) {
    if (n.data?.image?.path) used.add(n.data.image.path);
    if (n.data?.maskImage?.path) used.add(n.data.maskImage.path);
    if (n.data?.views) {
      for (const v of Object.values(n.data.views)) {
        if (v?.path) used.add(v.path);
      }
    }
    if (Array.isArray(n.data?.candidates)) {
      for (const c of n.data.candidates) {
        if (c?.path) used.add(c.path);
        for (const r of c?.resources || []) {
          if (r?.path) used.add(r.path);
        }
      }
    }
  }
  return used;
}

export function pruneUnusedGraphDocuments(p, files) {
  if (!p?.documents || !p?.nodeGraph) return;
  const keep = collectReferencedGraphPaths(p.nodeGraph);
  const nextDocs = [];
  for (const d of p.documents) {
    if (!d.path.startsWith('documents/node-graph/') || keep.has(d.path)) {
      nextDocs.push(d);
    } else {
      files?.delete?.(d.path);
    }
  }
  p.documents = nextDocs;
}

export function validateNodeGraph(p) {
  const g = p?.nodeGraph;
  if (g === undefined) return;
  if (!g || g.version !== 1 || !Array.isArray(g.nodes) || g.nodes.length > 96 || !Array.isArray(g.edges) || g.edges.length > 256) {
    throw Error('Invalid nodeGraph structure.');
  }
  const docPaths = new Set((p.documents || []).map(d => d.path));
  const validPath = fp => docPaths.has(fp);
  const nodeIds = new Set();
  for (const n of g.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id || nodeIds.has(n.id) || !NODE_SPECS[n.type]) {
      throw Error('Invalid node entry in nodeGraph.');
    }
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) throw Error('Invalid node coordinates.');
    nodeIds.add(n.id);
    if (n.data?.image && !validPath(n.data.image.path)) throw Error('Referenced node image file is missing.');
    if (n.data?.maskImage && !validPath(n.data.maskImage.path)) throw Error('Referenced node mask image file is missing.');
    if (n.data?.views) {
      for (const v of Object.values(n.data.views)) {
        if (v && !validPath(v.path)) throw Error('Referenced node view PNG is missing.');
      }
    }
    if (Array.isArray(n.data?.candidates)) {
      for (const c of n.data.candidates) {
        if (!c?.path || !validPath(c.path)) throw Error('Referenced 3D candidate FBX is missing.');
        for (const r of c.resources || []) {
          if (!r?.path || !validPath(r.path)) throw Error('Referenced 3D texture resource is missing.');
        }
      }
    }
  }
  for (const e of g.edges) {
    if (!e || typeof e.id !== 'string' || !nodeIds.has(e.fromNode) || !nodeIds.has(e.toNode)) {
      throw Error('Invalid edge connection in nodeGraph.');
    }
  }
}
