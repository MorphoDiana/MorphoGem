import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BaseWindow, WebContentsView, session, ipcMain, shell, clipboard, dialog } from 'electron';
import electronUpdaterPkg from 'electron-updater';

const { autoUpdater } = electronUpdaterPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isSmokeTest = process.argv.includes('--smoke-test');

if (process.platform === 'win32') {
  app.setAppUserModelId('ai.morphogem.desktop');
}

function resolvePaths() {
  if (app.isPackaged) {
    const installRoot = process.env.MORPHOGEM_SUITE_ROOT
      ? path.resolve(process.env.MORPHOGEM_SUITE_ROOT)
      : path.dirname(process.execPath);

    const appCoreCandidates = [
      process.env.MORPHOGEM_APP_CORE,
      path.join(process.resourcesPath, 'app-core'),
      path.join(installRoot, 'app-core'),
    ].filter(Boolean);
    const appCoreDir = appCoreCandidates.find(d => fsSync.existsSync(path.join(d, 'server.mjs')))
      || path.join(process.resourcesPath, 'app-core');

    const userDataRoot = process.env.MORPHOGEM_WORKSPACE_DIR
      ? path.resolve(process.env.MORPHOGEM_WORKSPACE_DIR)
      : path.join(installRoot, 'userdata');

    const defaultDownloads = process.env.MORPHOGEM_DOWNLOADS_DIR
      ? path.resolve(process.env.MORPHOGEM_DOWNLOADS_DIR)
      : path.join(installRoot, 'Exports');

    return {
      installRoot,
      appCoreDir,
      toolsDir: process.env.MORPHOGEM_TOOLS_DIR || path.join(installRoot, 'tools'),
      userDataRoot,
      chromiumDir: path.join(userDataRoot, 'chromium'),
      projectsDir: process.env.MORPHOGEM_PROJECTS_ROOT || path.join(installRoot, 'Projects'),
      modsDir: process.env.MORPHOGEM_MODS_DIR || path.join(installRoot, 'Mods'),
      localDir: path.join(userDataRoot, 'local'),
      tripoStagingDir: path.join(userDataRoot, 'tripo-staging'),
      defaultUserDownloadsDir: defaultDownloads,
      settingsFile: path.join(userDataRoot, 'desktop-settings.json'),
    };
  }

  // Source / dev mode (`MorphoGem/desktop`)
  const appCoreDir = path.resolve(__dirname, '..');
  const suiteRoot = path.resolve(appCoreDir, '..');
  const userDataRoot = process.env.MORPHOGEM_WORKSPACE_DIR
    ? path.resolve(process.env.MORPHOGEM_WORKSPACE_DIR)
    : path.join(suiteRoot, 'userdata');
  const existingProjects = path.join(appCoreDir, 'projects');
  const existingLocal = path.join(appCoreDir, 'local');
  const resolvedLocalDir = fsSync.existsSync(existingLocal) ? existingLocal : path.join(userDataRoot, 'local');

  return {
    installRoot: appCoreDir,
    appCoreDir,
    toolsDir: path.join(suiteRoot, 'tools'),
    userDataRoot,
    chromiumDir: path.join(userDataRoot, 'chromium'),
    projectsDir: process.env.MORPHOGEM_PROJECTS_ROOT || (fsSync.existsSync(existingProjects) ? existingProjects : path.join(appCoreDir, 'Projects')),
    modsDir: process.env.MORPHOGEM_MODS_DIR || path.join(appCoreDir, 'Mods'),
    localDir: resolvedLocalDir,
    tripoStagingDir: path.join(userDataRoot, 'tripo-staging'),
    defaultUserDownloadsDir: process.env.MORPHOGEM_DOWNLOADS_DIR
      ? path.resolve(process.env.MORPHOGEM_DOWNLOADS_DIR)
      : path.join(appCoreDir, 'Exports'),
    settingsFile: path.join(resolvedLocalDir, 'desktop-settings.json'),
  };
}

const paths = resolvePaths();
if (isSmokeTest) {
  const smokeTmp = path.join(paths.userDataRoot, '.smoke-' + process.pid);
  paths.chromiumDir = path.join(smokeTmp, 'chromium');
  paths.localDir = path.join(smokeTmp, 'local');
  paths.tripoStagingDir = path.join(smokeTmp, 'staging');
  paths.settingsFile = path.join(smokeTmp, 'desktop-settings.json');
}
for (const dir of [paths.userDataRoot, paths.chromiumDir, paths.projectsDir, paths.modsDir, paths.localDir, paths.tripoStagingDir]) {
  fsSync.mkdirSync(dir, { recursive: true });
}

// Seed helpful README inside <InstallDir>/Mods
const modsReadmeFile = path.join(paths.modsDir, 'README-如何安装与制作Mod.txt');
if (!fsSync.existsSync(modsReadmeFile)) {
  try {
    fsSync.writeFileSync(
      modsReadmeFile,
      [
        'MorphoGem 社区节点与模板 Mod 目录',
        '===================================',
        '1. 安装他人分享的 Mod：',
        '   将 .mgmod 文件或包含 manifest.json 的 Mod 文件夹直接放入本目录，',
        '   然后在 MorphoGem 画布工具栏点击「🧩 Mod」->「热重载扫描」即可启用！',
        '',
        '2. 制作并分享自己的 Mod：',
        '   在 MorphoGem 画布工具栏点击「🧩 Mod」->「打包制作我的 Mod」，',
        '   即可将你的节点拓扑、专属分支与 AI 拆图心得一键导出为单个 .mgmod 文件分享给他人。',
        '',
        '3. 客户端升级与卸载保护：',
        '   通过 GitHub Release 升级或卸载客户端时，Projects、Exports、Mods 与 userdata 目录均会自动保留，不会丢失数据。',
      ].join('\r\n'),
      'utf8'
    );
  } catch {
    // ignore
  }
}

function loadDesktopSettingsSync() {
  try {
    return JSON.parse(fsSync.readFileSync(paths.settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

async function saveDesktopSettings(patch) {
  desktopSettings = { ...desktopSettings, ...patch };
  await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
  await fs.writeFile(paths.settingsFile, JSON.stringify(desktopSettings, null, 2), 'utf8');
  return desktopSettings;
}

let desktopSettings = loadDesktopSettingsSync();
let userDownloadsDir = desktopSettings.userDownloadsDir
  ? path.resolve(desktopSettings.userDownloadsDir)
  : paths.defaultUserDownloadsDir;
fsSync.mkdirSync(userDownloadsDir, { recursive: true });

// Clean up any leftover temp files in tripoStagingDir on startup
try {
  for (const name of fsSync.readdirSync(paths.tripoStagingDir)) {
    fsSync.rmSync(path.join(paths.tripoStagingDir, name), { recursive: true, force: true });
  }
} catch {
  // ignore
}

// Configure isolated Chromium userData & internal loopback CDP BEFORE app.whenReady()
app.setPath('userData', paths.chromiumDir);
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', process.env.MORPHOGEM_INTERNAL_CDP_PORT || '0');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (!isSmokeTest) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    process.exit(0);
  }
}

const TOOLBAR_HEIGHT = 44;
const TRIPO_START_URL = 'https://studio.tripo3d.ai/workspace/generate';
const GITHUB_RELEASES_API = 'https://api.github.com/repos/MorphoDiana/MorphoGem/releases/latest';

const chromeFullVer = process.versions.chrome || '134.0.6998.89';
const chromeMajorVer = chromeFullVer.split('.')[0];
const CLEAN_CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFullVer} Safari/537.36`;

let win = null;
let toolbarView = null;
let workbenchView = null;
let tripoView = null;
let workbenchSrv = null;
let tripoDaemon = null;
let jobsModRef = null;
let statusPollTimer = null;
let savedNoticeTimer = null;

const uiState = {
  appVersion: app.getVersion(),
  activeTab: 'workbench', // 'workbench' | 'tripo'
  workbenchUrl: '',
  projectsDir: paths.projectsDir,
  modsDir: paths.modsDir,
  userDownloadsDir,
  blenderFound: false,
  blenderPath: null,
  tripoReady: false,
  tripoCredits: null,
  tripoBlocked: null, // null | 'AUTH_REQUIRED' | 'CAPTCHA_OR_CHALLENGE'
  tripoActivity: { active: false, label: '' },
  download: { active: false, filename: '', received: 0, total: 0 },
  lastSavedDownload: null, // { filename, fullPath }
  update: { status: 'idle', version: null, percent: 0, message: '' },
};

function pushUiState() {
  for (const v of [toolbarView, workbenchView]) {
    if (v && !v.webContents.isDestroyed()) {
      v.webContents.send('desktop:state', uiState);
    }
  }
}

function layoutViews() {
  if (!win || win.isDestroyed()) return;
  if (typeof win.isMinimized === 'function' && win.isMinimized()) return;

  const contentSize = typeof win.getContentSize === 'function' ? win.getContentSize() : [0, 0];
  const bounds = win.getContentBounds();
  const w = Math.max(contentSize[0] || 0, bounds.width || 0);
  const h = Math.max(contentSize[1] || 0, bounds.height || 0);

  // Ignore transient 0x0 or tiny bounds emitted during Windows taskbar minimize/restore DWM animations
  if (w < 400 || h < 300) return;

  const bodyH = Math.max(120, h - TOOLBAR_HEIGHT);
  toolbarView?.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT });
  workbenchView?.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: bodyH });
  tripoView?.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: bodyH });
}

function scheduleRelayout() {
  layoutViews();
  setTimeout(layoutViews, 60);
  setTimeout(layoutViews, 220);
}

function setActiveTab(tab) {
  if (tab !== 'workbench' && tab !== 'tripo') return;
  uiState.activeTab = tab;
  if (win && !win.isDestroyed() && workbenchView && tripoView && toolbarView) {
    if (tab === 'workbench') {
      win.contentView.addChildView(tripoView);
      win.contentView.addChildView(workbenchView);
    } else {
      win.contentView.addChildView(workbenchView);
      win.contentView.addChildView(tripoView);
    }
    win.contentView.addChildView(toolbarView);
    layoutViews();
  }
  pushUiState();
}

let pendingCliMgemPath = null;

async function handleCliFileArgs(argv = []) {
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue;
    if (/\.mgmod$/i.test(arg)) {
      try {
        const src = path.resolve(arg);
        if (fsSync.existsSync(src)) {
          const dest = path.join(paths.modsDir, path.basename(src));
          await fs.copyFile(src, dest);
          if (workbenchView && !workbenchView.webContents.isDestroyed()) {
            workbenchView.webContents.reload();
          }
        }
      } catch {
        // ignore
      }
    } else if (/\.mgem$/i.test(arg)) {
      try {
        const src = path.resolve(arg);
        if (fsSync.existsSync(src)) {
          if (workbenchSrv?.url) {
            const buf = await fs.readFile(src);
            await fetch(`${workbenchSrv.url}/api/session/open`, {
              method: 'POST',
              headers: { host: new URL(workbenchSrv.url).host },
              body: buf,
            });
            if (workbenchView && !workbenchView.webContents.isDestroyed()) {
              workbenchView.webContents.reload();
            }
          } else {
            pendingCliMgemPath = src;
          }
        }
      } catch {
        // ignore
      }
    }
  }
}

function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function hasPackagedUpdateConfig() {
  return app.isPackaged && fsSync.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    uiState.update = { status: 'checking', version: null, percent: 0, message: '' };
    pushUiState();
  });

  autoUpdater.on('update-available', (info) => {
    uiState.update = { status: 'available', version: info?.version || '', percent: 0, message: '' };
    pushUiState();
  });

  autoUpdater.on('update-not-available', () => {
    uiState.update = { status: 'up-to-date', version: app.getVersion(), percent: 100, message: '' };
    pushUiState();
  });

  autoUpdater.on('download-progress', (prog) => {
    uiState.update = {
      status: 'downloading',
      version: uiState.update.version,
      percent: prog?.percent || 0,
      message: '',
    };
    pushUiState();
  });

  autoUpdater.on('update-downloaded', (info) => {
    uiState.update = {
      status: 'downloaded',
      version: info?.version || uiState.update.version,
      percent: 100,
      message: '',
    };
    pushUiState();
  });

  autoUpdater.on('error', (err) => {
    const raw = err?.message || String(err);
    const noReleaseYet = /404|No published versions|Cannot find latest\.yml/i.test(raw);
    uiState.update = noReleaseYet
      ? { status: 'up-to-date', version: app.getVersion(), percent: 100, message: '当前已是最新发行状态' }
      : { status: 'error', version: null, percent: 0, message: '连接 GitHub 更新源超时，可点击右侧前往 Releases 页面查看' };
    pushUiState();
  });
}

async function triggerUpdateCheck() {
  if (hasPackagedUpdateConfig()) {
    try {
      await autoUpdater.checkForUpdates();
      return uiState.update;
    } catch {
      return uiState.update;
    }
  }

  // Fallback check via GitHub Releases API when running unpacked or from dev source
  uiState.update = { status: 'checking', version: null, percent: 0, message: '' };
  pushUiState();
  try {
    const res = await fetch(GITHUB_RELEASES_API, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'MorphoGem-Desktop' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) {
      uiState.update = { status: 'up-to-date', version: app.getVersion(), percent: 100, message: '' };
      pushUiState();
      return uiState.update;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const remoteVer = String(data.tag_name || '').replace(/^v/i, '');
    if (remoteVer && compareSemver(remoteVer, app.getVersion()) > 0) {
      uiState.update = { status: 'available', version: remoteVer, percent: 0, htmlUrl: data.html_url };
    } else {
      uiState.update = { status: 'up-to-date', version: app.getVersion(), percent: 100, message: '' };
    }
  } catch {
    uiState.update = { status: 'error', version: null, percent: 0, message: '无法连接 GitHub API，请检查网络或直接访问 Releases 页面' };
  }
  pushUiState();
  return uiState.update;
}

async function readInternalCdpWsEndpoint(timeoutMs = 10000) {
  const portFile = path.join(paths.chromiumDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(portFile, 'utf8');
      const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length >= 2) {
        const port = Number.parseInt(lines[0], 10);
        if (Number.isInteger(port) && port > 0) {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
          if (res.ok) {
            const info = await res.json();
            if (info?.webSocketDebuggerUrl) return { port, wsEndpoint: info.webSocketDebuggerUrl };
          }
        }
      }
    } catch {
      // wait until DevTools server writes DevToolsActivePort
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Failed to discover internal Electron CDP endpoint');
}

function configureWorkbenchDownloads() {
  const wbSes = session.defaultSession;
  wbSes.on('will-download', (_event, item) => {
    const rawName = item.getFilename() || `export-${Date.now()}`;
    const safeName = path.basename(rawName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    fsSync.mkdirSync(userDownloadsDir, { recursive: true });
    const finalPath = path.join(userDownloadsDir, safeName);
    item.setSavePath(finalPath);

    uiState.download = {
      active: true,
      filename: safeName,
      received: 0,
      total: item.getTotalBytes(),
    };
    pushUiState();

    item.on('updated', (_ev, state) => {
      if (state === 'progressing') {
        uiState.download = {
          active: true,
          filename: safeName,
          received: item.getReceivedBytes(),
          total: item.getTotalBytes(),
        };
        pushUiState();
      }
    });

    item.once('done', (_ev, state) => {
      uiState.download = { active: false, filename: '', received: 0, total: 0 };
      if (state === 'completed') {
        uiState.lastSavedDownload = { filename: safeName, fullPath: finalPath };
        if (savedNoticeTimer) clearTimeout(savedNoticeTimer);
        savedNoticeTimer = setTimeout(() => {
          uiState.lastSavedDownload = null;
          pushUiState();
        }, 9000);
      }
      pushUiState();
    });
  });
}

function configureTripoSession() {
  const tripoSes = session.fromPartition('persist:tripo');
  tripoSes.setUserAgent(CLEAN_CHROME_UA);

  tripoSes.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = CLEAN_CHROME_UA;
    if (headers['sec-ch-ua']) {
      headers['sec-ch-ua'] = `"Chromium";v="${chromeMajorVer}", "Google Chrome";v="${chromeMajorVer}", "Not-A.Brand";v="99"`;
    }
    if (headers['sec-ch-ua-full-version-list']) {
      headers['sec-ch-ua-full-version-list'] = `"Chromium";v="${chromeFullVer}", "Google Chrome";v="${chromeFullVer}", "Not-A.Brand";v="99.0.0.0"`;
    }
    callback({ requestHeaders: headers });
  });

  tripoSes.on('will-download', (_event, item) => {
    const rawName = item.getFilename() || `tripo-export-${Date.now()}.zip`;
    const safeName = path.basename(rawName);
    fsSync.mkdirSync(paths.tripoStagingDir, { recursive: true });
    const finalPath = path.join(paths.tripoStagingDir, safeName);
    const tempPath = `${finalPath}.crdownload`;

    try { fsSync.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    item.setSavePath(tempPath);

    uiState.download = {
      active: true,
      filename: safeName,
      received: 0,
      total: item.getTotalBytes(),
    };
    pushUiState();

    item.on('updated', (_ev, state) => {
      if (state === 'progressing') {
        uiState.download = {
          active: true,
          filename: safeName,
          received: item.getReceivedBytes(),
          total: item.getTotalBytes(),
        };
        pushUiState();
      }
    });

    item.once('done', async (_ev, state) => {
      try {
        if (state === 'completed') {
          await fs.rm(finalPath, { force: true }).catch(() => {});
          await fs.rename(tempPath, finalPath);
        } else {
          await fs.rm(tempPath, { force: true }).catch(() => {});
        }
      } finally {
        uiState.download = { active: false, filename: '', received: 0, total: 0 };
        pushUiState();
      }
    });
  });

  return tripoSes;
}

async function refreshTripoQuickState() {
  if (!tripoView || tripoView.webContents.isDestroyed()) return;
  try {
    const info = await tripoView.webContents.executeJavaScript(`(() => {
      const url = location.href || '';
      const title = document.title || '';
      const bodyText = (document.body?.innerText || '').slice(0, 2500);
      const hasTurnstile = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, #challenge-running')
        || /verify you are human|just a moment|請稍候|请稍候|checking your browser/i.test(title);
      if (hasTurnstile && bodyText.length < 800) return { blocked: 'CAPTCHA_OR_CHALLENGE', credits: null, ready: false };
      const buttons = [...document.querySelectorAll('button, a')].map(el => (el.innerText || '').trim());
      const hasLogin = buttons.some(t => /^(sign in|log in|登录|登入)$/i.test(t));
      const hasWorkspace = !!document.querySelector('main') && buttons.some(t => /generate|hd model|export/i.test(t));
      if (hasLogin && !hasWorkspace) return { blocked: 'AUTH_REQUIRED', credits: null, ready: false };
      const creditsEl = [...document.querySelectorAll('header *, banner *, nav *, body *')].find(el => {
        if (el.children.length > 0 || el.closest('button')) return false;
        const txt = (el.textContent || '').trim();
        if (!/^\\d{1,7}$/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.y >= 0 && r.y < 64 && r.x > window.innerWidth * 0.65;
      });
      return {
        blocked: null,
        ready: hasWorkspace || url.includes('/workspace/'),
        credits: creditsEl ? Number.parseInt(creditsEl.textContent.trim(), 10) : null,
      };
    })()`, true);

    uiState.tripoBlocked = info.blocked;
    uiState.tripoReady = Boolean(info.ready && !info.blocked);
    if (Number.isInteger(info.credits)) uiState.tripoCredits = info.credits;
    pushUiState();
  } catch {
    // page still loading
  }
}

function buildAgentMcpConfigJson() {
  const serverScript = path.join(paths.appCoreDir, 'tripo_mcp', 'server.mjs');
  const stateFile = path.join(paths.localDir, 'tripo-daemon-state.json');
  if (app.isPackaged) {
    return JSON.stringify({
      mcpServers: {
        'tripo-studio': {
          command: process.execPath,
          args: [serverScript],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            TRIPO_DAEMON_STATE_FILE: stateFile,
          },
        },
      },
    }, null, 2);
  }
  return JSON.stringify({
    mcpServers: {
      'tripo-studio': {
        command: 'node',
        args: [serverScript],
        env: {
          TRIPO_DAEMON_STATE_FILE: stateFile,
        },
      },
    },
  }, null, 2);
}

function registerIpc() {
  ipcMain.handle('desktop:get-state', () => uiState);
  ipcMain.handle('desktop:switch-tab', (_e, tab) => {
    setActiveTab(tab);
    if (tab === 'tripo') void refreshTripoQuickState();
    return uiState;
  });
  ipcMain.handle('desktop:open-projects', async () => {
    await fs.mkdir(paths.projectsDir, { recursive: true });
    await shell.openPath(paths.projectsDir);
    return true;
  });
  ipcMain.handle('desktop:open-mods', async () => {
    await fs.mkdir(paths.modsDir, { recursive: true });
    await shell.openPath(paths.modsDir);
    return true;
  });
  ipcMain.handle('desktop:open-downloads', async () => {
    await fs.mkdir(userDownloadsDir, { recursive: true });
    await shell.openPath(userDownloadsDir);
    return true;
  });
  ipcMain.handle('desktop:choose-downloads', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择默认导出文件存放目录',
      defaultPath: userDownloadsDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!res.canceled && res.filePaths?.[0]) {
      userDownloadsDir = path.resolve(res.filePaths[0]);
      await fs.mkdir(userDownloadsDir, { recursive: true });
      await saveDesktopSettings({ userDownloadsDir });
      uiState.userDownloadsDir = userDownloadsDir;
      pushUiState();
      return userDownloadsDir;
    }
    return null;
  });
  ipcMain.handle('desktop:choose-blender', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择本机安装的 Blender 可执行文件 (blender.exe)',
      defaultPath: uiState.blenderPath ? path.dirname(uiState.blenderPath) : (process.env.ProgramFiles || 'C:\\Program Files'),
      filters: [
        { name: 'Blender 可执行程序 (blender.exe)', extensions: process.platform === 'win32' ? ['exe'] : ['*'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths?.[0]) return null;
    const valid = await jobsModRef?.validateBlenderExecutable?.(res.filePaths[0]);
    if (!valid) {
      await dialog.showMessageBox(win, {
        type: 'warning',
        title: '无效的 Blender 可执行文件',
        message: '请选择名为 blender.exe 的 Blender 主程序文件（推荐 Blender 4.2 ~ 5.2）。',
      });
      return null;
    }
    process.env.BLENDER = valid;
    await saveDesktopSettings({ blenderPath: valid });
    const py = await jobsModRef?.findBundledPython?.();
    if (py) process.env.PYTHON = py;
    uiState.blenderFound = true;
    uiState.blenderPath = valid;
    pushUiState();
    return valid;
  });
  ipcMain.handle('desktop:notify-blender-updated', async (_e, newPath) => {
    desktopSettings = loadDesktopSettingsSync();
    if (newPath) {
      process.env.BLENDER = newPath;
      const py = await jobsModRef?.findBundledPython?.();
      if (py) process.env.PYTHON = py;
      uiState.blenderFound = true;
      uiState.blenderPath = newPath;
    } else {
      delete process.env.BLENDER;
      uiState.blenderFound = false;
      uiState.blenderPath = null;
    }
    pushUiState();
    return true;
  });
  ipcMain.handle('desktop:check-updates', () => triggerUpdateCheck());
  ipcMain.handle('desktop:download-update', async () => {
    if (hasPackagedUpdateConfig()) {
      await autoUpdater.downloadUpdate();
      return true;
    }
    const targetUrl = uiState.update?.htmlUrl || 'https://github.com/MorphoDiana/MorphoGem/releases/latest';
    await shell.openExternal(targetUrl);
    return true;
  });
  ipcMain.handle('desktop:install-update', () => {
    if (hasPackagedUpdateConfig() && uiState.update.status === 'downloaded') {
      autoUpdater.quitAndInstall(false, true);
      return true;
    }
    return false;
  });
  ipcMain.handle('desktop:reveal-last-download', () => {
    if (uiState.lastSavedDownload?.fullPath) {
      shell.showItemInFolder(uiState.lastSavedDownload.fullPath);
      return true;
    }
    void shell.openPath(userDownloadsDir);
    return true;
  });
  ipcMain.handle('desktop:copy-mcp-config', () => {
    clipboard.writeText(buildAgentMcpConfigJson());
    return true;
  });
  ipcMain.handle('desktop:reload-active', () => {
    scheduleRelayout();
    const target = uiState.activeTab === 'tripo' ? tripoView : workbenchView;
    target?.webContents.reload();
    return true;
  });
  ipcMain.handle('desktop:check-tripo', async () => {
    await refreshTripoQuickState();
    return uiState;
  });
}

async function findFreePort(preferredPort = 8766) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', () => {
      const fallback = net.createServer();
      fallback.once('error', reject);
      fallback.listen(0, '127.0.0.1', () => {
        const p = fallback.address().port;
        fallback.close(() => resolve(p));
      });
    });
    tester.listen(preferredPort, '127.0.0.1', () => {
      const p = tester.address().port;
      tester.close(() => resolve(p));
    });
  });
}

app.on('second-instance', (_event, argv) => {
  void handleCliFileArgs(argv);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  try {
    process.env.MORPHOGEM_TOOLS_DIR = paths.toolsDir;
    process.env.MORPHOGEM_USERDATA_DIR = paths.localDir;
    process.env.MORPHOGEM_PROJECTS_ROOT = paths.projectsDir;
    process.env.MORPHOGEM_MODS_DIR = paths.modsDir;
    process.env.MORPHOGEM_SETTINGS_FILE = paths.settingsFile;
    process.env.MORPHOGEM_SESSION_FILE = path.join(paths.localDir, 'session.json');
    process.env.TRIPO_DOWNLOAD_DIR = paths.tripoStagingDir;
    process.env.TRIPO_AUTO_CLEAN_STAGING = '1';
    process.env.TRIPO_EMBEDDED = '1';

    await handleCliFileArgs(process.argv);

    const jobsMod = await import(pathToFileURL(path.join(paths.appCoreDir, 'server-blender.mjs')).href);
    jobsModRef = jobsMod;
    const blenderExe = await jobsMod.findBlender();
    if (blenderExe) {
      process.env.BLENDER = blenderExe;
      uiState.blenderFound = true;
      uiState.blenderPath = blenderExe;
    }
    const bundledPy = await jobsMod.findBundledPython();
    if (bundledPy) {
      process.env.PYTHON = bundledPy;
    }

    const srvMod = await import(pathToFileURL(path.join(paths.appCoreDir, 'server.mjs')).href);
    const port = await findFreePort(Number(process.env.PORT || 8766));
    workbenchSrv = await srvMod.startMorphoGemServer({
      port,
      host: '127.0.0.1',
      sessionOptions: {
        directory: paths.projectsDir,
        stateFile: path.join(paths.localDir, 'session.json'),
      },
    });
    uiState.workbenchUrl = workbenchSrv.url;
    if (pendingCliMgemPath && fsSync.existsSync(pendingCliMgemPath)) {
      try {
        const buf = await fs.readFile(pendingCliMgemPath);
        await fetch(`${workbenchSrv.url}/api/session/open`, {
          method: 'POST',
          headers: { host: new URL(workbenchSrv.url).host },
          body: buf,
        });
      } catch {
        // ignore
      }
      pendingCliMgemPath = null;
    }

    setupAutoUpdater();
    configureWorkbenchDownloads();
    const tripoSes = configureTripoSession();
    registerIpc();

    const iconFile = path.join(__dirname, 'build', 'icon.ico');
    win = new BaseWindow({
      width: 1480,
      height: 940,
      minWidth: 1024,
      minHeight: 680,
      title: 'MorphoGem — 节点式 3D 角色工坊',
      icon: fsSync.existsSync(iconFile) ? iconFile : undefined,
      backgroundColor: '#0f172a',
      show: !isSmokeTest,
    });

    toolbarView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload-toolbar.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    workbenchView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload-toolbar.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    tripoView = new WebContentsView({
      webPreferences: {
        session: tripoSes,
        preload: path.join(__dirname, 'preload-tripo.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    tripoView.webContents.setUserAgent(CLEAN_CHROME_UA);
    tripoView.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://studio.tripo3d.ai') || url.startsWith('https://accounts.tripo3d.ai')) {
        tripoView.webContents.loadURL(url);
        setActiveTab('tripo');
        return { action: 'deny' };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });

    workbenchView.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
        return { action: 'allow' };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });

    win.contentView.addChildView(tripoView);
    win.contentView.addChildView(workbenchView);
    win.contentView.addChildView(toolbarView);
    scheduleRelayout();
    win.on('resize', layoutViews);
    for (const evName of ['restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'show', 'focus']) {
      win.on(evName, scheduleRelayout);
    }

    await toolbarView.webContents.loadFile(path.join(__dirname, 'toolbar.html'));
    void workbenchView.webContents.loadURL(workbenchSrv.url);
    if (!isSmokeTest) {
      void tripoView.webContents.loadURL(TRIPO_START_URL);
    } else {
      await tripoView.webContents.loadURL('data:text/html;charset=utf-8,<html><title>Tripo Smoke Stub</title><body><main><button>HD Model</button><button>Generate</button></main></body></html>');
    }

    tripoView.webContents.on('did-finish-load', () => { void refreshTripoQuickState(); });
    tripoView.webContents.on('did-navigate-in-page', () => { void refreshTripoQuickState(); });

    const cdp = await readInternalCdpWsEndpoint();
    const daemonMod = await import(pathToFileURL(path.join(paths.appCoreDir, 'tripo_mcp', 'daemon.mjs')).href);
    const localStateFile = path.join(paths.localDir, 'tripo-daemon-state.json');
    const extraStates = [];
    if (!isSmokeTest && !app.isPackaged) {
      extraStates.push(path.join(paths.appCoreDir, 'tripo_mcp', '.daemon-state.json'));
    }

    tripoDaemon = await daemonMod.startTripoRpcDaemon({
      wsEndpoint: cdp.wsEndpoint,
      embedded: true,
      idleTimeoutMs: 0,
      stateFile: localStateFile,
      extraStateFiles: extraStates,
      onActivity: (act) => {
        uiState.tripoActivity = act || { active: false, label: '' };
        pushUiState();
      },
      onBlocked: (check) => {
        uiState.tripoBlocked = check?.blocked || 'AUTH_REQUIRED';
        uiState.tripoReady = false;
        setActiveTab('tripo');
      },
      onUnblocked: () => {
        uiState.tripoBlocked = null;
        uiState.tripoReady = true;
        void refreshTripoQuickState();
      },
    });

    pushUiState();
    statusPollTimer = setInterval(() => { void refreshTripoQuickState(); }, 8000);

    // Non-blocking silent update check 4 seconds after launch
    if (!isSmokeTest && hasPackagedUpdateConfig()) {
      setTimeout(() => { void triggerUpdateCheck(); }, 4000);
    }

    if (isSmokeTest) {
      await new Promise((resolve) => {
        if (!workbenchView.webContents.isLoading()) resolve();
        else workbenchView.webContents.once('did-finish-load', resolve);
      });
      await new Promise(r => setTimeout(r, 350));
      const uaCheck = await tripoView.webContents.executeJavaScript('({ ua: navigator.userAgent, webdriver: navigator.webdriver, w: window.innerWidth, h: window.innerHeight })');
      const wbCheck = await workbenchView.webContents.executeJavaScript(`(() => {
        const ws = document.getElementById('nodeGraphWorkspace');
        const wsRect = ws ? ws.getBoundingClientRect() : { width: 0, height: 0 };
        const centerRect = document.getElementById('headerCenterSlot')?.getBoundingClientRect() || { left: 0, right: 0 };
        const actionsFirstBtn = document.querySelector('.header-actions .hdr-btn')?.getBoundingClientRect() || { left: 9999 };
        const beforeCount = document.querySelectorAll('#ngNodesLayer .ng-node').length;
        document.getElementById('ngQuickAddBtn')?.click();
        const firstQuickItem = document.querySelector('#ngQuickList .ng-quick-item');
        firstQuickItem?.click();
        const afterCount = document.querySelectorAll('#ngNodesLayer .ng-node').length;
        return {
          title: document.title,
          brandName: document.querySelector('#studioBrandName')?.textContent?.trim() || '',
          hasLocaleSwitch: !!document.getElementById('localeSwitchBtn'),
          hasModsBtn: !!document.getElementById('ngModsBtn'),
          hasViewportSection: !!document.getElementById('viewport3DWorkspace'),
          nodeGraphActive: document.body.classList.contains('node-graph-active'),
          canvasVisibleHeight: Math.round(wsRect.height),
          headerNoOverlap: centerRect.right <= actionsFirstBtn.left,
          renderedNodeCardsBefore: beforeCount,
          renderedNodeCardsAfterAdd: afterCount,
        };
      })()`);
      // Verify instant dropdown onchange template switching (deluxe_composite = 17 nodes, chibi mod = 9 nodes)
      await workbenchView.webContents.executeJavaScript(`(() => {
        const sel = document.getElementById('ngTemplateSelect');
        sel.value = 'deluxe_composite';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise(r => setTimeout(r, 250));
      const deluxeNodeCount = await workbenchView.webContents.executeJavaScript(`document.querySelectorAll('#ngNodesLayer .ng-node').length`);
      wbCheck.deluxeTemplateNodes = deluxeNodeCount;
      // Verify Smart Mesh UV/Retexture controls render when switching a tripo_mesh node to 'smart'
      const smartCheck = await workbenchView.webContents.executeJavaScript(`(() => {
        const meshCard = document.querySelector('#ngNodesLayer .ng-node[data-type="tripo_mesh"]');
        const modeSel = meshCard?.querySelector('select');
        if (modeSel) {
          modeSel.value = 'smart';
          modeSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const updatedCard = document.querySelector('#ngNodesLayer .ng-node[data-type="tripo_mesh"]');
        const txt = updatedCard?.innerText || '';
        return txt.includes('Smart UV') && txt.includes('Retexture');
      })()`);
      wbCheck.smartUvRetexRendered = smartCheck;
      const sessRes = await fetch(`${workbenchSrv.url}/api/session`, { headers: { host: new URL(workbenchSrv.url).host } });
      const sessJson = await sessRes.json();
      const smokeResult = {
        ok: true,
        version: app.getVersion(),
        packaged: app.isPackaged,
        projectsDir: paths.projectsDir,
        modsDir: paths.modsDir,
        userDownloadsDir,
        activeProjectPath: sessJson?.active?.path || null,
        workbenchChecks: wbCheck,
        cleanUserAgent: !uaCheck.ua.includes('Electron') && uaCheck.ua.includes('Chrome/'),
        webdriverHidden: uaCheck.webdriver === false,
      };
      if (!wbCheck.hasModsBtn || wbCheck.canvasVisibleHeight < 300 || !wbCheck.headerNoOverlap || wbCheck.renderedNodeCardsAfterAdd <= wbCheck.renderedNodeCardsBefore || wbCheck.deluxeTemplateNodes !== 17 || !wbCheck.smartUvRetexRendered) {
        throw new Error('Workbench UI layout, node-creation, template-switch, or Smart UV check failed: ' + JSON.stringify(wbCheck));
      }
      console.log('DESKTOP_SMOKE_OK ' + JSON.stringify(smokeResult));
      setTimeout(() => app.quit(), 250);
    }
  } catch (err) {
    console.error('DESKTOP_INIT_FAILED:', err);
    if (isSmokeTest) {
      app.exit(1);
    }
  }
});

let cleaningUp = false;
app.on('before-quit', (e) => {
  if (cleaningUp) return;
  cleaningUp = true;
  e.preventDefault();
  if (statusPollTimer) clearInterval(statusPollTimer);
  if (savedNoticeTimer) clearTimeout(savedNoticeTimer);
  Promise.allSettled([
    tripoDaemon?.close?.(),
    workbenchSrv?.server ? new Promise(r => workbenchSrv.server.close(() => r())) : Promise.resolve(),
  ]).finally(() => {
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
