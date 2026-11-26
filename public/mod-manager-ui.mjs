import {serializeGraphAsTemplate, extractBranchPreset, ensureNodeGraph} from './node-graph.mjs';

const AUTHOR_STORAGE_KEY = 'morphogem.modAuthorName';

export function initModAndSystemUI(hooks) {
  let modsState = {modsDir: '', mods: []};

  // --- 1. Mount Blender Path & App Update Controls inside #previewSettingsDialog ---
  const settingsDialog = document.querySelector('#previewSettingsDialog');
  const settingsProject = settingsDialog?.querySelector('.settings-project');
  if (settingsDialog && settingsProject) {
    const engineBox = document.createElement('div');
    engineBox.className = 'settings-engine-box';
    engineBox.innerHTML = `
      <div class="settings-sec-head">
        <h3>🔧 Blender 引擎路径（合并导出必需）</h3>
        <span id="blenderStatusTag" class="sys-tag warn">待配置</span>
      </div>
      <p class="small-note" style="margin:4px 0 8px;line-height:1.5">
        合并部件并导出 FBX / GLB / Blend 时需要调用本机安装的 Blender（推荐 Blender 4.2 ~ 5.2）。请选择 <code>blender.exe</code> 可执行文件路径：
      </p>
      <div class="blender-path-row">
        <input type="text" id="blenderPathInput" class="ng-input" placeholder="例如：C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" autocomplete="off">
        <button type="button" id="browseBlenderBtn" class="ng-btn" hidden>📂 浏览…</button>
        <button type="button" id="saveBlenderBtn" class="ng-btn primary">校验并保存</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap">
        <button type="button" id="scanBlenderBtn" class="ng-btn">🔍 自动扫描本机常见安装路径</button>
        <span id="blenderSaveMsg" style="font-size:11.5px;color:#94a3b8"></span>
      </div>
      <div id="blenderScanCandidates" class="blender-scan-pills" hidden></div>

      <div id="desktopUpdateSection" class="settings-update-box" hidden>
        <div class="settings-sec-head" style="margin-top:14px">
          <h3>🚀 客户端版本与 GitHub 更新</h3>
          <span id="appVersionTag" class="sys-tag">v2.1.0</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;flex-wrap:wrap">
          <span id="updateStatusText" style="font-size:12px;color:#cbd5e1">通过 GitHub Releases 获取最新客户端安装包与增量更新</span>
          <div style="display:flex;gap:6px">
            <button type="button" id="checkUpdateBtn" class="ng-btn primary">🔄 检查更新</button>
            <button type="button" id="installUpdateBtn" class="ng-btn emerald" hidden>⚡ 立即重启并安装新版本</button>
            <a href="https://github.com/MorphoDiana/MorphoGem/releases" target="_blank" rel="noopener noreferrer" class="ng-btn" style="text-decoration:none">GitHub Releases ↗</a>
          </div>
        </div>
      </div>
    `;
    settingsProject.before(engineBox);

    const pathInput = engineBox.querySelector('#blenderPathInput');
    const statusTag = engineBox.querySelector('#blenderStatusTag');
    const saveMsg = engineBox.querySelector('#blenderSaveMsg');
    const browseBtn = engineBox.querySelector('#browseBlenderBtn');
    const saveBtn = engineBox.querySelector('#saveBlenderBtn');
    const scanBtn = engineBox.querySelector('#scanBlenderBtn');
    const scanBox = engineBox.querySelector('#blenderScanCandidates');

    const desktopBridge = window.morphogemDesktop;
    if (desktopBridge?.chooseBlenderExe) {
      browseBtn.hidden = false;
      browseBtn.onclick = async () => {
        const chosen = await desktopBridge.chooseBlenderExe();
        if (chosen) {
          pathInput.value = chosen;
          await saveBlenderPath(chosen);
        }
      };
    }

    async function refreshBlenderSettingsUI() {
      try {
        const res = await fetch('/api/system/settings');
        if (!res.ok) return;
        const data = await res.json();
        pathInput.value = data.blenderPath || data.configuredRaw || '';
        if (data.blenderValid) {
          statusTag.className = 'sys-tag ok';
          statusTag.textContent = '✓ 已连接可用';
          saveMsg.textContent = '';
        } else {
          statusTag.className = 'sys-tag warn';
          statusTag.textContent = '⚠ 尚未配置';
        }
      } catch {
        // ignore
      }
    }

    async function saveBlenderPath(rawVal) {
      saveMsg.style.color = '#94a3b8';
      saveMsg.textContent = '正在校验路径…';
      try {
        const res = await fetch('/api/system/settings', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({blenderPath: rawVal.trim()}),
        });
        const data = await res.json();
        if (!res.ok) {
          statusTag.className = 'sys-tag warn';
          statusTag.textContent = '⚠ 路径无效';
          saveMsg.style.color = '#fca5a5';
          saveMsg.textContent = data.error || '路径无效';
          return;
        }
        pathInput.value = data.blenderPath || '';
        statusTag.className = data.blenderValid ? 'sys-tag ok' : 'sys-tag warn';
        statusTag.textContent = data.blenderValid ? '✓ 已连接可用' : '⚠ 尚未配置';
        saveMsg.style.color = '#86efac';
        saveMsg.textContent = data.blenderValid ? '✓ Blender 路径已保存并生效！' : '已清空 Blender 路径配置';
        desktopBridge?.notifyBlenderUpdated?.(data.blenderPath || '');
      } catch (e) {
        saveMsg.style.color = '#fca5a5';
        saveMsg.textContent = e.message;
      }
    }

    saveBtn.onclick = () => void saveBlenderPath(pathInput.value);
    pathInput.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void saveBlenderPath(pathInput.value);
      }
    });

    scanBtn.onclick = async () => {
      scanBox.hidden = false;
      scanBox.innerHTML = '<span style="font-size:11.5px;color:#94a3b8">正在扫描本机常见目录…</span>';
      try {
        const res = await fetch('/api/system/scan-blender');
        const {candidates = []} = await res.json();
        scanBox.replaceChildren();
        if (!candidates.length) {
          scanBox.innerHTML = '<span style="font-size:11.5px;color:#fbbf24">未在默认目录扫描到 Blender，请点击「浏览…」或手动粘贴你的 blender.exe 路径。</span>';
          return;
        }
        for (const cand of candidates) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ng-pill';
          b.textContent = `采用：${cand}`;
          b.onclick = () => {
            pathInput.value = cand;
            void saveBlenderPath(cand);
          };
          scanBox.append(b);
        }
      } catch (e) {
        scanBox.textContent = e.message;
      }
    };

    // Desktop Auto-Update controls inside Settings
    if (desktopBridge?.getState) {
      const updSection = engineBox.querySelector('#desktopUpdateSection');
      const verTag = engineBox.querySelector('#appVersionTag');
      const updText = engineBox.querySelector('#updateStatusText');
      const chkBtn = engineBox.querySelector('#checkUpdateBtn');
      const instBtn = engineBox.querySelector('#installUpdateBtn');
      updSection.hidden = false;

      const syncUpdateUI = st => {
        if (!st) return;
        if (st.appVersion) verTag.textContent = `v${st.appVersion}`;
        const u = st.update || {};
        instBtn.hidden = u.status !== 'downloaded';
        chkBtn.disabled = u.status === 'checking' || u.status === 'downloading';
        if (u.status === 'checking') updText.textContent = '⏳ 正在向 GitHub Releases 检查最新版本…';
        else if (u.status === 'available') {
          updText.textContent = `🎉 发现新版本 v${u.version}！点击右侧按钮立即下载更新`;
          chkBtn.textContent = `⬇ 下载 v${u.version}`;
        } else if (u.status === 'downloading') {
          updText.textContent = `⬇ 正在下载新版本安装包 (${Math.round(u.percent || 0)}%)…`;
        } else if (u.status === 'downloaded') {
          updText.textContent = `✓ 新版本 v${u.version} 已下载就绪，点击右侧按钮重启即可自动升级（工程与 Mod 完整保留）`;
          chkBtn.hidden = true;
        } else if (u.status === 'up-to-date') {
          updText.textContent = `✓ 当前已是最新版本 (v${st.appVersion || '2.1.0'})`;
          chkBtn.textContent = '🔄 重新检查';
        } else if (u.status === 'error') {
          updText.textContent = `⚠ ${u.message || '检查更新失败，可直接前往 GitHub Releases 查看'}`;
          chkBtn.textContent = '🔄 重试检查';
        }
      };

      chkBtn.onclick = () => {
        desktopBridge.getState().then(st => {
          if (st?.update?.status === 'available') desktopBridge.downloadUpdate?.();
          else desktopBridge.checkUpdates?.();
        });
      };
      instBtn.onclick = () => desktopBridge.quitAndInstallUpdate?.();
      desktopBridge.onState?.(st => {
        syncUpdateUI(st);
        if (st?.blenderPath && document.activeElement !== pathInput) {
          pathInput.value = st.blenderPath;
          statusTag.className = 'sys-tag ok';
          statusTag.textContent = '✓ 已连接可用';
        }
      });
      desktopBridge.getState().then(syncUpdateUI);
    }

    document.querySelector('#previewSettings')?.addEventListener('click', () => {
      void refreshBlenderSettingsUI();
    });
    void refreshBlenderSettingsUI();
  }

  // --- 2. Build Full Mod Manager & Mod Packager Dialog ---
  const modDlg = document.createElement('dialog');
  modDlg.id = 'ngModsDialog';
  modDlg.className = 'ng-modal mod-studio-modal';
  modDlg.innerHTML = `
    <div class="dialog-top" style="margin-bottom:12px">
      <h2>🧩 MorphoGem 社区 Mod 扩展与打包工坊</h2>
      <button type="button" id="closeModsDlg" aria-label="关闭">×</button>
    </div>

    <div class="mod-tabs">
      <button type="button" class="mod-tab active" data-mod-tab="installed">📦 已安装 Mod 库 <span id="modInstalledCount">0</span></button>
      <button type="button" class="mod-tab" data-mod-tab="create">🛠️ 打包制作我的 Mod（分享分发）</button>
    </div>

    <!-- Tab 1: Installed Mods -->
    <div id="modTabInstalled" class="mod-tab-pane">
      <div class="mod-bar">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <label class="ng-btn primary" style="cursor:pointer">
            📥 导入 .mgmod 扩展包
            <input type="file" id="importMgmodInput" accept=".mgmod,.zip" hidden>
          </label>
          <button type="button" id="openModsFolderBtn" class="ng-btn">📂 打开 Mods 文件夹</button>
          <button type="button" id="reloadModsBtn" class="ng-btn">🔄 热重载扫描</button>
        </div>
        <small id="modsFolderHint" style="color:#94a3b8;font-size:11px"></small>
      </div>
      <p style="margin:6px 0 10px;font-size:11.5px;color:#94a3b8">
        提示：你可以直接将好友分享的 <code>.mgmod</code> 文件拖入此窗口，或把 Mod 文件夹放进安装目录的 <code>Mods/</code> 目录后点「热重载扫描」；启用的 Mod 模版与专属节点会直接出现在画布模版框与 <code>Space</code> 搜索菜单中。
      </p>
      <div id="modCardsContainer" class="mod-cards-list"></div>
    </div>

    <!-- Tab 2: Create & Export Shareable .mgmod -->
    <form id="modTabCreate" class="mod-tab-pane" hidden>
      <div class="ng-row2" style="margin-bottom:10px">
        <label class="ng-field">
          <span>Mod 名称 *</span>
          <input type="text" id="modCreateName" class="ng-input" required maxlength="60" placeholder="例如：Q版盲盒手办拆件包 / 机甲战姬武装Mod">
        </label>
        <div class="ng-row2">
          <label class="ng-field">
            <span>作者署名 *</span>
            <input type="text" id="modCreateAuthor" class="ng-input" required maxlength="40" placeholder="例如：MorphoDiana">
          </label>
          <label class="ng-field">
            <span>版本号</span>
            <input type="text" id="modCreateVersion" class="ng-input" value="1.0.0" maxlength="20">
          </label>
        </div>
      </div>

      <div class="ng-row2" style="margin-bottom:10px">
        <label class="ng-field">
          <span>分类标签（逗号分隔）</span>
          <input type="text" id="modCreateTags" class="ng-input" maxlength="80" placeholder="例如：二次元, 翅膀武装, 高精拆件">
        </label>
        <label class="ng-field">
          <span>Mod 简介说明</span>
          <input type="text" id="modCreateDesc" class="ng-input" maxlength="200" placeholder="简述适用角色类型、推荐面数与包含的节点亮点">
        </label>
      </div>

      <div class="mod-pack-checks">
        <strong style="font-size:12px;color:#e2e8f0;display:block;margin-bottom:6px">📦 选择要打包进此 Mod 的画布内容：</strong>
        <label class="mod-chk-row">
          <input type="checkbox" id="modIncWholeGraph" checked>
          <span>包含当前画布的完整拓扑作为「Mod 整图蓝图模版」</span>
        </label>
        <label class="mod-chk-row">
          <input type="checkbox" id="modIncSelectedBranch" checked>
          <span id="modSelectedBranchLabel">包含当前画布选中的节点作为「Mod 专属节点 / 分支预设」（按 Space 可一键插入）</span>
        </label>
      </div>

      <label class="ng-field" style="margin:10px 0 14px">
        <span>✨ 专属 AI 拆图工艺规则（可选 · 启用该 Mod 时将自动注入给 AI Agent！）</span>
        <textarea id="modCreateRules" class="ng-input" rows="4" style="resize:vertical;font-family:inherit;line-height:1.5" placeholder="例如：1. 所有机甲装甲部件在侧面视图需交代 ≥8px 的外甲板厚与内衬卡槽；2. 羽翼能量光效部分与实体骨架分开保持干净闭合轮廓…"></textarea>
      </label>

      <div class="dialog-actions" style="justify-content:flex-end;gap:8px">
        <button type="button" id="modInstallLocalBtn" class="ng-btn violet">💾 直接安装到我的 Mods 库</button>
        <button type="submit" id="modExportFileBtn" class="ng-btn emerald">📦 打包导出 .mgmod 分享文件</button>
      </div>
    </form>
  `;
  document.body.append(modDlg);

  const closeBtn = modDlg.querySelector('#closeModsDlg');
  closeBtn.onclick = () => modDlg.close();

  const tabBtns = [...modDlg.querySelectorAll('.mod-tab')];
  const paneInstalled = modDlg.querySelector('#modTabInstalled');
  const paneCreate = modDlg.querySelector('#modTabCreate');

  function switchModTab(tabName) {
    for (const b of tabBtns) b.classList.toggle('active', b.dataset.modTab === tabName);
    paneInstalled.hidden = tabName !== 'installed';
    paneCreate.hidden = tabName !== 'create';
    if (tabName === 'create') {
      const savedAuthor = localStorage.getItem(AUTHOR_STORAGE_KEY) || '';
      const authorInp = modDlg.querySelector('#modCreateAuthor');
      if (!authorInp.value && savedAuthor) authorInp.value = savedAuthor;
      const selCount = hooks.getSelectedNodeIds?.()?.length || 0;
      const selChk = modDlg.querySelector('#modIncSelectedBranch');
      const selLbl = modDlg.querySelector('#modSelectedBranchLabel');
      selChk.disabled = selCount === 0;
      selChk.checked = selCount > 0;
      selLbl.textContent = selCount > 0
        ? `包含当前画布选中的 ${selCount} 个节点作为「Mod 专属分支预设」（按 Space 可直接刷出）`
        : '包含画布选中节点作为专属分支（当前未选中节点，可在画布框选后再勾选）';
    }
  }

  for (const b of tabBtns) {
    b.onclick = () => switchModTab(b.dataset.modTab);
  }

  async function refreshMods() {
    try {
      const res = await fetch('/api/mods');
      if (!res.ok) return modsState;
      modsState = await res.json();
      globalThis.__morphogemLoadedMods = modsState.mods || [];
      renderInstalledMods();
      hooks.onModsUpdated?.(modsState.mods || []);
    } catch {
      // ignore
    }
    return modsState;
  }

  function renderInstalledMods() {
    const listEl = modDlg.querySelector('#modCardsContainer');
    const countEl = modDlg.querySelector('#modInstalledCount');
    const dirHint = modDlg.querySelector('#modsFolderHint');
    const mods = modsState.mods || [];
    countEl.textContent = String(mods.length);
    dirHint.textContent = modsState.modsDir ? `Mods 路径: ${modsState.modsDir}` : '';

    const enabledCount = mods.filter(m => m.enabled).length;
    const toolbarBadge = document.querySelector('#ngModsBtnCount');
    if (toolbarBadge) toolbarBadge.textContent = String(enabledCount);

    listEl.replaceChildren();
    if (!mods.length) {
      listEl.innerHTML = '<div style="padding:24px;text-align:center;color:#64748b;font-size:12.5px">暂无已安装的 Mod 扩展包。点击上方「📥 导入 .mgmod 扩展包」或切换到右侧标签制作你的第一个 Mod！</div>';
      return;
    }

    for (const m of mods) {
      const card = document.createElement('div');
      card.className = 'mod-card' + (m.enabled ? ' enabled' : ' disabled');
      const tplCount = m.templates?.length || 0;
      const nodeCount = (m.customNodes?.length || 0) + (m.branches?.length || 0);
      const hasRules = Boolean(m.promptRules);

      card.innerHTML = `
        <div class="mod-card-top">
          <div class="mod-card-title-row">
            <strong class="mod-card-name"></strong>
            <span class="mod-ver-pill"></span>
            <span class="mod-src-pill ${m.source === 'builtin' ? 'builtin' : 'user'}">${m.source === 'builtin' ? '官方内置' : '本地安装'}</span>
            <span class="mod-author"></span>
          </div>
          <div class="mod-card-controls">
            <button type="button" class="ng-btn mod-exp-btn" title="将此 Mod 导出为单个 .mgmod 文件以便发给好友">📤 分享 .mgmod</button>
            ${m.source === 'user' ? '<button type="button" class="ng-btn danger mod-del-btn" title="卸载删除此 Mod">🗑</button>' : ''}
            <label class="mod-switch" title="启用或禁用此 Mod">
              <input type="checkbox" class="mod-enable-chk" ${m.enabled ? 'checked' : ''}>
              <span>${m.enabled ? '已启用' : '已禁用'}</span>
            </label>
          </div>
        </div>
        <p class="mod-card-desc"></p>
        <div class="mod-card-meta"></div>
      `;
      card.querySelector('.mod-card-name').textContent = m.name;
      card.querySelector('.mod-ver-pill').textContent = `v${m.version}`;
      card.querySelector('.mod-author').textContent = `by ${m.author}`;
      card.querySelector('.mod-card-desc').textContent = m.description || '作者未填写简介';

      const metaRow = card.querySelector('.mod-card-meta');
      if (tplCount) {
        const s = document.createElement('span');
        s.className = 'mod-stat-chip';
        s.textContent = `🗺️ 整图模板 ×${tplCount}`;
        metaRow.append(s);
      }
      if (nodeCount) {
        const s = document.createElement('span');
        s.className = 'mod-stat-chip';
        s.textContent = `🧩 专属节点/分支 ×${nodeCount}`;
        metaRow.append(s);
      }
      if (hasRules) {
        const s = document.createElement('span');
        s.className = 'mod-stat-chip rules';
        s.textContent = '✨ 含 AI 拆图工艺规则';
        metaRow.append(s);
      }
      for (const tg of m.tags || []) {
        const s = document.createElement('span');
        s.className = 'mod-tag-chip';
        s.textContent = `#${tg}`;
        metaRow.append(s);
      }

      card.querySelector('.mod-enable-chk').onchange = async ev => {
        const enabled = ev.target.checked;
        const res = await fetch('/api/mods/toggle', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({id: m.id, enabled}),
        });
        if (res.ok) {
          modsState = await res.json();
          globalThis.__morphogemLoadedMods = modsState.mods || [];
          renderInstalledMods();
          hooks.onModsUpdated?.(modsState.mods || []);
          hooks.toast(enabled ? `✓ 已启用 Mod「${m.name}」` : `已禁用 Mod「${m.name}」`);
        }
      };

      card.querySelector('.mod-exp-btn').onclick = async () => {
        try {
          const res = await fetch(`/api/mods/export?id=${encodeURIComponent(m.id)}`);
          if (!res.ok) throw Error((await res.json()).error || '导出失败');
          const blob = await res.blob();
          hooks.download(blob, `${m.id}-v${m.version}.mgmod`);
          hooks.toast(`✓ 已导出分享包 ${m.id}-v${m.version}.mgmod`);
        } catch (e) {
          hooks.toast(e.message);
        }
      };

      const delBtn = card.querySelector('.mod-del-btn');
      if (delBtn) {
        delBtn.onclick = async () => {
          if (!confirm(`确定要从本地 Mods 目录卸载删除「${m.name}」吗？`)) return;
          const res = await fetch('/api/mods/delete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({id: m.id}),
          });
          if (res.ok) {
            modsState = await res.json();
            globalThis.__morphogemLoadedMods = modsState.mods || [];
            renderInstalledMods();
            hooks.onModsUpdated?.(modsState.mods || []);
            hooks.toast(`已卸载 Mod「${m.name}」`);
          }
        };
      }

      listEl.append(card);
    }
  }

  async function importMgmodFile(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/mods/import', {
        method: 'POST',
        headers: {'Content-Type': 'application/octet-stream'},
        body: buf,
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || '导入 .mgmod 失败');
      modsState = data;
      globalThis.__morphogemLoadedMods = modsState.mods || [];
      switchModTab('installed');
      renderInstalledMods();
      hooks.onModsUpdated?.(modsState.mods || []);
      hooks.toast(`✓ 成功导入并启用 Mod「${data.importedId}」！`);
    } catch (e) {
      hooks.toast(e.message);
    }
  }

  modDlg.querySelector('#importMgmodInput').onchange = ev => {
    const f = ev.target.files?.[0];
    ev.target.value = '';
    if (f) void importMgmodFile(f);
  };

  modDlg.ondragover = ev => { ev.preventDefault(); };
  modDlg.ondrop = ev => {
    const f = ev.dataTransfer?.files?.[0];
    if (f && /\.(mgmod|zip)$/i.test(f.name)) {
      ev.preventDefault();
      void importMgmodFile(f);
    }
  };

  modDlg.querySelector('#reloadModsBtn').onclick = async () => {
    await refreshMods();
    hooks.toast('✓ 已重新扫描本地 Mods 目录');
  };

  modDlg.querySelector('#openModsFolderBtn').onclick = async () => {
    if (window.morphogemDesktop?.openModsDir) {
      await window.morphogemDesktop.openModsDir();
    } else if (modsState.modsDir) {
      try {
        await navigator.clipboard.writeText(modsState.modsDir);
        hooks.toast(`已复制 Mods 目录路径：${modsState.modsDir}`);
      } catch {
        hooks.toast(`Mods 目录路径：${modsState.modsDir}`);
      }
    }
  };

  function collectCreatePayload() {
    const name = modDlg.querySelector('#modCreateName').value.trim();
    const author = modDlg.querySelector('#modCreateAuthor').value.trim() || 'MorphoGem 创作者';
    const version = modDlg.querySelector('#modCreateVersion').value.trim() || '1.0.0';
    const tags = modDlg.querySelector('#modCreateTags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const description = modDlg.querySelector('#modCreateDesc').value.trim();
    const promptRules = modDlg.querySelector('#modCreateRules').value.trim();
    const incWhole = modDlg.querySelector('#modIncWholeGraph').checked;
    const incSel = modDlg.querySelector('#modIncSelectedBranch').checked;

    if (!name) throw Error('请填写 Mod 名称');
    try { localStorage.setItem(AUTHOR_STORAGE_KEY, author); } catch {}

    const g = ensureNodeGraph(hooks.getProject());
    const templates = [];
    const branches = [];

    if (incWhole) {
      const tpl = serializeGraphAsTemplate(g, {name: `${name} 整图模板`, description});
      templates.push(tpl);
    }
    const selIds = hooks.getSelectedNodeIds?.() || [];
    if (incSel && selIds.length > 0) {
      const br = extractBranchPreset(g, selIds, {
        name: `${name} 专属分支`,
        description,
        autoPair: true,
      });
      if (promptRules) {
        br.craftRules = [promptRules.split(/\r?\n/)[0].slice(0, 240)];
      }
      branches.push(br);
    }

    if (!templates.length && !branches.length && !promptRules) {
      throw Error('请至少勾选打包「整图模板」、「选中分支」或填写「专属 AI 拆图规则」中的一项');
    }

    return {name, author, version, tags, description, promptRules, templates, branches, customNodes: []};
  }

  modDlg.querySelector('#modInstallLocalBtn').onclick = async () => {
    try {
      const payload = collectCreatePayload();
      const res = await fetch('/api/mods/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...payload, installLocal: true, downloadBlob: false}),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || '安装 Mod 失败');
      modsState = data;
      globalThis.__morphogemLoadedMods = modsState.mods || [];
      switchModTab('installed');
      renderInstalledMods();
      hooks.onModsUpdated?.(modsState.mods || []);
      hooks.toast(`✓ 已将「${payload.name}」安装到本地 Mods 库并启用！`);
    } catch (e) {
      hooks.toast(e.message);
    }
  };

  paneCreate.onsubmit = async ev => {
    ev.preventDefault();
    try {
      const payload = collectCreatePayload();
      const res = await fetch('/api/mods/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...payload, installLocal: true, downloadBlob: true}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Error(err.error || '打包 .mgmod 失败');
      }
      const blob = await res.blob();
      const safeFile = `${payload.name.replace(/[\\/:*?"<>|\s]+/g, '_')}-v${payload.version}.mgmod`;
      hooks.download(blob, safeFile);
      await refreshMods();
      switchModTab('installed');
      hooks.toast(`✓ 已导出可分享文件 ${safeFile}（并已同步装入你的本地 Mods 库）！`);
    } catch (e) {
      hooks.toast(e.message);
    }
  };

  void refreshMods();

  return {
    openDialog: (tab = 'installed') => {
      switchModTab(tab);
      void refreshMods();
      modDlg.showModal();
    },
    refreshMods,
    getMods: () => modsState.mods || [],
    importMgmodFile,
  };
}
