// Tripo 的 Google 一键登录在 Electron 内核里会被 Google 服务端直接拒绝
// （accounts.google.com/v3/signin/rejected →「此浏览器或应用可能不安全」）。
// 实测同一账号在 Edge / Chrome 里完全正常，所以这里把「认证」这一步交给
// 系统里的真实浏览器，完成后再把 session 搬回客户端自己的 persist:tripo 分区。
//
// 全程只使用本机浏览器 + 官方页面，不伪造任何凭据。

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TRIPO_HOME = 'https://studio.tripo3d.ai/workspace/generate';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 找一个可以用来做 Google 授权的外部浏览器 */
export function findExternalBrowser() {
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      { name: 'chrome', exe: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'chrome', exe: path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'chrome', exe: path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'edge', exe: path.join(progFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'edge', exe: path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      { name: 'chrome', exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'edge', exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    );
  } else {
    candidates.push(
      { name: 'chrome', exe: '/usr/bin/google-chrome' },
      { name: 'chromium', exe: '/usr/bin/chromium' },
      { name: 'edge', exe: '/usr/bin/microsoft-edge' },
    );
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.exe)) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

async function fetchJson(url, timeoutMs = 2500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp(port, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const info = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    if (info?.webSocketDebuggerUrl) return info;
    await sleep(400);
  }
  return null;
}

/** 极简 CDP 客户端 */
class Cdp {
  #ws = null;
  #id = 0;
  #pending = new Map();

  static async connect(wsUrl) {
    const c = new Cdp();
    await c.#open(wsUrl);
    return c;
  }

  #open(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.#ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
      ws.addEventListener('message', ev => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve: r, reject: j } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) j(new Error(msg.error.message || 'CDP error'));
          else r(msg.result);
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (e) {
        this.#pending.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try { this.#ws?.close(); } catch { /* ignore */ }
  }
}

/** 在指定 target 上执行表达式 */
async function evalOnTarget(browser, targetId, expression) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    // 必须先 enable，否则该 session 上 Runtime.evaluate 会报 "wasn't found"
    await browser.send('Runtime.enable', {}, sessionId);
    const res = await browser.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluate 异常');
    return res?.result?.value;
  } finally {
    await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

async function getAllCookies(browser) {
  const { targetInfos } = await browser.send('Target.getTargets');
  const page = targetInfos.find(t => t.type === 'page' && (t.url || '').includes('tripo3d.ai'))
    || targetInfos.find(t => t.type === 'page');
  if (!page) return [];
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  try {
    await browser.send('Network.enable', {}, sessionId);
    const res = await browser.send('Network.getAllCookies', {}, sessionId);
    return res?.cookies || [];
  } finally {
    await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

// Tripo 用 Ory Kratos 做身份认证。真正的会话令牌是 httpOnly 的
// ory_kratos_session —— 页面 JS 读不到，只有 CDP 层能取。
// 这也是判断「是否真的登录」最可靠的信号，不依赖积分数字何时渲染。
const SESSION_COOKIE = 'ory_kratos_session';

const isTripoDomain = (domain) => {
  const d = (domain || '').replace(/^\./, '');
  return d === 'tripo3d.ai' || d.endsWith('.tripo3d.ai')
    || d === 'tripo3d.com' || d.endsWith('.tripo3d.com')
    || d === 'msapi.tripo3d.ai' || d.endsWith('.msapi.tripo3d.ai');
};

const hasSessionCookie = (cookies) =>
  cookies.some(c => c.name === SESSION_COOKIE && isTripoDomain(c.domain) && c.value);

const LOGGED_IN_PROBE = `(() => {
  const header = document.querySelector('header');
  if (!header) return { ready: false, reason: 'no-header' };
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const signIn = [...header.querySelectorAll('button, a')]
    .find(el => /^\\s*(sign in|log in|登录|登入)\\s*$/i.test(el.innerText || '') && visible(el));
  const credits = [...header.querySelectorAll('*')].find(el => {
    if (el.children.length > 0) return false;
    if (!/^\\d{1,7}$/.test((el.textContent || '').trim())) return false;
    if (el.closest('button, a')) return false;
    return visible(el) && el.getBoundingClientRect().x > window.innerWidth * 0.6;
  });
  const avatar = [...header.querySelectorAll('img, [class*="avatar" i], [class*="Avatar"]')]
    .some(el => visible(el) && !/tripo-wordmark|logo/i.test((el.src || el.className || '').toString()));
  return {
    ready: !signIn && (!!credits || avatar),
    hasSignIn: !!signIn,
    credits: credits ? Number.parseInt(credits.textContent.trim(), 10) : null,
  };
})()`;

/**
 * 关掉正在跑的同类浏览器。
 *
 * Chrome / Edge 有单实例机制：只要已经有一个在跑，新进程会把参数转交给它
 * 然后立刻退出，--remote-debugging-port 根本不会生效。所以开调试端口前
 * 必须先确保没有残留实例。
 */
function killRunningBrowser(browserName) {
  if (process.platform !== 'win32') return;
  const exeNames = browserName === 'chrome' ? ['chrome.exe'] : ['msedge.exe'];
  try {
    for (const name of exeNames) {
      // 用 taskkill 而不是 process.kill，避免误伤其它同名子进程
      execSync(`taskkill /F /IM ${name} /T`, { stdio: 'ignore', timeout: 15000 });
    }
  } catch {
    // 没有在跑就是最好的情况
  }
}

async function waitPortFree(port, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
    } catch {
      return true; // 连不上说明端口空闲
    }
    await sleep(300);
  }
  return false;
}

/**
 * 打开外部浏览器做一次 Tripo 的 Google 登录，返回可回填的 cookie 列表。
 *
 * 使用独立 profile（默认 profile 不允许开调试端口），所以第一次需要登录
 * Google，之后 profile 会保留登录态，再点就直接过。
 */
export async function loginTripoViaExternalBrowser(options = {}) {
  const onStatus = options.onStatus || (() => {});
  const browser = findExternalBrowser();
  if (!browser) {
    throw Object.assign(new Error('没有找到可用的 Chrome / Edge，请先安装其中一个'), { code: 'NO_BROWSER' });
  }

  const port = options.port || 19500 + Math.floor(Math.random() * 400);
  // profile 放在应用自己的 userdata 下，随安装目录走、升级后保留
  const profileDir = options.profileDir
    || path.join(options.userDataDir || os.tmpdir(), 'tripo-login-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  // 先清掉残留实例，否则调试端口不会起来
  onStatus({ phase: 'preparing', browser: browser.name });
  killRunningBrowser(browser.name);
  await waitPortFree(port, Date.now() + 6000);

  // Edge 会残留 Crashpad 之类的小进程，等它们彻底退出
  await sleep(1200);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1300,920',
    TRIPO_HOME,
  ];

  onStatus({ phase: 'launching', browser: browser.name });
  const child = spawn(browser.exe, args, { stdio: 'ignore', detached: false });

  let cdp = null;
  try {
    const info = await waitForCdp(port, Date.now() + 45000);
    if (!info) {
      throw Object.assign(
        new Error('外部浏览器没能开启调试端口。请手动关掉所有 Chrome / Edge 窗口后重试。'),
        { code: 'BROWSER_LAUNCH_FAILED' }
      );
    }

    cdp = await Cdp.connect(info.webSocketDebuggerUrl);
    onStatus({ phase: 'waiting-login', browser: browser.name });

    // 默认给 15 分钟，避免用户慢慢输密码时流程已经被判超时
    const deadline = Date.now() + (options.timeoutMs || 15 * 60 * 1000);
    let loggedIn = false;
    let lastCredits = null;
    let harvest = [];

    while (Date.now() < deadline) {
      await sleep(2000);

      // 每轮都取一次 cookie：ory_kratos_session 出现了就说明登录成功，
      // 这比等页面渲染出积分数字可靠得多。
      let cookies = [];
      try {
        cookies = await getAllCookies(cdp);
      } catch {
        continue;
      }

      const tripoCookies = cookies.filter(c => isTripoDomain(c.domain));

      if (hasSessionCookie(tripoCookies)) {
        loggedIn = true;
        harvest = tripoCookies;
        onStatus({ phase: 'logged-in', browser: browser.name });

        // 顺手读一下积分，失败了不影响登录成功
        try {
          const { targetInfos } = await cdp.send('Target.getTargets');
          const page = targetInfos.find(t => t.type === 'page' && (t.url || '').includes('tripo3d.ai'));
          if (page) {
            const probe = await evalOnTarget(cdp, page.targetId, LOGGED_IN_PROBE);
            lastCredits = probe?.credits ?? null;
          }
        } catch {
          // ignore
        }
        break;
      }
    }

    if (!loggedIn) {
      throw Object.assign(
        new Error('等待登录超时。请在弹出的浏览器里完成 Google 登录，登录成功后会自动回填。'),
        { code: 'LOGIN_TIMEOUT' }
      );
    }

    // 再补一次，确保拿到登录后新种下的全部 cookie
    try {
      const fresh = await getAllCookies(cdp);
      const extra = fresh.filter(c => isTripoDomain(c.domain));
      if (extra.length >= harvest.length) harvest = extra;
    } catch {
      // 用上一轮的也够
    }

    onStatus({ phase: 'harvested', count: harvest.length, credits: lastCredits });

    return { cookies: harvest, browser: browser.name, profileDir, credits: lastCredits };
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  }
}
