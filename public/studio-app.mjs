// MorphoGem Clean-Room Studio Application Controller (zh-CN & en ONLY)
import {
  getLocale,
  setLocale,
  onLocaleChange,
  tr,
} from './i18n.mjs';
import {
  createNewProject,
  packProject,
  unpackProject,
} from './mgem-project.mjs';
import {
  ensureNodeGraph,
  getNode,
  incomingEdges,
  isMeshNodeType,
  nodeInputStamp,
  pruneUnusedGraphDocuments,
} from './node-graph.mjs';
import {initNodeCanvas} from './node-canvas.mjs';
import {initViewport3D} from './viewport-3d.mjs';

const UI_STRINGS = {
  hdrNew: ['+ 新建', '+ New'],
  hdrRecent: ['📂 历史项目', '📂 Projects'],
  hdrOpen: ['打开 .mgem', 'Open .mgem'],
  hdrExportMgem: ['💾 导出包', '💾 Export .mgem'],
  hdrSettings: ['⚙ 设置', '⚙ Settings'],
  camOrbit: ['自由透视', 'Orbit'],
  camFront: ['正视', 'Front'],
  camRight: ['右视', 'Right'],
  camLeft: ['左视', 'Left'],
  camBack: ['背视', 'Back'],
  camTop: ['顶视', 'Top'],
  vpFit: ['居中适应', 'Fit View'],
  vpGuide: ['比例垫图', 'Ref Guide'],
  vpWireframe: ['网格线框', 'Wireframe'],
  vpEmptyTitle: ['尚未接入已生成的 3D 部件网格', 'No Generated 3D Part Meshes Connected Yet'],
  vpEmptyDesc: [
    '请先在「节点蓝图画布」完成四视图拆解并运行 Tripo 3D 建模节点，且确保建模节点连入了「3D 合体对位与最终导出」终点节点。',
    'Complete 4-view decomposition and run your Tripo 3D mesh nodes on the Node Graph Canvas first, ensuring they are wired into the Assembly Export node.',
  ],
  vpBackCanvas: ['← 返回节点蓝图画布', '← Back to Node Graph Canvas'],
  vpPartsTitle: ['🧩 已接入的 3D 部件', '🧩 Connected 3D Parts'],
  vpTransformTitle: ['✥ 选中部件空间微调', '✥ Part Transform'],
  vpResetPart: ['重置', 'Reset'],
  tfScale: ['等比缩放', 'Scale'],
  tfPosX: ['左右 X (m)', 'Pos X (m)'],
  tfPosZ: ['高低 Z (m)', 'Height Z (m)'],
  tfPosY: ['前后 Y (m)', 'Depth Y (m)'],
  tfRotX: ['俯仰 Rx (°)', 'Pitch Rx (°)'],
  tfRotY: ['侧倾 Ry (°)', 'Roll Ry (°)'],
  tfRotZ: ['旋转 Rz (°)', 'Yaw Rz (°)'],
  vpExportTitle: ['📦 整体身高与合并导出', '📦 Total Height & Merge Export'],
  vpTargetHeightLabel: ['目标总身高 (m)', 'Target Total Height (m)'],
  vpApplyHeightBtn: ['校准总高与贴地', 'Fit Height & Ground'],
  vpHeadBodyRatioLabel: ['📏 3D 头身比例 (头数 1.5~9.5)', '📏 3D Head-Body Ratio (1.5~9.5H)'],
  vpApplyRatioBtn: ['重配头身比例', 'Apply Ratio'],
  vpMaterialModeLabel: ['Blender 导出着色器模式', 'Blender Export Shader'],
  matPbr: ['PBR 标准材质（通用推荐）', 'PBR Standard Material (Recommended)'],
  matToon: ['Anime Toon 二次元赛璐璐材质', 'Anime Cel-Toon Material'],
  vpExportBtn: ['📦 合并导出最终模型 (FBX + GLB + Blend)', '📦 Merge & Export Final Assets (FBX + GLB + Blend)'],
  settingsTitle: ['⚙ 工作台与引擎设置', '⚙ Studio & Engine Settings'],
  settingsLangTitle: ['🌐 界面与 AI 提示词语言 / Language', '🌐 UI & AI Prompt Language'],
  settingsDirTitle: ['📁 当前活跃工程存储位置', '📁 Active Project Storage Path'],
  recentTitle: ['📂 本地历史项目 (Projects)', '📂 Recent Local Projects'],
  promptModalTitle: ['✨ AI 正交多视图拆解指令已生成', '✨ AI Orthographic Views Prompt Ready'],
  promptModalHint: [
    '关联节点已自动进入局部锁定保护（画布中其他无关分支仍可自由编辑）。请复制下方指令发送给你的 AI 助手（Claude Code / Antigravity / Cursor 等），AI 完成后结果会自动热刷新回画布节点并自动解锁！',
    'Target nodes are now locally locked for safety (all other unrelated branches remain freely editable). Paste this prompt into your AI Agent (Claude Code / Antigravity / Cursor); views will hot-reload automatically upon completion!',
  ],
  btnCancelLock: ['🔓 取消本次任务并解锁节点', '🔓 Cancel & Unlock Nodes'],
  btnCopyPrompt: ['📋 一键复制完整指令', '📋 Copy Full Prompt'],
  btnDone: ['完成', 'Done'],
  btnClose: ['关闭', 'Close'],
};

let state = {
  project: createNewProject({locale: getLocale()}),
  files: new Map(),
  activeMeta: null,
  lastPromptText: '',
  lockState: {
    active: false,
    status: 'idle',
    id: null,
    lockedNodeIds: [],
    targetNodeIds: [],
    progress: '',
  },
};

const nameInput = document.querySelector('#projectNameInput');
const saveStatusPill = document.querySelector('#saveStatusPill');
const localeSwitchBtn = document.querySelector('#localeSwitchBtn');
const toastEl = document.querySelector('#studioToast');
const settingsDlg = document.querySelector('#previewSettingsDialog');
const recentDlg = document.querySelector('#recentProjectsDialog');
const promptDlg = document.querySelector('#aiPromptDialog');
const promptTextarea = document.querySelector('#aiPromptTextarea');

let toastTimer = null;
export function showToast(msg, durationMs = 3400) {
  if (!toastEl) return;
  toastEl.textContent = String(msg || '');
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, durationMs);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function setSaveBadge(mode, customText = '') {
  saveStatusPill.classList.remove('saving', 'saved');
  if (mode === 'saving') {
    saveStatusPill.classList.add('saving');
    saveStatusPill.textContent = customText || tr('保存中…', 'Saving...');
  } else if (mode === 'saved') {
    saveStatusPill.classList.add('saved');
    saveStatusPill.textContent = customText || tr('✓ 已自动保存', '✓ Saved');
  } else {
    saveStatusPill.textContent = customText || tr('已就绪', 'Ready');
  }
}

let saveTimer = null;
let savingPromise = null;

async function flushSaveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (savingPromise) {
    await savingPromise.catch(() => {});
  }
  savingPromise = (async () => {
    try {
      setSaveBadge('saving');
      pruneUnusedGraphDocuments(state.project, state.files);
      const packed = await packProject(state.project, state.files);
      const res = await fetch('/api/session/save', {
        method: 'PUT',
        headers: {'Content-Type': 'application/octet-stream'},
        body: packed.bytes,
      });
      if (res.ok) {
        const data = await res.json();
        state.activeMeta = data.active || state.activeMeta;
        setSaveBadge('saved');
      } else {
        setSaveBadge('idle', tr('本地暂存', 'In-Memory'));
      }
    } catch (err) {
      console.warn('Auto-save warning:', err);
      setSaveBadge('idle');
    } finally {
      savingPromise = null;
    }
  })();
  return savingPromise;
}

function scheduleSave() {
  setSaveBadge('saving');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushSaveNow();
  }, 420);
}

function updateLockStateFromRequest(reqObj) {
  const wasActive = state.lockState.active;
  const prevSig = JSON.stringify(state.lockState);
  if (!reqObj || (reqObj.status !== 'pending' && reqObj.status !== 'running')) {
    state.lockState = {
      active: false,
      status: 'idle',
      id: null,
      lockedNodeIds: [],
      targetNodeIds: [],
      progress: '',
    };
  } else {
    state.lockState = {
      active: true,
      status: reqObj.status,
      id: reqObj.id,
      lockedNodeIds: Array.isArray(reqObj.lockedNodeIds) ? reqObj.lockedNodeIds : [],
      targetNodeIds: Array.isArray(reqObj.targetNodeIds) ? reqObj.targetNodeIds : [],
      progress: reqObj.progress || '',
    };
  }
  if (wasActive !== state.lockState.active || prevSig !== JSON.stringify(state.lockState)) {
    window.dispatchEvent(new CustomEvent('morphogem-lock-change', {detail: state.lockState}));
  }
}

async function mergeCompletedAiViewsFromServer(targetNodeIds = []) {
  const res = await fetch('/api/session/file');
  if (!res.ok) return;
  const buf = new Uint8Array(await res.arrayBuffer());
  const {project: diskProj, files: diskFiles} = await unpackProject(buf);
  const diskGraph = ensureNodeGraph(diskProj);
  const liveGraph = ensureNodeGraph(state.project);

  const targetSet = new Set(
    Array.isArray(targetNodeIds) && targetNodeIds.length
      ? targetNodeIds
      : diskGraph.nodes.filter(n => n.type === 'part_views' || n.type === 'balance_views').map(n => n.id)
  );

  const existingDocPaths = new Set((state.project.documents || []).map(d => d.path));
  const copyDocIfNeeded = docRef => {
    if (!docRef?.path) return;
    const bytes = diskFiles.get(docRef.path);
    if (bytes) {
      state.files.set(docRef.path, bytes);
      if (!existingDocPaths.has(docRef.path)) {
        state.project.documents ??= [];
        state.project.documents.push({path: docRef.path, sha256: docRef.sha256});
        existingDocPaths.add(docRef.path);
      }
    }
  };

  for (const tid of targetSet) {
    const diskNode = getNode(diskGraph, tid);
    const liveNode = getNode(liveGraph, tid);
    if (!diskNode || !liveNode) continue;
    if (diskNode.data?.views) {
      liveNode.data.views = structuredClone(diskNode.data.views);
      for (const vDoc of Object.values(diskNode.data.views)) {
        copyDocIfNeeded(vDoc);
      }
      liveNode.data.completedStamp = diskNode.data.completedStamp || nodeInputStamp(liveGraph, liveNode.id);
    }
  }

  pruneUnusedGraphDocuments(state.project, state.files);
  await fetch('/api/session/ack', {method: 'POST'}).catch(() => {});
  updateLockStateFromRequest(null);
  canvasCtrl.clearBlobUrls();
  canvasCtrl.render();
  await flushSaveNow();
  showToast(
    tr(
      '✨ AI 多视图拆解已完成，新视图已无损合并回节点并自动解锁！',
      '✨ AI orthographic views registered & nodes unlocked!'
    ),
    4800
  );
}

let pollBusy = false;
async function pollSessionStatus() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const res = await fetch('/api/session');
    if (!res.ok) return;
    const data = await res.json();
    state.activeMeta = data.active || state.activeMeta;
    const req = data.request;
    if (req?.status === 'completed' && req.projectId === state.project.id) {
      await mergeCompletedAiViewsFromServer(req.targetNodeIds || []);
      return;
    }
    updateLockStateFromRequest(req);
  } catch {
    // ignore transient offline
  } finally {
    pollBusy = false;
  }
}

setInterval(() => {
  if (state.lockState.active) {
    void pollSessionStatus();
  }
}, 1800);

window.addEventListener('focus', () => {
  void pollSessionStatus();
});

async function buildSlimTripoInputArchive(project, filesMap, targetNodeId) {
  const slimProj = structuredClone(project);
  const slimFiles = new Map(filesMap);
  const g = ensureNodeGraph(slimProj);
  const targetNode = getNode(g, targetNodeId);
  const keepMeshNodeId = targetNode?.type === 'tripo_retexture'
    ? (incomingEdges(g, targetNode.id, 'mesh')[0]?.fromNode || null)
    : null;
  for (const n of g.nodes) {
    if (!isMeshNodeType(n.type)) continue;
    if (n.id === keepMeshNodeId) {
      const cands = n.data?.candidates || [];
      const sel = cands.find(c => c.id === n.data?.selectedId) || cands[0] || null;
      n.data.candidates = sel ? [sel] : [];
    } else if (n.data) {
      n.data.candidates = [];
    }
  }
  pruneUnusedGraphDocuments(slimProj, slimFiles);
  return packProject(slimProj, slimFiles);
}

async function mergeReturnedMeshArchiveIntoState(nodeId, retBytes) {
  const {project: retProj, files: retFiles} = await unpackProject(retBytes);
  const retMeshNode = getNode(ensureNodeGraph(retProj), nodeId);
  const liveMeshNode = getNode(ensureNodeGraph(state.project), nodeId);
  if (retMeshNode && liveMeshNode) {
    liveMeshNode.data.candidates = structuredClone(retMeshNode.data.candidates || []);
    liveMeshNode.data.selectedId = retMeshNode.data.selectedId;
    liveMeshNode.data.completedStamp = retMeshNode.data.completedStamp;
    liveMeshNode.data.runtimeStatus = '';
    const existingPaths = new Set((state.project.documents || []).map(d => d.path));
    for (const c of liveMeshNode.data.candidates) {
      const allRefs = [c, ...(c.resources || [])];
      for (const ref of allRefs) {
        if (ref?.path && retFiles.has(ref.path)) {
          state.files.set(ref.path, retFiles.get(ref.path));
          if (!existingPaths.has(ref.path)) {
            state.project.documents ??= [];
            state.project.documents.push({path: ref.path, sha256: ref.sha256});
            existingPaths.add(ref.path);
          }
        }
      }
    }
    if (retProj.placements?.[nodeId]) {
      state.project.placements ??= {};
      state.project.placements[nodeId] ??= structuredClone(retProj.placements[nodeId]);
    }
  }
}

// --- Initialize Viewport & Node Canvas ---
const hooks = {
  get: () => ({project: state.project, files: state.files}),
  changed: () => {
    nameInput.value = state.project.name || '';
    scheduleSave();
  },
  commit: async (nextProject, nextFiles) => {
    state.project = nextProject;
    state.files = nextFiles;
    nameInput.value = state.project.name || '';
    canvasCtrl?.clearBlobUrls?.();
    canvasCtrl?.render?.();
    void viewportCtrl?.sync?.();
    await flushSaveNow();
  },
  toast: msg => showToast(msg),
  download: (blob, filename) => triggerDownload(blob, filename),
  syncViewportMeshes: () => {
    if (!document.body.classList.contains('node-graph-active')) {
      void viewportCtrl?.sync?.();
    }
  },
  onEnterViewport: () => {
    viewportCtrl?.resize?.();
    void viewportCtrl?.sync?.();
  },
  session: () => ({
    getNodeLockState: () => state.lockState,
    reopenPromptDialog: () => {
      if (state.lastPromptText) {
        promptTextarea.value = state.lastPromptText;
        promptDlg.showModal();
      } else {
        void hooks.requestGraphViews(state.lockState.targetNodeIds);
      }
    },
    cancelActiveRequest: async () => {
      await fetch('/api/session/cancel', {method: 'POST'}).catch(() => {});
      updateLockStateFromRequest(null);
      if (promptDlg.open) promptDlg.close();
      showToast(tr('🔓 已取消本次 AI 任务锁定', '🔓 AI node lock cancelled'));
    },
  }),
  requestGraphViews: async (targetNodeIds = null) => {
    try {
      const g = ensureNodeGraph(state.project);
      const srcNode = g.nodes.find(n => n.type === 'source_image');
      if (!srcNode?.data?.image?.sha256) {
        showToast(tr('请先在左侧「主立绘」节点上传一张角色或物件原画！', 'Please upload a Source Concept Image on the canvas first!'));
        return;
      }
      setSaveBadge('saving', tr('正在生成指令…', 'Preparing prompt...'));
      pruneUnusedGraphDocuments(state.project, state.files);
      const packed = await packProject(state.project, state.files);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'X-Locale': getLocale(),
      };
      if (Array.isArray(targetNodeIds) && targetNodeIds.length) {
        headers['X-Target-Nodes'] = targetNodeIds.join(',');
      }
      const res = await fetch('/api/session/request', {
        method: 'POST',
        headers,
        body: packed.bytes,
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || 'Failed to create AI session');

      state.activeMeta = data.active || state.activeMeta;
      state.lastPromptText = data.prompt || '';
      updateLockStateFromRequest(data.request);
      setSaveBadge('saved');

      promptTextarea.value = state.lastPromptText;
      promptDlg.showModal();
      try {
        await navigator.clipboard.writeText(state.lastPromptText);
        showToast(tr('📋 AI 拆图指令已自动复制到剪贴板，关联节点已保护锁定！', '📋 AI prompt copied to clipboard & target nodes locked!'));
      } catch {
        // user can click copy button inside dialog
      }
    } catch (err) {
      setSaveBadge('idle');
      showToast(err.message || String(err));
    }
  },
  fetchTripoAssets: async () => {
    const res = await fetch('/api/node-graph/tripo-assets');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(data.error || `Failed to query Tripo assets (${res.status})`);
    return data;
  },
  importTripoModelToNode: async (nodeId, modelId, onStatus) => {
    await flushSaveNow();
    onStatus?.(nodeId, tr('正在从 Tripo 导出已生成模型…', 'Exporting ready model from Tripo...'));
    const slimPacked = await buildSlimTripoInputArchive(state.project, state.files, nodeId);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'X-Node-Id': nodeId,
    };
    if (modelId) headers['X-Model-Id'] = String(modelId).trim();
    const res = await fetch('/api/node-graph/import-tripo-model', {
      method: 'POST',
      headers,
      body: slimPacked.bytes,
    });
    if (!res.ok) {
      const errObj = await res.json().catch(() => ({}));
      throw Error(errObj.error || `Tripo import failed (${res.status})`);
    }
    const retBytes = new Uint8Array(await res.arrayBuffer());
    await mergeReturnedMeshArchiveIntoState(nodeId, retBytes);
    onStatus?.(nodeId, '');
    canvasCtrl.render();
    await flushSaveNow();
    showToast(tr('🎉 已直接从 Tripo 导入模型并接入合体节点（0 积分消耗）！', '🎉 Imported ready 3D model from Tripo (0 credits spent)!'));
  },
  executeTripoNodes: async (nodeIds, onStatus) => {
    await flushSaveNow();
    for (const nodeId of nodeIds) {
      onStatus?.(nodeId, tr('正在调用 Tripo 生成 3D…', 'Generating 3D in Tripo...'));
      const slimPacked = await buildSlimTripoInputArchive(state.project, state.files, nodeId);
      const res = await fetch('/api/node-graph/run-tripo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Node-Id': nodeId,
        },
        body: slimPacked.bytes,
      });
      if (!res.ok) {
        const errObj = await res.json().catch(() => ({}));
        throw Error(errObj.error || `Tripo generation failed (${res.status})`);
      }
      const retBytes = new Uint8Array(await res.arrayBuffer());
      await mergeReturnedMeshArchiveIntoState(nodeId, retBytes);
      onStatus?.(nodeId, '');
      canvasCtrl.render();
      await flushSaveNow();
    }
    showToast(tr('🎉 Tripo 3D 部件网格生成并入库完成！可切换至 3D 视口对位。', '🎉 Tripo 3D part meshes generated! Switch to 3D Viewport to assemble.'));
  },
  exportGraphAssets: async (assemblyNodeId = '') => {
    try {
      const g = ensureNodeGraph(state.project);
      const asm = assemblyNodeId ? getNode(g, assemblyNodeId) : g.nodes.find(n => n.type === 'assembly_export');
      showToast(tr('⏳ 正在调用 Blender 合并所有部件并导出 FBX / GLB / Blend…', '⏳ Running Blender to merge & export FBX / GLB / Blend...'), 10000);
      await flushSaveNow();
      const packed = await packProject(state.project, state.files);
      const res = await fetch('/api/node-graph/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(asm?.id ? {'X-Assembly-Node': asm.id} : {}),
        },
        body: packed.bytes,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Error(err.error || `Export failed (${res.status})`);
      }
      const zipBlob = await res.blob();
      const safeName = (state.project.name || 'character').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim() || 'character';
      triggerDownload(zipBlob, `${safeName}-assets.zip`);
      if (asm) {
        asm.data.exportRecord = {
          exportedAt: new Date().toISOString(),
          sourceStamp: nodeInputStamp(g, asm.id),
        };
        canvasCtrl.render();
        await flushSaveNow();
      }
      showToast(tr(`✓ 已成功导出合并资产包 ${safeName}-assets.zip！`, `✓ Exported merged package ${safeName}-assets.zip!`));
    } catch (err) {
      showToast(err.message || String(err), 5200);
    }
  },
};

const viewportCtrl = initViewport3D(hooks);
const canvasCtrl = initNodeCanvas(hooks);

// --- Bilingual UI Application (`zh-CN` & `en` ONLY) ---
function applyLocaleToDOM() {
  const loc = getLocale();
  const isEnglish = loc === 'en';
  document.documentElement.lang = loc;
  document.title = isEnglish
    ? 'MorphoGem — Node-Based 2D-to-3D Character Studio'
    : 'MorphoGem — 节点式 3D 角色工坊';

  localeSwitchBtn.textContent = isEnglish ? '🌐 EN' : '🌐 中文';

  for (const [key, [zh, en]] of Object.entries(UI_STRINGS)) {
    for (const el of document.querySelectorAll(`[data-i18n="${key}"]`)) {
      el.textContent = isEnglish ? en : zh;
    }
  }

  for (const btn of document.querySelectorAll('.lang-choice[data-set-lang]')) {
    btn.classList.toggle('active', btn.dataset.setLang === loc);
  }

  // Translate dynamic workspace switcher & key Node Canvas toolbar controls
  const wsCanvasBtn = document.querySelector('.workspace-mode-btn[data-ws-mode="canvas"]');
  const wsVpBtn = document.querySelector('.workspace-mode-btn[data-ws-mode="viewport"]');
  if (wsCanvasBtn) wsCanvasBtn.textContent = isEnglish ? '🕸️ Node Graph Canvas' : '🕸️ 节点蓝图画布';
  if (wsVpBtn) wsVpBtn.textContent = isEnglish ? '🧍 3D Assembly Viewport' : '🧍 3D 合体对位视口';

  const setTxt = (sel, zh, en) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = isEnglish ? en : zh;
  };
  setTxt('#ngApplyTemplate', '↻ 重置', '↻ Reset');
  setTxt('#ngSaveTemplate', '💾 存为模板', '💾 Save Template');
  setTxt('#ngSaveBranch', '🌿 存分支', '🌿 Save Branch');
  setTxt('#ngManagePresets', '⚙ 预设', '⚙ Presets');
  setTxt('#ngDeleteSelected', '🗑 删除', '🗑 Delete');
  setTxt('#ngFitCanvas', '适应全图', 'Fit Graph');
  setTxt('#ngRequestViews', '✨ 复制 AI 拆图指令', '✨ Copy AI Views Prompt');
  setTxt('#ngRunAllTripo', '▶ 一键直跑 3D 节点', '▶ Run Tripo 3D Nodes');
  setTxt(
    '#ngFooterHint',
    'Space / Shift+A 搜索添加节点与分支 · Del / X 删除 · Shift+D 克隆 · G 抓取移动 · B / Shift+左键 框选 · Alt+左键划断连线 · 拖线松手自动建节点',
    'Space / Shift+A Quick Add · Del / X Delete · Shift+D Clone · G Grab · B / Shift+Drag Box Select · Alt+Drag Cut Wire · Drop Wire to Create'
  );
  const quickBtn = document.querySelector('#ngQuickAddBtn');
  if (quickBtn) {
    quickBtn.innerHTML = isEnglish
      ? '+ Add Node <span class="ng-kbd">Space</span>'
      : '+ 添加节点 <span class="ng-kbd">Space</span>';
  }

  viewportCtrl.refreshLabels();
}

onLocaleChange(() => applyLocaleToDOM());
localeSwitchBtn.onclick = () => {
  setLocale(getLocale() === 'en' ? 'zh-CN' : 'en');
};
document.querySelectorAll('.lang-choice[data-set-lang]').forEach(btn => {
  btn.onclick = () => setLocale(btn.dataset.setLang);
});

// --- Header Controls ---
nameInput.onchange = () => {
  const nextName = nameInput.value.trim() || tr('新角色', 'New Character');
  state.project.name = nextName;
  nameInput.value = nextName;
  scheduleSave();
};

document.querySelector('#newProjectBtn').onclick = async () => {
  if (state.lockState.active) {
    showToast(tr('请先等待当前 AI 任务完成或点击取消锁定后再新建项目', 'Finish or cancel the active AI lock before creating a new project'));
    return;
  }
  const fresh = createNewProject({locale: getLocale()});
  await hooks.commit(fresh, new Map());
  canvasCtrl.setWorkspaceMode('canvas');
  canvasCtrl.fitCanvas();
  showToast(tr('✓ 已创建全新角色工程', '✓ Created new character project'));
};

document.querySelector('#openProjectInput').onchange = async ev => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const ab = await file.arrayBuffer();
    const {project, files} = await unpackProject(ab);
    const res = await fetch('/api/session/open', {
      method: 'POST',
      headers: {'Content-Type': 'application/octet-stream'},
      body: new Uint8Array(ab),
    });
    if (res.ok) {
      const d = await res.json();
      state.activeMeta = d.active || null;
    }
    updateLockStateFromRequest(null);
    state.project = project;
    state.files = files;
    nameInput.value = project.name;
    canvasCtrl.clearBlobUrls();
    canvasCtrl.render();
    canvasCtrl.fitCanvas();
    void viewportCtrl.sync();
    setSaveBadge('saved');
    showToast(tr(`✓ 已载入项目「${project.name}」`, `✓ Opened project "${project.name}"`));
  } catch (err) {
    showToast(err.message || String(err));
  }
};

document.querySelector('#downloadMgemBtn').onclick = async () => {
  try {
    pruneUnusedGraphDocuments(state.project, state.files);
    const packed = await packProject(state.project, state.files);
    const safe = (state.project.name || 'character').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim() || 'character';
    triggerDownload(packed.blob, `${safe}.mgem`);
    showToast(tr(`✓ 已导出工程文件 ${safe}.mgem`, `✓ Exported ${safe}.mgem`));
  } catch (err) {
    showToast(err.message || String(err));
  }
};

// --- Recent Projects Modal ---
async function openRecentProjectsModal() {
  const listEl = document.querySelector('#recentProjectsList');
  const dirHint = document.querySelector('#recentDirHint');
  listEl.innerHTML = `<div style="color:#94a3b8;padding:12px">${tr('正在读取…', 'Loading...')}</div>`;
  recentDlg.showModal();

  try {
    const res = await fetch('/api/session/projects');
    const data = await res.json();
    dirHint.textContent = `${tr('存储目录', 'Projects Directory')}: ${data.directory || ''}`;
    listEl.innerHTML = '';
    const items = data.projects || [];
    if (!items.length) {
      listEl.innerHTML = `<div style="color:#64748b;padding:14px">${tr('暂无历史保存记录', 'No saved projects yet')}</div>`;
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = `recent-proj-row${item.id === state.project.id ? ' current' : ''}`;
      const infoDiv = document.createElement('div');
      const kb = Math.max(1, Math.round((item.sizeBytes || 0) / 1024));
      const timeStr = new Date(item.updatedAt).toLocaleString();
      infoDiv.innerHTML = `
        <div style="font-weight:700;color:#f8fafc;font-size:13px">${item.name}</div>
        <div style="color:#94a3b8;font-size:11.5px;margin-top:2px">
          ${item.nodeCount} ${tr('节点', 'nodes')} · ${item.meshCount} ${tr('个3D网格', 'meshes')} · ${kb} KB · ${timeStr}
        </div>
      `;
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = item.id === state.project.id ? 'ng-btn' : 'ng-btn primary';
      openBtn.textContent = item.id === state.project.id ? tr('当前项目', 'Current') : tr('载入', 'Open');
      openBtn.disabled = item.id === state.project.id;
      openBtn.onclick = async () => {
        const sw = await fetch('/api/session/open-recent', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: item.path}),
        });
        if (!sw.ok) return;
        const fileRes = await fetch('/api/session/file');
        if (!fileRes.ok) return;
        const {project, files} = await unpackProject(await fileRes.arrayBuffer());
        state.project = project;
        state.files = files;
        nameInput.value = project.name;
        updateLockStateFromRequest(null);
        canvasCtrl.clearBlobUrls();
        canvasCtrl.render();
        canvasCtrl.fitCanvas();
        void viewportCtrl.sync();
        recentDlg.close();
        showToast(tr(`✓ 已切换至项目「${project.name}」`, `✓ Switched to "${project.name}"`));
      };
      row.append(infoDiv, openBtn);
      listEl.append(row);
    }
  } catch (err) {
    listEl.innerHTML = `<div style="color:#f87171;padding:12px">${err.message}</div>`;
  }
}

document.querySelector('#recentProjectsBtn').onclick = () => void openRecentProjectsModal();
document.querySelector('#closeRecentBtn').onclick = () => recentDlg.close();
document.querySelector('#closeRecentFooterBtn').onclick = () => recentDlg.close();

// --- Settings Dialog ---
document.querySelector('#openSettingsBtn').onclick = () => {
  const pathText = document.querySelector('#settingsProjectPathText');
  if (pathText) {
    pathText.textContent = state.activeMeta?.path || tr('尚未写入磁盘', 'Not saved to disk yet');
  }
  settingsDlg.showModal();
};
document.querySelector('#closeSettingsBtn').onclick = () => settingsDlg.close();
document.querySelector('#closeSettingsFooterBtn').onclick = () => settingsDlg.close();

// --- AI Prompt Modal ---
document.querySelector('#closePromptDialogBtn').onclick = () => promptDlg.close();
document.querySelector('#doneAiPromptBtn').onclick = () => promptDlg.close();
document.querySelector('#copyAiPromptBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(promptTextarea.value);
    showToast(tr('✓ 已复制完整指令！', '✓ Prompt copied to clipboard!'));
  } catch {
    promptTextarea.select();
    document.execCommand('copy');
    showToast(tr('✓ 已复制完整指令！', '✓ Prompt copied to clipboard!'));
  }
};
document.querySelector('#cancelAiLockBtn').onclick = () => hooks.session().cancelActiveRequest();

// --- Initial Session Restore ---
async function bootstrap() {
  applyLocaleToDOM();
  try {
    const res = await fetch('/api/session');
    if (res.ok) {
      const data = await res.json();
      if (data.active?.path) {
        const fRes = await fetch('/api/session/file');
        if (fRes.ok) {
          const {project, files} = await unpackProject(await fRes.arrayBuffer());
          state.project = project;
          state.files = files;
          state.activeMeta = data.active;
          nameInput.value = project.name;
          updateLockStateFromRequest(data.request);
          canvasCtrl.clearBlobUrls();
          canvasCtrl.render();
          canvasCtrl.fitCanvas();
          setSaveBadge('saved');
          return;
        }
      }
    }
  } catch {
    // start fresh
  }
  nameInput.value = state.project.name;
  canvasCtrl.render();
  canvasCtrl.fitCanvas();
  await flushSaveNow();
}

void bootstrap();
