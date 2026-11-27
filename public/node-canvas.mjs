import {
  NODE_SPECS,
  GRAPH_VIEWS_4,
  GRAPH_VIEWS_3,
  HEAD_BODY_RATIO_PRESETS,
  PROPORTION_ARCHETYPES,
  createProportionSpecFromArchetype,
  normalizeProportionSpec,
  ensureGraphProportionSpec,
  resolveNumericHeadBodyRatio,
  BUILTIN_BRANCH_PRESETS,
  ensureNodeGraph,
  createNode,
  isMeshNodeType,
  resolveUpstreamViewsNode,
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
import {
  formatProportionSummary,
  renderProportionMannequinRgba,
  drawProportionMannequinToCanvas,
} from './proportion-mannequin.mjs';
import {
  analyzeMaskColorBlocks,
  compositeMaskHighlightRgba,
  friendlyColorName,
  hexToRgb,
} from './mask-color-analyzer.mjs';
import {tr, onLocaleChange, isEn} from './i18n.mjs';

const KIND_COLORS = {
  image: '#38bdf8',
  mask: '#f43f5e',
  style: '#c084fc',
  ratio: '#2dd4bf',
  views: '#fbbf24',
  mesh: '#34d399',
  guide: '#818cf8',
};

const KIND_LABELS = {
  image: '主设计图',
  mask: 'Mask 遮罩',
  style: '画风参考',
  ratio: '头身比参考',
  views: '四方向视图',
  mesh: '部件 3D 网格',
  guide: '三视图参考尺',
};

const VIEW_LABELS = {front: '正', left: '左', right: '右', back: '背', side: '右'};
const VIEW_FULL_LABELS = {
  front: ['正面 Front (0°)', 'Front (0°)'],
  left: ['左侧面 Left (<--)', 'Left Profile (<--)'],
  right: ['右侧面 Right (-->)', 'Right Profile (-->)'],
  side: ['右侧面 Side (-->)', 'Right Profile (-->)'],
  back: ['背面 Back (180°)', 'Back (180°)'],
};
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
        <button type="button" id="ngApplyTemplate" class="ng-btn" title="重置套用左侧选中的模板（保留已上传的主立绘与参考图）">↻ 重置</button>
        <button type="button" id="ngSaveTemplate" class="ng-btn violet" title="将当前画布的完整节点布局与参数保存为自定义模板">💾 存为模板</button>
        <span class="ng-sep"></span>
        <select id="ngGlobalRatioSelect" class="ng-select" title="快速切换体型与头身比预设" style="max-width:176px"></select>
        <button type="button" id="ngEditProportionBtn" class="ng-btn cyan" title="打开可视化体型比例设计器：实时滑块微调头身比、肩宽、腰胯、腿长并实时查看比例标尺图">🧍 调体型图</button>
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
        <button type="button" id="ngInspectAllViewsBtn" class="ng-btn cyan" title="将画布中所有部件的四视图按行上下排开，一屏总览对比全角色所有识图">🔍 全图识图总览</button>
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

  // Multi-View Side-by-Side Comparison Lightbox (expands ALL views of a node at once!)
  const previewDlg = document.createElement('dialog');
  previewDlg.id = 'ngImagePreviewDialog';
  previewDlg.innerHTML = `
    <div class="dialog-top">
      <h2 id="ngPreviewTitle">多视图同屏对比检视</h2>
      <button type="button" id="ngClosePreview">×</button>
    </div>
    <div class="mv-inspector-toolbar">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="display:inline-flex;gap:4px">
          <button type="button" class="ng-pill active" id="mvScopeSingleBtn">当前部件 (1×4)</button>
          <button type="button" class="ng-pill" id="mvScopeMatrixBtn">📋 全角色所有部件总表 (N×4)</button>
        </div>
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#e0f2fe;font-weight:600;cursor:pointer">
          <input type="checkbox" id="mvShowLaserChk" checked>
          <span id="mvShowLaserLabel">📏 显示像素上下对齐激光参考线</span>
        </label>
        <span id="mvAlignSummary" style="font-size:11.5px;color:#94a3b8"></span>
      </div>
      <div class="mv-bg-pills">
        <span id="mvBgLabel" style="font-size:11.5px;color:#94a3b8;margin-right:4px">检视底色:</span>
        <button type="button" class="ng-pill active" data-mv-bg="checker">🏁 棋盘格</button>
        <button type="button" class="ng-pill" data-mv-bg="black">⬛ 纯黑</button>
        <button type="button" class="ng-pill" data-mv-bg="white">⬜ 纯白</button>
        <button type="button" class="ng-pill" data-mv-bg="magenta" title="品红底色可一秒暴露漏抠的纯白内孔或白边">🟪 品红检白边</button>
      </div>
    </div>
    <div class="mv-sheet-grid" id="mvSheetGrid" data-bg="checker"></div>
    <div class="mv-matrix-stack" id="mvMatrixStack" hidden></div>
    <input type="file" id="ngReplaceViewInput" accept=".png,.jpg,.jpeg,.webp" hidden>
    <div class="dialog-actions" style="margin-top:12px;justify-content:space-between;flex-wrap:wrap">
      <span id="mvFooterTip" style="font-size:11.5px;color:#94a3b8">提示：可直接将本地图片拖拽到任意视角槽位上进行替换</span>
      <button type="button" id="ngClosePreviewBtn" class="ng-btn primary">关闭检视窗</button>
    </div>
  `;
  document.body.append(previewDlg);
  previewDlg.querySelector('#ngClosePreview').onclick = () => previewDlg.close();
  previewDlg.querySelector('#ngClosePreviewBtn').onclick = () => previewDlg.close();

  // Mask Color Eyedropper Modal (for multi-color ID Mask region selection)
  const maskPickerDlg = document.createElement('dialog');
  maskPickerDlg.id = 'ngMaskPickerDialog';
  maskPickerDlg.className = 'ng-modal';
  maskPickerDlg.style.maxWidth = '680px';
  maskPickerDlg.innerHTML = `
    <div class="dialog-top">
      <h2 id="ngMaskPickerTitle">💧 点击 Mask 图片吸取目标部件颜色</h2>
      <button type="button" id="ngMaskPickerClose">×</button>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin:8px 0">在下方多色 ID Mask 图上直接点击你要拆出的部件颜色区域：</p>
    <div style="display:flex;justify-content:center;align-items:center;background:#090d16;border:1px solid #28354d;border-radius:8px;padding:8px;max-height:66vh;overflow:auto">
      <canvas id="ngMaskPickerCanvas" style="max-width:100%;max-height:60vh;cursor:crosshair"></canvas>
    </div>
  `;
  document.body.append(maskPickerDlg);
  maskPickerDlg.querySelector('#ngMaskPickerClose').onclick = () => maskPickerDlg.close();

  // Multi-Color ID Mask Auto-Split & Part Naming Modal
  const multiMaskDlg = document.createElement('dialog');
  multiMaskDlg.id = 'ngMultiMaskSplitDialog';
  multiMaskDlg.innerHTML = `
    <div class="dialog-top">
      <h2 id="mmSplitTitle">🪄 多色块 Mask 自动识别与一键建拆件分支</h2>
      <button type="button" id="mmSplitCloseX">×</button>
    </div>
    <p id="mmSplitDesc" style="font-size:12px;color:#94a3b8;margin:6px 0 8px">
      已自动聚类剔除抗锯齿杂色并识别出以下色块分区（左侧预览为该色块对应原画高亮区域）。请确认每个色块的部件名称，一键生成全部「拆图 + Tripo 建模」分支：
    </p>
    <div class="mm-region-list" id="mmRegionList"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <button type="button" id="mmPickExtraBtn" class="ng-btn">💧 在图上手动点击补充微小色块…</button>
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;cursor:pointer">
        <input type="checkbox" id="mmReplaceEmptyChk" checked>
        <span id="mmReplaceEmptyLbl">自动清理画布原有的空白未生成拆件节点</span>
      </label>
    </div>
    <div class="dialog-actions" style="justify-content:flex-end;gap:8px">
      <button type="button" id="mmCancelBtn" class="ng-btn">取消</button>
      <button type="button" id="mmConfirmGenerateBtn" class="ng-btn primary">✨ 一键生成拆件 + 3D 建模分支</button>
    </div>
  `;
  document.body.append(multiMaskDlg);

  // Live Interactive Parametric Body Proportion Studio Modal
  const propStudioDlg = document.createElement('dialog');
  propStudioDlg.id = 'ngProportionStudioDialog';
  propStudioDlg.innerHTML = `
    <div class="dialog-top">
      <h2 id="propStudioTitle">🧍 可视化体型与头身比实时设计器</h2>
      <button type="button" id="propStudioCloseX">×</button>
    </div>
    <div class="prop-studio-layout">
      <div class="prop-preview-col">
        <div class="prop-preview-stage" id="propPreviewStage" data-theme="light">
          <img id="propUnderlayImg" class="prop-underlay-img" alt="" hidden style="opacity:0.36">
          <canvas id="propStudioCanvas" width="560" height="560"></canvas>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11.5px;color:#94a3b8">
          <div style="display:flex;gap:5px">
            <button type="button" class="ng-pill active" data-prop-theme="light" id="propThemeLightBtn">⬜ 标准白底 (AI导出同款)</button>
            <button type="button" class="ng-pill" data-prop-theme="blueprint" id="propThemeDarkBtn">🟦 蓝图深色</button>
          </div>
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:#cbd5e1">
            <input type="checkbox" id="propShowUnderlayChk">
            <span id="propUnderlayLbl">叠底主立绘对比</span>
            <input type="range" id="propUnderlayOpacity" min="0.15" max="0.80" step="0.05" value="0.36" style="width:64px" hidden>
          </label>
        </div>
        <div id="propLiveMetricBar" style="font-size:11.5px;color:#5eead4;background:rgba(13,42,46,0.5);border:1px solid rgba(45,212,191,0.3);border-radius:7px;padding:6px 10px"></div>
      </div>

      <div class="prop-controls-col">
        <div class="prop-enable-banner" id="propEnableBanner">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;color:#f8fafc">
            <input type="checkbox" id="propEnableChk" checked>
            <strong id="propEnableTitle">启用参数化体型强约束（导出此实时标尺图高权重约束 AI 与 3D）</strong>
          </label>
        </div>

        <div>
          <div style="font-size:11px;color:#94a3b8;margin-bottom:5px" id="propPresetHint">快速载入基础人设基底（载入后下方所有滑块均可自由微调）：</div>
          <div class="prop-archetype-pills" id="propArchetypePills"></div>
        </div>

        <div class="prop-slider-list" id="propSliderList"></div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:#111827;border:1px solid #1e293b;border-radius:9px;padding:8px 12px;font-size:12px">
          <span id="propPoseLabel" style="color:#cbd5e1">标尺手臂姿态：</span>
          <div style="display:flex;gap:6px">
            <button type="button" class="ng-pill active" data-prop-pose="t">T-Pose 水平展臂</button>
            <button type="button" class="ng-pill" data-prop-pose="a">A-Pose 40°斜展臂</button>
          </div>
        </div>
      </div>
    </div>
    <div class="dialog-actions" style="margin-top:14px;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <button type="button" id="propDownloadPngBtn" class="ng-btn">⬇ 导出当前比例标尺图 (.png)</button>
      <div style="display:flex;gap:8px">
        <button type="button" id="propCancelBtn" class="ng-btn">取消</button>
        <button type="button" id="propApplyBtn" class="ng-btn primary">💾 应用此体型比例</button>
      </div>
    </div>
  `;
  document.body.append(propStudioDlg);

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

  // Non-blocking Styled Confirmation Dialog (avoids Electron BaseWindow window.confirm freeze)
  const confirmDlg = document.createElement('dialog');
  confirmDlg.id = 'ngConfirmDialog';
  confirmDlg.className = 'ng-modal';
  confirmDlg.innerHTML = `
    <div class="dialog-top"><h2 id="ngConfirmTitle">确认操作</h2><button type="button" id="ngConfirmCloseX">×</button></div>
    <p id="ngConfirmMessage" style="color:#cbd5e1;font-size:12.5px;line-height:1.6;margin:12px 0 18px"></p>
    <div class="dialog-actions" style="justify-content:flex-end;gap:8px">
      <button type="button" id="ngConfirmCancelBtn" class="ng-btn">取消</button>
      <button type="button" id="ngConfirmOkBtn" class="ng-btn primary">确定继续</button>
    </div>
  `;
  document.body.append(confirmDlg);

  function askConfirmDialog(title, message) {
    return new Promise(resolve => {
      confirmDlg.querySelector('#ngConfirmTitle').textContent = title;
      confirmDlg.querySelector('#ngConfirmMessage').textContent = message;
      confirmDlg.querySelector('#ngConfirmCancelBtn').textContent = tr('取消', 'Cancel');
      confirmDlg.querySelector('#ngConfirmOkBtn').textContent = tr('确认切换', 'Confirm');
      const finish = ok => {
        confirmDlg.onclose = null;
        if (confirmDlg.open) confirmDlg.close();
        resolve(ok);
      };
      confirmDlg.querySelector('#ngConfirmCloseX').onclick = () => finish(false);
      confirmDlg.querySelector('#ngConfirmCancelBtn').onclick = () => finish(false);
      confirmDlg.querySelector('#ngConfirmOkBtn').onclick = () => finish(true);
      confirmDlg.onclose = () => resolve(false);
      confirmDlg.showModal();
    });
  }

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
  const decodedImgCache = new Map(); // sha256|maxDim -> Promise<{width,height,rgba,blocks?}>
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
    const activePreset = currentGraph()?.preset || 'standard_split';
    sel.replaceChildren();

    const grpBuiltin = document.createElement('optgroup');
    grpBuiltin.label = tr('内置标准模板', 'Built-in Templates');
    const builtins = [
      ['standard_split', tr('模板：精细角色拆分（裸脸 + 头发 + 服装身体）', 'Template: Standard Character Split (Face + Hair + Body)')],
      ['deluxe_composite', tr('模板：豪华多件复合（裸脸 + 发 + 上衣 + 下裙 + 翅膀 + 武器）', 'Template: Deluxe 6-Part Composite (Face + Hair + Outfit + Wings + Weapon)')],
      ['mask_custom_split', tr('模板：Mask 遮罩精准拆件（主立绘 + Mask 遮罩拆分）', 'Template: Mask-Guided Part Extraction (Concept + Mask)')],
      ['single_prop', tr('模板：自由单件 / 道具', 'Template: Standalone Prop / Weapon')],
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
      grpCustom.label = tr('🌟 我的自定义模板', '🌟 My Saved Templates');
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
      grpMod.label = tr('🧩 已启用 Mod 扩展模板', '🧩 Enabled Mod Templates');
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

    const exists = [...sel.querySelectorAll('option')].some(o => o.value === activePreset);
    sel.value = exists ? activePreset : 'standard_split';

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

  function refreshGlobalRatioSelect() {
    const sel = $('#ngGlobalRatioSelect');
    const editBtn = $('#ngEditProportionBtn');
    if (!sel) return;
    const g = currentGraph();
    const spec = ensureGraphProportionSpec(g);
    const curVal = spec.enabled ? (spec.archetype || 'custom') : 'keep';
    sel.replaceChildren();
    for (const preset of PROPORTION_ARCHETYPES) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = tr(preset.zh, preset.en);
      sel.append(opt);
    }
    const exists = PROPORTION_ARCHETYPES.some(p => p.id === curVal);
    sel.value = exists ? curVal : (spec.enabled ? 'custom' : 'keep');
    if (editBtn) {
      editBtn.textContent = spec.enabled
        ? tr(`🧍 调体型 (${spec.headRatio}H·肩${spec.shoulderWidth}×)`, `🧍 Body (${spec.headRatio}H·Shld ${spec.shoulderWidth}×)`)
        : tr('🧍 实时调体型图', '🧍 Body Designer');
    }
  }

  // --- Undo / Redo Snapshot Stack ---
  function snapshotState(g) {
    return JSON.stringify({
      preset: g.preset || 'standard_split',
      headBodyRatio: g.headBodyRatio || 'keep',
      customHeadBodyRatio: g.customHeadBodyRatio ?? 6.8,
      proportionSpec: ensureGraphProportionSpec(g),
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
    g.proportionSpec = normalizeProportionSpec(parsed.proportionSpec, parsed.headBodyRatio, parsed.customHeadBodyRatio);
    ensureGraphProportionSpec(g);
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
    decodedImgCache.clear();
  }

  function decodeSmallImage(docRef, maxDim = 240, {withColorBlocks = false} = {}) {
    if (!docRef?.path) return Promise.resolve(null);
    const cacheKey = `${docRef.sha256 || docRef.path}|${maxDim}`;
    let p = decodedImgCache.get(cacheKey);
    if (!p) {
      const u = fileUrl(docRef);
      if (!u) return Promise.resolve(null);
      p = new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          try {
            const nw = img.naturalWidth || maxDim;
            const nh = img.naturalHeight || maxDim;
            const sc = Math.min(1, maxDim / Math.max(nw, nh));
            const cw = Math.max(1, Math.round(nw * sc));
            const ch = Math.max(1, Math.round(nh * sc));
            const cvs = document.createElement('canvas');
            cvs.width = cw;
            cvs.height = ch;
            const ctx = cvs.getContext('2d', {willReadFrequently: true});
            ctx.drawImage(img, 0, 0, cw, ch);
            const rgba = new Uint8Array(ctx.getImageData(0, 0, cw, ch).data);
            resolve({width: cw, height: ch, rgba, blocks: null});
          } catch {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = u;
      });
      decodedImgCache.set(cacheKey, p);
    }
    if (!withColorBlocks) return p;
    return p.then(res => {
      if (!res) return null;
      if (!res.blocks) {
        res.blocks = analyzeMaskColorBlocks(res.rgba, res.width, res.height, {minCoveragePct: 0.16, maxRegions: 12});
      }
      return res;
    });
  }

  async function paintLiveMaskHighlightThumb(canvas, srcDoc, maskDoc, mode = 'auto', colorHex = '#ff3b30', boxSize = 96) {
    if (!canvas || !maskDoc) return;
    const [srcDec, mskDec] = await Promise.all([
      srcDoc ? decodeSmallImage(srcDoc, boxSize * 2, {withColorBlocks: false}) : Promise.resolve(null),
      decodeSmallImage(maskDoc, boxSize * 2, {withColorBlocks: mode === 'color'}),
    ]);
    if (!mskDec || !canvas.isConnected) return;
    const rivals = mode === 'color' && mskDec.blocks
      ? mskDec.blocks.map(b => b.rgb).filter(([r, g2, b]) => {
          const [tr, tg, tb] = hexToRgb(colorHex);
          return ((r - tr) ** 2 + (g2 - tg) ** 2 + (b - tb) ** 2) > 36 * 36;
        })
      : null;
    const comp = compositeMaskHighlightRgba(
      srcDec ? srcDec.rgba : null,
      srcDec ? srcDec.width : 0,
      srcDec ? srcDec.height : 0,
      mskDec.rgba,
      mskDec.width,
      mskDec.height,
      {mode, colorHex, rivalColors: rivals}
    );
    canvas.width = comp.width;
    canvas.height = comp.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(comp.rgba, comp.width, comp.height), 0, 0);
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
      const toNode = getNode(g, e.toNode);
      const outSpec = NODE_SPECS[fromNode?.type]?.outputs?.find(o => o.id === e.fromPort);
      let stroke = KIND_COLORS[outSpec?.kind] || '#60a5fa';
      if (e.toPort === 'mask' && toNode?.params?.maskMode === 'color' && /^#[0-9a-fA-F]{6}$/.test(toNode?.params?.maskColor || '')) {
        stroke = toNode.params.maskColor;
      }
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
      if (kind === 'image' || kind === 'mask' || kind === 'style' || kind === 'ratio') {
        return branchDef.nodes.some(n => n.type === 'part_views' || (kind !== 'mask' && n.type === 'balance_views'));
      }
      if (kind === 'views') {
        return branchDef.nodes.some(n => isMeshNodeType(n.type));
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
      ['part_views', '✂️ 部件正交四视图拆图', '自由命名要拆出的部件（支持接入 Mask 遮罩精准指定边界），生成正左右背四视图', 'part views split mask 拆图 部件 四视图 遮罩'],
      ['mask_ref', '🎭 Mask 分区遮罩图', '上传黑白遮罩、半透明涂鸦或多色 ID Mask，连入一个或多个拆图节点精准拆件', 'mask id segmentation 遮罩 蒙版 抠图 分区'],
      ['tripo_mesh', '🧊 Tripo 3D 建模节点', '接收四方向视图，配置 HD 百万面或 Smart 智能拓扑（含自动重展UV上色）', 'tripo mesh 3d model 建模 网格 高模 低模 smart'],
      ['tripo_retexture', '🎨 UV 重展开与贴图上色', '对上游 3D 白模/原模执行独立 Smart UV 重展开与多视图 4K/8K 上色（支持多皮肤换色）', 'uv unwrap smart uv retexture texture 重展开 上色 贴图 换色'],
      ['style_ref', '🎨 画风参考立绘', '提供赛璐璐/厚涂/二次元渲染画风与线条参考', 'style ref 画风 上色 参考'],
      ['balance_views', '📐 全身合体比例三视图', '生成正/侧/背全身比例标尺，配合参数化头身比校准 3D 合体', 'balance guide three views 三视图 比例尺 头身比'],
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
            } else if (isMeshNodeType(type)) {
              const asm = g.nodes.find(x => x.type === 'assembly_export');
              if (asm) try { connectPorts(g, n.id, 'mesh', asm.id, 'meshes'); } catch {}
            }
          } else {
            applyPendingWireToCreated([n], wireFrom);
            if ((type === 'part_views' || type === 'balance_views') && wireFrom.dir === 'out' && wireFrom.kind !== 'image') {
              const src = g.nodes.find(x => x.type === 'source_image');
              if (src) try { connectPorts(g, src.id, 'image', n.id, 'source'); } catch {}
            }
            // If inserting `tripo_retexture` downstream of a `tripo_mesh`, splice it cleanly into `assembly_export`
            if (type === 'tripo_retexture' && wireFrom.dir === 'out' && wireFrom.kind === 'mesh') {
              const asmEdge = g.edges.find(
                e => e.fromNode === wireFrom.nodeId && e.fromPort === 'mesh' && getNode(g, e.toNode)?.type === 'assembly_export'
              );
              if (asmEdge) {
                const asmId = asmEdge.toNode;
                disconnectEdge(g, asmEdge.id);
                try { connectPorts(g, n.id, 'mesh', asmId, 'meshes'); } catch {}
              }
            }
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

    const doc = await registerGraphDocument(p, f, file.name, raw, viewKey === '__mask__' ? 'mask_ref' : node.type);
    const imgMeta = {...doc, mime: info.mime, width: info.width, height: info.height};

    if (viewKey === '__mask__') {
      node.data ??= {};
      node.data.maskImage = imgMeta;
    } else if (viewKey && node.data?.views) {
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
    if (previewDlg.open && viewKey && viewKey !== '__mask__') {
      if (previewDlg.dataset.matrixMode === '1') {
        openMultiViewInspector(nodeId, viewKey, {matrixAll: true});
      } else if (previewDlg.dataset.nodeId === nodeId) {
        openMultiViewInspector(nodeId, viewKey, {matrixAll: false});
      }
    }
    if (!viewKey && node.type === 'mask_ref') {
      const dec = await decodeSmallImage(imgMeta, 256, {withColorBlocks: true});
      if (dec?.blocks?.length >= 2) {
        openMultiMaskSplitDialog(node.id);
      }
    }
  }

  // --- Pixel Alpha Alignment Scanner & Multi-View Side-by-Side Comparison Lightbox ---
  async function scanViewAlphaBounds(imgUrl) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          const nw = img.naturalWidth || 1024;
          const nh = img.naturalHeight || 1024;
          const scale = nh > 1024 ? 1024 / nh : 1;
          const cw = Math.max(1, Math.round(nw * scale));
          const ch = Math.max(1, Math.round(nh * scale));
          const cvs = document.createElement('canvas');
          cvs.width = cw;
          cvs.height = ch;
          const ctx = cvs.getContext('2d', {willReadFrequently: true});
          ctx.drawImage(img, 0, 0, cw, ch);
          const data = ctx.getImageData(0, 0, cw, ch).data;
          // Check whether image actually uses alpha transparency; if opaque (JPG/white-bg), detect non-white subject
          let transparentCount = 0;
          for (let i = 3; i < data.length; i += 64) {
            if (data[i] < 245) transparentCount++;
          }
          const hasAlpha = transparentCount > 8;
          let topRow = -1;
          let botRow = -1;
          for (let y = 0; y < ch; y++) {
            const rowOff = y * cw * 4;
            let hit = false;
            for (let x = 0; x < cw; x++) {
              const idx = rowOff + x * 4;
              const a = data[idx + 3];
              if (hasAlpha ? a >= 20 : (a >= 20 && (data[idx] < 246 || data[idx + 1] < 246 || data[idx + 2] < 246))) {
                hit = true;
                break;
              }
            }
            if (hit) {
              if (topRow < 0) topRow = y;
              botRow = y;
            }
          }
          if (topRow < 0) {
            resolve(null);
            return;
          }
          resolve({
            width: nw,
            height: nh,
            topPx: Math.round(topRow / scale),
            botPx: Math.round(botRow / scale),
            topPct: (topRow / ch) * 100,
            botPct: ((botRow + 1) / ch) * 100,
            midPct: (((topRow + botRow + 1) * 0.5) / ch) * 100,
          });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = imgUrl;
    });
  }

  function syncInspectorLaserVisibility() {
    const show = Boolean(previewDlg.querySelector('#mvShowLaserChk')?.checked);
    for (const ln of previewDlg.querySelectorAll('.mv-laser-line')) {
      ln.style.display = show ? '' : 'none';
    }
  }

  previewDlg.querySelector('#mvShowLaserChk').onchange = () => syncInspectorLaserVisibility();
  for (const bgBtn of previewDlg.querySelectorAll('[data-mv-bg]')) {
    bgBtn.onclick = () => {
      const bg = bgBtn.dataset.mvBg || 'checker';
      previewDlg.querySelector('#mvSheetGrid').dataset.bg = bg;
      for (const subGrid of previewDlg.querySelectorAll('#mvMatrixStack .mv-sheet-grid')) {
        subGrid.dataset.bg = bg;
      }
      for (const b of previewDlg.querySelectorAll('[data-mv-bg]')) {
        b.classList.toggle('active', b === bgBtn);
      }
    };
  }

  function buildInspectorRowGrid(g, node, gridEl, {highlightKey = null, activeBg = 'checker'} = {}) {
    const keys = node.type === 'balance_views' ? GRAPH_VIEWS_3 : GRAPH_VIEWS_4;
    const locked = isNodeLocked(node.id);
    gridEl.dataset.bg = activeBg;
    gridEl.classList.toggle('cols-3', keys.length === 3);
    gridEl.replaceChildren();

    const urlByKey = new Map();
    const cardByKey = new Map();

    for (const k of keys) {
      const doc = node.data?.views?.[k];
      const u = fileUrl(doc);
      if (u) urlByKey.set(k, u);

      const card = document.createElement('div');
      card.className = 'mv-slot-card';
      card.dataset.viewSlot = k;
      if (highlightKey === k) {
        card.style.borderColor = '#60a5fa';
        card.style.boxShadow = '0 0 0 1px rgba(96, 165, 250, 0.45)';
      }

      const head = document.createElement('div');
      head.className = 'mv-slot-head';
      const fullLbl = VIEW_FULL_LABELS[k] ? tr(VIEW_FULL_LABELS[k][0], VIEW_FULL_LABELS[k][1]) : k;
      const titleSpan = document.createElement('span');
      titleSpan.textContent = fullLbl;
      const alignBadge = document.createElement('span');
      alignBadge.className = 'mv-align-tag';
      alignBadge.hidden = true;
      head.append(titleSpan, alignBadge);

      const frame = document.createElement('div');
      frame.className = 'mv-img-frame';
      if (u) {
        const img = document.createElement('img');
        img.src = u;
        img.alt = k;
        const lnTop = document.createElement('div');
        lnTop.className = 'mv-laser-line top';
        lnTop.hidden = true;
        const lnMid = document.createElement('div');
        lnMid.className = 'mv-laser-line mid';
        lnMid.hidden = true;
        const lnBot = document.createElement('div');
        lnBot.className = 'mv-laser-line bot';
        lnBot.hidden = true;
        frame.append(img, lnTop, lnMid, lnBot);
      } else {
        const empty = document.createElement('div');
        empty.className = 'mv-empty-hint';
        empty.textContent = tr('尚未填入此视角\n点击下方「上传」或直接拖入图片', 'Empty view slot\nClick Upload or drop image here');
        empty.style.whiteSpace = 'pre-line';
        frame.append(empty);
      }

      const foot = document.createElement('div');
      foot.className = 'mv-slot-foot';
      const dimSpan = document.createElement('span');
      dimSpan.textContent = doc?.width ? `${doc.width}×${doc.height} px` : tr('未上传', 'Empty');
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:6px';

      if (!locked) {
        const repBtn = document.createElement('button');
        repBtn.type = 'button';
        repBtn.className = 'ng-btn';
        repBtn.style.cssText = 'height:24px;padding:0 8px;font-size:11px';
        repBtn.textContent = u ? tr('📂 替换', '📂 Replace') : tr('📂 上传', '📂 Upload');
        repBtn.onclick = () => {
          pendingUploadTarget = {nodeId: node.id, viewKey: k};
          previewDlg.querySelector('#ngReplaceViewInput').click();
        };
        btnRow.append(repBtn);
      }
      if (doc?.path) {
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'ng-btn';
        dlBtn.style.cssText = 'height:24px;padding:0 8px;font-size:11px';
        dlBtn.textContent = tr('⬇ 导出', '⬇ Save');
        dlBtn.onclick = () => {
          const bytes = hooks.get().files.get(doc.path);
          if (!bytes) return;
          const ext = /\.webp$/i.test(doc.path) ? 'webp' : /\.jpe?g$/i.test(doc.path) ? 'jpg' : 'png';
          const safePart = (node.params?.partName || node.id).replace(/[\\/:*?"<>|\s]+/g, '_');
          hooks.download?.(new Blob([bytes], {type: doc.mime || 'image/png'}), `${safePart}_${k}.${ext}`);
        };
        btnRow.append(dlBtn);
      }

      foot.append(dimSpan, btnRow);
      card.append(head, frame, foot);

      if (!locked) {
        card.ondragover = ev => { ev.preventDefault(); card.style.borderColor = '#38bdf8'; };
        card.ondragleave = () => { card.style.borderColor = highlightKey === k ? '#60a5fa' : ''; };
        card.ondrop = ev => {
          ev.preventDefault();
          card.style.borderColor = highlightKey === k ? '#60a5fa' : '';
          const file = ev.dataTransfer?.files?.[0];
          if (file) void handleImageUpload(file, node.id, k);
        };
      }

      gridEl.append(card);
      cardByKey.set(k, {card, alignBadge, frame});
    }

    return {keys, urlByKey, cardByKey};
  }

  async function scanAndAnnotateRowAlignment(rowSpec, token) {
    const {keys, urlByKey, cardByKey} = rowSpec;
    const boundsMap = new Map();
    for (const [k, u] of urlByKey) {
      const b = await scanViewAlphaBounds(u);
      if (b) boundsMap.set(k, b);
    }
    if (previewDlg.dataset.scanToken !== token) return null;
    const refKey = boundsMap.has('front') ? 'front' : [...boundsMap.keys()][0];
    const refB = refKey ? boundsMap.get(refKey) : null;
    if (!refB) return {loaded: 0, total: keys.length, maxDiffPx: 0};

    let maxDiffPx = 0;
    for (const [k, {alignBadge, frame}] of cardByKey) {
      const lnTop = frame.querySelector('.mv-laser-line.top');
      const lnMid = frame.querySelector('.mv-laser-line.mid');
      const lnBot = frame.querySelector('.mv-laser-line.bot');
      if (lnTop && lnMid && lnBot) {
        lnTop.style.top = `${refB.topPct.toFixed(2)}%`;
        lnMid.style.top = `${refB.midPct.toFixed(2)}%`;
        lnBot.style.top = `${refB.botPct.toFixed(2)}%`;
        lnTop.hidden = false;
        lnMid.hidden = false;
        lnBot.hidden = false;
      }
      const curB = boundsMap.get(k);
      if (!curB) continue;
      if (k === refKey) {
        alignBadge.hidden = false;
        alignBadge.className = 'mv-align-tag ok';
        alignBadge.textContent = tr(`基准 Y:${curB.topPx}~${curB.botPx}`, `Ref Y:${curB.topPx}~${curB.botPx}`);
      } else {
        const dTop = Math.abs(curB.topPx - refB.topPx);
        const dBot = Math.abs(curB.botPx - refB.botPx);
        const worst = Math.max(dTop, dBot);
        if (worst > maxDiffPx) maxDiffPx = worst;
        alignBadge.hidden = false;
        if (worst <= 4) {
          alignBadge.className = 'mv-align-tag ok';
          alignBadge.textContent = tr(`✓ 对齐 (Δ${worst}px)`, `✓ Aligned (Δ${worst}px)`);
        } else {
          alignBadge.className = 'mv-align-tag warn';
          alignBadge.className = 'mv-align-tag warn';
          alignBadge.textContent = tr(`⚠ Δ顶${dTop}/底${dBot}px`, `⚠ ΔT${dTop}/B${dBot}px`);
        }
      }
    }
    return {loaded: boundsMap.size, total: keys.length, maxDiffPx};
  }

  function openMultiViewInspector(nodeId = null, highlightKey = null, {matrixAll = false} = {}) {
    const g = currentGraph();
    const viewNodes = g.nodes.filter(n => n.type === 'part_views' || n.type === 'balance_views');
    if (!viewNodes.length) {
      hooks.toast(tr('当前画布没有拆图或三视图节点', 'No view nodes on canvas'));
      return;
    }
    const targetSingle = nodeId ? getNode(g, nodeId) : viewNodes[0];
    const isMatrix = matrixAll || !targetSingle;

    previewDlg.dataset.nodeId = targetSingle?.id || viewNodes[0].id;
    previewDlg.dataset.matrixMode = isMatrix ? '1' : '0';

    const singleBtn = previewDlg.querySelector('#mvScopeSingleBtn');
    const matrixBtn = previewDlg.querySelector('#mvScopeMatrixBtn');
    singleBtn.textContent = tr('当前部件 (1×4)', 'Single Node (1×4)');
    matrixBtn.textContent = tr(`📋 全角色所有部件总表 (${viewNodes.length}组)`, `📋 All Parts Matrix (${viewNodes.length} sets)`);
    singleBtn.classList.toggle('active', !isMatrix);
    matrixBtn.classList.toggle('active', isMatrix);
    singleBtn.onclick = () => openMultiViewInspector(previewDlg.dataset.nodeId, null, {matrixAll: false});
    matrixBtn.onclick = () => openMultiViewInspector(previewDlg.dataset.nodeId, null, {matrixAll: true});

    previewDlg.querySelector('#mvShowLaserLabel').textContent = tr(
      '📏 显示像素上下对齐激光参考线',
      '📏 Show Top/Bottom Pixel Alignment Laser Lines'
    );
    previewDlg.querySelector('#mvBgLabel').textContent = tr('检视底色:', 'Backdrop:');
    previewDlg.querySelector('#mvFooterTip').textContent = tr(
      '提示：可直接将本地图片拖拽到任意视角槽位上进行替换',
      'Tip: Drag & drop an image onto any view slot to replace it'
    );
    previewDlg.querySelector('#ngClosePreviewBtn').textContent = tr('关闭检视窗', 'Close Inspector');

    const gridEl = previewDlg.querySelector('#mvSheetGrid');
    const stackEl = previewDlg.querySelector('#mvMatrixStack');
    const activeBg = previewDlg.querySelector('[data-mv-bg].active')?.dataset?.mvBg || 'checker';
    const summaryEl = previewDlg.querySelector('#mvAlignSummary');
    const token = String(Date.now()) + Math.random();
    previewDlg.dataset.scanToken = token;

    if (!isMatrix) {
      stackEl.hidden = true;
      gridEl.hidden = false;
      const partLabel = targetSingle.type === 'balance_views'
        ? tr('全身合体比例三视图', 'Full-Body Proportion 3-View Sheet')
        : (targetSingle.params?.partName || tr('部件四视图', 'Part 4-View Sheet'));
      previewDlg.querySelector('#ngPreviewTitle').textContent = tr(
        `🔍 多视图同屏展开对比 · ${partLabel}`,
        `🔍 Side-by-Side Multi-View Inspector · ${partLabel}`
      );
      summaryEl.textContent = tr('正在扫描像素边界…', 'Scanning pixel alignment…');
      const rowSpec = buildInspectorRowGrid(g, targetSingle, gridEl, {highlightKey, activeBg});
      if (!previewDlg.open) previewDlg.showModal();
      void (async () => {
        const res = await scanAndAnnotateRowAlignment(rowSpec, token);
        if (!res) return;
        syncInspectorLaserVisibility();
        summaryEl.textContent = res.loaded === 0
          ? tr('上传视图后自动检测头顶与脚底像素对齐度', 'Upload views to inspect top/bottom alignment')
          : res.maxDiffPx <= 4
            ? tr(`✓ 已加载 ${res.loaded}/${res.total} 视角 · 像素上下基准线已对齐 (Δ≤${res.maxDiffPx}px)`, `✓ ${res.loaded}/${res.total} views aligned (max Δ${res.maxDiffPx}px)`)
            : tr(`⚠ 检测到最大高度偏差 ${res.maxDiffPx}px`, `⚠ Max height delta ${res.maxDiffPx}px`);
      })();
      return;
    }

    // N x 4 Matrix Overview across ALL view nodes!
    gridEl.hidden = true;
    stackEl.hidden = false;
    stackEl.replaceChildren();
    previewDlg.querySelector('#ngPreviewTitle').textContent = tr(
      `📋 全角色多部件识图总览（共 ${viewNodes.length} 组视图）`,
      `📋 All-Parts Multi-View Matrix Overview (${viewNodes.length} Node Sets)`
    );
    summaryEl.textContent = tr(`正在扫描全角色 ${viewNodes.length} 组视图…`, `Scanning all ${viewNodes.length} view sets…`);

    const srcDoc = g.nodes.find(x => x.type === 'source_image')?.data?.image || null;
    const rowSpecs = [];
    for (const vn of viewNodes) {
      const block = document.createElement('div');
      block.className = 'mv-matrix-row-block';
      const rHead = document.createElement('div');
      rHead.className = 'mv-matrix-row-head';

      const badge = document.createElement('div');
      badge.className = 'mv-matrix-part-badge';

      // Show color dot + live mini highlight if masked!
      const mEdge = incomingEdges(g, vn.id).find(e => e.toPort === 'mask');
      const mNode = mEdge ? getNode(g, mEdge.fromNode) : null;
      const mDoc = mNode?.data?.image || vn.data?.maskImage || null;
      if (mDoc) {
        const miniM = document.createElement('canvas');
        miniM.width = 34;
        miniM.height = 34;
        miniM.style.cssText = 'width:30px;height:30px;border-radius:5px;border:1px solid #38bdf8;background:#090d16';
        void paintLiveMaskHighlightThumb(miniM, srcDoc, mDoc, vn.params?.maskMode || 'auto', vn.params?.maskColor || '#ff3b30', 48);
        badge.append(miniM);
        if (vn.params?.maskMode === 'color' && vn.params?.maskColor) {
          const sw = document.createElement('span');
          sw.className = 'ng-mask-chip';
          sw.innerHTML = `<span class="ng-mask-chip-dot" style="background:${vn.params.maskColor}"></span>${vn.params.maskColor}`;
          badge.append(sw);
        }
      }

      const nameTxt = document.createElement('span');
      nameTxt.textContent = vn.type === 'balance_views'
        ? `📐 ${tr('全身合体比例三视图', 'Full-Body 3-View Guide')}`
        : `✂️ ${vn.params?.partName || vn.id}`;
      badge.append(nameTxt);

      const focusOneBtn = document.createElement('button');
      focusOneBtn.type = 'button';
      focusOneBtn.className = 'ng-btn';
      focusOneBtn.style.cssText = 'height:24px;padding:0 8px;font-size:11px';
      focusOneBtn.textContent = tr('仅看此部件', 'Focus Node');
      focusOneBtn.onclick = () => openMultiViewInspector(vn.id, null, {matrixAll: false});

      rHead.append(badge, focusOneBtn);
      const subGrid = document.createElement('div');
      subGrid.className = 'mv-sheet-grid';
      const spec = buildInspectorRowGrid(g, vn, subGrid, {
        highlightKey: vn.id === nodeId ? highlightKey : null,
        activeBg,
      });
      block.append(rHead, subGrid);
      stackEl.append(block);
      rowSpecs.push(spec);
    }

    if (!previewDlg.open) previewDlg.showModal();
    void (async () => {
      let totalLoaded = 0;
      let totalSlots = 0;
      let worstPx = 0;
      for (const sp of rowSpecs) {
        const r = await scanAndAnnotateRowAlignment(sp, token);
        if (!r) return;
        totalLoaded += r.loaded;
        totalSlots += r.total;
        if (r.maxDiffPx > worstPx) worstPx = r.maxDiffPx;
      }
      syncInspectorLaserVisibility();
      summaryEl.textContent = tr(
        `✓ 共展开 ${viewNodes.length} 组部件（已就绪 ${totalLoaded}/${totalSlots} 张视图${totalLoaded ? ` · 最大对齐偏差 ${worstPx}px` : ''}）`,
        `✓ Expanded ${viewNodes.length} sets (${totalLoaded}/${totalSlots} views loaded)`
      );
    })();
  }

  // --- Mask Color Eyedropper Modal ---
  function openMaskColorPicker(maskUrl, onPick) {
    if (!maskUrl) {
      hooks.toast(tr('请先上传或连入 Mask 遮罩图后再吸取颜色', 'Upload or connect a Mask image first'));
      return;
    }
    const cvs = maskPickerDlg.querySelector('#ngMaskPickerCanvas');
    const img = new Image();
    img.onload = () => {
      cvs.width = img.naturalWidth || 512;
      cvs.height = img.naturalHeight || 512;
      const ctx = cvs.getContext('2d', {willReadFrequently: true});
      ctx.clearRect(0, 0, cvs.width, cvs.height);
      ctx.drawImage(img, 0, 0);
      cvs.onclick = ev => {
        const rect = cvs.getBoundingClientRect();
        const px = Math.max(0, Math.min(cvs.width - 1, Math.floor(((ev.clientX - rect.left) / Math.max(1, rect.width)) * cvs.width)));
        const py = Math.max(0, Math.min(cvs.height - 1, Math.floor(((ev.clientY - rect.top) / Math.max(1, rect.height)) * cvs.height)));
        const [r, g2, b] = ctx.getImageData(px, py, 1, 1).data;
        const hex = '#' + [r, g2, b].map(v => v.toString(16).padStart(2, '0')).join('');
        onPick(hex);
        maskPickerDlg.close();
      };
      maskPickerDlg.showModal();
    };
    img.src = maskUrl;
  }

  // --- Live Interactive Body Proportion Designer Studio ---
  let propPreviewTheme = 'light';
  const PROP_SLIDER_DEFS = [
    {key: 'headRatio', min: 1.5, max: 9.5, step: 0.1, hi: true, zh: '头身比 (总高 = N头)', en: 'Head-Body Ratio (H)'},
    {key: 'shoulderWidth', min: 0.60, max: 2.60, step: 0.01, hi: true, zh: '肩宽 (×头宽倍数)', en: 'Shoulder Width (×HW)'},
    {key: 'chestWidth', min: 0.60, max: 2.25, step: 0.01, hi: false, zh: '胸廓宽 (×头宽倍数)', en: 'Chest Width (×HW)'},
    {key: 'waistWidth', min: 0.40, max: 1.85, step: 0.01, hi: false, zh: '腰宽 (×头宽倍数)', en: 'Waist Width (×HW)'},
    {key: 'hipWidth', min: 0.60, max: 2.20, step: 0.01, hi: true, zh: '胯宽/骨盆 (×头宽)', en: 'Hip / Pelvis (×HW)'},
    {key: 'legRatio', min: 0.30, max: 0.68, step: 0.01, hi: true, zh: '腿长占比 (占无头身)', en: 'Leg Ratio (of Body)'},
    {key: 'headWidth', min: 0.55, max: 1.22, step: 0.01, hi: false, zh: '脸宽/头圆度 (×头高)', en: 'Head Width / Round'},
    {key: 'neckLen', min: 0.02, max: 0.36, step: 0.01, hi: false, zh: '脖子长度 (×头高)', en: 'Neck Length (×H)'},
    {key: 'limbThickness', min: 0.50, max: 1.65, step: 0.01, hi: false, zh: '四肢与手脚粗细', en: 'Limb & Foot Volume'},
    {key: 'armSpan', min: 0.70, max: 1.22, step: 0.01, hi: false, zh: '手臂长度系数', en: 'Arm Length Factor'},
  ];

  function openProportionStudio({autoEnableIfOff = true} = {}) {
    const g = currentGraph();
    const curSpec = ensureGraphProportionSpec(g);
    let draft = structuredClone(curSpec);
    if (autoEnableIfOff && !draft.enabled) {
      draft.enabled = true;
      if (!draft.archetype || draft.archetype === 'keep') draft.archetype = 'anime_fem_68';
    }

    const stageBox = propStudioDlg.querySelector('#propPreviewStage');
    const cvs = propStudioDlg.querySelector('#propStudioCanvas');
    const underlayImg = propStudioDlg.querySelector('#propUnderlayImg');
    const underlayChk = propStudioDlg.querySelector('#propShowUnderlayChk');
    const underlayOp = propStudioDlg.querySelector('#propUnderlayOpacity');
    const enableChk = propStudioDlg.querySelector('#propEnableChk');
    const enableBanner = propStudioDlg.querySelector('#propEnableBanner');
    const pillsWrap = propStudioDlg.querySelector('#propArchetypePills');
    const sliderList = propStudioDlg.querySelector('#propSliderList');
    const metricBar = propStudioDlg.querySelector('#propLiveMetricBar');

    // Bilingual static labels
    propStudioDlg.querySelector('#propStudioTitle').textContent = tr(
      '🧍 可视化体型与头身比实时设计器（所见即导出给 AI 的精确标尺图）',
      '🧍 Live Parametric Body Proportion Studio (WYSIWYG Orthographic Ruler)'
    );
    propStudioDlg.querySelector('#propThemeLightBtn').textContent = tr('⬜ 标准白底 (AI导出同款)', '⬜ Light Chart (AI Export)');
    propStudioDlg.querySelector('#propThemeDarkBtn').textContent = tr('🟦 蓝图深色', '🟦 Blueprint Dark');
    propStudioDlg.querySelector('#propUnderlayLbl').textContent = tr('叠底主立绘对比', 'Concept Underlay');
    propStudioDlg.querySelector('#propEnableTitle').textContent = tr(
      '启用参数化体型强约束（导出此实时标尺图高权重约束 AI 拆图与 3D 视口）',
      'Enable Parametric Proportion Lock (exports this ruler PNG + exact ratios to AI & 3D)'
    );
    propStudioDlg.querySelector('#propPresetHint').textContent = tr(
      '一键载入基础人设模板（载入后下方全部滑块均可自由实时拖动微调）：',
      'Quick starter archetypes (all sliders below remain 100% freely adjustable):'
    );
    propStudioDlg.querySelector('#propPoseLabel').textContent = tr('标尺手臂姿态：', 'Mannequin Pose:');
    propStudioDlg.querySelector('#propDownloadPngBtn').textContent = tr('⬇ 导出当前比例标尺图 (.png)', '⬇ Save Ruler PNG');
    propStudioDlg.querySelector('#propCancelBtn').textContent = tr('取消', 'Cancel');
    propStudioDlg.querySelector('#propApplyBtn').textContent = tr('💾 应用此体型比例', '💾 Apply Proportions');

    const srcDoc = g.nodes.find(n => n.type === 'source_image')?.data?.image || null;
    const srcUrl = fileUrl(srcDoc);
    if (srcUrl) {
      underlayImg.src = srcUrl;
    } else {
      underlayChk.checked = false;
      underlayImg.hidden = true;
    }

    const rowControls = new Map();

    const syncControlsFromDraft = () => {
      enableChk.checked = Boolean(draft.enabled);
      enableBanner.dataset.disabled = draft.enabled ? '0' : '1';
      sliderList.style.opacity = draft.enabled ? '1' : '0.5';
      for (const [key, {range, num}] of rowControls) {
        range.value = String(draft[key]);
        num.value = String(draft[key]);
      }
      for (const b of pillsWrap.querySelectorAll('button[data-arch]')) {
        b.classList.toggle('active', draft.enabled && draft.archetype === b.dataset.arch);
      }
      for (const pb of propStudioDlg.querySelectorAll('button[data-prop-pose]')) {
        pb.classList.toggle('active', draft.pose === pb.dataset.propPose);
      }
    };

    const redrawLiveChart = () => {
      const useUnderlay = Boolean(srcUrl && underlayChk.checked);
      underlayImg.hidden = !useUnderlay;
      underlayOp.hidden = !useUnderlay;
      underlayImg.style.opacity = underlayOp.value;
      stageBox.dataset.theme = propPreviewTheme;

      drawProportionMannequinToCanvas(cvs, draft, {
        size: 560,
        theme: propPreviewTheme,
        transparentBg: useUnderlay,
        showLabels: true,
      });

      const bodyU = Math.max(0.5, Number((draft.headRatio - 1).toFixed(2)));
      const legPct = Math.round(draft.legRatio * 100);
      metricBar.textContent = draft.enabled
        ? tr(
            `📏 实时参数：${draft.headRatio} 头身（无头身长 ${bodyU}H） · 肩宽 ${draft.shoulderWidth}×头宽 · 腰 ${draft.waistWidth}× · 胯 ${draft.hipWidth}× · 腿占身长 ${legPct}%`,
            `📏 Live: ${draft.headRatio}H (Body ${bodyU}H) · Shld ${draft.shoulderWidth}×HW · Waist ${draft.waistWidth}× · Hip ${draft.hipWidth}× · Legs ${legPct}%`
          )
        : tr('⚪ 当前未启用体型覆盖（AI 将保持原画默认头身与肩胯比例）', '⚪ Parametric override off (keeps source art proportions)');
    };

    // Populate archetype quick pills
    pillsWrap.replaceChildren();
    for (const arch of PROPORTION_ARCHETYPES) {
      if (arch.id === 'keep' || arch.id === 'custom') continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ng-pill';
      btn.dataset.arch = arch.id;
      btn.textContent = tr(arch.zh.split('（')[0], arch.en);
      btn.onclick = () => {
        draft = createProportionSpecFromArchetype(arch.id);
        draft.enabled = true;
        syncControlsFromDraft();
        redrawLiveChart();
      };
      pillsWrap.append(btn);
    }

    // Populate 10 anatomical sliders
    sliderList.replaceChildren();
    for (const def of PROP_SLIDER_DEFS) {
      const row = document.createElement('label');
      row.className = 'prop-slider-row' + (def.hi ? ' highlight' : '');
      const lbl = document.createElement('span');
      lbl.textContent = tr(def.zh, def.en);
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(def.min);
      range.max = String(def.max);
      range.step = String(def.step);
      range.value = String(draft[def.key]);

      const num = document.createElement('input');
      num.type = 'number';
      num.min = String(def.min);
      num.max = String(def.max);
      num.step = String(def.step);
      num.value = String(draft[def.key]);

      const onVal = rawVal => {
        const v = Math.max(def.min, Math.min(def.max, Number(Number(rawVal).toFixed(2))));
        if (!Number.isFinite(v)) return;
        draft[def.key] = v;
        draft.enabled = true;
        draft.archetype = 'custom';
        range.value = String(v);
        num.value = String(v);
        enableChk.checked = true;
        enableBanner.dataset.disabled = '0';
        sliderList.style.opacity = '1';
        for (const b of pillsWrap.querySelectorAll('button[data-arch]')) b.classList.remove('active');
        redrawLiveChart();
      };
      range.oninput = ev => onVal(ev.target.value);
      num.onchange = ev => onVal(ev.target.value);

      row.append(lbl, range, num);
      sliderList.append(row);
      rowControls.set(def.key, {range, num});
    }

    enableChk.onchange = () => {
      draft.enabled = enableChk.checked;
      if (draft.enabled && (!draft.archetype || draft.archetype === 'keep')) draft.archetype = 'custom';
      syncControlsFromDraft();
      redrawLiveChart();
    };

    for (const tb of propStudioDlg.querySelectorAll('button[data-prop-theme]')) {
      tb.classList.toggle('active', tb.dataset.propTheme === propPreviewTheme);
      tb.onclick = () => {
        propPreviewTheme = tb.dataset.propTheme;
        for (const x of propStudioDlg.querySelectorAll('button[data-prop-theme]')) {
          x.classList.toggle('active', x === tb);
        }
        redrawLiveChart();
      };
    }

    for (const pb of propStudioDlg.querySelectorAll('button[data-prop-pose]')) {
      pb.onclick = () => {
        draft.pose = pb.dataset.propPose === 'a' ? 'a' : 't';
        draft.enabled = true;
        syncControlsFromDraft();
        redrawLiveChart();
      };
    }

    underlayChk.onchange = () => {
      if (underlayChk.checked && !srcUrl) {
        underlayChk.checked = false;
        hooks.toast(tr('请先在主立绘节点上传角色原画后再开启叠底对比', 'Upload a Source Concept image first to enable underlay'));
        return;
      }
      redrawLiveChart();
    };
    underlayOp.oninput = () => redrawLiveChart();

    propStudioDlg.querySelector('#propDownloadPngBtn').onclick = () => {
      const off = document.createElement('canvas');
      off.width = 1024;
      off.height = 1024;
      drawProportionMannequinToCanvas(off, draft, {size: 1024, theme: 'light', transparentBg: false, showLabels: true});
      off.toBlob(blob => {
        if (blob) hooks.download?.(blob, `MorphoGem_Proportion_${draft.headRatio}H.png`);
      }, 'image/png');
    };

    const closeStudio = () => propStudioDlg.close();
    propStudioDlg.querySelector('#propStudioCloseX').onclick = closeStudio;
    propStudioDlg.querySelector('#propCancelBtn').onclick = closeStudio;
    propStudioDlg.querySelector('#propApplyBtn').onclick = () => {
      pushUndo();
      g.proportionSpec = normalizeProportionSpec(draft);
      ensureGraphProportionSpec(g);
      refreshGlobalRatioSelect();
      hooks.changed();
      render();
      window.dispatchEvent(new CustomEvent('morphogem-ratio-changed', {
        detail: {ratio: g.proportionSpec.enabled ? g.proportionSpec.headRatio : null, spec: g.proportionSpec},
      }));
      closeStudio();
      hooks.toast(
        g.proportionSpec.enabled
          ? tr(`✓ 已应用自定义体型比例：${formatProportionSummary(g.proportionSpec, false)}`, `✓ Applied custom proportions: ${formatProportionSummary(g.proportionSpec, true)}`)
          : tr('✓ 已恢复为保持原画默认比例', '✓ Restored original concept proportions')
      );
    };

    syncControlsFromDraft();
    redrawLiveChart();
    if (!propStudioDlg.open) propStudioDlg.showModal();
  }

  // --- Multi-Color ID Mask Auto-Split & Part Naming Studio ---
  function parseMaskNoteLegend(noteStr) {
    const map = new Map();
    if (!noteStr) return map;
    for (const seg of String(noteStr).split(/[,，;；\n|]+/)) {
      const m = seg.trim().match(/^([^=:：]+)[=:：]\s*(.+)$/);
      if (m) map.set(m[1].trim().toLowerCase(), m[2].trim());
    }
    return map;
  }

  async function openMultiMaskSplitDialog(maskNodeId) {
    const g = currentGraph();
    const maskNode = getNode(g, maskNodeId);
    const maskDoc = maskNode?.data?.image;
    if (!maskNode || !maskDoc) {
      hooks.toast(tr('请先在此 Mask 节点上传多色遮罩图', 'Upload a Mask image onto this node first'));
      return;
    }
    const dec = await decodeSmallImage(maskDoc, 280, {withColorBlocks: true});
    if (!dec?.blocks?.length) {
      hooks.toast(tr('未在遮罩图中检测到有效前景颜色区域', 'No valid foreground color regions detected in mask'));
      return;
    }

    const srcDoc = g.nodes.find(n => n.type === 'source_image')?.data?.image || null;
    const legendMap = parseMaskNoteLegend(maskNode.params?.note || '');

    const rowsState = dec.blocks.map((blk, idx) => {
      const shortZh = blk.colorNameZh.replace(/色$/, '');
      const fromLegend =
        legendMap.get(blk.hex.toLowerCase()) ||
        legendMap.get(blk.colorNameZh.toLowerCase()) ||
        legendMap.get(shortZh) ||
        legendMap.get(blk.colorNameEn.toLowerCase()) ||
        '';
      const partName = fromLegend || tr(blk.suggestedPartNameZh, blk.suggestedPartNameEn);
      const isLowerOrBody = blk.centerY > 0.36 && blk.coveragePct > 6;
      return {
        enabled: true,
        hex: blk.hex,
        coveragePct: blk.coveragePct,
        partName,
        pose: isLowerOrBody ? 't' : 'natural',
        quality: 'high',
      };
    });

    multiMaskDlg.querySelector('#mmSplitTitle').textContent = tr(
      `🪄 多色块 Mask 自动识别与一键建分支（已识别 ${rowsState.length} 个色块）`,
      `🪄 Multi-Color ID Mask Auto-Split (${rowsState.length} Regions Detected)`
    );
    multiMaskDlg.querySelector('#mmSplitDesc').textContent = tr(
      '已自动过滤边缘抗锯齿过渡色并按从上到下顺序提取色块（左侧实时预览该色块对应原画的高亮区域）。确认部件名称后一键生成全套「拆图 + Tripo 3D」分支：',
      'Anti-aliased fringes filtered; regions ordered top-to-bottom with live concept-art highlight previews. Name each part and generate all branches in one click:'
    );
    multiMaskDlg.querySelector('#mmPickExtraBtn').textContent = tr('💧 图上手动吸取补充微小色块…', '💧 Pick Extra Small Color Region...');
    multiMaskDlg.querySelector('#mmReplaceEmptyLbl').textContent = tr(
      '自动清理画布原有的空白未生成拆件节点（推荐）',
      'Clean up unused empty placeholder part nodes on canvas'
    );
    multiMaskDlg.querySelector('#mmCancelBtn').textContent = tr('取消', 'Cancel');

    const listEl = multiMaskDlg.querySelector('#mmRegionList');
    const confirmBtn = multiMaskDlg.querySelector('#mmConfirmGenerateBtn');

    const updateConfirmBtnText = () => {
      const activeCnt = rowsState.filter(r => r.enabled).length;
      confirmBtn.disabled = activeCnt === 0;
      confirmBtn.textContent = tr(
        `✨ 一键生成 ${activeCnt} 组「拆件 + Tripo 建模」分支`,
        `✨ Generate ${activeCnt} Part + Tripo 3D Branches`
      );
    };

    const renderRows = () => {
      listEl.replaceChildren();
      rowsState.forEach((st, idx) => {
        const row = document.createElement('div');
        row.className = 'mm-region-row';
        row.dataset.off = st.enabled ? '0' : '1';

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = st.enabled;
        chk.onchange = () => {
          st.enabled = chk.checked;
          row.dataset.off = st.enabled ? '0' : '1';
          updateConfirmBtnText();
        };

        const cvs = document.createElement('canvas');
        cvs.className = 'mm-region-thumb';
        cvs.width = 96;
        cvs.height = 96;
        void paintLiveMaskHighlightThumb(cvs, srcDoc, maskDoc, 'color', st.hex, 96);

        const swCol = document.createElement('div');
        swCol.style.cssText = 'display:flex;flex-direction:column;gap:3px;align-items:flex-start';
        const cInp = document.createElement('input');
        cInp.type = 'color';
        cInp.value = st.hex;
        cInp.style.cssText = 'width:44px;height:24px;padding:0;border:1px solid #475569;border-radius:5px;background:transparent;cursor:pointer';
        cInp.onchange = () => {
          st.hex = cInp.value;
          hexSpan.textContent = st.hex;
          void paintLiveMaskHighlightThumb(cvs, srcDoc, maskDoc, 'color', st.hex, 96);
        };
        const hexSpan = document.createElement('span');
        hexSpan.style.cssText = 'font-size:10px;color:#94a3b8;font-family:monospace';
        hexSpan.textContent = st.coveragePct ? `${st.hex} (${st.coveragePct}%)` : st.hex;
        swCol.append(cInp, hexSpan);

        const nameInp = document.createElement('input');
        nameInp.type = 'text';
        nameInp.className = 'ng-input';
        nameInp.value = st.partName;
        nameInp.placeholder = tr('输入部件名称，如：双马尾 / 外套 / 百褶裙', 'Part name, e.g. Hair / Coat / Skirt');
        nameInp.oninput = () => { st.partName = nameInp.value; };

        const poseSel = document.createElement('select');
        poseSel.className = 'ng-select';
        poseSel.style.cssText = 'width:100%;font-size:11px;height:28px';
        poseSel.innerHTML = `
          <option value="natural">${tr('自然端正姿态', 'Natural Upright')}</option>
          <option value="t">T-Pose</option>
          <option value="a">A-Pose</option>
        `;
        poseSel.value = st.pose;
        poseSel.onchange = () => { st.pose = poseSel.value; };

        const qSel = document.createElement('select');
        qSel.className = 'ng-select';
        qSel.style.cssText = 'width:100%;font-size:11px;height:28px';
        qSel.innerHTML = `
          <option value="high">${tr('HD 高精百万面', 'HD High-Poly')}</option>
          <option value="smart">${tr('Smart 智能低模+UV', 'Smart Quad + UV')}</option>
        `;
        qSel.value = st.quality;
        qSel.onchange = () => { st.quality = qSel.value; };

        row.append(chk, cvs, swCol, nameInp, poseSel, qSel);
        listEl.append(row);
      });
      updateConfirmBtnText();
    };

    multiMaskDlg.querySelector('#mmPickExtraBtn').onclick = () => {
      openMaskColorPicker(fileUrl(maskDoc), pickedHex => {
        const [r, g2, b] = hexToRgb(pickedHex);
        const cname = friendlyColorName(r, g2, b, isEn());
        rowsState.push({
          enabled: true,
          hex: pickedHex,
          coveragePct: 0,
          partName: tr(`${cname}补充部件 ${rowsState.length + 1}`, `${cname} Extra Part ${rowsState.length + 1}`),
          pose: 'natural',
          quality: 'high',
        });
        renderRows();
      });
    };

    const closeMm = () => multiMaskDlg.close();
    multiMaskDlg.querySelector('#mmSplitCloseX').onclick = closeMm;
    multiMaskDlg.querySelector('#mmCancelBtn').onclick = closeMm;

    confirmBtn.onclick = async () => {
      const chosen = rowsState.filter(r => r.enabled);
      if (!chosen.length) return;
      const cleanEmpty = Boolean(multiMaskDlg.querySelector('#mmReplaceEmptyChk')?.checked);

      pushUndo();
      const {project: curP, files: curF} = hooks.get();
      const p = structuredClone(curP);
      const f = new Map(curF);
      const pg = ensureNodeGraph(p);

      if (cleanEmpty) {
        const emptyPartIds = pg.nodes
          .filter(n => n.type === 'part_views' && !isNodeLocked(n.id) && !Object.values(n.data?.views || {}).some(Boolean))
          .map(n => n.id);
        for (const pid of emptyPartIds) {
          const downMeshes = pg.edges
            .filter(e => e.fromNode === pid && e.fromPort === 'views')
            .map(e => getNode(pg, e.toNode))
            .filter(mn => mn && mn.type === 'tripo_mesh' && !isNodeLocked(mn.id) && !(mn.data?.candidates?.length));
          for (const mn of downMeshes) removeNode(pg, p, mn.id);
          removeNode(pg, p, pid);
        }
      }

      const srcN = pg.nodes.find(n => n.type === 'source_image');
      const mskN = getNode(pg, maskNodeId);
      const styN = pg.nodes.find(n => n.type === 'style_ref');
      const asmN = pg.nodes.find(n => n.type === 'assembly_export');

      const existingPartYs = pg.nodes.filter(n => n.type === 'part_views').map(n => n.y);
      const startY = existingPartYs.length ? Math.max(...existingPartYs) + 300 : 60;
      const rowGap = 295;

      chosen.forEach((item, i) => {
        const pName = (item.partName || '').trim() || `Mask部件 ${i + 1}`;
        const y = startY + i * rowGap;
        const pv = createNode('part_views', 430, y, {
          partName: pName,
          promptHint: tr(
            `严格仅提取多色 Mask 中 ${item.hex} 色块覆盖的独立部件，去除外围其余部位遮挡并补全背面闭环结构`,
            `Strictly extract ONLY the component marked by color ${item.hex} in the ID Mask and reconstruct occluded back surfaces`
          ),
          pose: item.pose || 'natural',
          resolution: 1024,
          maskMode: 'color',
          maskColor: item.hex,
        });
        const isSmart = item.quality === 'smart';
        const tm = createNode('tripo_mesh', 810, y, {
          title: `Tripo · ${pName}`,
          quality: isSmart ? 'smart' : 'high',
          aiModel: isSmart ? 'P2.0' : 'H3.5',
          smartUv: true,
          autoRetexture: true,
          polyFaces: isSmart ? 20000 : 2000000,
          textureSize: 4096,
          removeLighting: true,
        });
        pg.nodes.push(pv, tm);
        if (srcN) try { connectPorts(pg, srcN.id, 'image', pv.id, 'source'); } catch {}
        if (mskN) try { connectPorts(pg, mskN.id, 'mask', pv.id, 'mask'); } catch {}
        if (styN) try { connectPorts(pg, styN.id, 'style', pv.id, 'style'); } catch {}
        try { connectPorts(pg, pv.id, 'views', tm.id, 'views'); } catch {}
        if (asmN) try { connectPorts(pg, tm.id, 'mesh', asmN.id, 'meshes'); } catch {}
      });

      // Position balance_views nicely below all part_views & center assembly_export
      const balN = pg.nodes.find(n => n.type === 'balance_views');
      const allPartYs = pg.nodes.filter(n => n.type === 'part_views').map(n => n.y);
      if (allPartYs.length) {
        const maxPy = Math.max(...allPartYs);
        if (balN && balN.y <= maxPy + 180) balN.y = maxPy + rowGap;
        if (asmN) asmN.y = Math.round((Math.min(...allPartYs) + maxPy) * 0.5);
      }

      // Also record helpful legend summary into maskNode.params.note if empty
      if (mskN && !(mskN.params?.note || '').trim().includes('=')) {
        mskN.params.note = chosen.map(c => `${c.hex}=${(c.partName || '').trim()}`).join(', ');
      }

      validateProject(p);
      await hooks.commit(p, f);
      closeMm();
      render();
      fitCanvas(false);
      hooks.toast(tr(
        `✓ 已按多色 Mask 自动生成 ${chosen.length} 组彩色连线拆件 + Tripo 建模分支！`,
        `✓ Auto-generated ${chosen.length} color-coded Mask split + Tripo 3D branches!`
      ));
    };

    renderRows();
    if (!multiMaskDlg.open) multiMaskDlg.showModal();
  }

  function buildNodeBody(g, node) {
    const body = document.createElement('div');
    body.className = 'ng-body';

    if (node.type === 'source_image' || node.type === 'mask_ref' || node.type === 'style_ref' || node.type === 'ratio_ref') {
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
          : node.type === 'mask_ref'
            ? '点击或拖入 Mask 分区遮罩图（支持黑白遮罩 / 涂鸦 / 多色 ID 图）'
            : node.type === 'style_ref'
              ? '点击或拖入画风参考图（不连则用原画画风）'
              : '点击或拖入头身比参考图（旧版兼容，推荐使用顶部参数化头身比）';
        drop.append(hint);
      }
      drop.onclick = () => {
        pendingUploadTarget = {nodeId: node.id, viewKey: null};
        hiddenImgPicker.click();
      };
      drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = node.type === 'mask_ref' ? '#f43f5e' : '#60a5fa'; };
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
        noteField.innerHTML = `<span>${node.type === 'mask_ref' ? 'Mask 颜色分区说明（可选）' : '参考要求说明'}</span>`;
        const inp = document.createElement('input');
        inp.className = 'ng-input';
        inp.value = node.params?.note || '';
        inp.placeholder = node.type === 'mask_ref'
          ? '例如：红=外套，蓝=长裙，绿=披肩饰品'
          : '例如：偏二次元赛璐璐上色';
        inp.onchange = () => {
          node.params.note = inp.value.trim();
          hooks.changed();
          updateStatusesOnly();
        };
        noteField.append(inp);
        body.append(noteField);
      }

      if (node.type === 'mask_ref' && node.data?.image) {
        const swatchWrap = document.createElement('div');
        swatchWrap.className = 'ng-mask-swatches';
        swatchWrap.textContent = tr('正在扫描色块分区…', 'Scanning color regions…');

        const splitBtn = document.createElement('button');
        splitBtn.type = 'button';
        splitBtn.className = 'ng-btn primary';
        splitBtn.style.justifyContent = 'center';
        splitBtn.textContent = tr('🪄 按色块一键生成拆件分支…', '🪄 Auto-Split Color Regions...');
        splitBtn.onclick = () => void openMultiMaskSplitDialog(node.id);

        body.append(swatchWrap, splitBtn);

        void decodeSmallImage(node.data.image, 260, {withColorBlocks: true}).then(dec => {
          if (!swatchWrap.isConnected) return;
          const blocks = dec?.blocks || [];
          swatchWrap.replaceChildren();
          if (!blocks.length) {
            swatchWrap.textContent = tr('未检测到前景遮罩色块', 'No foreground mask regions detected');
            return;
          }
          for (const blk of blocks) {
            const chip = document.createElement('span');
            chip.className = 'ng-mask-chip';
            chip.title = `${blk.hex} · ${blk.coveragePct}%`;
            chip.innerHTML = `<span class="ng-mask-chip-dot" style="background:${blk.hex}"></span>${tr(blk.colorNameZh, blk.colorNameEn)} ${blk.coveragePct}%`;
            swatchWrap.append(chip);
          }
          splitBtn.textContent = tr(
            `🪄 按 ${blocks.length} 个色块一键生成拆件分支`,
            `🪄 Auto-Generate ${blocks.length} Color Branches`
          );
        });
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

        // Mask-Driven Part Extraction Control (supports upstream `mask_ref` wire OR inline Mask upload!)
        const srcEdgeForMask = incomingEdges(g, node.id).find(e => e.toPort === 'source');
        const srcDocForMask = srcEdgeForMask ? getNode(g, srcEdgeForMask.fromNode)?.data?.image : null;
        const maskEdge = incomingEdges(g, node.id).find(e => e.toPort === 'mask');
        const maskSrcNode = maskEdge ? getNode(g, maskEdge.fromNode) : null;
        const activeMaskDoc = maskSrcNode?.data?.image || node.data?.maskImage || null;
        const activeMaskUrl = fileUrl(activeMaskDoc);

        const maskBox = document.createElement('div');
        maskBox.className = 'ng-mask-box' + (activeMaskDoc ? ' active' : '');
        if (activeMaskDoc && node.params?.maskMode === 'color' && /^#[0-9a-fA-F]{6}$/.test(node.params?.maskColor || '')) {
          maskBox.style.borderColor = node.params.maskColor;
        }
        const maskHead = document.createElement('div');
        maskHead.className = 'ng-mask-row';

        let thumbEl;
        if (activeMaskDoc) {
          const liveCvs = document.createElement('canvas');
          liveCvs.className = 'ng-mask-live-thumb';
          liveCvs.width = 72;
          liveCvs.height = 72;
          liveCvs.title = tr('实时预览：主立绘压暗 + 仅高亮当前节点负责的遮罩区域', 'Live isolated highlight preview for this node');
          void paintLiveMaskHighlightThumb(
            liveCvs,
            srcDocForMask,
            activeMaskDoc,
            node.params?.maskMode || 'auto',
            node.params?.maskColor || '#ff3b30',
            72
          );
          thumbEl = liveCvs;
        } else {
          const thumb = document.createElement('div');
          thumb.className = 'ng-mask-thumb';
          thumb.textContent = '🎭';
          thumbEl = thumb;
        }

        const metaCol = document.createElement('div');
        metaCol.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px';
        const mTitle = document.createElement('span');
        mTitle.style.cssText = 'font-size:11px;font-weight:700;color:#fda4af';
        mTitle.textContent = maskSrcNode
          ? (node.params?.maskMode === 'color'
              ? tr(`🎭 多色分区 · ${node.params.maskColor || ''}`, `🎭 Color Mask · ${node.params.maskColor || ''}`)
              : tr('🎭 已连入上游 Mask 遮罩图', '🎭 Linked Upstream Mask'))
          : node.data?.maskImage
            ? tr('🎭 已挂载本节点专属 Mask 图', '🎭 Inline Part Mask Attached')
            : tr('🎭 Mask 遮罩拆件（可选 · 点击或拖入）', '🎭 Part Mask (Optional · Click/Drop)');
        const mSub = document.createElement('span');
        mSub.style.cssText = 'font-size:10px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        mSub.textContent = activeMaskDoc
          ? tr('左侧已实时预览本节点扣出的高亮部位', 'Live target-part highlight preview active')
          : tr('提供黑白遮罩或多色 ID 图，自动合成高亮边界引导拆件', 'Upload B/W, alpha, or ID mask for exact boundary split');
        metaCol.append(mTitle, mSub);
        maskHead.append(thumbEl, metaCol);

        if (!maskSrcNode && node.data?.maskImage && !isNodeLocked(node.id)) {
          const clrBtn = document.createElement('button');
          clrBtn.type = 'button';
          clrBtn.className = 'ng-btn danger';
          clrBtn.style.cssText = 'height:22px;padding:0 6px;font-size:10.5px';
          clrBtn.title = tr('移除本节点内嵌 Mask', 'Remove inline mask');
          clrBtn.textContent = '✕';
          clrBtn.onclick = async ev => {
            ev.stopPropagation();
            const {project: curP, files: curF} = hooks.get();
            const p = structuredClone(curP);
            const f = new Map(curF);
            const gn = getNode(ensureNodeGraph(p), node.id);
            if (gn?.data) gn.data.maskImage = null;
            pruneUnusedGraphDocuments(p, f);
            await hooks.commit(p, f);
            render();
          };
          maskHead.append(clrBtn);
        }

        if (!maskSrcNode) {
          maskHead.style.cursor = 'pointer';
          maskHead.onclick = () => {
            if (isNodeLocked(node.id)) return;
            pendingUploadTarget = {nodeId: node.id, viewKey: '__mask__'};
            hiddenImgPicker.click();
          };
          maskBox.ondragover = ev => { ev.preventDefault(); maskBox.style.borderColor = '#fb7185'; };
          maskBox.ondragleave = () => { maskBox.style.borderColor = ''; };
          maskBox.ondrop = ev => {
            ev.preventDefault();
            maskBox.style.borderColor = '';
            const file = ev.dataTransfer?.files?.[0];
            if (file) void handleImageUpload(file, node.id, '__mask__');
          };
        }
        maskBox.append(maskHead);

        if (activeMaskDoc || maskSrcNode) {
          const modeRow = document.createElement('div');
          modeRow.className = 'ng-mask-row';
          const modeSel = document.createElement('select');
          modeSel.style.cssText = 'flex:1;height:24px;font-size:11px;background:#0d1322;color:#f1f5f9;border:1px solid #3f283d;border-radius:5px;padding:0 6px';
          const modes = [
            ['auto', tr('自动识别遮罩前景 (黑白/透明/涂色)', 'Auto Detect Mask Region')],
            ['white', tr('白色区域 = 当前拆出部件', 'White Pixels = Target Part')],
            ['alpha', tr('不透明区域 (Alpha) = 当前拆出部件', 'Opaque Alpha = Target Part')],
            ['color', tr('多色 ID Mask · 指定颜色分区', 'Multi-Color ID Mask · Pick Color')],
          ];
          for (const [mv, ml] of modes) {
            const o = document.createElement('option');
            o.value = mv;
            o.textContent = ml;
            modeSel.append(o);
          }
          modeSel.value = node.params?.maskMode || 'auto';
          modeSel.onchange = () => {
            node.params.maskMode = modeSel.value;
            hooks.changed();
            render();
          };
          modeRow.append(modeSel);

          if ((node.params?.maskMode || 'auto') === 'color') {
            const colInp = document.createElement('input');
            colInp.type = 'color';
            colInp.value = /^#[0-9a-fA-F]{6}$/.test(node.params?.maskColor || '') ? node.params.maskColor : '#ff3b30';
            colInp.style.cssText = 'width:26px;height:24px;padding:0;border:1px solid #fb7185;border-radius:4px;background:transparent;cursor:pointer';
            colInp.onchange = () => {
              node.params.maskColor = colInp.value;
              hooks.changed();
              render();
            };
            const pickBtn = document.createElement('button');
            pickBtn.type = 'button';
            pickBtn.className = 'ng-btn';
            pickBtn.style.cssText = 'height:24px;padding:0 6px;font-size:10.5px';
            pickBtn.title = tr('在 Mask 图上点击吸取目标颜色', 'Sample color directly from Mask image');
            pickBtn.textContent = tr('💧吸色', '💧Pick');
            pickBtn.onclick = () => {
              openMaskColorPicker(activeMaskUrl, hex => {
                node.params.maskColor = hex;
                hooks.changed();
                render();
              });
            };
            modeRow.append(colInp, pickBtn);
          }
          maskBox.append(modeRow);
        }
        body.append(maskBox);
      } else {
        // balance_views: live miniature preview of the custom parametric proportion chart + 1-click live studio opener!
        const pSpec = ensureGraphProportionSpec(g);
        const miniCard = document.createElement('div');
        miniCard.className = 'ng-prop-mini-card';
        miniCard.title = tr('点击打开可视化体型比例设计器，实时拖动滑块调整头身比、肩宽、腰胯与腿长', 'Click to open Live Body Proportion Studio');

        const miniCvs = document.createElement('canvas');
        miniCvs.className = 'ng-prop-mini-canvas';
        miniCvs.width = 160;
        miniCvs.height = 160;
        drawProportionMannequinToCanvas(miniCvs, pSpec, {
          size: 160,
          theme: pSpec.enabled ? 'light' : 'blueprint',
          showLabels: false,
        });

        const miniInfo = document.createElement('div');
        miniInfo.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:3px';
        const line1 = document.createElement('strong');
        line1.style.cssText = 'font-size:11.5px;color:#5eead4';
        line1.textContent = pSpec.enabled
          ? `🧍 ${tr('自定义体型强约束已生效', 'Custom Body Proportions Active')}`
          : `🧍 ${tr('体型：保持原画比例', 'Body: Keep Source Art')}`;
        const line2 = document.createElement('span');
        line2.style.cssText = 'font-size:10.5px;color:#e2e8f0';
        line2.textContent = formatProportionSummary(pSpec, isEn());
        const line3 = document.createElement('span');
        line3.style.cssText = 'font-size:10px;color:#38bdf8';
        line3.textContent = tr('✏️ 点击实时调节肩宽/腰胯/腿长比例图…', '✏️ Click to live-adjust shoulder/hip/leg chart...');

        miniInfo.append(line1, line2, line3);
        miniCard.append(miniCvs, miniInfo);
        miniCard.onclick = () => openProportionStudio({autoEnableIfOff: true});
        body.append(miniCard);
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
      let loadedViewCount = 0;
      const grid = document.createElement('div');
      grid.className = 'ng-views-grid' + (keys.length === 3 ? ' cols-3' : '');
      for (const k of keys) {
        const cell = document.createElement('div');
        cell.className = 'ng-view-cell';
        const doc = node.data?.views?.[k];
        const u = fileUrl(doc);
        if (u) {
          loadedViewCount++;
          const img = document.createElement('img');
          img.src = u;
          img.alt = k;
          cell.append(img);
        }
        const tag = document.createElement('span');
        tag.textContent = VIEW_LABELS[k] || k;
        cell.append(tag);
        cell.title = u
          ? tr('点击同屏展开全部视图对比检视', 'Click to expand all views side-by-side')
          : tr('点击或拖入上传此视角图片', 'Click or drop to upload this view');
        cell.onclick = () => {
          pendingUploadTarget = {nodeId: node.id, viewKey: k};
          if (u) {
            openMultiViewInspector(node.id, k);
          } else {
            if (isNodeLocked(node.id)) {
              hooks.toast('🔒 该节点正在执行任务中，请等待 AI 生成视图完成');
              return;
            }
            hiddenImgPicker.click();
          }
        };
        cell.ondragover = ev => { ev.preventDefault(); cell.style.borderColor = '#38bdf8'; };
        cell.ondragleave = () => { cell.style.borderColor = ''; };
        cell.ondrop = ev => {
          ev.preventDefault();
          cell.style.borderColor = '';
          const file = ev.dataTransfer?.files?.[0];
          if (file) void handleImageUpload(file, node.id, k);
        };
        grid.append(cell);
      }
      body.append(grid);

      const expandAllBtn = document.createElement('button');
      expandAllBtn.type = 'button';
      expandAllBtn.className = 'ng-btn cyan';
      expandAllBtn.style.justifyContent = 'center';
      expandAllBtn.textContent = keys.length === 3
        ? tr(`🔍 同屏展开三视图对比 (${loadedViewCount}/3)`, `🔍 Inspect All 3 Views (${loadedViewCount}/3)`)
        : tr(`🔍 同屏展开四视图对比 (${loadedViewCount}/4)`, `🔍 Inspect All 4 Views (${loadedViewCount}/4)`);
      expandAllBtn.onclick = () => openMultiViewInspector(node.id, null);

      const singleReqBtn = document.createElement('button');
      singleReqBtn.type = 'button';
      singleReqBtn.className = 'ng-btn';
      singleReqBtn.style.justifyContent = 'center';
      singleReqBtn.textContent = tr('仅复制此节点拆图指令', 'Copy AI Prompt for This Node Only');
      singleReqBtn.onclick = () => hooks.requestGraphViews([node.id]);
      body.append(expandAllBtn, singleReqBtn);
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
          node.params.smartUv ??= true;
          node.params.autoRetexture ??= true;
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

      let smartPostBox = null;
      const isSmartMode = node.params.quality === 'smart';
      const texEnabled = !isSmartMode || node.params.autoRetexture !== false;

      if (isSmartMode) {
        smartPostBox = document.createElement('div');
        smartPostBox.style.cssText = 'display:flex;flex-direction:column;gap:5px;padding:7px 9px;border-radius:8px;background:rgba(6,182,212,0.10);border:1px solid rgba(56,189,248,0.32)';

        const uvLbl = document.createElement('label');
        uvLbl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:#bae6fd;font-weight:600;cursor:pointer';
        const uvChk = document.createElement('input');
        uvChk.type = 'checkbox';
        uvChk.checked = node.params.smartUv !== false;
        uvChk.onchange = () => {
          node.params.smartUv = uvChk.checked;
          hooks.changed();
          updateStatusesOnly();
        };
        uvLbl.append(uvChk, document.createTextNode(tr('重展开 Smart UV（规整低模 UV 岛）', 'Unwrap Smart UV (clean low-poly UVs)')));

        const retexLbl = document.createElement('label');
        retexLbl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:#e0f2fe;font-weight:600;cursor:pointer';
        const retexChk = document.createElement('input');
        retexChk.type = 'checkbox';
        retexChk.checked = node.params.autoRetexture !== false;
        retexChk.onchange = () => {
          node.params.autoRetexture = retexChk.checked;
          hooks.changed();
          render();
        };
        retexLbl.append(retexChk, document.createTextNode(tr('四视图自动上色（Retexture 烘焙贴图）', 'Auto 4-View Retexture (bake textures)')));

        smartPostBox.append(uvLbl, retexLbl);
      }

      const tRow = document.createElement('div');
      tRow.className = 'ng-row2';
      const texField = document.createElement('label');
      texField.className = 'ng-field';
      texField.innerHTML = '<span>贴图精度</span><select><option value="4096">4K 标准</option><option value="8192">8K 超清</option></select>';
      const texSel = texField.querySelector('select');
      texSel.value = String(node.params.textureSize || 4096);
      texSel.disabled = !texEnabled;
      texSel.onchange = () => { node.params.textureSize = Number(texSel.value); hooks.changed(); updateStatusesOnly(); };

      const cntField = document.createElement('label');
      cntField.className = 'ng-field';
      cntField.innerHTML = '<span>生成候选数</span><select><option value="1">1 个</option><option value="2">2 个</option><option value="3">3 个</option><option value="4">4 个</option></select>';
      const cntSel = cntField.querySelector('select');
      cntSel.value = String(node.params.candidateCount || 1);
      cntSel.onchange = () => { node.params.candidateCount = Number(cntSel.value); hooks.changed(); updateStatusesOnly(); };
      tRow.append(texField, cntField);

      const lightLabel = document.createElement('label');
      lightLabel.style.cssText = `display:flex;align-items:center;gap:6px;font-size:11.5px;color:#cbd5e1;cursor:pointer;opacity:${texEnabled ? '1' : '0.45'}`;
      const lightChk = document.createElement('input');
      lightChk.type = 'checkbox';
      lightChk.checked = Boolean(node.params.removeLighting);
      lightChk.disabled = !texEnabled;
      lightChk.onchange = () => { node.params.removeLighting = lightChk.checked; hooks.changed(); updateStatusesOnly(); };
      lightLabel.append(lightChk, document.createTextNode('去除烘焙高光与阴影（适合二次元/MToon）'));

      body.append(qRow, polyField);
      if (smartPostBox) body.append(smartPostBox);
      body.append(tRow, lightLabel);

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

    if (node.type === 'tripo_retexture') {
      const optsBox = document.createElement('div');
      optsBox.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 9px;border-radius:8px;background:rgba(139,92,246,0.10);border:1px solid rgba(167,139,250,0.32)';

      const uvLbl = document.createElement('label');
      uvLbl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:#ddd6fe;font-weight:600;cursor:pointer';
      const uvChk = document.createElement('input');
      uvChk.type = 'checkbox';
      uvChk.checked = node.params.smartUv !== false;
      uvChk.onchange = () => { node.params.smartUv = uvChk.checked; hooks.changed(); updateStatusesOnly(); };
      uvLbl.append(uvChk, document.createTextNode(tr('先执行 Smart UV 重展开（≤8万面推荐）', 'Run Smart UV Unwrap first (≤80k faces)')));

      const rtLbl = document.createElement('label');
      rtLbl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:#ede9fe;font-weight:600;cursor:pointer';
      const rtChk = document.createElement('input');
      rtChk.type = 'checkbox';
      rtChk.checked = node.params.retexture !== false;
      rtChk.onchange = () => { node.params.retexture = rtChk.checked; hooks.changed(); render(); };
      rtLbl.append(rtChk, document.createTextNode(tr('执行多视图贴图上色（Retexture）', 'Run Multi-View Retexture')));

      optsBox.append(uvLbl, rtLbl);
      body.append(optsBox);

      const needRetex = node.params.retexture !== false;
      if (needRetex) {
        const texField = document.createElement('label');
        texField.className = 'ng-field';
        texField.innerHTML = '<span>上色贴图分辨率</span><select><option value="4096">4K 标准</option><option value="8192">8K 超清</option></select>';
        const texSel = texField.querySelector('select');
        texSel.value = String(node.params.textureSize || 4096);
        texSel.onchange = () => { node.params.textureSize = Number(texSel.value); hooks.changed(); updateStatusesOnly(); };

        const pbrLbl = document.createElement('label');
        pbrLbl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:#cbd5e1;cursor:pointer';
        const pbrChk = document.createElement('input');
        pbrChk.type = 'checkbox';
        pbrChk.checked = node.params.pbr !== false;
        pbrChk.onchange = () => { node.params.pbr = pbrChk.checked; hooks.changed(); updateStatusesOnly(); };
        pbrLbl.append(pbrChk, document.createTextNode(tr('生成 PBR 粗糙度/金属度贴图', 'Generate PBR Metallic/Roughness maps')));

        const lightLbl = document.createElement('label');
        lightLbl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:#cbd5e1;cursor:pointer';
        const lightChk = document.createElement('input');
        lightChk.type = 'checkbox';
        lightChk.checked = Boolean(node.params.removeLighting);
        lightChk.onchange = () => { node.params.removeLighting = lightChk.checked; hooks.changed(); updateStatusesOnly(); };
        lightLbl.append(lightChk, document.createTextNode(tr('去除烘焙高光与阴影（二次元推荐）', 'Remove Baked Lighting (Anime/Toon)')));

        const pv = resolveUpstreamViewsNode(g, node.id);
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px;color:#94a3b8;line-height:1.4';
        hint.textContent = pv
          ? tr(`参考视图源：${pv.params?.partName || pv.id}`, `Views source: ${pv.params?.partName || pv.id}`)
          : tr('提示：未单独连入四视图时自动继承上游建模节点的四视图', 'Auto-inherits upstream 4-views unless wired');

        body.append(texField, pbrLbl, lightLbl, hint);
      }

      const mEdge = incomingEdges(g, node.id, 'mesh')[0];
      const upMesh = mEdge ? getNode(g, mEdge.fromNode) : null;
      const upReady = Array.isArray(upMesh?.data?.candidates) && upMesh.data.candidates.length > 0;
      const pv = resolveUpstreamViewsNode(g, node.id);
      const viewsReady = pv && GRAPH_VIEWS_4.every(k => pv.data?.views?.[k]?.sha256);
      const canRun = upReady && (!needRetex || viewsReady) && (needRetex || node.params.smartUv !== false);
      const busy = tripoExecutingIds.has(node.id) || isNodeLocked(node.id);

      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'ng-btn violet';
      runBtn.style.justifyContent = 'center';
      runBtn.disabled = busy || !canRun;
      runBtn.textContent = tripoExecutingIds.has(node.id)
        ? tr('⏳ 正在重展 UV / 上色…', '⏳ Unwrapping UV / Retexturing...')
        : node.data?.candidates?.length
          ? tr('▶ 重新执行 UV 与上色', '▶ Re-run Smart UV & Retexture')
          : tr('▶ 执行 UV 重展开与上色', '▶ Run Smart UV & Retexture');
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
    refreshGlobalRatioSelect();
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
    const sel = $('#ngTemplateSelect');
    const g = currentGraph();
    if (hasAnyLockedNode()) {
      if (sel) sel.value = g.preset || 'standard_split';
      hooks.toast(tr(
        '🔒 当前有正在执行或等待拆图的锁定节点，请等待完成或先取消锁定后再切换模板',
        '🔒 Nodes are currently locked by an active task. Finish or unlock before switching templates.'
      ));
      return;
    }

    try {
      const hasWork = g.nodes.some(
        n => (n.data?.candidates?.length > 0) || (n.data?.views && Object.values(n.data.views).some(Boolean))
      );
      if (hasWork) {
        const ok = await askConfirmDialog(
          tr('切换整图模板确认', 'Switch Graph Template'),
          tr(
            '切换模板将重置当前画布的拆件节点与已生成模型（已上传的主立绘/参考图会自动保留）。确定要切换吗？',
            'Switching templates resets part nodes and generated meshes on this canvas (uploaded reference images are automatically preserved). Continue?'
          )
        );
        if (!ok) {
          if (sel) sel.value = g.preset || 'standard_split';
          return;
        }
      }

      const oldSrc = g.nodes.find(n => n.type === 'source_image')?.data?.image || null;
      const oldMask = g.nodes.find(n => n.type === 'mask_ref')?.data?.image || null;
      const oldStyle = g.nodes.find(n => n.type === 'style_ref')?.data?.image || null;
      const oldRatio = g.nodes.find(n => n.type === 'ratio_ref')?.data?.image || null;
      const prevPropSpec = structuredClone(ensureGraphProportionSpec(g));
      const {project: curP, files: curF} = hooks.get();
      const p = structuredClone(curP);
      const f = new Map(curF);
      let appliedLabel = presetKey;

      if (String(presetKey).startsWith('mod:')) {
        let matchedMod = null;
        let matchedTpl = null;
        for (const mod of (globalThis.__morphogemLoadedMods || []).filter(m => m.enabled)) {
          const found = (mod.templates || []).find(t => t.id === presetKey);
          if (found) { matchedMod = mod; matchedTpl = found; break; }
        }
        if (!matchedTpl) {
          if (sel) sel.value = g.preset || 'standard_split';
          hooks.toast(tr('未找到该 Mod 模板（对应 Mod 可能已禁用）', 'Mod template not found or disabled'));
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
        appliedLabel = matchedTpl.name;
      } else if (String(presetKey).startsWith('custom:')) {
        const tplId = presetKey.slice(7);
        const found = userPresets.templates.find(t => t.id === tplId);
        if (!found) {
          if (sel) sel.value = g.preset || 'standard_split';
          hooks.toast(tr('未找到该自定义模板', 'Custom template not found'));
          return;
        }
        p.nodeGraph = instantiateGraphFromTemplate(found);
        p.nodeGraph.preset = presetKey;
        delete p.nodeGraph.modMeta;
        appliedLabel = found.name;
      } else {
        p.nodeGraph = createTemplateGraph(presetKey);
        p.nodeGraph.preset = presetKey;
        delete p.nodeGraph.modMeta;
        const selOpt = sel?.querySelector(`option[value="${CSS.escape(presetKey)}"]`);
        appliedLabel = selOpt ? selOpt.textContent : presetKey;
      }

      p.placements = {};
      p.nodeGraph.proportionSpec = prevPropSpec;
      ensureGraphProportionSpec(p.nodeGraph);
      if (oldSrc) { const s = p.nodeGraph.nodes.find(n => n.type === 'source_image'); if (s) s.data.image = oldSrc; }
      if (oldMask) { const s = p.nodeGraph.nodes.find(n => n.type === 'mask_ref'); if (s) s.data.image = oldMask; }
      if (oldStyle) { const s = p.nodeGraph.nodes.find(n => n.type === 'style_ref'); if (s) s.data.image = oldStyle; }
      if (oldRatio) { const s = p.nodeGraph.nodes.find(n => n.type === 'ratio_ref'); if (s) s.data.image = oldRatio; }
      pruneUnusedGraphDocuments(p, f);
      selectedNodeIds.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      await hooks.commit(p, f);
      render();
      fitCanvas(false);
      hooks.toast(tr(`✓ 已切换模板：${appliedLabel}`, `✓ Switched template: ${appliedLabel}`));
    } catch (err) {
      if (sel) sel.value = g.preset || 'standard_split';
      hooks.toast(err?.message || String(err));
    }
  }

  // --- Toolbar Bindings ---
  $('#ngTemplateSelect').onchange = ev => void applyTemplateByKey(ev.target.value);
  $('#ngApplyTemplate').onclick = () => void applyTemplateByKey($('#ngTemplateSelect').value);
  $('#ngGlobalRatioSelect').onchange = ev => {
    const chosenId = ev.target.value || 'keep';
    if (chosenId === 'custom') {
      openProportionStudio({autoEnableIfOff: true});
      return;
    }
    const g = currentGraph();
    pushUndo();
    g.proportionSpec = createProportionSpecFromArchetype(chosenId);
    ensureGraphProportionSpec(g);
    refreshGlobalRatioSelect();
    hooks.changed();
    render();
    window.dispatchEvent(new CustomEvent('morphogem-ratio-changed', {
      detail: {ratio: g.proportionSpec.enabled ? g.proportionSpec.headRatio : null, spec: g.proportionSpec},
    }));
    hooks.toast(
      g.proportionSpec.enabled
        ? tr(`📏 已载入体型预设：${formatProportionSummary(g.proportionSpec, false)}（点右侧「🧍调体型」可实时微调肩宽/腿长）`, `📏 Loaded ${formatProportionSummary(g.proportionSpec, true)}`)
        : tr('📏 已恢复为保持原画默认头身与肩胯比例', '📏 Restored original concept proportions')
    );
  };
  $('#ngEditProportionBtn').onclick = () => openProportionStudio({autoEnableIfOff: true});
  onLocaleChange(() => {
    refreshTemplateSelect();
    refreshGlobalRatioSelect();
  });
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
  $('#ngInspectAllViewsBtn').onclick = () => openMultiViewInspector(null, null, {matrixAll: true});
  $('#ngRequestViews').onclick = () => hooks.requestGraphViews(null);
  $('#ngExecViewPrompt').onclick = () => hooks.session?.()?.reopenPromptDialog?.();
  $('#ngExecCancel').onclick = () => hooks.session?.()?.cancelActiveRequest?.();
  window.addEventListener('morphogem-lock-change', () => render());
  window.addEventListener('morphogem-switch-workspace', ev => {
    if (ev.detail) setWorkspaceMode(ev.detail);
  });
  $('#ngRunAllTripo').onclick = async () => {
    const g = currentGraph();
    const stage1Ids = g.nodes
      .filter(n => n.type === 'tripo_mesh' && nodeStatus(g, n.id).state === 'dirty')
      .map(n => n.id);
    const stage2AlreadyDirty = g.nodes
      .filter(n => n.type === 'tripo_retexture' && nodeStatus(g, n.id).state === 'dirty')
      .map(n => n.id);
    if (!stage1Ids.length && !stage2AlreadyDirty.length) {
      hooks.toast(tr(
        '当前没有待执行的 Tripo 建模或 UV 上色节点（请先完成上游四视图拆图，或修改参数后再运行）',
        'No pending Tripo 3D or UV/Retexture nodes to run.'
      ));
      return;
    }
    if (stage1Ids.length) {
      await runTripoNodes(stage1Ids);
    }
    const gAfter = currentGraph();
    const stage2Ids = gAfter.nodes
      .filter(n => n.type === 'tripo_retexture' && nodeStatus(gAfter, n.id).state === 'dirty')
      .map(n => n.id);
    if (stage2Ids.length) {
      await runTripoNodes(stage2Ids);
    }
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
    applyTemplate: presetKey => applyTemplateByKey(presetKey),
    confirmDialog: (title, msg) => askConfirmDialog(title, msg),
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
