import {
  NODE_SPECS,
  GRAPH_VIEWS_4,
  GRAPH_VIEWS_3,
  BUILTIN_BRANCH_PRESETS,
  ensureNodeGraph,
  createNode,
  createTemplateGraph,
  serializeGraphAsTemplate,
  instantiateGraphFromTemplate,
  extractBranchPreset,
  insertBranchPreset,
  cloneNodesInGraph,
  getNode,
  incomingEdges,
  outgoingEdges,
  canConnectPorts,
  connectPorts,
  disconnectEdge,
  removeNode,
  addPartPipelineBranch,
  nodeInputStamp,
  nodeStatus,
  connectedAssemblyMeshes,
  registerGraphDocument,
  pruneUnusedGraphDocuments,
} from './node-graph.mjs';
import {inspectImage, validateProject, DEFAULT_PROJECT_NAMES} from './mgem-project.mjs';
import {initModAndSystemUI} from './mod-manager-ui.mjs';

const KIND_COLORS = {
  image: '#38bdf8',
  style: '#c084fc',
  ratio: '#2dd4bf',
  views: '#fbbf24',
  mesh: '#34d399',
  guide: '#818cf8',
};

const KIND_LABELS = {
  image: '主设计图',
  style: '画风参考',
  ratio: '头身比参考',
  views: '四方向视图',
  mesh: '部件 3D 网格',
  guide: '三视图参考尺',
};

const VIEW_LABELS = {front: '正', left: '左', right: '右', back: '背', side: '右'};
const DEFAULT_PROJ_NAMES = DEFAULT_PROJECT_NAMES;
const LOCAL_PRESET_KEY = 'morphogem.nodePresets.v1';

// 2D Line-segment intersection helper for Knife Wire Cutter
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const ccw = (p1x, p1y, p2x, p2y, p3x, p3y) => (p3y - p1y) * (p2x - p1x) > (p2y - p1y) * (p3x - p1x);
  return (ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy)) &&
         (ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy));
}

function sampleCubicBezier(x0, y0, x1, y1, x2, y2, x3, y3, steps = 18) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
    const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
    pts.push([x, y]);
  }
  return pts;
}

function polylineIntersectsBezier(polyPts, x0, y0, x3, y3) {
  if (polyPts.length < 2) return false;
  const dx = Math.max(60, Math.abs(x3 - x0) * 0.5);
  const curve = sampleCubicBezier(x0, y0, x0 + dx, y0, x3 - dx, y3, x3, y3, 18);
  for (let i = 0; i < polyPts.length - 1; i++) {
    const [ax, ay] = polyPts[i];
    const [bx, by] = polyPts[i + 1];
    for (let j = 0; j < curve.length - 1; j++) {
      const [cx, cy] = curve[j];
      const [dx2, dy2] = curve[j + 1];
      if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx2, dy2)) return true;
    }
  }
  return false;
}

export function initNodeCanvas(hooks) {
  if (!document.querySelector('link[href="./node-canvas.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './node-canvas.css';
    document.head.append(link);
  }

  // Add top header mode switch: [节点蓝图画布] <-> [3D 合体对位视口]
  const modeBar = document.createElement('div');
  modeBar.className = 'workspace-mode-switch';
  modeBar.innerHTML = `
    <button type="button" class="workspace-mode-btn active" data-ws-mode="canvas">🕸️ 节点蓝图画布</button>
    <button type="button" class="workspace-mode-btn" data-ws-mode="viewport">🧍 3D 合体对位视口</button>
  `;
  const mountSlot = document.querySelector('#headerCenterSlot') || document.querySelector('header .identity');
  if (mountSlot) mountSlot.append(modeBar);

  const root = document.createElement('section');
  root.id = 'nodeGraphWorkspace';
  root.innerHTML = `
    <div class="ng-toolbar">
      <div class="ng-toolbar-group">
        <select id="ngTemplateSelect" class="ng-select" title="选择内置或自定义保存的整图模板"></select>
        <button type="button" id="ngApplyTemplate" class="ng-btn" title="套用左侧选中的模板（保留已上传的主立绘与参考图）">套用</button>
        <button type="button" id="ngSaveTemplate" class="ng-btn violet" title="将当前画布的完整节点布局与参数保存为自定义模板">💾 存为模板</button>
        <span class="ng-sep"></span>
        <button type="button" id="ngQuickAddBtn" class="ng-btn amber" title="搜索并添加节点或自定义分支 (快捷键 Space / Shift+A)">+ 添加节点 <span class="ng-kbd">Space</span></button>
        <button type="button" id="ngSaveBranch" class="ng-btn violet" title="将当前选中的节点（或拆图+建模组合）保存为可复用的分支预设">🌿 存分支</button>
        <button type="button" id="ngManagePresets" class="ng-btn" title="管理已保存的个人模板与分支预设">⚙ 预设</button>
        <button type="button" id="ngModsBtn" class="ng-btn cyan" title="管理、导入或打包分享社区节点与模版 Mod (.mgmod)">🧩 Mod <span class="ng-kbd" id="ngModsBtnCount">0</span></button>
        <span class="ng-sep"></span>
        <button type="button" id="ngUndoBtn" class="ng-btn" title="撤销上一步节点操作 (Ctrl+Z)" disabled>↶</button>
        <button type="button" id="ngRedoBtn" class="ng-btn" title="重做节点操作 (Ctrl+Y)" disabled>↷</button>
        <button type="button" id="ngDeleteSelected" class="ng-btn danger" title="删除选中的节点 (Delete / Backspace / X)" disabled>🗑 删除</button>
        <button type="button" id="ngFitCanvas" class="ng-btn" title="聚焦选中节点或适应全图 (F / Home)">适应全图</button>
      </div>
      <div class="ng-toolbar-group">
        <button type="button" id="ngRequestViews" class="ng-btn primary">✨ 复制 AI 拆图指令</button>
        <button type="button" id="ngRunAllTripo" class="ng-btn emerald">▶ 一键直跑 3D 节点</button>
      </div>
    </div>
    <div class="ng-exec-banner" id="ngExecBanner" hidden>
      <div class="ng-exec-main">
        <span class="ng-exec-dot"></span>
        <strong id="ngExecTitle"></strong>
        <span id="ngExecMsg" class="ng-exec-msg"></span>
      </div>
      <div class="ng-exec-actions">
        <button type="button" id="ngExecViewPrompt" class="ng-btn" hidden>查看/复制指令</button>
        <button type="button" id="ngExecCancel" class="ng-btn danger" hidden>取消锁定</button>
      </div>
    </div>
    <div class="ng-stage" id="ngStage">
      <div class="ng-world" id="ngWorld">
        <svg class="ng-edges-svg" id="ngEdgesSvg"></svg>
        <div id="ngNodesLayer"></div>
      </div>
      <div class="ng-box-select" id="ngBoxSelect" hidden></div>
      <div class="ng-canvas-footer" id="ngFooterHint">Space / Shift+A 搜索添加节点与分支 · Del / X 删除 · Shift+D 克隆 · G 抓取移动 · B / Shift+左键 框选 · Alt+左键划断连线 · 拖线松手自动建节点</div>
    </div>

    <!-- Floating Quick-Add Search Palette -->
    <div class="ng-quick-menu" id="ngQuickMenu" hidden>
      <div class="ng-quick-head">
        <div class="ng-quick-filter-tag" id="ngQuickFilterTag" hidden></div>
        <input type="text" class="ng-quick-search" id="ngQuickSearch" placeholder="搜索节点或自定义分支 (↑↓选择 · Enter创建 · Esc关闭)…" autocomplete="off">
      </div>
      <div class="ng-quick-list" id="ngQuickList"></div>
    </div>

    <!-- Right-Click Node Context Menu -->
    <div class="ng-ctx-menu" id="ngCtxMenu" hidden>
      <button type="button" class="ng-ctx-btn" data-ctx="save-branch"><span>🌿 保存选中为「分支预设」…</span></button>
      <button type="button" class="ng-ctx-btn" data-ctx="clone"><span>📋 克隆选中节点</span><span class="ng-kbd">Shift+D</span></button>
      <button type="button" class="ng-ctx-btn" data-ctx="grab"><span>✥ 抓取自由移动</span><span class="ng-kbd">G</span></button>
      <button type="button" class="ng-ctx-btn" data-ctx="unlink"><span>✂ 断开选中节点连线</span></button>
      <div class="ng-ctx-sep"></div>
      <button type="button" class="ng-ctx-btn danger" data-ctx="delete"><span>🗑 删除选中节点</span><span class="ng-kbd">Del / X</span></button>
    </div>
  `;
  const appContent = document.querySelector('.app-content') || document.body;
  appContent.prepend(root);

  // Lightbox dialog for inspecting view images on nodes
  const previewDlg = document.createElement('dialog');
  previewDlg.id = 'ngImagePreviewDialog';
  previewDlg.innerHTML = `
    <div class="dialog-top"><h2 id="ngPreviewTitle">视图预览</h2><button type="button" id="ngClosePreview">×</button></div>
    <div style="display:flex;justify-content:center;align-items:center;max-height:72vh;overflow:auto;background:#090e1a;border-radius:8px;padding:8px">
      <img id="ngPreviewImg" alt="" style="max-width:680px;max-height:68vh;object-fit:contain">
    </div>
    <div class="dialog-actions" style="margin-top:10px">
      <label class="file-button">手动替换此图<input type="file" id="ngReplaceViewInput" accept=".png,.jpg,.jpeg,.webp" hidden></label>
      <button type="button" id="ngClosePreviewBtn" class="primary">关闭</button>
    </div>
  `;
  document.body.append(previewDlg);
  previewDlg.querySelector('#ngClosePreview').onclick = () => previewDlg.close();
  previewDlg.querySelector('#ngClosePreviewBtn').onclick = () => previewDlg.close();

  // Save Template / Save Branch Dialog
  const savePresetDlg = document.createElement('dialog');
  savePresetDlg.id = 'ngSavePresetDialog';
  savePresetDlg.className = 'ng-modal';
  savePresetDlg.innerHTML = `
    <form id="ngSavePresetForm">
      <div class="dialog-top"><h2 id="ngSavePresetTitle">保存预设</h2><button type="button" id="ngCancelSavePreset">×</button></div>
      <p id="ngSavePresetSummary" style="color:#94a3b8;font-size:12px;margin:8px 0 12px"></p>
      <label class="ng-field" style="margin-bottom:10px">
        <span>预设名称</span>
        <input type="text" id="ngPresetNameInput" class="ng-input" maxlength="60" required placeholder="例如：高精双马尾分支 / 二次元七件套全流程">
      </label>
      <label class="ng-field" style="margin-bottom:10px">
        <span>备注说明（可选，显示在空格搜索列表中）</span>
        <input type="text" id="ngPresetDescInput" class="ng-input" maxlength="160" placeholder="例如：2K挖空四视图 + H3.5 300万面 8K去高光">
      </label>
      <label id="ngAutoPairWrap" style="display:flex;align-items:center;gap:7px;font-size:12px;color:#cbd5e1;margin-bottom:14px;cursor:pointer">
        <input type="checkbox" id="ngAutoPairCheck" checked>
        <span>自动连带打包同分支关联的「拆图 ↔ Tripo 建模」配对节点</span>
      </label>
      <div class="dialog-actions" style="justify-content:flex-end">
        <button type="button" id="ngCancelSavePresetBtn" class="ng-btn">取消</button>
        <button type="submit" class="ng-btn primary">保存预设</button>
      </div>
    </form>
  `;
  document.body.append(savePresetDlg);

  // Preset Manager Dialog (Templates + Branches + JSON Export/Import)
  const manageDlg = document.createElement('dialog');
  manageDlg.id = 'ngManagePresetsDialog';
  manageDlg.className = 'ng-modal';
  manageDlg.innerHTML = `
    <div class="dialog-top"><h2>⚙ 管理自定义模板与分支预设</h2><button type="button" id="ngCloseManage">×</button></div>
    <div style="margin-top:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <strong style="font-size:13px;color:#93c5fd">🌟 我的整图模板</strong>
      </div>
      <div class="ng-preset-list" id="ngManageTemplateList"></div>
    </div>
    <div style="margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <strong style="font-size:13px;color:#fde68a">🌿 我的自定义分支预设（可在 Space 菜单快速插入）</strong>
      </div>
      <div class="ng-preset-list" id="ngManageBranchList"></div>
    </div>
    <div class="dialog-actions" style="margin-top:18px;justify-content:space-between;flex-wrap:wrap">
      <div style="display:flex;gap:8px">
        <button type="button" id="ngExportPresetsBtn" class="ng-btn">导出预设库 (.json)</button>
        <label class="ng-btn" style="cursor:pointer">导入预设库 (.json)<input type="file" id="ngImportPresetsInput" accept=".json" hidden></label>
      </div>
      <button type="button" id="ngCloseManageBtn" class="ng-btn primary">完成</button>
    </div>
  `;
  document.body.append(manageDlg);

  const hiddenImgPicker = document.createElement('input');
  hiddenImgPicker.type = 'file';
  hiddenImgPicker.accept = '.png,.jpg,.jpeg,.webp';
  hiddenImgPicker.hidden = true;
  root.append(hiddenImgPicker);

  const $ = s => root.querySelector(s);
  const stageEl = $('#ngStage');
  const worldEl = $('#ngWorld');
  const svgEl = $('#ngEdgesSvg');
  const nodesLayer = $('#ngNodesLayer');
  const boxSelectEl = $('#ngBoxSelect');
  const footerHintEl = $('#ngFooterHint');
  const quickMenuEl = $('#ngQuickMenu');
  const quickSearchEl = $('#ngQuickSearch');
  const quickListEl = $('#ngQuickList');
  const quickFilterTagEl = $('#ngQuickFilterTag');
  const ctxMenuEl = $('#ngCtxMenu');

  const DEFAULT_FOOTER = 'Space / Shift+A 搜索添加节点与分支 · Del / X 删除 · Shift+D 克隆 · G 抓取移动 · B / Shift+左键 框选 · Alt+左键划断连线 · 拖线松手自动建节点';

  const blobUrls = new Map();
  const selectedNodeIds = new Set();
  const undoStack = [];
  const redoStack = [];
  let userPresets = {version: 1, templates: [], branches: []};

  let pendingUploadTarget = null; // { nodeId, viewKey? }
  let activeMode = 'canvas'; // 'canvas' | 'viewport'
  let lastMouseClient = {x: 560, y: 340};

  // Interactive gesture states
  let panDrag = null;
  let nodeDrag = null; // { startWorldX, startWorldY, moved, clickedId, additive, initialPositions: Map<id,{x,y}> }
  let wireDrag = null; // { dir: 'out'|'in', nodeId, portId, kind, x, y, startClientX, startClientY, unpluggedEdge? }
  let boxSelectDrag = null; // { startClientX, startClientY, curClientX, curClientY, additive }
  let boxSelectArmed = false; // Blender 'B' key armed
  let knifeDrag = null; // { pointsWorld: [[x,y], ...], cutEdgeIds: Set<string> }
  let grabState = null; // Blender 'G' key free move { startWorldX, startWorldY, initialPositions: Map<id,{x,y}> }
  let rightClickTrack = null; // { startX, startY, nodeId }

  // Quick menu state
  let quickMenuContext = null; // { worldX, worldY, wireFrom?: { dir:'out'|'in', nodeId, portId, kind } }
  let quickFilteredItems = [];
  let quickActiveIdx = 0;
  let saveModalMode = 'template'; // 'template' | 'branch'
  const tripoExecutingIds = new Set();
  const tripoLockedIds = new Set();

  function getAgentLockState() {
    return hooks.session?.()?.getNodeLockState?.() || {active: false, status: 'idle', lockedNodeIds: [], targetNodeIds: []};
  }

  function isNodeLocked(nodeId) {
    if (!nodeId) return false;
    if (tripoLockedIds.has(nodeId)) return true;
    const al = getAgentLockState();
    return Boolean(al.active && Array.isArray(al.lockedNodeIds) && al.lockedNodeIds.includes(nodeId));
  }

  function isEdgeLocked(edge) {
    if (!edge) return false;
    return isNodeLocked(edge.toNode);
  }

  function hasAnyLockedNode() {
    if (tripoLockedIds.size > 0) return true;
    const al = getAgentLockState();
    return Boolean(al.active && al.lockedNodeIds?.length > 0);
  }

  function syncExecBanner() {
    const banner = $('#ngExecBanner');
    if (!banner) return;
    const al = getAgentLockState();
    const tripoCount = tripoExecutingIds.size;
    if (!al.active && al.status !== 'failed' && tripoCount === 0) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    const titleEl = $('#ngExecTitle');
    const msgEl = $('#ngExecMsg');
    const viewBtn = $('#ngExecViewPrompt');
    const cancelBtn = $('#ngExecCancel');

    if (al.status === 'failed') {
      banner.dataset.state = 'failed';
      titleEl.textContent = '⚠️ 上次 AI 拆图已中止';
      msgEl.textContent = al.error || '请检查节点配置后重新发起拆图';
      viewBtn.hidden = true;
      cancelBtn.hidden = false;
      cancelBtn.textContent = '关闭提示';
    } else if (al.active && al.status === 'queued') {
      banner.dataset.state = 'queued';
      titleEl.textContent = `📋 待发送拆图指令（已锁定 ${al.lockedNodeIds.length} 个关联节点）`;
      msgEl.textContent = '请将指令粘贴给 AI；其余未锁定节点仍可自由增删与连线';
      viewBtn.hidden = !al.canReopenPrompt;
      cancelBtn.hidden = false;
      cancelBtn.textContent = '取消本次锁定';
    } else if (al.active) {
      banner.dataset.state = 'running';
      titleEl.textContent = `⚡ AI 拆图执行中（已锁定 ${al.lockedNodeIds.length} 个关联节点）`;
      msgEl.textContent = `${al.message || '正在拆解正交视图…'} · 其余节点可自由操作，完成后无损合并写回`;
      viewBtn.hidden = true;
      cancelBtn.hidden = true;
    } else if (tripoCount > 0) {
      banner.dataset.state = 'running';
      titleEl.textContent = `🧊 Tripo 3D 建模执行中（${tripoCount} 个节点）`;
      msgEl.textContent = `已局部锁定正在建模的分支（共 ${tripoLockedIds.size} 个节点），画布其余节点可自由编辑`;
      viewBtn.hidden = true;
      cancelBtn.hidden = true;
    }
  }

  // --- Presets Persistence (Disk API + localStorage backup) ---
  function readLocalPresetsBackup() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_PRESET_KEY) || '{}');
      return {
        version: 1,
        templates: Array.isArray(raw.templates) ? raw.templates : [],
        branches: Array.isArray(raw.branches) ? raw.branches : [],
      };
    } catch {
      return {version: 1, templates: [], branches: []};
    }
  }

  async function loadUserPresets() {
    const local = readLocalPresetsBackup();
    try {
      const res = await fetch('/api/node-graph/presets');
      if (res.ok) {
        const remote = await res.json();
        const mergeById = (a, b) => {
          const map = new Map();
          for (const item of [...a, ...b]) if (item?.id) map.set(item.id, item);
          return [...map.values()];
        };
        userPresets = {
          version: 1,
          templates: mergeById(local.templates, remote.templates || []),
          branches: mergeById(local.branches, remote.branches || []),
        };
        try { localStorage.setItem(LOCAL_PRESET_KEY, JSON.stringify(userPresets)); } catch {}
        refreshTemplateSelect();
        return;
      }
    } catch {
      // fallback to localStorage
    }
    userPresets = local;
    refreshTemplateSelect();
  }

  async function persistUserPresets() {
    try { localStorage.setItem(LOCAL_PRESET_KEY, JSON.stringify(userPresets)); } catch {}
    try {
      await fetch('/api/node-graph/presets', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(userPresets),
      });
    } catch {
      // ignore if offline static preview
    }
    refreshTemplateSelect();
  }

  function refreshTemplateSelect() {
    const sel = $('#ngTemplateSelect');
    if (!sel) return;
    const prevVal = sel.value || currentGraph()?.preset || 'standard_split';
    sel.replaceChildren();

    const grpBuiltin = document.createElement('optgroup');
    grpBuiltin.label = '内置标准模板';
    const builtins = [
      ['standard_split', '模板：精细角色拆分（裸脸 + 头发 + 服装身体）'],
      ['deluxe_composite', '模板：豪华多件复合（裸脸 + 发 + 上衣 + 下裙 + 翅膀 + 武器）'],
      ['single_prop', '模板：自由单件 / 道具'],
    ];
    for (const [val, text] of builtins) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      grpBuiltin.append(opt);
    }
    sel.append(grpBuiltin);

    if (userPresets.templates.length) {
      const grpCustom = document.createElement('optgroup');
      grpCustom.label = '🌟 我的自定义模板';
      for (const tpl of userPresets.templates) {
        const opt = document.createElement('option');
        opt.value = `custom:${tpl.id}`;
        opt.textContent = `★ ${tpl.name}`;
        grpCustom.append(opt);
      }
      sel.append(grpCustom);
    }

    const enabledMods = (globalThis.__morphogemLoadedMods || []).filter(m => m.enabled && m.templates?.length);
    if (enabledMods.length) {
      const grpMod = document.createElement('optgroup');
      grpMod.label = '🧩 已启用 Mod 扩展模板';
      for (const mod of enabledMods) {
        for (const tpl of mod.templates) {
          const opt = document.createElement('option');
          opt.value = tpl.id; // starts with 'mod:'
          opt.textContent = `🧩 [${mod.name}] ${tpl.name}`;
          grpMod.append(opt);
        }
      }
      sel.append(grpMod);
    }

    const exists = [...sel.querySelectorAll('option')].some(o => o.value === prevVal);
    sel.value = exists ? prevVal : 'standard_split';

    // Sync New Project dialog's template dropdown with Mod templates too!
    const newProjSel = document.querySelector('#newProjectGraphPreset');
    if (newProjSel) {
      for (const oldGrp of [...newProjSel.querySelectorAll('optgroup[data-mod-group="1"]')]) oldGrp.remove();
      if (enabledMods.length) {
        const grpNew = document.createElement('optgroup');
        grpNew.label = '🧩 已启用 Mod 扩展模板';
        grpNew.dataset.modGroup = '1';
        for (const mod of enabledMods) {
          for (const tpl of mod.templates) {
            const opt = document.createElement('option');
            opt.value = tpl.id;
            opt.textContent = `🧩 [${mod.name}] ${tpl.name}`;
            grpNew.append(opt);
          }
        }
        newProjSel.append(grpNew);
      }
    }
  }

  // --- Undo / Redo Snapshot Stack ---
  function snapshotState(g) {
    return JSON.stringify({
      preset: g.preset || 'standard_split',
      modMeta: g.modMeta || null,
      nodes: g.nodes,
      edges: g.edges,
    });
  }

  function pushUndo() {
    const g = currentGraph();
    const snap = snapshotState(g);
    if (undoStack.length && undoStack[undoStack.length - 1] === snap) return;
    undoStack.push(snap);
    if (undoStack.length > 40) undoStack.shift();
    redoStack.length = 0;
    syncToolbarButtons();
  }

  function canApplySnapshotSafely(snapStr) {
    if (!hasAnyLockedNode()) return true;
    const g = currentGraph();
    const parsed = JSON.parse(snapStr);
    const allLocked = new Set([...tripoLockedIds, ...(getAgentLockState().lockedNodeIds || [])]);
    for (const lid of allLocked) {
      const curNode = getNode(g, lid);
      const nextNode = getNode(parsed, lid);
      if (!curNode || !nextNode) return false;
      if (nodeInputStamp(g, lid) !== nodeInputStamp(parsed, lid)) return false;
    }
    return true;
  }

  function applySnapshot(snapStr) {
    const parsed = JSON.parse(snapStr);
    const g = currentGraph();
    const allLocked = new Set([...tripoLockedIds, ...(getAgentLockState().lockedNodeIds || [])]);
    const preservedData = new Map();
    for (const lid of allLocked) {
      const curNode = getNode(g, lid);
      if (curNode) preservedData.set(lid, structuredClone(curNode.data));
    }
    g.preset = parsed.preset || g.preset;
    g.nodes = parsed.nodes;
    g.edges = parsed.edges;
    for (const [lid, data] of preservedData) {
      const n = getNode(g, lid);
      if (n) n.data = data;
    }
    for (const id of [...selectedNodeIds]) {
      if (!getNode(g, id)) selectedNodeIds.delete(id);
    }
    hooks.changed();
    render();
    hooks.syncViewportMeshes?.();
  }

  function undo() {
    if (!undoStack.length) return;
    const candidate = undoStack[undoStack.length - 1];
    if (!canApplySnapshotSafely(candidate)) {
      hooks.toast('🔒 该步撤销涉及正在执行的锁定节点，请等待任务完成后再撤销');
      return;
    }
    const g = currentGraph();
    redoStack.push(snapshotState(g));
    const prev = undoStack.pop();
    applySnapshot(prev);
    syncToolbarButtons();
    hooks.toast('已撤销节点操作');
  }

  function redo() {
    if (!redoStack.length) return;
    const candidate = redoStack[redoStack.length - 1];
    if (!canApplySnapshotSafely(candidate)) {
      hooks.toast('🔒 该步重做涉及正在执行的锁定节点，请等待任务完成后再重做');
      return;
    }
    const g = currentGraph();
    undoStack.push(snapshotState(g));
    const next = redoStack.pop();
    applySnapshot(next);
    syncToolbarButtons();
    hooks.toast('已重做节点操作');
  }

  function syncToolbarButtons() {
    const uBtn = $('#ngUndoBtn');
    const rBtn = $('#ngRedoBtn');
    const dBtn = $('#ngDeleteSelected');
    const reqBtn = $('#ngRequestViews');
    const al = getAgentLockState();
    if (uBtn) uBtn.disabled = undoStack.length === 0;
    if (rBtn) rBtn.disabled = redoStack.length === 0;
    if (dBtn) {
      const hasUnlockedSel = [...selectedNodeIds].some(id => !isNodeLocked(id));
      dBtn.disabled = !hasUnlockedSel;
    }
    if (reqBtn) {
      reqBtn.disabled = al.status === 'syncing' || al.status === 'running';
    }
    syncExecBanner();
  }

  function updateSelectionVisuals() {
    for (const el of nodesLayer.querySelectorAll('.ng-node')) {
      el.classList.toggle('selected', selectedNodeIds.has(el.dataset.nodeId));
    }
    syncToolbarButtons();
  }

  function setSingleSelection(nodeId) {
    selectedNodeIds.clear();
    if (nodeId) selectedNodeIds.add(nodeId);
    updateSelectionVisuals();
  }

  function fileUrl(docRef) {
    if (!docRef?.path) return '';
    const key = docRef.path + '|' + (docRef.sha256 || '');
    if (blobUrls.has(key)) return blobUrls.get(key);
    const bytes = hooks.get().files.get(docRef.path);
    if (!bytes) return '';
    const mime = /\.png$/i.test(docRef.path) ? 'image/png' : /\.webp$/i.test(docRef.path) ? 'image/webp' : 'image/jpeg';
    const u = URL.createObjectURL(new Blob([bytes], {type: mime}));
    blobUrls.set(key, u);
    return u;
  }

  function clearBlobUrls() {
    for (const u of blobUrls.values()) URL.revokeObjectURL(u);
    blobUrls.clear();
  }

  function currentGraph() {
    const {project: p} = hooks.get();
    return ensureNodeGraph(p);
  }

  function applyWorldTransform() {
    const g = currentGraph();
    const vp = g.viewport ??= {panX: 24, panY: 20, zoom: 0.86};
    worldEl.style.transform = `translate(${vp.panX}px, ${vp.panY}px) scale(${vp.zoom})`;
    stageEl.style.backgroundPosition = `${vp.panX}px ${vp.panY}px`;
    const sz = Math.max(10, Math.round(24 * vp.zoom));
    stageEl.style.backgroundSize = `${sz}px ${sz}px`;
  }

  function screenToWorld(clientX, clientY) {
    const rect = stageEl.getBoundingClientRect();
    const vp = currentGraph().viewport || {panX: 0, panY: 0, zoom: 1};
    return {
      x: (clientX - rect.left - vp.panX) / vp.zoom,
      y: (clientY - rect.top - vp.panY) / vp.zoom,
    };
  }

  function portCenterInWorld(nodeId, dir, portId) {
    const dot = nodesLayer.querySelector(`.ng-node[data-node-id="${nodeId}"] .ng-port.${dir}[data-port-id="${portId}"] .ng-port-dot`);
    if (!dot) return null;
    const dr = dot.getBoundingClientRect();
    return screenToWorld(dr.left + dr.width / 2, dr.top + dr.height / 2);
  }

  function bezierPath(x1, y1, x2, y2) {
    const dx = Math.max(60, Math.abs(x2 - x1) * 0.5);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  function renderEdges() {
    const g = currentGraph();
    svgEl.replaceChildren();
    for (const e of g.edges) {
      const p1 = portCenterInWorld(e.fromNode, 'out', e.fromPort);
      const p2 = portCenterInWorld(e.toNode, 'in', e.toPort);
      if (!p1 || !p2) continue;
      const fromNode = getNode(g, e.fromNode);
      const outSpec = NODE_SPECS[fromNode?.type]?.outputs?.find(o => o.id === e.fromPort);
      const stroke = KIND_COLORS[outSpec?.kind] || '#60a5fa';
      const d = bezierPath(p1.x, p1.y, p2.x, p2.y);

      const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const isCut = knifeDrag?.cutEdgeIds?.has(e.id);
      const edgeLocked = isEdgeLocked(e);
      grp.setAttribute('class', 'ng-edge-group' + (isCut ? ' cutting' : '') + (edgeLocked ? ' locked' : ''));
      grp.dataset.edgeId = e.id;
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('class', 'ng-edge-hit');
      hit.setAttribute('d', d);
      hit.addEventListener('click', ev => {
        ev.stopPropagation();
        if (isEdgeLocked(e)) {
          hooks.toast('🔒 该连线正在供给执行中的锁定节点，暂时无法断开');
          return;
        }
        pushUndo();
        disconnectEdge(g, e.id);
        hooks.changed();
        render();
      });
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'ng-edge-path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', stroke);
      grp.append(hit, path);
      svgEl.append(grp);
    }

    if (wireDrag) {
      const anchor = portCenterInWorld(wireDrag.nodeId, wireDrag.dir, wireDrag.portId);
      if (anchor) {
        const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        temp.setAttribute('class', 'ng-edge-temp');
        temp.setAttribute('stroke', KIND_COLORS[wireDrag.kind] || '#60a5fa');
        const d = wireDrag.dir === 'out'
          ? bezierPath(anchor.x, anchor.y, wireDrag.x, wireDrag.y)
          : bezierPath(wireDrag.x, wireDrag.y, anchor.x, anchor.y);
        temp.setAttribute('d', d);
        svgEl.append(temp);
      }
    }

    if (knifeDrag && knifeDrag.pointsWorld.length >= 2) {
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('class', 'ng-knife-path');
      poly.setAttribute('points', knifeDrag.pointsWorld.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
      svgEl.append(poly);
    }
  }

  // --- Node Actions (Delete, Clone, Grab, Unlink) ---
  function deleteNodesByIds(ids) {
    const g = currentGraph();
    const valid = ids.filter(id => getNode(g, id));
    if (!valid.length) return;
    const unlocked = valid.filter(id => !isNodeLocked(id));
    const skippedLocked = valid.length - unlocked.length;
    if (!unlocked.length) {
      hooks.toast('🔒 选中的节点正在执行任务或等待拆图，已锁定保护不可删除');
      return;
    }
    const deletable = unlocked.filter(id => {
      const n = getNode(g, id);
      if (n?.type === 'assembly_export' && g.nodes.filter(x => x.type === 'assembly_export').length <= 1) return false;
      return true;
    });
    if (!deletable.length) {
      hooks.toast('至少需要保留一个「3D 合体对位与最终导出」终点节点');
      return;
    }
    pushUndo();
    for (const id of deletable) {
      removeNode(g, hooks.get().project, id);
      selectedNodeIds.delete(id);
    }
    hooks.changed();
    render();
    hooks.syncViewportMeshes?.();
    if (skippedLocked > 0) {
      hooks.toast(`已删除 ${deletable.length} 个未锁定节点（${skippedLocked} 个执行锁定节点已自动保留）`);
    }
  }

  function cloneSelectedNodes({startGrab = false} = {}) {
    const ids = [...selectedNodeIds];
    if (!ids.length) {
      hooks.toast('请先点击或框选要克隆的节点');
      return;
    }
    const g = currentGraph();
    pushUndo();
    const created = cloneNodesInGraph(g, ids, startGrab ? 24 : 44, startGrab ? 24 : 64);
    if (!created.length) {
      hooks.toast('合体终点节点无需重复克隆');
      return;
    }
    selectedNodeIds.clear();
    for (const c of created) selectedNodeIds.add(c.id);
    hooks.changed();
    render();
    if (startGrab) {
      beginGrabMove(lastMouseClient.x, lastMouseClient.y, {alreadyPushedUndo: true});
    }
  }

  function unlinkSelectedNodes() {
    if (!selectedNodeIds.size) return;
    const g = currentGraph();
    const removable = g.edges.filter(e => (selectedNodeIds.has(e.fromNode) || selectedNodeIds.has(e.toNode)) && !isEdgeLocked(e));
    if (!removable.length) {
      if (g.edges.some(e => (selectedNodeIds.has(e.fromNode) || selectedNodeIds.has(e.toNode)) && isEdgeLocked(e))) {
        hooks.toast('🔒 关联执行中的输入连线已锁定，暂时无法断开');
      }
      return;
    }
    const rmSet = new Set(removable.map(e => e.id));
    pushUndo();
    g.edges = g.edges.filter(e => !rmSet.has(e.id));
    hooks.changed();
    render();
    hooks.toast('已断开选中节点的未锁定连线');
  }

  function beginGrabMove(clientX, clientY, {alreadyPushedUndo = false} = {}) {
    if (!selectedNodeIds.size) return;
    const g = currentGraph();
    if (!alreadyPushedUndo) pushUndo();
    const w = screenToWorld(clientX, clientY);
    const initialPositions = new Map();
    for (const id of selectedNodeIds) {
      const n = getNode(g, id);
      if (n) initialPositions.set(id, {x: n.x, y: n.y});
    }
    grabState = {startWorldX: w.x, startWorldY: w.y, initialPositions, alreadyPushedUndo};
    stageEl.classList.add('grab-mode');
    footerHintEl.textContent = '抓取移动中：移动鼠标放置节点 · 左键或 Enter 确认落位 · 右键或 Esc 取消回退';
  }

  function commitGrabMove() {
    if (!grabState) return;
    grabState = null;
    stageEl.classList.remove('grab-mode');
    footerHintEl.textContent = DEFAULT_FOOTER;
    hooks.changed();
  }

  function cancelGrabMove() {
    if (!grabState) return;
    const g = currentGraph();
    for (const [id, pos] of grabState.initialPositions) {
      const n = getNode(g, id);
      if (n) { n.x = pos.x; n.y = pos.y; }
    }
    if (!grabState.alreadyPushedUndo) undoStack.pop();
    grabState = null;
    stageEl.classList.remove('grab-mode');
    footerHintEl.textContent = DEFAULT_FOOTER;
    syncToolbarButtons();
    render();
  }

  // --- Space / Shift+A Quick-Add Search Menu & Wire Drop-to-Create ---
  function buildQuickCatalog(wireFrom = null) {
    const items = [];

    const acceptsOutKind = (branchDef, kind) => {
      if (kind === 'image' || kind === 'style' || kind === 'ratio') {
        return branchDef.nodes.some(n => n.type === 'part_views' || n.type === 'balance_views');
      }
      if (kind === 'views') {
        return branchDef.nodes.some(n => n.type === 'tripo_mesh');
      }
      return false;
    };

    const producesInKind = (branchDef, kind) => {
      if (kind === 'mesh') return branchDef.nodes.some(n => n.type === 'tripo_mesh');
      if (kind === 'views') return branchDef.nodes.some(n => n.type === 'part_views');
      if (kind === 'guide') return branchDef.nodes.some(n => n.type === 'balance_views');
      return false;
    };

    const branchMatchesWire = (br) => {
      if (!wireFrom) return true;
      return wireFrom.dir === 'out' ? acceptsOutKind(br, wireFrom.kind) : producesInKind(br, wireFrom.kind);
    };

    // 0. Enabled Community Mods: Custom Specialized Nodes & Branches!
    const enabledMods = (globalThis.__morphogemLoadedMods || []).filter(m => m.enabled);
    for (const mod of enabledMods) {
      for (const cn of mod.customNodes || []) {
        const spec = NODE_SPECS[cn.baseType];
        if (!spec) continue;
        if (wireFrom) {
          if (wireFrom.dir === 'out' && !spec.inputs.some(i => i.kind === wireFrom.kind)) continue;
          if (wireFrom.dir === 'in' && !spec.outputs.some(o => o.kind === wireFrom.kind)) continue;
        }
        items.push({
          category: `🧩 Mod 扩展 · ${mod.name}`,
          title: `🧩 ${cn.title}`,
          desc: cn.description || `来自 Mod「${mod.name}」的专属节点`,
          keywords: `${cn.title} ${cn.description || ''} ${mod.name} ${(mod.tags || []).join(' ')} mod`,
          tag: cn.badge || 'Mod 节点',
          tagClass: 'custom',
          action: (wx, wy) => {
            const g = currentGraph();
            pushUndo();
            const n = createNode(cn.baseType, wx, wy, cn.params || {});
            n.params = {...n.params, ...structuredClone(cn.params || {})};
            g.nodes.push(n);
            if (!wireFrom) {
              if (cn.baseType === 'part_views' || cn.baseType === 'balance_views') {
                const src = g.nodes.find(x => x.type === 'source_image');
                if (src) try { connectPorts(g, src.id, 'image', n.id, 'source'); } catch {}
              } else if (cn.baseType === 'tripo_mesh') {
                const asm = g.nodes.find(x => x.type === 'assembly_export');
                if (asm) try { connectPorts(g, n.id, 'mesh', asm.id, 'meshes'); } catch {}
              }
            } else {
              applyPendingWireToCreated([n], wireFrom);
            }
            setSingleSelection(n.id);
            hooks.changed();
            render();
          },
        });
      }
      for (const br of mod.branches || []) {
        if (!branchMatchesWire(br)) continue;
        items.push({
          category: `🧩 Mod 扩展 · ${mod.name}`,
          title: `🧩 ${br.name}`,
          desc: br.description || `来自 Mod「${mod.name}」的专属组合分支`,
          keywords: `${br.name} ${br.description || ''} ${mod.name} ${(mod.tags || []).join(' ')} mod branch`,
          tag: 'Mod 分支',
          tagClass: 'custom',
          action: (wx, wy) => spawnBranchItem(br, wx, wy, wireFrom),
        });
      }
    }

    // 1. User-Saved Custom Branches (Top Priority!)
    for (const br of userPresets.branches) {
      if (!branchMatchesWire(br)) continue;
      items.push({
        category: '🌟 我的自定义分支',
        title: `🌿 ${br.name}`,
        desc: br.description || `包含 ${br.nodes?.length || 1} 个节点的自定义分支`,
        keywords: `${br.name} ${br.description || ''} custom branch 自定义分支`,
        tag: '我的分支',
        tagClass: 'custom',
        action: (wx, wy) => spawnBranchItem(br, wx, wy, wireFrom),
      });
    }

    // 2. Quick Default Branch + Builtin Curated Branches
    const emptyBranchStub = {nodes: [{type: 'part_views'}, {type: 'tripo_mesh'}]};
    if (branchMatchesWire(emptyBranchStub)) {
      items.push({
        category: '⚡ 快捷组合分支（自动连线）',
        title: '➕ 新增空白「拆图 + Tripo 建模」分支',
        desc: '自动连入主立绘与合体终点，直接输入部件名称即可',
        keywords: 'branch split tripo 新增 拆件 分支 部件 建模',
        tag: '组合分支',
        tagClass: 'branch',
        action: (wx, wy) => {
          const g = currentGraph();
          pushUndo();
          const {partViewsNode, tripoMeshNode} = addPartPipelineBranch(g, {partName: '新自定义部件', x: wx, y: wy});
          applyPendingWireToCreated([partViewsNode, tripoMeshNode], wireFrom);
          setSingleSelection(partViewsNode.id);
          hooks.changed();
          render();
          const inp = nodesLayer.querySelector(`.ng-node[data-node-id="${partViewsNode.id}"] .part-name-input`);
          if (inp) { inp.focus(); inp.select(); }
        },
      });
    }

    for (const br of BUILTIN_BRANCH_PRESETS) {
      if (!branchMatchesWire(br)) continue;
      items.push({
        category: '⚡ 快捷组合分支（自动连线）',
        title: `⚡ ${br.name}`,
        desc: br.description,
        keywords: `${br.name} ${br.description} face hair body weapon wing 裸脸 头发 身体 武器`,
        tag: '预设分支',
        tagClass: 'branch',
        action: (wx, wy) => spawnBranchItem(br, wx, wy, wireFrom),
      });
    }

    // 3. Individual Atomic Nodes
    const nodeEntries = [
      ['part_views', '✂️ 部件正交四视图拆图', '自由命名要拆出的部件（脸/发/衣/翼/武器），生成正左右背四视图', 'part views split 拆图 部件 四视图'],
      ['tripo_mesh', '🧊 Tripo 3D 建模节点', '接收四方向视图，独立配置 HD 百万面或 Smart 四边面拓扑生成模型', 'tripo mesh 3d model 建模 网格 高模 低模'],
      ['style_ref', '🎨 画风参考立绘', '提供赛璐璐/厚涂/二次元渲染画风与线条参考', 'style ref 画风 上色 参考'],
      ['ratio_ref', '📏 头身比参考图', '提供全身头身比例与肢体修长度参考', 'ratio proportion 头身比 比例 参考'],
      ['balance_views', '📐 全身合体比例三视图', '生成正/侧/背全身比例标尺，辅助 3D 视口合体对位', 'balance guide three views 三视图 比例尺'],
      ['source_image', '🖼️ 主立绘（目标原画）', '输入核心角色或物件的目标原画立绘', 'source main image 主立绘 原画 输入'],
      ['assembly_export', '🧩 3D 合体对位与最终导出', '汇聚多部件 3D 网格并在 Blender 中合并导出 FBX / GLB / Blend', 'assembly export merge 合体 导出 终点'],
    ];

    for (const [type, title, desc, kw] of nodeEntries) {
      const spec = NODE_SPECS[type];
      if (wireFrom) {
        if (wireFrom.dir === 'out' && !spec.inputs.some(i => i.kind === wireFrom.kind)) continue;
        if (wireFrom.dir === 'in' && !spec.outputs.some(o => o.kind === wireFrom.kind)) continue;
      }
      items.push({
        category: '🧩 独立基础节点',
        title,
        desc,
        keywords: `${title} ${desc} ${kw} ${type}`,
        tag: spec.badge,
        tagClass: '',
        action: (wx, wy) => {
          const g = currentGraph();
          pushUndo();
          const n = createNode(type, wx, wy, type === 'part_views' ? {partName: '自定义部件'} : {});
          g.nodes.push(n);
          if (!wireFrom) {
            if (type === 'part_views' || type === 'balance_views') {
              const src = g.nodes.find(x => x.type === 'source_image');
              if (src) try { connectPorts(g, src.id, 'image', n.id, 'source'); } catch {}
            } else if (type === 'tripo_mesh') {
              const asm = g.nodes.find(x => x.type === 'assembly_export');
              if (asm) try { connectPorts(g, n.id, 'mesh', asm.id, 'meshes'); } catch {}
            }
          } else {
            applyPendingWireToCreated([n], wireFrom);
          }
          setSingleSelection(n.id);
          hooks.changed();
          render();
          if (type === 'part_views') {
            const inp = nodesLayer.querySelector(`.ng-node[data-node-id="${n.id}"] .part-name-input`);
            if (inp) { inp.focus(); inp.select(); }
          }
        },
      });
    }

    return items;
  }

  function applyPendingWireToCreated(createdNodes, wireFrom) {
    if (!wireFrom || !createdNodes.length) return;
    const g = currentGraph();
    if (wireFrom.dir === 'out') {
      for (const n of createdNodes) {
        const matchIn = NODE_SPECS[n.type]?.inputs?.find(i => i.kind === wireFrom.kind);
        if (matchIn) {
          try { connectPorts(g, wireFrom.nodeId, wireFrom.portId, n.id, matchIn.id); } catch {}
          break;
        }
      }
    } else if (wireFrom.dir === 'in') {
      for (let i = createdNodes.length - 1; i >= 0; i--) {
        const n = createdNodes[i];
        const matchOut = NODE_SPECS[n.type]?.outputs?.find(o => o.kind === wireFrom.kind);
        if (matchOut) {
          try { connectPorts(g, n.id, matchOut.id, wireFrom.nodeId, wireFrom.portId); } catch {}
          break;
        }
      }
    }
  }

  function spawnBranchItem(branchDef, wx, wy, wireFrom) {
    const g = currentGraph();
    pushUndo();
    const created = insertBranchPreset(g, branchDef, {x: wx, y: wy, autoWire: true});
    applyPendingWireToCreated(created, wireFrom);
    selectedNodeIds.clear();
    for (const c of created) selectedNodeIds.add(c.id);
    hooks.changed();
    render();
  }

  function openQuickMenu(clientX, clientY, {wireFrom = null, spawnAtStageCenter = false} = {}) {
    closeCtxMenu();
    const sr = stageEl.getBoundingClientRect();
    const clampedX = Math.max(sr.left + 40, Math.min(sr.right - 40, clientX));
    const clampedY = Math.max(sr.top + 40, Math.min(sr.bottom - 40, clientY));
    const spawnScreenX = spawnAtStageCenter ? (sr.left + sr.width * 0.45) : clampedX;
    const spawnScreenY = spawnAtStageCenter ? (sr.top + sr.height * 0.42) : clampedY;
    const w = screenToWorld(spawnScreenX, spawnScreenY);
    quickMenuContext = {worldX: Math.round(w.x - 40), worldY: Math.round(w.y - 20), wireFrom};

    if (wireFrom) {
      quickFilterTagEl.hidden = false;
      quickFilterTagEl.textContent = wireFrom.dir === 'out'
        ? `🔗 自动连接「${KIND_LABELS[wireFrom.kind] || wireFrom.kind}」输出到新节点：`
        : `🔗 自动创建上游节点接入「${KIND_LABELS[wireFrom.kind] || wireFrom.kind}」：`;
    } else {
      quickFilterTagEl.hidden = true;
    }

    quickMenuEl.hidden = false;
    const menuW = 360;
    const menuH = 420;
    const left = Math.max(12, Math.min(window.innerWidth - menuW - 12, clientX));
    const top = Math.max(52, Math.min(window.innerHeight - menuH - 12, clientY));
    quickMenuEl.style.left = `${left}px`;
    quickMenuEl.style.top = `${top}px`;

    quickSearchEl.value = '';
    quickActiveIdx = 0;
    renderQuickMenuList();
    requestAnimationFrame(() => quickSearchEl.focus());
  }

  function closeQuickMenu() {
    quickMenuEl.hidden = true;
    quickMenuContext = null;
  }

  function renderQuickMenuList() {
    if (!quickMenuContext) return;
    const q = quickSearchEl.value.trim().toLowerCase();
    const all = buildQuickCatalog(quickMenuContext.wireFrom);
    quickFilteredItems = q
      ? all.filter(it => it.keywords.toLowerCase().includes(q) || it.title.toLowerCase().includes(q))
      : all;
    if (quickActiveIdx >= quickFilteredItems.length) quickActiveIdx = 0;

    quickListEl.replaceChildren();
    if (!quickFilteredItems.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:16px;text-align:center;color:#64748b;font-size:12px';
      empty.textContent = '没有匹配的节点或分支预设';
      quickListEl.append(empty);
      return;
    }

    let lastCat = '';
    quickFilteredItems.forEach((item, idx) => {
      if (item.category !== lastCat) {
        lastCat = item.category;
        const cat = document.createElement('div');
        cat.className = 'ng-quick-cat';
        cat.textContent = lastCat;
        quickListEl.append(cat);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ng-quick-item' + (idx === quickActiveIdx ? ' active' : '');
      btn.innerHTML = `
        <div class="ng-quick-item-main">
          <span class="ng-quick-item-title"></span>
          <span class="ng-quick-item-desc"></span>
        </div>
        <span class="ng-quick-tag ${item.tagClass || ''}"></span>
      `;
      btn.querySelector('.ng-quick-item-title').textContent = item.title;
      btn.querySelector('.ng-quick-item-desc').textContent = item.desc;
      btn.querySelector('.ng-quick-tag').textContent = item.tag;
      btn.onmouseenter = () => {
        quickActiveIdx = idx;
        for (const [i, el] of [...quickListEl.querySelectorAll('.ng-quick-item')].entries()) {
          el.classList.toggle('active', i === idx);
        }
      };
      btn.onclick = () => {
        const ctx = quickMenuContext;
        closeQuickMenu();
        if (ctx) item.action(ctx.worldX, ctx.worldY);
      };
      quickListEl.append(btn);
    });
  }

  quickSearchEl.addEventListener('input', () => {
    quickActiveIdx = 0;
    renderQuickMenuList();
  });

  quickSearchEl.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (quickFilteredItems.length) {
        quickActiveIdx = (quickActiveIdx + 1) % quickFilteredItems.length;
        renderQuickMenuList();
        quickListEl.querySelector('.ng-quick-item.active')?.scrollIntoView({block: 'nearest'});
      }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (quickFilteredItems.length) {
        quickActiveIdx = (quickActiveIdx - 1 + quickFilteredItems.length) % quickFilteredItems.length;
        renderQuickMenuList();
        quickListEl.querySelector('.ng-quick-item.active')?.scrollIntoView({block: 'nearest'});
      }
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const chosen = quickFilteredItems[quickActiveIdx];
      const ctx = quickMenuContext;
      if (chosen && ctx) {
        closeQuickMenu();
        chosen.action(ctx.worldX, ctx.worldY);
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeQuickMenu();
    }
  });

  // --- Right-Click Context Menu ---
  function openCtxMenu(clientX, clientY, nodeId) {
    closeQuickMenu();
    if (nodeId && !selectedNodeIds.has(nodeId)) {
      setSingleSelection(nodeId);
    }
    ctxMenuEl.hidden = false;
    const left = Math.max(10, Math.min(window.innerWidth - 230, clientX));
    const top = Math.max(50, Math.min(window.innerHeight - 210, clientY));
    ctxMenuEl.style.left = `${left}px`;
    ctxMenuEl.style.top = `${top}px`;
  }

  function closeCtxMenu() {
    ctxMenuEl.hidden = true;
  }

  ctxMenuEl.onclick = ev => {
    const btn = ev.target.closest('[data-ctx]');
    if (!btn) return;
    const act = btn.dataset.ctx;
    closeCtxMenu();
    if (act === 'save-branch') openSavePresetDialog('branch');
    else if (act === 'clone') cloneSelectedNodes({startGrab: true});
    else if (act === 'grab') beginGrabMove(lastMouseClient.x, lastMouseClient.y);
    else if (act === 'unlink') unlinkSelectedNodes();
    else if (act === 'delete') deleteNodesByIds([...selectedNodeIds]);
  };

  // --- Save Template / Save Branch / Preset Manager Dialogs ---
  function openSavePresetDialog(mode = 'template') {
    saveModalMode = mode;
    const g = currentGraph();
    const titleEl = savePresetDlg.querySelector('#ngSavePresetTitle');
    const summaryEl = savePresetDlg.querySelector('#ngSavePresetSummary');
    const nameInp = savePresetDlg.querySelector('#ngPresetNameInput');
    const descInp = savePresetDlg.querySelector('#ngPresetDescInput');
    const autoPairWrap = savePresetDlg.querySelector('#ngAutoPairWrap');
    const autoPairChk = savePresetDlg.querySelector('#ngAutoPairCheck');

    if (mode === 'template') {
      titleEl.textContent = '💾 保存当前画布为「整图模板」';
      const partNames = g.nodes.filter(n => n.type === 'part_views').map(n => n.params?.partName || '未命名');
      summaryEl.textContent = `将保存全部 ${g.nodes.length} 个节点的坐标布局、连线关系与 Tripo 精度参数（含部件：${partNames.join(' / ') || '无'}）。`;
      nameInp.value = `${hooks.get().project.name || '自定义'} 拆分模板`;
      descInp.value = partNames.length ? `包含：${partNames.join(' + ')}` : '';
      autoPairWrap.style.display = 'none';
    } else {
      if (!selectedNodeIds.size) {
        hooks.toast('请先在画布点击或框选要保存的分支节点（如拆图节点或 Tripo 节点）');
        return;
      }
      titleEl.textContent = '🌿 保存选中节点为「自定义分支预设」';
      autoPairWrap.style.display = selectedNodeIds.size === 1 ? 'flex' : 'none';
      autoPairChk.checked = true;

      const updateBranchPreview = () => {
        try {
          const preview = extractBranchPreset(g, [...selectedNodeIds], {autoPair: autoPairChk.checked});
          const labels = preview.nodes.map(n => n.type === 'part_views' ? `拆图[${n.params.partName}]` : n.type === 'tripo_mesh' ? `${n.params.title || 'Tripo'} (${n.params.quality === 'smart' ? 'Smart' : 'HD'} ${(n.params.polyFaces || 0).toLocaleString()}面)` : NODE_SPECS[n.type]?.defaultTitle);
          summaryEl.textContent = `打包节点 (${preview.nodes.length})：${labels.join(' → ')}（后续按 Space 即可一键插入并自动接线）`;
          if (!nameInp.dataset.touched) nameInp.value = preview.name;
          if (!descInp.dataset.touched) descInp.value = labels.join(' → ');
        } catch (err) {
          summaryEl.textContent = err.message;
        }
      };
      nameInp.dataset.touched = '';
      descInp.dataset.touched = '';
      nameInp.oninput = () => { nameInp.dataset.touched = '1'; };
      descInp.oninput = () => { descInp.dataset.touched = '1'; };
      autoPairChk.onchange = updateBranchPreview;
      updateBranchPreview();
    }

    savePresetDlg.showModal();
    requestAnimationFrame(() => { nameInp.focus(); nameInp.select(); });
  }

  savePresetDlg.querySelector('#ngCancelSavePreset').onclick = () => savePresetDlg.close();
  savePresetDlg.querySelector('#ngCancelSavePresetBtn').onclick = () => savePresetDlg.close();
  savePresetDlg.querySelector('#ngSavePresetForm').onsubmit = async ev => {
    ev.preventDefault();
    const g = currentGraph();
    const name = savePresetDlg.querySelector('#ngPresetNameInput').value.trim();
    const description = savePresetDlg.querySelector('#ngPresetDescInput').value.trim();
    const autoPair = savePresetDlg.querySelector('#ngAutoPairCheck').checked;
    if (!name) return;

    try {
      if (saveModalMode === 'template') {
        const tpl = serializeGraphAsTemplate(g, {name, description});
        userPresets.templates.unshift(tpl);
        g.preset = `custom:${tpl.id}`;
        await persistUserPresets();
        $('#ngTemplateSelect').value = `custom:${tpl.id}`;
        hooks.changed();
        hooks.toast(`✓ 已保存整图模板「${tpl.name}」`);
      } else {
        const br = extractBranchPreset(g, [...selectedNodeIds], {name, description, autoPair});
        userPresets.branches.unshift(br);
        await persistUserPresets();
        hooks.toast(`✓ 已保存分支预设「${br.name}」（按 Space 键即可快速选用）`);
      }
      savePresetDlg.close();
    } catch (err) {
      hooks.toast(err.message);
    }
  };

  function renderManagePresetsModal() {
    const tplList = manageDlg.querySelector('#ngManageTemplateList');
    const brList = manageDlg.querySelector('#ngManageBranchList');
    tplList.replaceChildren();
    brList.replaceChildren();

    if (!userPresets.templates.length) {
      tplList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:8px 0">暂未保存整图模板（可在工具栏点「💾 保存为模板」）</div>';
    } else {
      for (const tpl of userPresets.templates) {
        const row = document.createElement('div');
        row.className = 'ng-preset-row';
        row.innerHTML = `<div class="ng-preset-info"><strong></strong><small></small></div><div class="ng-preset-actions"></div>`;
        row.querySelector('strong').textContent = tpl.name;
        row.querySelector('small').textContent = tpl.description || `${tpl.nodes?.length || 0} 个节点`;
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'ng-btn primary';
        applyBtn.textContent = '套用';
        applyBtn.onclick = async () => {
          manageDlg.close();
          await applyTemplateByKey(`custom:${tpl.id}`);
        };
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ng-btn danger';
        delBtn.textContent = '删除';
        delBtn.onclick = async () => {
          userPresets.templates = userPresets.templates.filter(x => x.id !== tpl.id);
          await persistUserPresets();
          renderManagePresetsModal();
        };
        row.querySelector('.ng-preset-actions').append(applyBtn, delBtn);
        tplList.append(row);
      }
    }

    if (!userPresets.branches.length) {
      brList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:8px 0">暂未保存自定义分支（选中节点后点「🌿 保存选中分支」或右键菜单保存）</div>';
    } else {
      for (const br of userPresets.branches) {
        const row = document.createElement('div');
        row.className = 'ng-preset-row';
        row.innerHTML = `<div class="ng-preset-info"><strong></strong><small></small></div><div class="ng-preset-actions"></div>`;
        row.querySelector('strong').textContent = br.name;
        row.querySelector('small').textContent = br.description || `${br.nodes?.length || 0} 个节点`;
        const insBtn = document.createElement('button');
        insBtn.type = 'button';
        insBtn.className = 'ng-btn amber';
        insBtn.textContent = '+ 插入画布';
        insBtn.onclick = () => {
          manageDlg.close();
          const g = currentGraph();
          pushUndo();
          const created = insertBranchPreset(g, br, {autoWire: true});
          selectedNodeIds.clear();
          for (const c of created) selectedNodeIds.add(c.id);
          hooks.changed();
          render();
          hooks.toast(`已插入分支「${br.name}」`);
        };
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ng-btn danger';
        delBtn.textContent = '删除';
        delBtn.onclick = async () => {
          userPresets.branches = userPresets.branches.filter(x => x.id !== br.id);
          await persistUserPresets();
          renderManagePresetsModal();
        };
        row.querySelector('.ng-preset-actions').append(insBtn, delBtn);
        brList.append(row);
      }
    }
  }

  manageDlg.querySelector('#ngCloseManage').onclick = () => manageDlg.close();
  manageDlg.querySelector('#ngCloseManageBtn').onclick = () => manageDlg.close();
  manageDlg.querySelector('#ngExportPresetsBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(userPresets, null, 2)], {type: 'application/json'});
    hooks.download(blob, 'MorphoGem-NodePresets.json');
  };
  manageDlg.querySelector('#ngImportPresetsInput').onchange = async ev => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const merge = (cur, inc) => {
        const m = new Map(cur.map(x => [x.id, x]));
        for (const item of Array.isArray(inc) ? inc : []) {
          if (item?.id && item?.name && Array.isArray(item?.nodes)) m.set(item.id, item);
        }
        return [...m.values()];
      };
      userPresets.templates = merge(userPresets.templates, parsed.templates);
      userPresets.branches = merge(userPresets.branches, parsed.branches);
      await persistUserPresets();
      renderManagePresetsModal();
      hooks.toast('✓ 已成功导入预设库');
    } catch {
      hooks.toast('预设 JSON 格式无效');
    }
  };

  // --- Image Upload Handling ---
  async function handleImageUpload(file, nodeId, viewKey = null) {
    if (!file) return;
    if (isNodeLocked(nodeId)) {
      hooks.toast('🔒 该节点正在执行任务中，已局部锁定，暂时无法替换图片');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 25 * 1024 * 1024) {
      hooks.toast('请选择 25MB 以内的 PNG / JPG / WebP 图片');
      return;
    }
    const raw = new Uint8Array(await file.arrayBuffer());
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const info = await inspectImage(raw, ext);
    const {project: curP, files: curF} = hooks.get();
    const p = structuredClone(curP);
    const f = new Map(curF);
    const g = ensureNodeGraph(p);
    const node = getNode(g, nodeId);
    if (!node) return;

    const doc = await registerGraphDocument(p, f, file.name, raw, node.type);
    const imgMeta = {...doc, mime: info.mime, width: info.width, height: info.height};

    if (viewKey && node.data?.views) {
      node.data.views[viewKey] = imgMeta;
    } else {
      node.data.image = imgMeta;
      if (node.type === 'source_image') {
        const stem = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 80);
        if (stem && !/^(image|img|photo|pic|download|unnamed|untitled|screenshot|\d+)$/i.test(stem) && DEFAULT_PROJ_NAMES.has((p.name || '').trim())) {
          p.name = stem;
        }
      }
    }
    pruneUnusedGraphDocuments(p, f);
    validateProject(p);
    await hooks.commit(p, f);
    render();
  }

  function buildNodeBody(g, node) {
    const body = document.createElement('div');
    body.className = 'ng-body';

    if (node.type === 'source_image' || node.type === 'style_ref' || node.type === 'ratio_ref') {
      const drop = document.createElement('div');
      drop.className = 'ng-img-drop';
      const u = fileUrl(node.data?.image);
      if (u) {
        const img = document.createElement('img');
        img.src = u;
        img.alt = node.data.image.filename || '';
        drop.append(img);
      } else {
        const hint = document.createElement('div');
        hint.className = 'ng-drop-hint';
        hint.textContent = node.type === 'source_image'
          ? '点击或拖入主角色 / 物件原画'
          : node.type === 'style_ref'
            ? '点击或拖入画风参考图（不连则用原画画风）'
            : '点击或拖入头身比参考图（不连则默认比例）';
        drop.append(hint);
      }
      drop.onclick = () => {
        pendingUploadTarget = {nodeId: node.id, viewKey: null};
        hiddenImgPicker.click();
      };
      drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = '#60a5fa'; };
      drop.ondragleave = () => { drop.style.borderColor = ''; };
      drop.ondrop = e => {
        e.preventDefault();
        drop.style.borderColor = '';
        const file = e.dataTransfer?.files?.[0];
        if (file) void handleImageUpload(file, node.id, null);
      };
      body.append(drop);

      if (node.type !== 'source_image') {
        const noteField = document.createElement('label');
        noteField.className = 'ng-field';
        noteField.innerHTML = '<span>参考要求说明</span>';
        const inp = document.createElement('input');
        inp.className = 'ng-input';
        inp.value = node.params?.note || '';
        inp.placeholder = '例如：偏二次元赛璐璐上色 / 7.5头身';
        inp.onchange = () => {
          node.params.note = inp.value.trim();
          hooks.changed();
          updateStatusesOnly();
        };
        noteField.append(inp);
        body.append(noteField);
      }
      return body;
    }

    if (node.type === 'part_views' || node.type === 'balance_views') {
      if (node.type === 'part_views') {
        const nameField = document.createElement('label');
        nameField.className = 'ng-field';
        nameField.innerHTML = '<span>拆出部件名称（AI 按此名称拆分）</span>';
        const nameInp = document.createElement('input');
        nameInp.className = 'ng-input part-name-input';
        nameInp.value = node.params?.partName || '';
        nameInp.placeholder = '如：无发裸脸 / 双马尾头发 / 翅膀 / 巨剑';
        nameInp.onchange = () => {
          const val = nameInp.value.trim() || '未命名部件';
          node.params.partName = val;
          for (const e of g.edges.filter(x => x.fromNode === node.id)) {
            const dn = getNode(g, e.toNode);
            if (dn?.type === 'tripo_mesh') dn.params.title = `Tripo · ${val}`;
          }
          hooks.changed();
          render();
        };
        nameField.append(nameInp);
        body.append(nameField);
      }

      const hintField = document.createElement('label');
      hintField.className = 'ng-field';
      hintField.innerHTML = '<span>拆解细节补充（可选）</span>';
      const hintInp = document.createElement('input');
      hintInp.className = 'ng-input';
      hintInp.value = node.params?.promptHint || '';
      hintInp.placeholder = '如：去掉刘海遮挡画全额头 / 对称展开';
      hintInp.onchange = () => {
        node.params.promptHint = hintInp.value.trim();
        hooks.changed();
        updateStatusesOnly();
      };
      hintField.append(hintInp);

      const row = document.createElement('div');
      row.className = 'ng-row2';
      const poseField = document.createElement('label');
      poseField.className = 'ng-field';
      poseField.innerHTML = '<span>姿态标准</span><select><option value="natural">物件/头部自然姿态</option><option value="t">T-Pose 水平展臂</option><option value="a">A-Pose 45°斜展臂</option></select>';
      const poseSel = poseField.querySelector('select');
      poseSel.value = node.params?.pose || 't';
      poseSel.onchange = () => { node.params.pose = poseSel.value; hooks.changed(); updateStatusesOnly(); };

      const resField = document.createElement('label');
      resField.className = 'ng-field';
      resField.innerHTML = '<span>视图分辨率</span><select><option value="1024">1024 px</option><option value="2048">2048 px (2K)</option></select>';
      const resSel = resField.querySelector('select');
      resSel.value = String(node.params?.resolution || 1024);
      resSel.onchange = () => { node.params.resolution = Number(resSel.value); hooks.changed(); updateStatusesOnly(); };

      row.append(poseField, resField);
      body.append(hintField, row);

      const keys = node.type === 'balance_views' ? GRAPH_VIEWS_3 : GRAPH_VIEWS_4;
      const grid = document.createElement('div');
      grid.className = 'ng-views-grid' + (keys.length === 3 ? ' cols-3' : '');
      for (const k of keys) {
        const cell = document.createElement('div');
        cell.className = 'ng-view-cell';
        const doc = node.data?.views?.[k];
        const u = fileUrl(doc);
        if (u) {
          const img = document.createElement('img');
          img.src = u;
          img.alt = k;
          cell.append(img);
        }
        const tag = document.createElement('span');
        tag.textContent = VIEW_LABELS[k] || k;
        cell.append(tag);
        cell.onclick = () => {
          pendingUploadTarget = {nodeId: node.id, viewKey: k};
          if (u) {
            previewDlg.querySelector('#ngPreviewTitle').textContent = `${node.params?.partName || '视图'} · ${VIEW_LABELS[k]}`;
            previewDlg.querySelector('#ngPreviewImg').src = u;
            const repLabel = previewDlg.querySelector('#ngReplaceViewInput')?.closest('label');
            if (repLabel) repLabel.hidden = isNodeLocked(node.id);
            previewDlg.showModal();
          } else {
            if (isNodeLocked(node.id)) {
              hooks.toast('🔒 该节点正在执行任务中，请等待 AI 生成视图完成');
              return;
            }
            hiddenImgPicker.click();
          }
        };
        grid.append(cell);
      }
      body.append(grid);

      const singleReqBtn = document.createElement('button');
      singleReqBtn.type = 'button';
      singleReqBtn.className = 'ng-btn';
      singleReqBtn.style.justifyContent = 'center';
      singleReqBtn.textContent = '仅复制此节点拆图指令';
      singleReqBtn.onclick = () => hooks.requestGraphViews([node.id]);
      body.append(singleReqBtn);
      return body;
    }

    if (node.type === 'tripo_mesh') {
      const qRow = document.createElement('div');
      qRow.className = 'ng-row2';
      const qField = document.createElement('label');
      qField.className = 'ng-field';
      qField.innerHTML = '<span>网格模式</span><select><option value="high">高精度 HD</option><option value="smart">Smart 智能拓扑</option></select>';
      const qSel = qField.querySelector('select');
      qSel.value = node.params.quality || 'high';

      const subField = document.createElement('label');
      subField.className = 'ng-field';
      if (node.params.quality === 'smart') {
        subField.innerHTML = '<span>拓扑形状</span><select><option value="quad">四边面 Quad (≤2.5万)</option><option value="triangle">三角面 Tri (≤5万)</option></select>';
        const sSel = subField.querySelector('select');
        sSel.value = node.params.smartTopology || 'quad';
        sSel.onchange = () => {
          node.params.smartTopology = sSel.value;
          const cap = sSel.value === 'triangle' ? 50000 : 25000;
          if (node.params.polyFaces > cap) node.params.polyFaces = cap;
          hooks.changed();
          render();
        };
      } else {
        subField.innerHTML = '<span>AI 模型</span><select><option value="H3.5">H3.5 (最新旗舰)</option><option value="H3.1">H3.1</option></select>';
        const mSel = subField.querySelector('select');
        mSel.value = node.params.aiModel === 'H3.1' ? 'H3.1' : 'H3.5';
        mSel.onchange = () => { node.params.aiModel = mSel.value; hooks.changed(); updateStatusesOnly(); };
      }

      qSel.onchange = () => {
        node.params.quality = qSel.value;
        if (qSel.value === 'smart') {
          node.params.aiModel = 'P2.0';
          node.params.polyFaces = Math.min(node.params.polyFaces || 20000, node.params.smartTopology === 'triangle' ? 50000 : 25000);
        } else {
          node.params.aiModel = 'H3.5';
          if ((node.params.polyFaces || 0) <= 50000) node.params.polyFaces = 2000000;
        }
        hooks.changed();
        render();
      };
      qRow.append(qField, subField);

      const maxFaces = node.params.quality === 'smart'
        ? (node.params.smartTopology === 'triangle' ? 50000 : 25000)
        : 5000000;
      const polyField = document.createElement('div');
      polyField.className = 'ng-field';
      polyField.innerHTML = `<span>目标面数上限 (500 ~ ${maxFaces.toLocaleString()})</span>`;
      const polyInp = document.createElement('input');
      polyInp.type = 'number';
      polyInp.className = 'ng-input';
      polyInp.min = '500';
      polyInp.max = String(maxFaces);
      polyInp.step = node.params.quality === 'smart' ? '500' : '50000';
      polyInp.value = String(node.params.polyFaces || 2000000);
      polyInp.onchange = () => {
        const v = Math.max(500, Math.min(maxFaces, Math.round(Number(polyInp.value) || 20000)));
        node.params.polyFaces = v;
        polyInp.value = String(v);
        hooks.changed();
        render();
      };
      const presets = node.params.quality === 'smart'
        ? [[5000, '5千'], [15000, '1.5万'], [25000, '2.5万'], ...(node.params.smartTopology === 'triangle' ? [[50000, '5万']] : [])]
        : [[300000, '30万'], [1000000, '100万'], [2000000, '200万'], [3000000, '300万'], [5000000, '500万']];
      const pills = document.createElement('div');
      pills.className = 'ng-pills';
      for (const [val, txt] of presets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ng-pill' + (node.params.polyFaces === val ? ' active' : '');
        b.textContent = txt;
        b.onclick = () => { node.params.polyFaces = val; hooks.changed(); render(); };
        pills.append(b);
      }
      polyField.append(polyInp, pills);

      const tRow = document.createElement('div');
      tRow.className = 'ng-row2';
      const texField = document.createElement('label');
      texField.className = 'ng-field';
      texField.innerHTML = '<span>贴图精度</span><select><option value="4096">4K 标准</option><option value="8192">8K 超清</option></select>';
      const texSel = texField.querySelector('select');
      texSel.value = String(node.params.textureSize || 4096);
      texSel.onchange = () => { node.params.textureSize = Number(texSel.value); hooks.changed(); updateStatusesOnly(); };

      const cntField = document.createElement('label');
      cntField.className = 'ng-field';
      cntField.innerHTML = '<span>生成候选数</span><select><option value="1">1 个</option><option value="2">2 个</option><option value="3">3 个</option><option value="4">4 个</option></select>';
      const cntSel = cntField.querySelector('select');
      cntSel.value = String(node.params.candidateCount || 1);
      cntSel.onchange = () => { node.params.candidateCount = Number(cntSel.value); hooks.changed(); updateStatusesOnly(); };
      tRow.append(texField, cntField);

      const lightLabel = document.createElement('label');
      lightLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:#cbd5e1;cursor:pointer';
      const lightChk = document.createElement('input');
      lightChk.type = 'checkbox';
      lightChk.checked = Boolean(node.params.removeLighting);
      lightChk.onchange = () => { node.params.removeLighting = lightChk.checked; hooks.changed(); updateStatusesOnly(); };
      lightLabel.append(lightChk, document.createTextNode('去除烘焙高光与阴影（适合二次元/MToon）'));

      body.append(qRow, polyField, tRow, lightLabel);

      if (Array.isArray(node.data?.candidates) && node.data.candidates.length > 1) {
        const candRow = document.createElement('div');
        candRow.className = 'ng-pills';
        node.data.candidates.forEach((c, idx) => {
          const b = document.createElement('button');
          b.type = 'button';
          const isSel = (node.data.selectedId || node.data.candidates[0].id) === c.id;
          b.className = 'ng-pill' + (isSel ? ' active' : '');
          b.textContent = `采用候选 ${idx + 1}`;
          b.onclick = () => {
            node.data.selectedId = c.id;
            hooks.changed();
            render();
            hooks.syncViewportMeshes?.();
          };
          candRow.append(b);
        });
        body.append(candRow);
      }

      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'ng-btn emerald';
      runBtn.style.justifyContent = 'center';
      const vEdge = incomingEdges(g, node.id, 'views')[0];
      const pv = vEdge ? getNode(g, vEdge.fromNode) : null;
      const viewsReady = pv && GRAPH_VIEWS_4.every(k => pv.data?.views?.[k]?.sha256);
      const thisTripoBusy = tripoExecutingIds.has(node.id) || isNodeLocked(node.id);
      runBtn.disabled = thisTripoBusy || !viewsReady;
      runBtn.textContent = tripoExecutingIds.has(node.id)
        ? '⏳ Tripo 正在建模中…'
        : node.data?.candidates?.length
          ? '▶ 重新在 Tripo 生成此部件'
          : '▶ 直接在 Tripo 生成此 3D 部件';
      runBtn.onclick = () => void runTripoNodes([node.id]);
      body.append(runBtn);
      return body;
    }

    if (node.type === 'assembly_export') {
      const matField = document.createElement('label');
      matField.className = 'ng-field';
      matField.innerHTML = '<span>最终材质着色模式</span><select><option value="pbr">标准 PBR（通用引擎 / 写实 / 复合）</option><option value="mtoon">二次元 MToon 卡通材质</option></select>';
      const matSel = matField.querySelector('select');
      matSel.value = node.params?.materialMode || 'pbr';
      matSel.onchange = () => { node.params.materialMode = matSel.value; hooks.changed(); updateStatusesOnly(); };
      body.append(matField);

      const connected = connectedAssemblyMeshes(g, node.id);
      const list = document.createElement('div');
      list.className = 'ng-part-list';
      if (!connected.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#64748b;font-size:11.5px;padding:6px 0';
        empty.textContent = '暂无已生成的 3D 部件接入（左侧建模节点完成后将自动汇入）';
        list.append(empty);
      } else {
        for (const item of connected) {
          const row = document.createElement('div');
          row.className = 'ng-part-item';
          row.innerHTML = `<span>✓ ${item.partLabel.replace(/</g, '&lt;')}</span><small style="color:#86efac">已接入</small>`;
          list.append(row);
        }
      }
      body.append(list);

      const btn3d = document.createElement('button');
      btn3d.type = 'button';
      btn3d.className = 'ng-btn primary';
      btn3d.style.justifyContent = 'center';
      btn3d.textContent = '🧍 打开 3D 视口调整各部件比例与位置';
      btn3d.onclick = () => setWorkspaceMode('viewport');

      const btnExp = document.createElement('button');
      btnExp.type = 'button';
      btnExp.className = 'ng-btn emerald';
      btnExp.style.justifyContent = 'center';
      btnExp.disabled = connected.length === 0;
      btnExp.textContent = '📦 合并导出最终模型 (FBX / GLB / Blend)';
      btnExp.onclick = () => hooks.exportGraphAssets(node.id);

      body.append(btn3d, btnExp);
      return body;
    }

    return body;
  }

  function updateStatusesOnly() {
    const g = currentGraph();
    for (const n of g.nodes) {
      const card = nodesLayer.querySelector(`.ng-node[data-node-id="${n.id}"]`);
      if (!card) continue;
      const st = nodeStatus(g, n.id);
      const pill = card.querySelector('.ng-status-pill');
      if (pill) {
        pill.dataset.state = st.state;
        const txt = pill.querySelector('.ng-status-text');
        if (txt) txt.textContent = st.label;
      }
    }
  }

  function render() {
    const g = currentGraph();
    refreshTemplateSelect();
    applyWorldTransform();
    nodesLayer.replaceChildren();

    for (const node of g.nodes) {
      const spec = NODE_SPECS[node.type];
      if (!spec) continue;
      const nodeLocked = isNodeLocked(node.id);
      const card = document.createElement('div');
      card.className = 'ng-node' + (selectedNodeIds.has(node.id) ? ' selected' : '') + (nodeLocked ? ' locked' : '');
      card.dataset.nodeId = node.id;
      card.dataset.type = node.type;
      card.dataset.category = spec.category;
      card.style.left = `${node.x}px`;
      card.style.top = `${node.y}px`;

      card.onpointerdown = ev => {
        if (ev.button === 2) return; // handled by right-click logic
        const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        if (additive) {
          if (selectedNodeIds.has(node.id)) selectedNodeIds.delete(node.id);
          else selectedNodeIds.add(node.id);
          updateSelectionVisuals();
        } else if (!selectedNodeIds.has(node.id)) {
          setSingleSelection(node.id);
        }
        // Blur any active text input if user clicked outside inputs/selects on the card
        if (!ev.target.closest('input, textarea, select')) {
          if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur?.();
          }
        }
      };

      const head = document.createElement('div');
      head.className = 'ng-node-head';
      const titleText = node.type === 'part_views'
        ? `拆件：${node.params?.partName || '未命名'}`
        : (node.params?.title || spec.defaultTitle);
      const badgeText = node.params?.modBadge || spec.badge;
      head.innerHTML = `<span class="ng-badge${node.params?.modId ? ' mod-badge' : ''}"></span><span class="ng-head-title"></span>`;
      head.querySelector('.ng-badge').textContent = badgeText;
      head.querySelector('.ng-head-title').textContent = titleText;

      if (nodeLocked) {
        const lockTag = document.createElement('span');
        lockTag.className = 'ng-lock-pill';
        lockTag.title = '该节点关联正在执行的任务，已局部锁定保护；其余节点仍可自由编辑';
        lockTag.textContent = '🔒 锁定';
        head.append(lockTag);
      } else if (!(node.type === 'assembly_export' && g.nodes.filter(x => x.type === 'assembly_export').length <= 1)) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ng-del-btn';
        del.title = '删除此节点 (Del / X)';
        del.textContent = '×';
        del.onclick = ev => {
          ev.stopPropagation();
          deleteNodesByIds([node.id]);
        };
        head.append(del);
      }

      head.onpointerdown = ev => {
        if (ev.button !== 0 || ev.target.closest('button')) return;
        ev.stopPropagation();
        closeQuickMenu();
        closeCtxMenu();
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur?.();
        }
        const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        if (additive) {
          if (selectedNodeIds.has(node.id)) selectedNodeIds.delete(node.id);
          else selectedNodeIds.add(node.id);
          updateSelectionVisuals();
          return;
        }
        if (!selectedNodeIds.has(node.id)) {
          setSingleSelection(node.id);
        }
        const startWorld = screenToWorld(ev.clientX, ev.clientY);
        const initialPositions = new Map();
        for (const sid of selectedNodeIds) {
          const sn = getNode(g, sid);
          if (sn) initialPositions.set(sid, {x: sn.x, y: sn.y});
        }
        nodeDrag = {
          startWorldX: startWorld.x,
          startWorldY: startWorld.y,
          moved: false,
          clickedId: node.id,
          initialPositions,
          preSnap: snapshotState(g),
        };
        head.setPointerCapture(ev.pointerId);
      };

      const st = nodeStatus(g, node.id);
      const statusRow = document.createElement('div');
      statusRow.className = 'ng-status-row';
      statusRow.innerHTML = `<span class="ng-status-pill" data-state="${st.state}"><span class="ng-status-dot"></span><span class="ng-status-text"></span></span>`;
      statusRow.querySelector('.ng-status-text').textContent = st.label;

      const portsBar = document.createElement('div');
      portsBar.className = 'ng-ports-bar';
      const inCol = document.createElement('div');
      inCol.className = 'ng-ports-col in';
      for (const inp of spec.inputs) {
        const pEl = document.createElement('div');
        pEl.className = 'ng-port in';
        pEl.dataset.portId = inp.id;
        const dot = document.createElement('span');
        dot.className = 'ng-port-dot in';
        dot.dataset.kind = inp.kind;
        dot.dataset.nodeId = node.id;
        dot.dataset.portId = inp.id;
        dot.title = inp.multi ? '拖入多路连接，或向左拖出自动新建上游节点' : '按住向外拖可拔线重连（Blender式），或向左拖出空白处新建上游节点';
        dot.onpointerdown = ev => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          ev.preventDefault();
          closeQuickMenu();
          closeCtxMenu();
          if (isNodeLocked(node.id)) {
            hooks.toast('🔒 该节点正在执行任务中，输入连线已锁定保护');
            return;
          }
          const w = screenToWorld(ev.clientX, ev.clientY);
          const existing = incomingEdges(g, node.id, inp.id);
          if (existing.length && !inp.multi) {
            // Blender-style unplug existing wire & turn into outgoing drag from its source!
            const oldEdge = existing[0];
            pushUndo();
            disconnectEdge(g, oldEdge.id);
            wireDrag = {
              dir: 'out',
              nodeId: oldEdge.fromNode,
              portId: oldEdge.fromPort,
              kind: inp.kind,
              x: w.x,
              y: w.y,
              startClientX: ev.clientX,
              startClientY: ev.clientY,
              unplugged: true,
            };
            highlightCompatPorts(g, 'out', oldEdge.fromNode, oldEdge.fromPort, inp.kind);
            renderEdges();
          } else {
            wireDrag = {
              dir: 'in',
              nodeId: node.id,
              portId: inp.id,
              kind: inp.kind,
              x: w.x,
              y: w.y,
              startClientX: ev.clientX,
              startClientY: ev.clientY,
            };
            highlightCompatPorts(g, 'in', node.id, inp.id, inp.kind);
            renderEdges();
          }
        };
        const lbl = document.createElement('span');
        lbl.textContent = inp.label;
        pEl.append(dot, lbl);
        inCol.append(pEl);
      }

      const outCol = document.createElement('div');
      outCol.className = 'ng-ports-col out';
      for (const out of spec.outputs) {
        const pEl = document.createElement('div');
        pEl.className = 'ng-port out';
        pEl.dataset.portId = out.id;
        const lbl = document.createElement('span');
        lbl.textContent = out.label;
        const dot = document.createElement('span');
        dot.className = 'ng-port-dot out';
        dot.dataset.kind = out.kind;
        dot.dataset.nodeId = node.id;
        dot.dataset.portId = out.id;
        dot.title = '向右拖向输入端口连接，或拖到空白处松手自动弹出匹配节点菜单';
        dot.onpointerdown = ev => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          ev.preventDefault();
          closeQuickMenu();
          closeCtxMenu();
          const w = screenToWorld(ev.clientX, ev.clientY);
          wireDrag = {
            dir: 'out',
            nodeId: node.id,
            portId: out.id,
            kind: out.kind,
            x: w.x,
            y: w.y,
            startClientX: ev.clientX,
            startClientY: ev.clientY,
          };
          highlightCompatPorts(g, 'out', node.id, out.id, out.kind);
          renderEdges();
        };
        pEl.append(lbl, dot);
        outCol.append(pEl);
      }
      portsBar.append(inCol, outCol);

      const nodeBody = buildNodeBody(g, node);
      if (nodeLocked) {
        for (const ctrl of nodeBody.querySelectorAll('input, select, textarea, button')) {
          ctrl.disabled = true;
        }
        for (const dropZone of nodeBody.querySelectorAll('.ng-img-drop')) {
          dropZone.onclick = () => hooks.toast('🔒 该节点关联正在执行的任务，暂时无法更换参考图');
        }
      }
      card.append(head, statusRow, portsBar, nodeBody);
      nodesLayer.append(card);
    }

    syncToolbarButtons();
    requestAnimationFrame(() => renderEdges());
  }

  function highlightCompatPorts(g, dragDir, nodeId, portId) {
    if (dragDir === 'out') {
      for (const inDot of nodesLayer.querySelectorAll('.ng-port-dot.in')) {
        const ok = canConnectPorts(g, nodeId, portId, inDot.dataset.nodeId, inDot.dataset.portId).ok;
        inDot.classList.toggle('compat', ok);
      }
    } else {
      for (const outDot of nodesLayer.querySelectorAll('.ng-port-dot.out')) {
        const ok = canConnectPorts(g, outDot.dataset.nodeId, outDot.dataset.portId, nodeId, portId).ok;
        outDot.classList.toggle('compat', ok);
      }
    }
  }

  function clearPortHighlights() {
    for (const d of nodesLayer.querySelectorAll('.ng-port-dot')) d.classList.remove('compat');
  }

  // --- Stage Pointer Events (Pan, Box Select, Knife Cut, Context Menu, Double-Click Quick Add) ---
  stageEl.addEventListener('contextmenu', ev => {
    ev.preventDefault();
  });

  stageEl.addEventListener('dblclick', ev => {
    if (ev.target === stageEl || ev.target === worldEl || ev.target === svgEl) {
      openQuickMenu(ev.clientX, ev.clientY);
    }
  });

  stageEl.addEventListener('pointerdown', ev => {
    lastMouseClient = {x: ev.clientX, y: ev.clientY};

    // If Grab mode is active: Left click commits, Right click cancels!
    if (grabState) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.button === 0) commitGrabMove();
      else cancelGrabMove();
      return;
    }

    // Close floating menus if clicking outside them
    if (!ev.target.closest('#ngQuickMenu')) closeQuickMenu();
    if (!ev.target.closest('#ngCtxMenu')) closeCtxMenu();

    // Right button: track for either Knife Cut (Ctrl+Right), Pan, or Context Menu on release
    if (ev.button === 2) {
      if (ev.ctrlKey) {
        const w = screenToWorld(ev.clientX, ev.clientY);
        knifeDrag = {pointsWorld: [[w.x, w.y]], cutEdgeIds: new Set()};
        stageEl.classList.add('knife-mode');
        return;
      }
      const card = ev.target.closest('.ng-node');
      rightClickTrack = {startX: ev.clientX, startY: ev.clientY, nodeId: card?.dataset?.nodeId || null, panned: false};
      const vp = currentGraph().viewport;
      panDrag = {startX: ev.clientX, startY: ev.clientY, origX: vp.panX, origY: vp.panY, isRightBtn: true};
      return;
    }

    // Middle mouse button: always Pan (Blender standard!)
    if (ev.button === 1) {
      ev.preventDefault();
      const vp = currentGraph().viewport;
      panDrag = {startX: ev.clientX, startY: ev.clientY, origX: vp.panX, origY: vp.panY};
      stageEl.classList.add('panning');
      return;
    }

    if (ev.button !== 0) return;

    // Alt + Left Drag anywhere on stage: Knife Wire Cutter!
    if (ev.altKey && !ev.target.closest('input, select, button')) {
      ev.preventDefault();
      const w = screenToWorld(ev.clientX, ev.clientY);
      knifeDrag = {pointsWorld: [[w.x, w.y]], cutEdgeIds: new Set()};
      stageEl.classList.add('knife-mode');
      return;
    }

    const isEmptyCanvas = (ev.target === stageEl || ev.target === worldEl || ev.target === svgEl);
    if (!isEmptyCanvas) return;

    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur?.();
    }

    // Box Marquee Selection: Shift + Left Drag OR armed via 'B' key
    if (ev.shiftKey || boxSelectArmed) {
      boxSelectArmed = false;
      stageEl.classList.remove('box-mode');
      footerHintEl.textContent = DEFAULT_FOOTER;
      boxSelectDrag = {
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        curClientX: ev.clientX,
        curClientY: ev.clientY,
        additive: ev.shiftKey,
      };
      updateBoxSelectVisual();
      return;
    }

    // Plain Left Click / Drag on empty canvas: Pan (and clear selection if clicked without dragging)
    const vp = currentGraph().viewport;
    panDrag = {startX: ev.clientX, startY: ev.clientY, origX: vp.panX, origY: vp.panY, clearSelOnClick: true, moved: false};
    stageEl.classList.add('panning');
  });

  function updateBoxSelectVisual() {
    if (!boxSelectDrag) {
      boxSelectEl.hidden = true;
      return;
    }
    const sr = stageEl.getBoundingClientRect();
    const x1 = Math.min(boxSelectDrag.startClientX, boxSelectDrag.curClientX) - sr.left;
    const y1 = Math.min(boxSelectDrag.startClientY, boxSelectDrag.curClientY) - sr.top;
    const w = Math.abs(boxSelectDrag.curClientX - boxSelectDrag.startClientX);
    const h = Math.abs(boxSelectDrag.curClientY - boxSelectDrag.startClientY);
    boxSelectEl.hidden = false;
    boxSelectEl.style.left = `${x1}px`;
    boxSelectEl.style.top = `${y1}px`;
    boxSelectEl.style.width = `${w}px`;
    boxSelectEl.style.height = `${h}px`;
  }

  window.addEventListener('pointermove', ev => {
    lastMouseClient = {x: ev.clientX, y: ev.clientY};

    if (grabState) {
      const g = currentGraph();
      const w = screenToWorld(ev.clientX, ev.clientY);
      const dx = Math.round(w.x - grabState.startWorldX);
      const dy = Math.round(w.y - grabState.startWorldY);
      for (const [id, orig] of grabState.initialPositions) {
        const n = getNode(g, id);
        if (!n) continue;
        n.x = orig.x + dx;
        n.y = orig.y + dy;
        const card = nodesLayer.querySelector(`.ng-node[data-node-id="${id}"]`);
        if (card) {
          card.style.left = `${n.x}px`;
          card.style.top = `${n.y}px`;
        }
      }
      renderEdges();
      return;
    }

    if (knifeDrag) {
      const w = screenToWorld(ev.clientX, ev.clientY);
      const last = knifeDrag.pointsWorld[knifeDrag.pointsWorld.length - 1];
      if (!last || Math.hypot(w.x - last[0], w.y - last[1]) > 4) {
        knifeDrag.pointsWorld.push([w.x, w.y]);
      }
      const g = currentGraph();
      knifeDrag.cutEdgeIds.clear();
      for (const e of g.edges) {
        if (isEdgeLocked(e)) continue;
        const p1 = portCenterInWorld(e.fromNode, 'out', e.fromPort);
        const p2 = portCenterInWorld(e.toNode, 'in', e.toPort);
        if (p1 && p2 && polylineIntersectsBezier(knifeDrag.pointsWorld, p1.x, p1.y, p2.x, p2.y)) {
          knifeDrag.cutEdgeIds.add(e.id);
        }
      }
      renderEdges();
      return;
    }

    if (boxSelectDrag) {
      boxSelectDrag.curClientX = ev.clientX;
      boxSelectDrag.curClientY = ev.clientY;
      updateBoxSelectVisual();
      return;
    }

    if (panDrag) {
      const dist = Math.hypot(ev.clientX - panDrag.startX, ev.clientY - panDrag.startY);
      if (dist > 4) {
        panDrag.moved = true;
        if (rightClickTrack) rightClickTrack.panned = true;
        stageEl.classList.add('panning');
      }
      if (panDrag.moved || !panDrag.isRightBtn) {
        const vp = currentGraph().viewport;
        vp.panX = Math.round(panDrag.origX + (ev.clientX - panDrag.startX));
        vp.panY = Math.round(panDrag.origY + (ev.clientY - panDrag.startY));
        applyWorldTransform();
      }
      return;
    }

    if (nodeDrag) {
      const g = currentGraph();
      const w = screenToWorld(ev.clientX, ev.clientY);
      const dx = Math.round(w.x - nodeDrag.startWorldX);
      const dy = Math.round(w.y - nodeDrag.startWorldY);
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) nodeDrag.moved = true;
      for (const [id, orig] of nodeDrag.initialPositions) {
        const n = getNode(g, id);
        if (!n) continue;
        n.x = orig.x + dx;
        n.y = orig.y + dy;
        const card = nodesLayer.querySelector(`.ng-node[data-node-id="${id}"]`);
        if (card) {
          card.style.left = `${n.x}px`;
          card.style.top = `${n.y}px`;
        }
      }
      renderEdges();
      return;
    }

    if (wireDrag) {
      const w = screenToWorld(ev.clientX, ev.clientY);
      wireDrag.x = w.x;
      wireDrag.y = w.y;
      renderEdges();
    }
  });

  window.addEventListener('pointerup', ev => {
    if (knifeDrag) {
      const toCut = [...knifeDrag.cutEdgeIds];
      knifeDrag = null;
      stageEl.classList.remove('knife-mode');
      if (toCut.length) {
        const g = currentGraph();
        pushUndo();
        for (const eid of toCut) disconnectEdge(g, eid);
        hooks.changed();
        hooks.toast(`✂ 已划断 ${toCut.length} 条连线`);
      }
      render();
      return;
    }

    if (boxSelectDrag) {
      const minX = Math.min(boxSelectDrag.startClientX, boxSelectDrag.curClientX);
      const maxX = Math.max(boxSelectDrag.startClientX, boxSelectDrag.curClientX);
      const minY = Math.min(boxSelectDrag.startClientY, boxSelectDrag.curClientY);
      const maxY = Math.max(boxSelectDrag.startClientY, boxSelectDrag.curClientY);
      if (!boxSelectDrag.additive) selectedNodeIds.clear();
      if (maxX - minX > 4 || maxY - minY > 4) {
        for (const card of nodesLayer.querySelectorAll('.ng-node')) {
          const r = card.getBoundingClientRect();
          const intersects = !(r.right < minX || r.left > maxX || r.bottom < minY || r.top > maxY);
          if (intersects) selectedNodeIds.add(card.dataset.nodeId);
        }
      }
      boxSelectDrag = null;
      updateBoxSelectVisual();
      updateSelectionVisuals();
      return;
    }

    if (panDrag) {
      const wasClickEmpty = panDrag.clearSelOnClick && !panDrag.moved;
      panDrag = null;
      stageEl.classList.remove('panning');
      if (wasClickEmpty && selectedNodeIds.size) {
        selectedNodeIds.clear();
        updateSelectionVisuals();
      }
    }

    if (rightClickTrack) {
      const rc = rightClickTrack;
      rightClickTrack = null;
      if (!rc.panned) {
        if (rc.nodeId) openCtxMenu(ev.clientX, ev.clientY, rc.nodeId);
        else openQuickMenu(ev.clientX, ev.clientY);
      }
      return;
    }

    if (nodeDrag) {
      if (nodeDrag.moved) {
        undoStack.push(nodeDrag.preSnap);
        if (undoStack.length > 40) undoStack.shift();
        redoStack.length = 0;
        syncToolbarButtons();
        hooks.changed();
      } else if (selectedNodeIds.size > 1) {
        setSingleSelection(nodeDrag.clickedId);
      }
      nodeDrag = null;
    }

    if (wireDrag) {
      const wd = wireDrag;
      wireDrag = null;
      clearPortHighlights();
      const targetSelector = wd.dir === 'out' ? '.ng-port-dot.in' : '.ng-port-dot.out';
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(targetSelector);
      const g = currentGraph();

      if (hit) {
        const destNodeId = wd.dir === 'out' ? hit.dataset.nodeId : wd.nodeId;
        if (isNodeLocked(destNodeId)) {
          hooks.toast('🔒 目标节点正在执行任务中，暂时无法改接输入连线');
          render();
          return;
        }
        try {
          if (!wd.unplugged) pushUndo();
          if (wd.dir === 'out') {
            connectPorts(g, wd.nodeId, wd.portId, hit.dataset.nodeId, hit.dataset.portId);
          } else {
            connectPorts(g, hit.dataset.nodeId, hit.dataset.portId, wd.nodeId, wd.portId);
          }
          hooks.changed();
          render();
          return;
        } catch (err) {
          hooks.toast(err.message);
        }
      } else {
        // Released in empty space! If dragged purposefully (> 22px) and wasn't just unplugging to drop, pop Quick-Add Menu!
        const dist = Math.hypot(ev.clientX - wd.startClientX, ev.clientY - wd.startClientY);
        if (wd.unplugged) {
          hooks.changed();
          render();
          if (dist > 60) {
            openQuickMenu(ev.clientX, ev.clientY, {wireFrom: {dir: wd.dir, nodeId: wd.nodeId, portId: wd.portId, kind: wd.kind}});
          }
          return;
        }
        if (dist > 22) {
          render();
          openQuickMenu(ev.clientX, ev.clientY, {wireFrom: {dir: wd.dir, nodeId: wd.nodeId, portId: wd.portId, kind: wd.kind}});
          return;
        }
      }
      render();
    }
  });

  // --- Global Keyboard Shortcuts (Space, Shift+A, Delete/Backspace/X, Shift+D, G, B, A, F, Ctrl+Z/Y) ---
  window.addEventListener('keydown', ev => {
    if (activeMode !== 'canvas') return;
    if (document.querySelector('dialog[open]')) return;

    const activeTag = document.activeElement?.tagName?.toLowerCase() || '';
    const isTyping = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || document.activeElement?.isContentEditable;

    if (isTyping) {
      if (ev.key === 'Escape' && document.activeElement !== quickSearchEl) {
        document.activeElement.blur?.();
      }
      return;
    }

    // Grab mode keyboard handling
    if (grabState) {
      if (ev.key === 'Escape') { ev.preventDefault(); cancelGrabMove(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); commitGrabMove(); }
      return;
    }

    // Escape closes menus / disarms box select / clears selection
    if (ev.key === 'Escape') {
      if (!quickMenuEl.hidden) { closeQuickMenu(); return; }
      if (!ctxMenuEl.hidden) { closeCtxMenu(); return; }
      if (boxSelectArmed) {
        boxSelectArmed = false;
        stageEl.classList.remove('box-mode');
        footerHintEl.textContent = DEFAULT_FOOTER;
        return;
      }
      if (selectedNodeIds.size) {
        selectedNodeIds.clear();
        updateSelectionVisuals();
      }
      return;
    }

    // Undo / Redo: Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) redo();
      else undo();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      redo();
      return;
    }

    // Space OR Shift+A: Open Floating Quick-Add Node & Branch Search Menu!
    if (ev.code === 'Space' || (ev.shiftKey && ev.key.toLowerCase() === 'a')) {
      ev.preventDefault();
      openQuickMenu(lastMouseClient.x, lastMouseClient.y);
      return;
    }

    // Delete / Backspace / X (Blender delete): Delete selected nodes!
    if (ev.key === 'Delete' || ev.key === 'Backspace' || (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.toLowerCase() === 'x')) {
      if (selectedNodeIds.size) {
        ev.preventDefault();
        deleteNodesByIds([...selectedNodeIds]);
      }
      return;
    }

    // Shift+D or Ctrl+D: Clone selected nodes / branch!
    if ((ev.shiftKey || ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
      ev.preventDefault();
      cloneSelectedNodes({startGrab: ev.shiftKey});
      return;
    }

    // G (Blender Grab): Free-move selected nodes!
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.toLowerCase() === 'g') {
      if (selectedNodeIds.size) {
        ev.preventDefault();
        beginGrabMove(lastMouseClient.x, lastMouseClient.y);
      }
      return;
    }

    // B (Blender Box Select): Arm marquee box select!
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.toLowerCase() === 'b') {
      ev.preventDefault();
      boxSelectArmed = !boxSelectArmed;
      stageEl.classList.toggle('box-mode', boxSelectArmed);
      footerHintEl.textContent = boxSelectArmed
        ? '框选已就绪：请在画布拖出矩形框选多个节点（Esc 取消）'
        : DEFAULT_FOOTER;
      return;
    }

    // A / Alt+A (Blender Select All / Deselect All)
    if (!ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      const g = currentGraph();
      if (ev.altKey) {
        selectedNodeIds.clear();
      } else {
        for (const n of g.nodes) selectedNodeIds.add(n.id);
      }
      updateSelectionVisuals();
      return;
    }

    // F / Home / . : Focus selected or Fit all
    if (!ev.ctrlKey && !ev.metaKey && (ev.key.toLowerCase() === 'f' || ev.key === 'Home' || ev.key === '.')) {
      ev.preventDefault();
      fitCanvas(ev.key === 'Home' ? false : selectedNodeIds.size > 0);
    }
  });

  stageEl.addEventListener('wheel', ev => {
    if (ev.target.closest('.ng-part-list, .ng-quick-list, select')) return;
    ev.preventDefault();
    const g = currentGraph();
    const vp = g.viewport;
    const rect = stageEl.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const prevZoom = vp.zoom || 1;
    const factor = ev.deltaY < 0 ? 1.09 : 0.91;
    const nextZoom = Math.max(0.35, Math.min(1.65, prevZoom * factor));
    vp.panX = Math.round(mx - ((mx - vp.panX) / prevZoom) * nextZoom);
    vp.panY = Math.round(my - ((my - vp.panY) / prevZoom) * nextZoom);
    vp.zoom = Number(nextZoom.toFixed(3));
    applyWorldTransform();
    renderEdges();
  }, {passive: false});

  function fitCanvas(selectedOnly = false) {
    const g = currentGraph();
    const pool = (selectedOnly && selectedNodeIds.size)
      ? g.nodes.filter(n => selectedNodeIds.has(n.id))
      : g.nodes;
    if (!pool.length) return;
    const rect = stageEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const minX = Math.min(...pool.map(n => n.x)) - 50;
    const minY = Math.min(...pool.map(n => n.y)) - 50;
    const maxX = Math.max(...pool.map(n => n.x + 340)) + 50;
    const maxY = Math.max(...pool.map(n => n.y + 320)) + 50;
    const bw = Math.max(400, maxX - minX);
    const bh = Math.max(300, maxY - minY);
    const zoom = Math.max(0.38, Math.min(1.08, Math.min(rect.width / bw, rect.height / bh)));
    g.viewport = {
      zoom: Number(zoom.toFixed(3)),
      panX: Math.round((rect.width - bw * zoom) / 2 - minX * zoom),
      panY: Math.round((rect.height - bh * zoom) / 2 - minY * zoom),
    };
    applyWorldTransform();
    renderEdges();
  }

  function recomputeTripoLocks() {
    tripoLockedIds.clear();
    const g = currentGraph();
    for (const tid of tripoExecutingIds) {
      tripoLockedIds.add(tid);
      for (const ie of incomingEdges(g, tid)) {
        tripoLockedIds.add(ie.fromNode);
      }
    }
  }

  async function runTripoNodes(nodeIds) {
    const queue = nodeIds.filter(id => !tripoExecutingIds.has(id) && !isNodeLocked(id));
    if (!queue.length) return;
    for (const id of queue) tripoExecutingIds.add(id);
    recomputeTripoLocks();
    render();
    try {
      await hooks.executeTripoNodes(queue, (nodeId, statusMsg) => {
        const g = currentGraph();
        const n = getNode(g, nodeId);
        if (n) n.data.runtimeStatus = statusMsg;
        updateStatusesOnly();
        syncExecBanner();
      });
    } finally {
      const g = currentGraph();
      for (const id of queue) {
        tripoExecutingIds.delete(id);
        const n = getNode(g, id);
        if (n) n.data.runtimeStatus = '';
      }
      recomputeTripoLocks();
      render();
    }
  }

  async function applyTemplateByKey(presetKey) {
    if (hasAnyLockedNode()) {
      hooks.toast('🔒 当前有正在执行或等待拆图的锁定节点，请等待完成或先取消锁定后再整图套用模板');
      return;
    }
    const g = currentGraph();
    const hasWork = g.nodes.some(n => (n.data?.candidates?.length > 0) || (n.data?.views && Object.values(n.data.views).some(Boolean)));
    if (hasWork && !confirm('切换模板将重置当前画布的拆件节点与模型（已上传的主立绘/参考图会自动保留）。是否继续？')) return;
    const oldSrc = g.nodes.find(n => n.type === 'source_image')?.data?.image || null;
    const oldStyle = g.nodes.find(n => n.type === 'style_ref')?.data?.image || null;
    const oldRatio = g.nodes.find(n => n.type === 'ratio_ref')?.data?.image || null;
    const {project: curP, files: curF} = hooks.get();
    const p = structuredClone(curP);
    const f = new Map(curF);

    if (String(presetKey).startsWith('mod:')) {
      let matchedMod = null;
      let matchedTpl = null;
      for (const mod of (globalThis.__morphogemLoadedMods || []).filter(m => m.enabled)) {
        const found = (mod.templates || []).find(t => t.id === presetKey);
        if (found) { matchedMod = mod; matchedTpl = found; break; }
      }
      if (!matchedTpl) {
        hooks.toast('未找到该 Mod 模板（对应 Mod 可能已禁用）');
        return;
      }
      p.nodeGraph = instantiateGraphFromTemplate(matchedTpl);
      p.nodeGraph.preset = presetKey;
      p.nodeGraph.modMeta = {
        id: matchedMod.id,
        name: matchedMod.name,
        author: matchedMod.author,
        promptRules: matchedTpl.promptRules || matchedMod.promptRules || '',
      };
    } else if (String(presetKey).startsWith('custom:')) {
      const tplId = presetKey.slice(7);
      const found = userPresets.templates.find(t => t.id === tplId);
      if (!found) {
        hooks.toast('未找到该自定义模板');
        return;
      }
      p.nodeGraph = instantiateGraphFromTemplate(found);
      p.nodeGraph.preset = presetKey;
      delete p.nodeGraph.modMeta;
    } else {
      p.nodeGraph = createTemplateGraph(presetKey);
      delete p.nodeGraph.modMeta;
    }

    if (oldSrc) { const s = p.nodeGraph.nodes.find(n => n.type === 'source_image'); if (s) s.data.image = oldSrc; }
    if (oldStyle) { const s = p.nodeGraph.nodes.find(n => n.type === 'style_ref'); if (s) s.data.image = oldStyle; }
    if (oldRatio) { const s = p.nodeGraph.nodes.find(n => n.type === 'ratio_ref'); if (s) s.data.image = oldRatio; }
    pruneUnusedGraphDocuments(p, f);
    selectedNodeIds.clear();
    undoStack.length = 0;
    redoStack.length = 0;
    await hooks.commit(p, f);
    render();
    fitCanvas(false);
  }

  // --- Toolbar Bindings ---
  $('#ngApplyTemplate').onclick = () => void applyTemplateByKey($('#ngTemplateSelect').value);
  $('#ngSaveTemplate').onclick = () => openSavePresetDialog('template');
  $('#ngSaveBranch').onclick = () => openSavePresetDialog('branch');
  $('#ngManagePresets').onclick = () => {
    renderManagePresetsModal();
    manageDlg.showModal();
  };
  $('#ngQuickAddBtn').onclick = ev => {
    const r = ev.currentTarget.getBoundingClientRect();
    openQuickMenu(r.left, r.bottom + 6, {spawnAtStageCenter: true});
  };
  $('#ngUndoBtn').onclick = undo;
  $('#ngRedoBtn').onclick = redo;
  $('#ngDeleteSelected').onclick = () => deleteNodesByIds([...selectedNodeIds]);
  $('#ngFitCanvas').onclick = () => fitCanvas(selectedNodeIds.size > 0);
  $('#ngRequestViews').onclick = () => hooks.requestGraphViews(null);
  $('#ngExecViewPrompt').onclick = () => hooks.session?.()?.reopenPromptDialog?.();
  $('#ngExecCancel').onclick = () => hooks.session?.()?.cancelActiveRequest?.();
  window.addEventListener('morphogem-lock-change', () => render());
  window.addEventListener('morphogem-switch-workspace', ev => {
    if (ev.detail) setWorkspaceMode(ev.detail);
  });
  $('#ngRunAllTripo').onclick = () => {
    const g = currentGraph();
    const readyIds = g.nodes
      .filter(n => n.type === 'tripo_mesh' && nodeStatus(g, n.id).state === 'dirty')
      .map(n => n.id);
    if (!readyIds.length) {
      hooks.toast('当前没有待生成的 Tripo 3D 节点（请先完成上游四视图拆图，或修改建模参数后再运行）');
      return;
    }
    void runTripoNodes(readyIds);
  };
  const open3DBtn = $('#ngOpen3D');
  if (open3DBtn) open3DBtn.onclick = () => setWorkspaceMode('viewport');

  hiddenImgPicker.onchange = e => {
    const file = e.target.files?.[0];
    hiddenImgPicker.value = '';
    if (file && pendingUploadTarget) {
      void handleImageUpload(file, pendingUploadTarget.nodeId, pendingUploadTarget.viewKey);
    }
  };

  previewDlg.querySelector('#ngReplaceViewInput').onchange = e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && pendingUploadTarget) {
      previewDlg.close();
      void handleImageUpload(file, pendingUploadTarget.nodeId, pendingUploadTarget.viewKey);
    }
  };

  function setWorkspaceMode(mode) {
    activeMode = mode === 'viewport' ? 'viewport' : 'canvas';
    const g = currentGraph();
    g.activeWorkspace = activeMode;
    document.body.classList.toggle('node-graph-active', activeMode === 'canvas');
    for (const b of modeBar.querySelectorAll('.workspace-mode-btn')) {
      b.classList.toggle('active', b.dataset.wsMode === activeMode);
    }
    if (activeMode === 'canvas') {
      render();
    } else {
      closeQuickMenu();
      closeCtxMenu();
      hooks.onEnterViewport?.();
    }
  }

  modeBar.onclick = ev => {
    const b = ev.target.closest('.workspace-mode-btn');
    if (b) setWorkspaceMode(b.dataset.wsMode);
  };

  const modUI = initModAndSystemUI({
    getProject: () => hooks.get().project,
    getSelectedNodeIds: () => [...selectedNodeIds],
    download: (blob, filename) => hooks.download?.(blob, filename),
    toast: msg => hooks.toast(msg),
    onModsUpdated: () => {
      refreshTemplateSelect();
      render();
    },
  });

  $('#ngModsBtn').onclick = () => modUI.openDialog('installed');

  stageEl.addEventListener('dragover', ev => {
    if ([...(ev.dataTransfer?.items || [])].some(i => i.kind === 'file')) {
      ev.preventDefault();
    }
  });
  stageEl.addEventListener('drop', ev => {
    const f = ev.dataTransfer?.files?.[0];
    if (f && /\.mgmod$/i.test(f.name)) {
      ev.preventDefault();
      ev.stopPropagation();
      void modUI.importMgmodFile(f);
    }
  });

  void loadUserPresets();
  setWorkspaceMode('canvas');

  return {
    render,
    clearBlobUrls,
    fitCanvas: () => fitCanvas(false),
    setWorkspaceMode,
    getWorkspaceMode: () => activeMode,
  };
}
