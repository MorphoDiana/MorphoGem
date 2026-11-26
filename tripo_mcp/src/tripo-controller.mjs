import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import {
  defaultDownloadsDir,
  snapshotDownloads,
  waitForCompletedDownload,
  extractAndVerifyDownload,
} from './downloads.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TRIPO_ORIGIN = 'https://studio.tripo3d.ai';
const TRIPO_GENERATE_URL = 'https://studio.tripo3d.ai/workspace/generate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultChromeUserDataDirs() {
  const dirs = [];
  if (process.env.TRIPO_CHROME_USER_DATA_DIR) {
    dirs.push(process.env.TRIPO_CHROME_USER_DATA_DIR);
  }
  dirs.push(path.resolve(__dirname, '../../local/chrome-debug-profile'));
  dirs.push(path.resolve(__dirname, '../../../chrome-debug-profile'));
  const platform = process.platform;
  if (platform === 'win32' && process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'));
    dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'));
  } else if (platform === 'darwin') {
    dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'));
  } else {
    dirs.push(path.join(os.homedir(), '.config', 'google-chrome'));
    dirs.push(path.join(os.homedir(), '.config', 'chromium'));
  }
  return dirs;
}

async function resolveAutoConnectWsEndpoint() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const info = await res.json();
      if (info?.webSocketDebuggerUrl) {
        return { wsEndpoint: info.webSocketDebuggerUrl, portFile: 'http://127.0.0.1:9222/json/version' };
      }
    }
  } catch {
    // fall through to DevToolsActivePort discovery
  }
  for (const dir of defaultChromeUserDataDirs()) {
    const portFile = path.join(dir, 'DevToolsActivePort');
    try {
      const raw = await fs.readFile(portFile, 'utf8');
      const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length >= 2) {
        const port = Number.parseInt(lines[0], 10);
        if (Number.isInteger(port) && port > 0 && port <= 65535 && lines[1].startsWith('/')) {
          return { wsEndpoint: `ws://127.0.0.1:${port}${lines[1]}`, portFile };
        }
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function extractUuid(str) {
  if (!str) return null;
  const m = String(str).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : null;
}

export class TripoController {
  #browser = null;
  #connecting = null;
  #lock = Promise.resolve();
  #options = {};
  #shieldStack = [];

  constructor(options = {}) {
    this.#options = options;
  }

  async #withLock(fn) {
    const prev = this.#lock;
    let release;
    this.#lock = new Promise(r => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async ensureBrowser() {
    if (this.#browser && this.#browser.connected) return this.#browser;
    if (this.#connecting) return this.#connecting;

    this.#connecting = (async () => {
      const wsEndpoint = this.#options.wsEndpoint || process.env.TRIPO_CHROME_WS;
      const browserURL = this.#options.browserURL || process.env.TRIPO_CHROME_URL;
      const connectOpts = {
        defaultViewport: null,
        protocolTimeout: 180000,
        targetFilter: t => !t.url().startsWith('chrome://'),
      };

      let hint = '';
      if (wsEndpoint) {
        connectOpts.browserWSEndpoint = wsEndpoint;
        hint = `wsEndpoint=${wsEndpoint}`;
      } else if (browserURL) {
        connectOpts.browserURL = browserURL;
        hint = `browserURL=${browserURL}`;
      } else {
        const auto = await resolveAutoConnectWsEndpoint();
        if (!auto) {
          throw new Error(
            '未检测到已开启远程调试的桌面 Chrome（未找到 DevToolsActivePort）。请在现有桌面 Chrome 地址栏打开 chrome://inspect/#remote-debugging 并勾选启用远程调试，然后重试。'
          );
        }
        connectOpts.browserWSEndpoint = auto.wsEndpoint;
        hint = `DevToolsActivePort (${auto.wsEndpoint})`;
      }

      try {
        const browser = await Promise.race([
          puppeteer.connect(connectOpts),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('等待 Chrome 远程调试授权超时（90 秒）')), 90000)
          ),
        ]);
        browser.once('disconnected', () => {
          if (this.#browser === browser) this.#browser = null;
        });
        this.#browser = browser;
        return browser;
      } catch (err) {
        throw new Error(
          `无法连接到现有桌面 Chrome [${hint}]：${err.message}。若 Chrome 顶栏弹出了“允许远程调试 / Allow remote debugging”确认框，请点击“允许 / Allow”后重试；或确认 chrome://inspect/#remote-debugging 已开启。`
        );
      } finally {
        this.#connecting = null;
      }
    })();

    return this.#connecting;
  }

  async disconnect() {
    if (this.#browser) {
      const b = this.#browser;
      this.#browser = null;
      try { await b.disconnect(); } catch { /* ignore */ }
    }
  }

  #isEmbedded() {
    return Boolean(this.#options.embedded || process.env.TRIPO_EMBEDDED === '1');
  }

  async #navigateToGenerateSpa(page) {
    if (/\/workspace\/generate(\/|$|\?)/.test(page.url())) return;
    if (page.url().startsWith(TRIPO_ORIGIN)) {
      const clickedSpa = await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('a[href*="/workspace/generate"], nav a, aside a')];
        const genLink = candidates.find(a => {
          const href = a.getAttribute('href') || '';
          const r = a.getBoundingClientRect();
          return /\/workspace\/generate(\/|$|\?)/.test(href) && r.width > 0 && r.height > 0 && r.x < 240;
        });
        if (genLink) {
          genLink.click();
          return true;
        }
        return false;
      }).catch(() => false);

      if (clickedSpa) {
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !/\/workspace\/generate(\/|$|\?)/.test(page.url())) {
          await sleep(250);
        }
        if (/\/workspace\/generate(\/|$|\?)/.test(page.url())) {
          await sleep(1200);
          return;
        }
      }
    }
    await page.goto(TRIPO_GENERATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
  }

  async getTripoPage({ navigateIfNeeded = true } = {}) {
    const browser = await this.ensureBrowser();
    const pages = await browser.pages();

    // Reuse an existing studio.tripo3d.ai tab without ever touching localhost/127.0.0.1 app tabs
    let page = pages.find(p => {
      try {
        return p.url().startsWith(TRIPO_ORIGIN);
      } catch {
        return false;
      }
    });

    if (!page) {
      page = await browser.newPage();
      await page.goto(TRIPO_GENERATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2500);
    } else if (navigateIfNeeded && !page.url().includes('/workspace/')) {
      await this.#navigateToGenerateSpa(page);
    }

    if (!this.#isEmbedded()) {
      try {
        await page.bringToFront();
      } catch {
        // ignore if headless/background
      }
    }
    if (this.#shieldStack.length === 0) {
      await this.#removeUiShield(page);
    }
    await this.assertNotBlocked(page);
    return page;
  }

  /**
   * Safety & compliance gate: never click through or bypass CAPTCHAs, anti-bot challenges,
   * or login walls. Stop immediately and report clearly to the user.
   */
  async assertNotBlocked(page) {
    const check = await page.evaluate(() => {
      const url = location.href;
      const title = document.title || '';
      const bodyText = (document.body?.innerText || '').slice(0, 3000);
      const hasTurnstile =
        !!document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, #challenge-running') ||
        /verify you are human|just a moment|請稍候|请稍候|checking your browser/i.test(title);
      if (hasTurnstile && bodyText.length < 800) {
        return { blocked: 'CAPTCHA_OR_CHALLENGE', url, title };
      }
      const buttons = [...document.querySelectorAll('button, a')].map(el => (el.innerText || '').trim());
      const hasLoginBtn = buttons.some(t => /^(sign in|log in|登录|登入)$/i.test(t));
      const hasWorkspace = !!document.querySelector('main') && buttons.some(t => /generate|hd model|export/i.test(t));
      if (hasLoginBtn && !hasWorkspace) {
        return { blocked: 'AUTH_REQUIRED', url, title };
      }
      return { blocked: null, url, title };
    });

    if (check.blocked === 'CAPTCHA_OR_CHALLENGE') {
      try { this.#options.onBlocked?.(check); } catch { /* ignore */ }
      throw new Error(
        `[BLOCKED: CAPTCHA_OR_CHALLENGE] Tripo 页面 (${check.url}) 当前处于人机验证/安全检查页面（标题: "${check.title}"）。请切到 Tripo 工作区手动完成验证后再继续，工具不会自动点击或绕过验证。`
      );
    }
    if (check.blocked === 'AUTH_REQUIRED') {
      try { this.#options.onBlocked?.(check); } catch { /* ignore */ }
      throw new Error(
        `[BLOCKED: AUTH_REQUIRED] Tripo 页面 (${check.url}) 尚未登录。请在 Tripo 工作区登录账号后再重试。`
      );
    }
    try { this.#options.onUnblocked?.(check); } catch { /* ignore */ }
  }

  async #readWorkspaceSnapshot(page) {
    return page.evaluate(() => {
      // Credits text sits in the top header next to "Upgrade" and is NOT inside a notification <button>
      const creditsEl = [...document.querySelectorAll('header *, banner *, nav *, body *')].find(el => {
        if (el.children.length > 0) return false;
        if (el.closest('button')) return false;
        const txt = (el.textContent || '').trim();
        if (!/^\d{1,7}$/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.y >= 0 && r.y < 64 && r.x > window.innerWidth * 0.65;
      });

      const hdBtn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === 'HD Model');
      const smartBtn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim().startsWith('Smart Mesh'));

      // Read AI Model combobox text (walk up from "AI Model" label until a [role="combobox"] is found)
      let aiModel = null;
      const aiLabel = [...document.querySelectorAll('*')].find(
        el => el.children.length === 0 && (el.textContent || '').trim() === 'AI Model' && el.getBoundingClientRect().x < 360
      );
      if (aiLabel) {
        let box = aiLabel.parentElement;
        while (box && !box.querySelector('[role="combobox"]') && box.tagName !== 'MAIN') {
          box = box.parentElement;
        }
        const combo = box?.querySelector('[role="combobox"]');
        if (combo) aiModel = (combo.textContent || combo.getAttribute('value') || '').trim().replace(/\s+/g, ' ');
      }

      // Read HUD Faces / Vertices if a model is open
      const findMetric = label => {
        const el = [...document.querySelectorAll('*')].find(n => n.children.length === 0 && (n.textContent || '').trim() === label);
        const next = el?.nextElementSibling || el?.parentElement?.querySelector(':scope > :last-child');
        return next && next !== el ? (next.textContent || '').trim() : null;
      };

      const exportBtn = [...document.querySelectorAll('button')].find(b => {
        const t = (b.innerText || '').trim();
        const r = b.getBoundingClientRect();
        return /^(Export|导出)$/i.test(t) && r.width > 0 && r.y > window.innerHeight * 0.65 && !b.closest('[role="dialog"]');
      });

      // Read right-side Assets panel items only (exclude left-rail nav link "Model")
      const seenIds = new Set();
      const assetLinks = [];
      for (const a of document.querySelectorAll('a[href*="/workspace/"]')) {
        const r = a.getBoundingClientRect();
        if (r.x < window.innerWidth * 0.5) continue;
        const href = a.getAttribute('href') || '';
        const uuidMatch = href.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        const modelId = uuidMatch ? uuidMatch[1].toLowerCase() : null;
        if (!modelId || seenIds.has(modelId)) continue;
        seenIds.add(modelId);
        const text = (a.innerText || '').trim().replace(/\s+/g, ' ');
        const hasCancelBtn = [...a.querySelectorAll('button')].some(b => /cancel/i.test(b.innerText || ''));
        const img = a.querySelector('img');
        assetLinks.push({
          modelId,
          href: new URL(href, location.origin).href,
          text,
          status: hasCancelBtn || /generating|queued/i.test(text) ? 'generating' : 'ready',
          thumbnail: img ? img.src : null,
        });
      }

      return {
        url: location.href,
        title: document.title,
        credits: creditsEl ? Number.parseInt(creditsEl.textContent.trim(), 10) : null,
        aiModel,
        faces: findMetric('Faces'),
        vertices: findMetric('Vertices'),
        exportReady: !!exportBtn && !exportBtn.disabled,
        hdModelVisible: !!hdBtn,
        smartMeshVisible: !!smartBtn,
        assets: assetLinks,
      };
    });
  }

  async #safeScreenshot(page, screenshotPath) {
    const abs = path.resolve(screenshotPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const client = await page.createCDPSession();
    try {
      const { data } = await Promise.race([
        client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout (window occluded)')), 5000)),
      ]);
      await fs.writeFile(abs, Buffer.from(data, 'base64'));
      return abs;
    } catch {
      return null;
    } finally {
      try { await client.detach(); } catch { /* ignore */ }
    }
  }

  async status({ screenshotPath, maxAssets = 10 } = {}) {
    return this.#withLock(async () => {
      const page = await this.getTripoPage({ navigateIfNeeded: false });
      const snap = await this.#readWorkspaceSnapshot(page);
      if (Number.isInteger(maxAssets) && maxAssets > 0 && snap.assets.length > maxAssets) {
        snap.totalAssetsInPanel = snap.assets.length;
        snap.assets = snap.assets.slice(0, maxAssets);
      }
      if (screenshotPath) {
        snap.screenshotPath = await this.#safeScreenshot(page, screenshotPath);
      }
      return snap;
    });
  }

  async #closeAnyOpenModalDialogs(page) {
    await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(d => d.offsetParent !== null);
      for (const d of dialogs) {
        const txt = d.innerText || '';
        if (/Geometry & Texture|Export/i.test(txt)) {
          const closeBtn = d.querySelector('button');
          if (closeBtn) closeBtn.click();
        }
      }
    });
    await sleep(250);
  }

  /**
   * Installs/updates an in-page capture-phase input lock + visual shield on Tripo Studio so human
   * mouse wheel scrolling, cursor hover, or accidental clicks cannot disrupt dropdowns/dialogs
   * while TripoController is actively clicking UI controls. Automatically removed in `finally`.
   */
  async #installUiShield(page, label = '自动化操作中') {
    try {
      await page.evaluate((taskLabel) => {
        const SHIELD_ID = '__morphogem_tripo_lock__';
        if (!window.__morphogemShieldState) {
          const st = {
            active: true,
            allowPoint: null,
            allowKeysUntil: 0,
          };
          window.__morphogemShieldState = st;

          const swallow = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          };

          const onWheel = (e) => {
            if (!st.active) return;
            swallow(e);
          };

          const onPointer = (e) => {
            if (!st.active || !e.isTrusted) return;
            const ap = st.allowPoint;
            if (ap && performance.now() <= ap.until && Math.hypot(e.clientX - ap.x, e.clientY - ap.y) <= 6) {
              return;
            }
            swallow(e);
          };

          const onKey = (e) => {
            if (!st.active || !e.isTrusted) return;
            if (performance.now() <= st.allowKeysUntil) return;
            swallow(e);
          };

          const wheelEvents = ['wheel', 'mousewheel', 'DOMMouseScroll', 'touchmove'];
          const pointerEvents = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend'];
          const keyEvents = ['keydown', 'keypress', 'keyup'];

          for (const ev of wheelEvents) window.addEventListener(ev, onWheel, { capture: true, passive: false });
          for (const ev of pointerEvents) window.addEventListener(ev, onPointer, { capture: true, passive: false });
          for (const ev of keyEvents) window.addEventListener(ev, onKey, { capture: true, passive: false });

          st.cleanup = () => {
            st.active = false;
            st.allowPoint = null;
            st.allowKeysUntil = 0;
            for (const ev of wheelEvents) window.removeEventListener(ev, onWheel, { capture: true });
            for (const ev of pointerEvents) window.removeEventListener(ev, onPointer, { capture: true });
            for (const ev of keyEvents) window.removeEventListener(ev, onKey, { capture: true });
            document.getElementById(SHIELD_ID)?.remove();
            delete window.__morphogemShieldState;
          };
        } else {
          window.__morphogemShieldState.active = true;
        }

        let el = document.getElementById(SHIELD_ID);
        if (!el) {
          el = document.createElement('div');
          el.id = SHIELD_ID;
          el.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:2147483647',
            'pointer-events:auto',
            'cursor:not-allowed',
            'user-select:none',
            'background:rgba(10,14,24,0.18)',
            'display:flex',
            'align-items:flex-start',
            'justify-content:center',
            'padding-top:16px',
            'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
          ].join(';');
          const badge = document.createElement('div');
          badge.dataset.role = 'label';
          badge.style.cssText = [
            'padding:10px 20px',
            'border-radius:999px',
            'background:rgba(15,23,42,0.94)',
            'border:1.5px solid #f59e0b',
            'box-shadow:0 8px 28px rgba(0,0,0,0.45)',
            'color:#fef3c7',
            'font-size:13.5px',
            'font-weight:700',
            'letter-spacing:0.02em',
            'pointer-events:none',
          ].join(';');
          el.appendChild(badge);
          (document.body || document.documentElement).appendChild(el);
        }
        const badge = el.querySelector('[data-role="label"]');
        if (badge) {
          badge.textContent = `🔒 MorphoGem AI 正在操作 Tripo（${taskLabel}）— 页面已临时锁定防误触，请勿滚动滑轮或点击`;
        }
      }, label);
    } catch {
      // ignore transient navigation context destruction
    }
  }

  async #removeUiShield(page) {
    try {
      await page.evaluate(() => {
        if (window.__morphogemShieldState?.cleanup) {
          window.__morphogemShieldState.cleanup();
        } else {
          document.getElementById('__morphogem_tripo_lock__')?.remove();
        }
      });
    } catch {
      // ignore if page closed
    }
  }

  async safeClick(page, x, y, options = {}) {
    await page.evaluate(({ px, py }) => {
      const el = document.getElementById('__morphogem_tripo_lock__');
      if (el) el.style.pointerEvents = 'none';
      if (window.__morphogemShieldState) {
        window.__morphogemShieldState.allowPoint = { x: px, y: py, until: performance.now() + 1200 };
      }
    }, { px: x, py: y }).catch(() => {});
    try {
      await page.mouse.click(x, y, options);
    } finally {
      await page.evaluate(() => {
        if (window.__morphogemShieldState) window.__morphogemShieldState.allowPoint = null;
        const el = document.getElementById('__morphogem_tripo_lock__');
        if (el) el.style.pointerEvents = 'auto';
      }).catch(() => {});
    }
  }

  async safePress(page, key, options = {}) {
    await page.evaluate(() => {
      if (window.__morphogemShieldState) window.__morphogemShieldState.allowKeysUntil = performance.now() + 1200;
    }).catch(() => {});
    try {
      await page.keyboard.press(key, options);
    } finally {
      await page.evaluate(() => {
        if (window.__morphogemShieldState) window.__morphogemShieldState.allowKeysUntil = 0;
      }).catch(() => {});
    }
  }

  async safeType(page, text, options = {}) {
    await page.evaluate((len) => {
      if (window.__morphogemShieldState) window.__morphogemShieldState.allowKeysUntil = performance.now() + Math.max(1500, len * 120);
    }, String(text).length).catch(() => {});
    try {
      await page.keyboard.type(text, options);
    } finally {
      await page.evaluate(() => {
        if (window.__morphogemShieldState) window.__morphogemShieldState.allowKeysUntil = 0;
      }).catch(() => {});
    }
  }

  async withUiShield(page, label, fn) {
    this.#shieldStack.push(label);
    let currentLabel = label;
    try { this.#options.onActivity?.({ active: true, label: currentLabel }); } catch { /* ignore */ }
    await this.#installUiShield(page, currentLabel);
    const onLoad = () => {
      const activeLabel = this.#shieldStack[this.#shieldStack.length - 1] || currentLabel;
      this.#installUiShield(page, activeLabel).catch(() => {});
    };
    page.on('load', onLoad);
    try {
      return await fn({
        refresh: (nextLabel = label) => {
          currentLabel = nextLabel;
          if (this.#shieldStack.length > 0) {
            this.#shieldStack[this.#shieldStack.length - 1] = nextLabel;
          }
          try { this.#options.onActivity?.({ active: true, label: nextLabel }); } catch { /* ignore */ }
          return this.#installUiShield(page, nextLabel);
        },
        click: (x, y, opts) => this.safeClick(page, x, y, opts),
        press: (key, opts) => this.safePress(page, key, opts),
        type: (txt, opts) => this.safeType(page, txt, opts),
      });
    } finally {
      page.off('load', onLoad);
      this.#shieldStack.pop();
      if (this.#shieldStack.length === 0) {
        try { this.#options.onActivity?.({ active: false, label: '' }); } catch { /* ignore */ }
        await this.#removeUiShield(page);
      } else {
        const remainingLabel = this.#shieldStack[this.#shieldStack.length - 1];
        try { this.#options.onActivity?.({ active: true, label: remainingLabel }); } catch { /* ignore */ }
        await this.#installUiShield(page, remainingLabel);
      }
    }
  }

  /**
   * Configures Tripo Generate workspace, uploads 4 multi-view images (or 1 single image),
   * clicks Generate `count` times, and optionally waits for all models to complete.
   */
  async generate({
    mode = 'multiview', // 'multiview' | 'single'
    front,
    left,
    right,
    back,
    image,
    smartMesh = false,
    aiModel = smartMesh ? 'P2.0' : 'H3.5',
    ultraMesh = !smartMesh,
    texture = true,
    textureQuality = '4K',
    pbr = true,
    removeLighting = false,
    topology = smartMesh ? 'Quad' : 'Triangle',
    polycount = smartMesh ? 25000 : 5000000,
    generateInParts = false,
    count = 1,
    wait = false,
    pollIntervalMs = 6000,
    timeoutMs = 600000,
    screenshotDir,
  } = {}) {
    if (count < 1 || count > 4) throw new Error(`Invalid candidate count: ${count} (expected 1..4)`);
    if (mode === 'multiview') {
      for (const [k, v] of [['front', front], ['left', left], ['right', right], ['back', back]]) {
        if (!v) throw new Error(`Missing required multiview image "${k}"`);
        await fs.access(path.resolve(v));
      }
    } else if (mode === 'single') {
      const singleImg = image || front;
      if (!singleImg) throw new Error('Missing required "image" path for single-image mode');
      await fs.access(path.resolve(singleImg));
    } else {
      throw new Error(`Unsupported generation mode: ${mode}`);
    }

    const generatedIds = await this.#withLock(async () => {
      const page = await this.getTripoPage({ navigateIfNeeded: true });
      return this.withUiShield(page, '配置参数并提交模型生成', async (ui) => {
      if (!/\/workspace\/generate(\/|$|\?)/.test(page.url())) {
        await this.#navigateToGenerateSpa(page);
        await this.assertNotBlocked(page);
        await ui.refresh('配置参数并提交模型生成');
      }

      await this.#closeAnyOpenModalDialogs(page);

      // 1. Select HD Model vs Smart Mesh
      await page.evaluate((wantSmart) => {
        const target = wantSmart ? 'Smart Mesh' : 'HD Model';
        const btn = [...document.querySelectorAll('button')].find(b => {
          const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
          return wantSmart ? t.startsWith('Smart Mesh') : t === 'HD Model';
        });
        if (!btn) throw new Error(`Could not find top mode button "${target}"`);
        btn.click();
      }, Boolean(smartMesh));
      await sleep(500);

      // 2. Select Multi-view (cube icon) vs Single-image
      await page.evaluate((wantMulti) => {
        const leftButtons = [...document.querySelectorAll('button')].filter(b => {
          const r = b.getBoundingClientRect();
          return r.x > 40 && r.x < 340 && r.y > 110 && r.y < 210 && r.width < 80 && r.height < 50;
        });
        const byIcon = leftButtons.find(b =>
          wantMulti
            ? /multi-view|multiview/i.test(b.innerHTML)
            : /add-image/i.test(b.innerHTML)
        );
        const targetBtn = byIcon || leftButtons[wantMulti ? 1 : 0];
        if (!targetBtn) throw new Error(`Could not locate ${wantMulti ? 'Multi-view' : 'Single-image'} mode button`);
        targetBtn.click();
      }, mode === 'multiview');
      await sleep(500);

      // 3. Clear any previously uploaded images in the left input box
      await page.evaluate(() => {
        const trashBtns = [...document.querySelectorAll('button')].filter(b => {
          const r = b.getBoundingClientRect();
          return (
            r.x > 40 &&
            r.x < 340 &&
            r.y > 160 &&
            r.y < 520 &&
            /trash|delete/i.test(b.innerHTML)
          );
        });
        trashBtns.forEach(b => b.click());
      });
      await sleep(500);

      // 4. Upload image(s) to the left-panel <input type="file"> elements
      const fileInputs = await page.$$('input[type="file"]');
      const imageInputs = [];
      for (const handle of fileInputs) {
        const info = await handle.evaluate(el => {
          const accept = (el.getAttribute('accept') || '').toLowerCase();
          const parentText = (el.closest('div')?.innerText || '').trim();
          const rect = (el.parentElement || el).getBoundingClientRect();
          const is3DUpload = /obj|fbx|stl|glb/i.test(accept) || /upload 3d model/i.test(parentText) || rect.x > window.innerWidth * 0.5;
          return { is3DUpload, x: rect.x, y: rect.y, text: parentText.slice(0, 40) };
        });
        if (!info.is3DUpload) {
          imageInputs.push({ handle, ...info });
        }
      }

      if (mode === 'multiview') {
        if (imageInputs.length < 4) {
          throw new Error(`Expected 4 multi-view file inputs in Tripo left panel, found ${imageInputs.length}`);
        }
        // Sort top-to-bottom, left-to-right -> [Front, Left, Right, Back]
        imageInputs.sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x));
        const orderedPaths = [front, left, right, back].map(p => path.resolve(p));
        for (let i = 0; i < 4; i++) {
          await imageInputs[i].handle.uploadFile(orderedPaths[i]);
          await sleep(300);
        }
      } else {
        if (imageInputs.length < 1) {
          throw new Error('Could not find single-image file input in Tripo left panel');
        }
        await imageInputs[0].handle.uploadFile(path.resolve(image || front));
      }
      await sleep(1200);

      // 5. Select AI Model (e.g. "H3.1", "H3.5", "P2.0") first — Radix combobox needs real mouse click,
      // and selecting the AI Model before opening Geometry & Texture ensures model-specific controls are rendered!
      if (aiModel) {
        const aiComboRect = await page.evaluate((targetModel) => {
          const aiLabel = [...document.querySelectorAll('*')].find(
            el => el.children.length === 0 && (el.textContent || '').trim() === 'AI Model' && el.getBoundingClientRect().x < 340
          );
          if (!aiLabel) return null;
          let box = aiLabel.parentElement;
          while (box && !box.querySelector('button, [role="combobox"]') && box.tagName !== 'MAIN') {
            box = box.parentElement;
          }
          const btn = box?.querySelector('[role="combobox"], button');
          if (!btn) return null;
          const cur = (btn.innerText || btn.getAttribute('value') || '').trim();
          if (cur.toLowerCase().includes(String(targetModel).toLowerCase())) return null;
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, aiModel);

        if (aiComboRect) {
          await ui.click(aiComboRect.x, aiComboRect.y);
          await sleep(500);
          const optRect = await page.evaluate((targetModel) => {
            const want = String(targetModel).trim().toLowerCase();
            const opts = [...document.querySelectorAll('[role="option"], [data-radix-collection-item], [role="menuitem"]')].filter(
              el => el.offsetParent !== null && !el.querySelector('[role="option"], [data-radix-collection-item]')
            );
            const hit = opts.find(o => {
              const firstLine = (o.innerText || '').trim().split(/\r?\n/)[0].trim().toLowerCase();
              return firstLine === want || firstLine.includes(want);
            }) || opts.find(o => (o.innerText || '').toLowerCase().includes(want));
            if (!hit) return null;
            hit.scrollIntoView({ block: 'nearest' });
            const r = hit.getBoundingClientRect();
            return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          }, aiModel);
          if (optRect) {
            await ui.click(optRect.x, optRect.y);
          } else {
            await ui.press('Escape');
          }
          await sleep(450);
        }
      }

      // 6. Ensure standalone switches ("Generate in Parts", "8K Texture") match desired state
      const want8K = Boolean(texture) && String(textureQuality || '').trim().toUpperCase() === '8K';
      const pendingSwitches = await page.evaluate(({ wantParts, want8K }) => {
        const todo = [];
        const syncLeftSwitch = (patterns, want) => {
          const el = [...document.querySelectorAll('*')].find(n => {
            if (n.children.length > 0 || n.getBoundingClientRect().x >= 360) return false;
            const txt = (n.textContent || '').trim();
            return patterns.some(rx => rx.test(txt));
          });
          if (!el) return;
          let row = el.parentElement;
          while (row && !row.querySelector('[role="switch"]') && row.tagName !== 'MAIN') {
            row = row.parentElement;
          }
          const sw = row?.querySelector('[role="switch"]');
          if (!sw || sw.disabled) return;
          const checked = sw.getAttribute('aria-checked') === 'true' || sw.dataset.state === 'checked';
          if (checked !== want) {
            sw.scrollIntoView({ block: 'nearest' });
            sw.click();
            const after = sw.getAttribute('aria-checked') === 'true' || sw.dataset.state === 'checked';
            if (after !== want) {
              const r = sw.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) todo.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            }
          }
        };
        syncLeftSwitch([/^Generate in Parts$/i, /^分部件生成$/], Boolean(wantParts));
        syncLeftSwitch([/^8K Texture$/i, /^8K\s*(贴图|纹理)$/i], Boolean(want8K));
        return todo;
      }, { wantParts: Boolean(generateInParts), want8K });
      for (const pt of pendingSwitches) {
        await ui.click(pt.x, pt.y);
        await sleep(250);
      }

      // 7. Configure polycount & topology:
      //    - In Smart Mesh mode: click "Customize Poly Counts" popper -> select Quad (default) or Triangle -> enable "Use Same Polygon Count" -> enter polycount (500..25k Quad / 500..50k Triangle).
      //    - In HD Model mode: click "Geometry & Texture" popper -> set switches, texture quality, topology, and polycount (500..5,000,000).
      if (smartMesh) {
        const smartPolyRect = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(
            b => /Customize Poly Counts|自定义面数/i.test((b.innerText || '').trim())
          );
          if (!btn) return null;
          btn.scrollIntoView({ block: 'nearest' });
          const r = btn.getBoundingClientRect();
          return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        });

        if (smartPolyRect) {
          await ui.click(smartPolyRect.x, smartPolyRect.y);
          await sleep(550);
          const smartPolyAction = await page.evaluate(async (cfg) => {
            const s = ms => new Promise(r => setTimeout(r, ms));
            const dlg = [...document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"]')].find(
              d => d.offsetParent !== null && /Topology|Polycount|Polygon Count/i.test(d.innerText || '')
            );
            if (!dlg) return null;

            const wantTopo = String(cfg.topology || 'Quad').trim().toLowerCase() === 'triangle' ? 'triangle' : 'quad';
            const tBtn = [...dlg.querySelectorAll('button')].find(b => {
              const val = (b.getAttribute('value') || '').trim().toLowerCase();
              const txt = (b.innerText || '').trim().toLowerCase();
              return val === wantTopo || txt.startsWith(wantTopo);
            });
            if (tBtn && tBtn.dataset?.state !== 'on' && tBtn.getAttribute('aria-pressed') !== 'true') {
              tBtn.click();
              await s(250);
            }

            const samePolySw = dlg.querySelector('[role="switch"]');
            if (samePolySw) {
              const checked = samePolySw.getAttribute('aria-checked') === 'true' || samePolySw.dataset?.state === 'checked';
              if (!checked) {
                samePolySw.click();
                await s(200);
              }
            }

            if (Number.isInteger(cfg.polycount) && cfg.polycount > 0) {
              const polyInp = dlg.querySelector('input');
              const slider = dlg.querySelector('[role="slider"]');
              const sMin = Number(slider?.getAttribute('aria-valuemin')) || 500;
              const sMax = Number(slider?.getAttribute('aria-valuemax')) || (wantTopo === 'triangle' ? 50000 : 25000);
              const clamped = Math.max(sMin, Math.min(sMax, cfg.polycount));
              if (polyInp && polyInp.value !== String(clamped)) {
                const ir = polyInp.getBoundingClientRect();
                if (ir.width && ir.height) {
                  return { x: ir.x + ir.width / 2, y: ir.y + ir.height / 2, targetValue: String(clamped) };
                }
              }
            }
            return null;
          }, { topology: topology || 'Quad', polycount: Number.isInteger(polycount) ? polycount : 25000 });

          if (smartPolyAction) {
            await ui.click(smartPolyAction.x, smartPolyAction.y, { clickCount: 3 });
            await ui.press('Backspace');
            await ui.type(smartPolyAction.targetValue);
            await ui.press('Enter');
            await sleep(300);
          }

          await ui.press('Escape');
          await sleep(300);
        }
      }

      const geoRect = !smartMesh ? await page.evaluate(() => {
        const el = [...document.querySelectorAll('*')].find(
          n => n.children.length === 0 && (n.textContent || '').trim() === 'Geometry & Texture'
        );
        const clickable = el?.closest('button, [role="button"], div[tabindex], div.cursor-pointer') || el;
        if (!clickable) return null;
        const r = clickable.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }) : null;

      if (geoRect) {
        await ui.click(geoRect.x, geoRect.y);
        await sleep(650);
        const polyAction = await page.evaluate((cfg) => {
          const dlg = [...document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"]')].find(
            d => d.offsetParent !== null && (d.innerText || '').includes('Geometry & Texture')
          );
          if (!dlg) return null;

          const setSwitch = (labelTxt, want) => {
            if (typeof want !== 'boolean') return;
            const labelEl = [...dlg.querySelectorAll('*')].find(
              n => n.children.length === 0 && (n.textContent || '').trim() === labelTxt
            );
            if (!labelEl) return;
            let row = labelEl.parentElement;
            while (row && row !== dlg && !row.querySelector('[role="switch"]')) {
              row = row.parentElement;
            }
            const sw = row?.querySelector('[role="switch"]');
            if (!sw) return;
            const isChecked = sw.getAttribute('aria-checked') === 'true' || sw.dataset.state === 'checked';
            if (isChecked !== want) sw.click();
          };

          setSwitch('Ultra Mesh Quality', cfg.ultraMesh);
          setSwitch('Texture', cfg.texture);
          setSwitch('Remove Lighting', cfg.removeLighting);
          setSwitch('PBR', cfg.pbr);
          setSwitch('8K Texture', Boolean(cfg.texture && String(cfg.textureQuality || '').trim().toUpperCase() === '8K'));

          if (cfg.texture && cfg.textureQuality) {
            const wantQ = String(cfg.textureQuality).trim().toUpperCase();
            const findQBtn = q => [...dlg.querySelectorAll('button')].find(
              b => (b.innerText || '').trim().toUpperCase().startsWith(q)
            );
            const qBtn = findQBtn(wantQ) || (wantQ === '8K' ? findQBtn('4K') : null);
            if (qBtn && qBtn.getAttribute('aria-pressed') !== 'true' && qBtn.dataset?.state !== 'on') qBtn.click();
          }

          if (cfg.topology) {
            const tBtn = [...dlg.querySelectorAll('button')].find(
              b => (b.innerText || '').trim().toLowerCase() === String(cfg.topology).toLowerCase()
            );
            if (tBtn && tBtn.getAttribute('aria-pressed') !== 'true' && tBtn.dataset?.state !== 'on') tBtn.click();
          }

          if (!cfg.smartMesh && Number.isInteger(cfg.polycount) && cfg.polycount > 0) {
            const polyLbl = [...dlg.querySelectorAll('*')].find(
              n => n.children.length === 0 && (n.textContent || '').trim() === 'Polycount'
            );
            let polyRow = polyLbl?.parentElement;
            while (polyRow && polyRow !== dlg && !polyRow.querySelector('input')) polyRow = polyRow.parentElement;
            const polyInp = polyRow?.querySelector('input');
            const slider = polyRow?.querySelector('[role="slider"]');
            const sMin = Number(slider?.getAttribute('aria-valuemin')) || 500;
            const sMax = Number(slider?.getAttribute('aria-valuemax')) || 5000000;
            const clamped = Math.max(sMin, Math.min(sMax, cfg.polycount));
            if (polyInp && polyInp.value !== String(clamped)) {
              const ir = polyInp.getBoundingClientRect();
              if (ir.width && ir.height) {
                return { x: ir.x + ir.width / 2, y: ir.y + ir.height / 2, targetValue: String(clamped) };
              }
            }
          }
          return null;
        }, { smartMesh: Boolean(smartMesh), ultraMesh, texture, textureQuality, removeLighting, pbr, topology, polycount });

        if (polyAction) {
          await ui.click(polyAction.x, polyAction.y, { clickCount: 3 });
          await ui.press('Backspace');
          await ui.type(polyAction.targetValue);
          await ui.press('Enter');
          await sleep(350);
        }

        await ui.press('Escape');
        await sleep(350);
        await this.#closeAnyOpenModalDialogs(page);
      }

      // 8. Submit generation task(s) and capture newly created modelId(s).
      // In Smart Mesh mode, generating 1 or 4 costs the exact same credits and Tripo outputs 4 variants per batch:
      // - When smartMesh=true and count=1 (default), ensure batch size is 4, click Generate ONCE, and return all 4 variants!
      // - When smartMesh=true and count in {2,3,4}, also run a single 4-variant batch (same price!) and return `count` variants.
      const beforeSnap = await this.#readWorkspaceSnapshot(page);
      const knownIds = new Set(beforeSnap.assets.map(a => a.modelId));
      const newIds = [];

      if (smartMesh) {
        const batchBtnRect = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')].filter(b => {
            if (b.offsetParent === null) return false;
            const r = b.getBoundingClientRect();
            return r.x > 40 && r.x < 360 && r.y > 300 && r.y < window.innerHeight * 0.85 && (b.innerText || '').trim() === '4';
          });
          const b4 = btns.find(b => b.getAttribute('aria-pressed') !== 'true');
          if (!b4) return null;
          const r = b4.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (batchBtnRect) {
          await ui.click(batchBtnRect.x, batchBtnRect.y);
          await sleep(300);
        }
      }

      const runs = smartMesh ? 1 : count;
      const targetYield = smartMesh ? (count === 1 ? 4 : count) : 1;

      for (let i = 0; i < runs; i++) {
        // Wait up to 20s for image S3 uploads to finish and the Generate button to become enabled
        let clicked = false;
        const btnDeadline = Date.now() + 20000;
        while (Date.now() < btnDeadline) {
          clicked = await page.evaluate(() => {
            const genBtn = [...document.querySelectorAll('button')].find(b => {
              const r = b.getBoundingClientRect();
              const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
              return r.width > 80 && r.x < 380 && r.y > window.innerHeight * 0.65 && /^Generate\b/i.test(txt) && !b.disabled;
            });
            if (!genBtn) return false;
            genBtn.click();
            return true;
          });
          if (clicked) break;
          await sleep(500);
        }
        if (!clicked) {
          throw new Error(`等待 20 秒后 Generate 按钮仍不可点击（第 ${i + 1}/${runs} 次），请检查四视图上传状态及积分是否充足。`);
        }

        // Wait up to 25s for newly queued task card(s) to appear in Assets
        let batchCollected = [];
        const waitDeadline = Date.now() + 25000;
        while (Date.now() < waitDeadline) {
          await sleep(1200);
          const snap = await this.#readWorkspaceSnapshot(page);
          const addedList = snap.assets.filter(a => !knownIds.has(a.modelId));
          if (addedList.length > 0) {
            if (smartMesh && addedList.length < targetYield && Date.now() + 3000 < waitDeadline) {
              // Give Tripo 2.5s to populate all 4 batch cards in Assets
              await sleep(2500);
              const snap2 = await this.#readWorkspaceSnapshot(page);
              batchCollected = snap2.assets.filter(a => !knownIds.has(a.modelId)).slice(0, targetYield).map(a => a.modelId);
            } else {
              batchCollected = addedList.slice(0, targetYield).map(a => a.modelId);
            }
            for (const id of batchCollected) {
              knownIds.add(id);
              newIds.push(id);
            }
            break;
          }
          // Fallback: check URL UUID if navigated
          const urlUuid = extractUuid(snap.url);
          if (urlUuid && !knownIds.has(urlUuid)) {
            batchCollected = [urlUuid];
            knownIds.add(urlUuid);
            newIds.push(urlUuid);
            break;
          }
        }
        if (batchCollected.length === 0) {
          throw new Error(`提交第 ${i + 1} 次生成后 25 秒内未在 Tripo Assets 列表中检测到新任务，请检查积分或页面提示。`);
        }
        if (i + 1 < runs) await sleep(1200);
      }

      return newIds;
      });
    });

    if (!wait) {
      const post = await this.status();
      return {
        status: 'submitted',
        modelIds: generatedIds,
        creditsRemaining: post.credits,
      };
    }

    return this.waitForModels({
      modelIds: generatedIds,
      pollIntervalMs,
      timeoutMs,
      screenshotDir,
    });
  }

  /**
   * Polls Tripo Studio locally until all target `modelIds` finish generating (zero LLM tokens spent).
   */
  async waitForModels({
    modelIds = [],
    pollIntervalMs = 6000,
    timeoutMs = 600000,
    screenshotDir,
  } = {}) {
    const targets = modelIds.map(id => id.toLowerCase());
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const snap = await this.#withLock(async () => {
        const page = await this.getTripoPage({ navigateIfNeeded: false });
        return this.#readWorkspaceSnapshot(page);
      });

      const activeTargets = targets.length > 0
        ? targets
        : snap.assets.filter(a => a.status === 'generating').map(a => a.modelId);

      if (activeTargets.length === 0) {
        return { status: 'complete', models: [], creditsRemaining: snap.credits };
      }

      const statuses = activeTargets.map(id => {
        const found = snap.assets.find(a => a.modelId === id);
        return { modelId: id, found: !!found, status: found ? found.status : 'unknown', info: found || null };
      });

      const allReady = statuses.every(s => s.found && s.status === 'ready');
      if (allReady) {
        const results = [];
        if (screenshotDir) {
          await fs.mkdir(path.resolve(screenshotDir), { recursive: true });
        }
        await this.#withLock(async () => {
          const page = await this.getTripoPage({ navigateIfNeeded: false });
          for (const s of statuses) {
            await this.#selectAssetOnPage(page, s.modelId);
            const detail = await this.#readWorkspaceSnapshot(page);
            let screenshotPath = null;
            if (screenshotDir) {
              const targetShot = path.join(path.resolve(screenshotDir), `${s.modelId}.png`);
              screenshotPath = await this.#safeScreenshot(page, targetShot);
            }
            results.push({
              modelId: s.modelId,
              href: s.info?.href,
              label: s.info?.text,
              faces: detail.faces,
              vertices: detail.vertices,
              screenshotPath,
            });
          }
        });
        return {
          status: 'complete',
          models: results,
          creditsRemaining: snap.credits,
        };
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(`等待 Tripo 模型生成超时（>${Math.round(timeoutMs / 1000)} 秒）：${targets.join(', ')}`);
  }

  async #selectAssetOnPage(page, modelId) {
    const targetId = modelId.toLowerCase();
    await this.assertNotBlocked(page);
    if (!page.url().toLowerCase().includes(targetId)) {
      // Prefer in-app SPA link click (avoids full document reload / unnecessary CDN challenges)
      const clicked = await page.evaluate((id) => {
        const link = [...document.querySelectorAll('a[href*="/workspace/generate/"]')].find(
          a => a.getBoundingClientRect().x > window.innerWidth * 0.5 && (a.getAttribute('href') || '').toLowerCase().includes(id)
        );
        if (link) {
          link.scrollIntoView({ block: 'nearest' });
          link.click();
          return true;
        }
        return false;
      }, targetId);

      if (clicked) {
        // Wait for SPA router to switch URL to targetId and begin loading the new 3D asset
        const urlDeadline = Date.now() + 10000;
        while (Date.now() < urlDeadline && !page.url().toLowerCase().includes(targetId)) {
          await sleep(300);
        }
        await sleep(2000);
      }

      if (!page.url().toLowerCase().includes(targetId)) {
        await page.goto(`${TRIPO_GENERATE_URL}/${targetId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(2500);
        await this.assertNotBlocked(page);
      }
    }

    // Wait up to 30s for target URL to match and Export button to become enabled (3D preview loaded)
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(800);
      if (!page.url().toLowerCase().includes(targetId)) continue;
      const snap = await this.#readWorkspaceSnapshot(page);
      if (snap.exportReady) return snap;
    }
    return this.#readWorkspaceSnapshot(page);
  }

  /**
   * Exports one or multiple completed Tripo models via standard Studio Export,
   * waits for local Downloads completion, verifies FBX/GLB headers, and extracts safely.
   */
  async exportModels({
    modelIds,
    format = 'FBX', // 'FBX' | 'GLB'
    preset = 'Blender', // 'Blender' | 'Mixamo' | '3dsmax'
    textureResolution = '4k', // '4k' | '2k'
    outputDir,
    subdirs,
    downloadsDir = defaultDownloadsDir(),
    downloadTimeoutMs = 600000,
  } = {}) {
    if (!outputDir) throw new Error('exportModels requires "outputDir"');

    return this.#withLock(async () => {
      const page = await this.getTripoPage({ navigateIfNeeded: false });
      return this.withUiShield(page, `自动导出 ${String(format || 'FBX').toUpperCase()} 模型`, async (ui) => {
        await this.#closeAnyOpenModalDialogs(page);

        let ids = Array.isArray(modelIds) && modelIds.length > 0 ? modelIds.map(s => s.toLowerCase()) : [];
        if (ids.length === 0) {
          const curUuid = extractUuid(page.url());
          if (!curUuid) throw new Error('未指定 modelIds，且当前 Tripo URL 中没有选中的模型 UUID。');
          ids = [curUuid];
        }

        const exported = [];
        for (let i = 0; i < ids.length; i++) {
          const modelId = ids[i];
          await ui.refresh(`自动导出 ${String(format || 'FBX').toUpperCase()} 模型 (${i + 1}/${ids.length})`);

          let verified = null;
          let lastExportErr = null;
          for (let exportAttempt = 1; exportAttempt <= 3; exportAttempt++) {
            try {
              const snap = await this.#selectAssetOnPage(page, modelId);
              await ui.refresh(`自动导出 ${String(format || 'FBX').toUpperCase()} 模型 (${i + 1}/${ids.length})`);
              if (!snap.exportReady) {
                throw new Error(`模型 ${modelId} 的 Export 按钮尚未就绪，请确认模型已生成完毕。`);
              }

              const baseline = await snapshotDownloads(downloadsDir);

              // Open bottom Export dialog using shielded real mouse coordinates on the visible bottom Export button
              const bottomExportRect = await page.evaluate(() => {
                const btn = [...document.querySelectorAll('button')].find(b => {
                  if (b.offsetParent === null || b.disabled || b.closest('[role="dialog"]')) return false;
                  const r = b.getBoundingClientRect();
                  const t = (b.innerText || '').trim();
                  return /^(Export|导出)$/i.test(t) && r.width > 0 && r.height > 0 && r.y > window.innerHeight * 0.65;
                });
                if (!btn) return null;
                btn.scrollIntoView({ block: 'nearest' });
                const r = btn.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              });
              if (!bottomExportRect) {
                throw new Error('Bottom Export button not found');
              }
              await ui.click(bottomExportRect.x, bottomExportRect.y);
              await sleep(750);

              // Configure Format, Preset, Texture Resolution inside Export dialog (with strict readback verification)
              await this.#configureExportDialog(page, { format, preset, textureResolution, ui });

              // Re-verify active URL modelId + selected Format right before clicking confirm Export inside dialog
              if (!page.url().toLowerCase().includes(modelId)) {
                throw new Error(`导出前检测到当前页面模型已偏离目标 (${modelId})`);
              }
              const confirmAction = await page.evaluate((wantFmt) => {
                const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
                  d => d.offsetParent !== null && /Format|格式/i.test(d.innerText || '')
                );
                if (!dlg) return { ok: false, reason: 'Export dialog closed unexpectedly before confirmation' };
                const fmtLabel = [...dlg.querySelectorAll('*')].find(
                  n => n.children.length === 0 && /^(Format|格式)$/i.test((n.textContent || '').trim())
                );
                let row = fmtLabel?.parentElement;
                while (row && row !== dlg && !row.querySelector('[role="combobox"], button')) row = row.parentElement;
                const combo = row?.querySelector('[role="combobox"], button');
                const curFmt = (combo?.innerText || combo?.getAttribute('value') || '').trim().split(/\r?\n/)[0].trim();
                if (wantFmt && curFmt && !new RegExp(`^${wantFmt}\\b`, 'i').test(curFmt)) {
                  return { ok: false, reason: `Format verification failed right before Export: expected "${wantFmt}", got "${curFmt}"` };
                }
                const btns = [...dlg.querySelectorAll('button')].filter(
                  b => b.offsetParent !== null && !b.disabled && /^(Export|导出)$/i.test((b.innerText || '').trim())
                );
                const confirmBtn = btns[btns.length - 1];
                if (!confirmBtn) return { ok: false, reason: 'Confirm Export button not found or disabled inside Export dialog' };
                confirmBtn.scrollIntoView({ block: 'nearest' });
                const r = confirmBtn.getBoundingClientRect();
                if (r.width < 24 || r.height < 16) return { ok: false, reason: 'Confirm Export button has invalid zero/tiny bounds' };
                return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, curFmt };
              }, format);

              if (!confirmAction.ok) {
                throw new Error(confirmAction.reason);
              }
              await ui.click(confirmAction.x, confirmAction.y);

              const downloadedFile = await waitForCompletedDownload(baseline, { timeoutMs: downloadTimeoutMs });
              await this.#closeAnyOpenModalDialogs(page);

              const sub = Array.isArray(subdirs) && subdirs[i]
                ? subdirs[i]
                : ids.length > 1 ? `c${i + 1}-${modelId.slice(0, 8)}` : '';
              const targetDir = sub ? path.join(path.resolve(outputDir), sub) : path.resolve(outputDir);

              verified = await extractAndVerifyDownload(downloadedFile, targetDir, {
                modelId,
                format,
                preset,
                textureResolution,
                faces: snap.faces,
                vertices: snap.vertices,
              });
              break;
            } catch (err) {
              lastExportErr = err;
              await ui.press('Escape').catch(() => {});
              await this.#closeAnyOpenModalDialogs(page).catch(() => {});
              if (exportAttempt < 3) {
                await sleep(800);
              }
            }
          }

          if (!verified) {
            throw new Error(`未能安全导出模型 ${modelId}：${lastExportErr?.message || lastExportErr}`);
          }
          exported.push(verified);
        }

        return { status: 'exported', count: exported.length, items: exported };
      });
    });
  }

  async #configureExportDialog(page, { format, preset, textureResolution, ui }) {
    const click = (x, y, opts) => (ui ? ui.click(x, y, opts) : this.safeClick(page, x, y, opts));
    const press = (key, opts) => (ui ? ui.press(key, opts) : this.safePress(page, key, opts));
    // 1. Format combobox (FBX / GLB) — Radix Select requires real mouse click on leaf [role="option"] ONLY!
    // Never match `[role="listbox"] div`, whose innerText contains all formats ("GLB\nFBX\nOBJ\nSTL...") and centers on "STL"!
    if (format) {
      const wantUpper = String(format).trim().toUpperCase();
      let matchedFmt = false;
      let lastSeenFmt = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const fmtState = await page.evaluate((wantFmt) => {
          const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
            d => d.offsetParent !== null && /Format|格式/i.test(d.innerText || '')
          );
          if (!dlg) throw new Error('Export dialog did not open');
          const fmtLabel = [...dlg.querySelectorAll('*')].find(
            n => n.children.length === 0 && /^(Format|格式)$/i.test((n.textContent || '').trim())
          );
          let row = fmtLabel?.parentElement;
          while (row && row !== dlg && !row.querySelector('[role="combobox"], button')) row = row.parentElement;
          const combo = row?.querySelector('[role="combobox"], button');
          if (!combo) return { missingCombo: true, cur: '' };
          const cur = (combo.innerText || combo.getAttribute('value') || '').trim().split(/\r?\n/)[0].trim();
          const matches = new RegExp(`^${wantFmt}\\b`, 'i').test(cur);
          combo.scrollIntoView({ block: 'nearest' });
          const r = combo.getBoundingClientRect();
          return { missingCombo: false, matches, cur, x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, wantUpper);

        if (fmtState.missingCombo) break;
        lastSeenFmt = fmtState.cur;
        if (fmtState.matches) {
          matchedFmt = true;
          break;
        }

        await click(fmtState.x, fmtState.y);
        await sleep(450);

        const optRect = await page.evaluate((wantFmt) => {
          const opts = [...document.querySelectorAll('[role="option"], [data-radix-collection-item]')].filter(
            el => el.offsetParent !== null && !el.querySelector('[role="option"], [data-radix-collection-item]')
          );
          const hit = opts.find(o => {
            const firstToken = (o.innerText || '').trim().split(/\s+/)[0].toUpperCase();
            return firstToken === wantFmt;
          }) || opts.find(o => new RegExp(`^${wantFmt}\\b`, 'i').test((o.innerText || '').trim()));
          if (!hit) return null;
          hit.scrollIntoView({ block: 'nearest' });
          const r = hit.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        }, wantUpper);

        if (optRect) {
          await click(optRect.x, optRect.y);
        } else {
          await press('Escape');
        }
        await sleep(450);

        const verifyCur = await page.evaluate(() => {
          const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
            d => d.offsetParent !== null && /Format|格式/i.test(d.innerText || '')
          );
          const fmtLabel = [...(dlg?.querySelectorAll('*') || [])].find(
            n => n.children.length === 0 && /^(Format|格式)$/i.test((n.textContent || '').trim())
          );
          let row = fmtLabel?.parentElement;
          while (row && row !== dlg && !row.querySelector('[role="combobox"], button')) row = row.parentElement;
          const combo = row?.querySelector('[role="combobox"], button');
          return (combo?.innerText || combo?.getAttribute('value') || '').trim().split(/\r?\n/)[0].trim();
        });
        lastSeenFmt = verifyCur;
        if (new RegExp(`^${wantUpper}\\b`, 'i').test(verifyCur)) {
          matchedFmt = true;
          break;
        }
      }

      if (!matchedFmt && lastSeenFmt) {
        await press('Escape').catch(() => {});
        throw new Error(`导出格式选择失败：目标格式为 "${wantUpper}"，但当前弹窗格式仍为 "${lastSeenFmt}"（已中止导出，防止误导出 STL 等格式）`);
      }
    }

    // 2. Preset button (Blender / Mixamo / 3dsmax) when exporting FBX
    if (preset && String(format).toUpperCase() === 'FBX') {
      const presetRect = await page.evaluate((wantPreset) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
          d => d.offsetParent !== null && /Format|格式/i.test(d.innerText || '')
        );
        const btn = [...(dlg?.querySelectorAll('button') || [])].find(
          b => b.offsetParent !== null && (b.innerText || '').trim().toLowerCase() === String(wantPreset).toLowerCase()
        );
        if (!btn || btn.getAttribute('aria-pressed') === 'true' || btn.dataset?.state === 'on') return null;
        btn.scrollIntoView({ block: 'nearest' });
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      }, preset);
      if (presetRect) {
        await click(presetRect.x, presetRect.y);
        await sleep(300);
      }
    }

    // 3. Texture Resolution combobox (4k / 8k) — leaf [role="option"] only
    if (textureResolution) {
      const resRect = await page.evaluate((wantRes) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
          d => d.offsetParent !== null && /Format|格式/i.test(d.innerText || '')
        );
        const resLabel = [...(dlg?.querySelectorAll('*') || [])].find(
          n => n.children.length === 0 && /^(Texture Resolution|贴图分辨率|纹理分辨率)$/i.test((n.textContent || '').trim())
        );
        let row = resLabel?.parentElement;
        while (row && row !== dlg && !row.querySelector('[role="combobox"], button')) row = row.parentElement;
        const combo = row?.querySelector('[role="combobox"], button');
        if (!combo) return null;
        const cur = (combo.innerText || combo.getAttribute('value') || '').trim().split(/\r?\n/)[0].trim();
        if (cur.toLowerCase().includes(String(wantRes).toLowerCase())) return null;
        combo.scrollIntoView({ block: 'nearest' });
        const r = combo.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      }, textureResolution);

      if (resRect) {
        await click(resRect.x, resRect.y);
        await sleep(450);
        const resOptRect = await page.evaluate((wantRes) => {
          const want = String(wantRes).trim().toLowerCase();
          const opts = [...document.querySelectorAll('[role="option"], [data-radix-collection-item]')].filter(
            el => el.offsetParent !== null && !el.querySelector('[role="option"], [data-radix-collection-item]')
          );
          const matchTok = rx => opts.find(o => rx.test((o.innerText || '').trim().split(/\r?\n/)[0].trim()));
          const hit = opts.find(o => (o.innerText || '').trim().split(/\s+/)[0].toLowerCase() === want)
            || opts.find(o => (o.innerText || '').toLowerCase().includes(want))
            || (want === '8k' ? (matchTok(/^(original|原图|原始)/i) || matchTok(/^4k\b/i)) : null);
          if (!hit) return null;
          hit.scrollIntoView({ block: 'nearest' });
          const r = hit.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        }, textureResolution);
        if (resOptRect) {
          await click(resOptRect.x, resOptRect.y);
        } else {
          await press('Escape');
        }
        await sleep(300);
      }
    }
  }

  /**
   * Uploads a local 3D model (.fbx / .glb) into Tripo Assets and applies orientation (X=0, Y=90, Z=0 by default for Y-up FBX).
   */
  async uploadModel({
    filePath,
    rotateX = 0,
    rotateY = 90,
    rotateZ = 0,
  } = {}) {
    if (!filePath) throw new Error('uploadModel requires "filePath"');
    const absFile = path.resolve(filePath);
    await fs.access(absFile);

    return this.#withLock(async () => {
      const page = await this.getTripoPage({ navigateIfNeeded: true });
      return this.withUiShield(page, '上传 3D 模型并设置朝向', async () => {
        await this.#closeAnyOpenModalDialogs(page);

        const beforeSnap = await this.#readWorkspaceSnapshot(page);
        const knownIds = new Set(beforeSnap.assets.map(a => a.modelId));

        // Find right-panel "Upload 3D Model" <input type="file">
        const fileInputs = await page.$$('input[type="file"]');
        let uploadInput = null;
        for (const handle of fileInputs) {
          const is3D = await handle.evaluate(el => {
            const accept = (el.getAttribute('accept') || '').toLowerCase();
            const txt = (el.closest('div')?.innerText || '');
            return /fbx|glb|obj|stl/i.test(accept) || /upload 3d model/i.test(txt);
          });
          if (is3D) {
            uploadInput = handle;
            break;
          }
        }
        if (!uploadInput) {
          throw new Error('未在 Tripo 右侧 Assets 面板找到 "Upload 3D Model" 文件上传框，请确认 Assets 标签已展开。');
        }

        await uploadInput.uploadFile(absFile);
        await sleep(2500);

        // Check if "Find Optimal Orientation" / XYZ rotation dialog appeared
        const oriented = await page.evaluate(async ({ rx, ry, rz }) => {
          const spinboxes = [...document.querySelectorAll('input[type="number"], [role="spinbutton"]')].filter(
            el => el.offsetParent !== null
          );
          // Look for X / Y / Z inputs in orientation modal/overlay
          const setInput = (el, val) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, String(val));
            else el.value = String(val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };

          const labels = ['X', 'Y', 'Z'];
          const vals = [rx, ry, rz];
          let matched = 0;
          for (let i = 0; i < 3; i++) {
            const lbl = [...document.querySelectorAll('*')].find(
              n => n.children.length === 0 && (n.textContent || '').trim() === labels[i] && n.offsetParent !== null
            );
            const inp = lbl?.parentElement?.querySelector('input') || spinboxes[i];
            if (inp && !inp.closest('[aria-label="Export"]')) {
              setInput(inp, vals[i]);
              matched++;
            }
          }
          return matched;
        }, { rx: rotateX, ry: rotateY, rz: rotateZ });

        if (oriented > 0) {
          await sleep(1000);
          await page.evaluate(() => {
            const dlgs = [...document.querySelectorAll('[role="dialog"]')].filter(d => d.offsetParent !== null);
            const scope = dlgs[dlgs.length - 1] || document;
            const btns = [...scope.querySelectorAll('button')].filter(b => b.offsetParent !== null && !b.disabled);
            const confirmBtn = btns.find(b => /^(Confirm|確認|确认|OK|Done)$/i.test((b.innerText || '').trim()))
              || btns.find(b => /^Save$/i.test((b.innerText || '').trim()));
            if (confirmBtn) confirmBtn.click();
          });
        }

        // Wait up to 45s for uploaded modelId to appear in Assets
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          await sleep(1500);
          const snap = await this.#readWorkspaceSnapshot(page);
          const added = snap.assets.find(a => !knownIds.has(a.modelId) && a.status === 'ready');
          if (added) {
            return {
              status: 'uploaded',
              modelId: added.modelId,
              filePath: absFile,
              appliedRotation: { x: rotateX, y: rotateY, z: rotateZ },
            };
          }
        }
        throw new Error(`上传 3D 模型 (${path.basename(absFile)}) 后 45 秒内未检测到就绪资产，请检查 Tripo 页面状态（是否有朝向确认弹窗未关闭）。`);
      });
    });
  }
}
