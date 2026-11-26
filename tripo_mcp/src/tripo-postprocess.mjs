import path from 'node:path';
import fs from 'node:fs/promises';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TRIPO_BASE = 'https://studio.tripo3d.ai/workspace';

/**
 * Post-processing workflows on an existing or newly uploaded Tripo modelId:
 * - Coarse Segmentation (/workspace/segmentation/<modelId>)
 * - Smart UV + 4K Retexture (/workspace/smart-uv/<modelId> -> /workspace/texture/<modelId>)
 * - VRM Auto-Rigging (/workspace/rigging/<modelId>)
 */
export async function runSegmentation(controller, {
  filePath,
  modelId,
  rotateX = 0,
  rotateY = 90,
  rotateZ = 0,
  outputDir,
  pollIntervalMs = 6000,
  timeoutMs = 600000,
} = {}) {
  let activeId = modelId;
  if (filePath) {
    const up = await controller.uploadModel({ filePath, rotateX, rotateY, rotateZ });
    activeId = up.modelId;
  }
  if (!activeId) throw new Error('runSegmentation requires either "filePath" or "modelId"');

  const page = await controller.getTripoPage({ navigateIfNeeded: false });
  await page.goto(`${TRIPO_BASE}/segmentation/${activeId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await controller.assertNotBlocked(page);

  const before = await controller.status();
  const known = new Set(before.assets.map(a => a.modelId));

  await controller.withUiShield(page, '提交自动分割 (Segmentation)', async (ui) => {
    // Switch to Auto -> Simple (coarse 3-6 parts) segmentation using real mouse clicks (Radix ToggleGroup)
    const autoRect = await page.evaluate(() => {
      const leftBtns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && b.getBoundingClientRect().x >= 60 && b.getBoundingClientRect().x < 400);
      const autoBtn = leftBtns.find(b => (b.innerText || '').replace(/\s+/g, ' ').trim() === 'Auto');
      if (!autoBtn || autoBtn.getAttribute('aria-pressed') === 'true') return null;
      const r = autoBtn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (autoRect) {
      await ui.click(autoRect.x, autoRect.y);
      await sleep(600);
    }
    const simpleRect = await page.evaluate(() => {
      const leftBtns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && b.getBoundingClientRect().x >= 60 && b.getBoundingClientRect().x < 400);
      const simpleBtn = leftBtns.find(b => /simple/i.test((b.innerText || '').replace(/\s+/g, ' ').trim()));
      if (!simpleBtn || simpleBtn.getAttribute('aria-pressed') === 'true') return null;
      const r = simpleBtn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (simpleRect) {
      await ui.click(simpleRect.x, simpleRect.y);
      await sleep(500);
    }

    // Click primary action button in left Segmentation panel (Start Segmenting / Segment / Generate)
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => {
        const r = b.getBoundingClientRect();
        const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
        return r.x < 360 && r.y > window.innerHeight * 0.65 && !b.disabled && /segment|generate|start|confirm/i.test(t);
      });
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new Error('未能在 Segmentation 面板找到可点击的分割执行按钮，请检查页面加载状态。');
  });

  // Wait for segmentation completion: Tripo may segment in-place on activeId (no new card) or spawn a new asset.
  const deadline = Date.now() + timeoutMs;
  let segId = activeId;
  await sleep(3000);
  while (Date.now() < deadline) {
    const snap = await controller.status();
    const newAsset = snap.assets.find(a => !known.has(a.modelId));
    if (newAsset) {
      segId = newAsset.modelId;
      if (newAsset.status === 'ready') break;
    } else {
      const state = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        const hasCancel = btns.some(b => /^cancel$/i.test((b.innerText || '').trim()));
        const resegReady = btns.some(b => /resegment/i.test((b.innerText || '').replace(/\s+/g, ' ').trim()) && !b.disabled);
        const exportReady = btns.some(b => {
          const r = b.getBoundingClientRect();
          return (b.innerText || '').trim() === 'Export' && r.y > window.innerHeight * 0.75 && !b.disabled;
        });
        return { hasCancel, resegReady, exportReady };
      });
      if (!state.hasCancel && state.resegReady && state.exportReady) break;
    }
    await sleep(pollIntervalMs);
  }

  // Click Save if present and enabled on the segmentation page so segmented parts are committed
  const saved = await page.evaluate(() => {
    const saveBtn = [...document.querySelectorAll('button')].find(b => {
      if (b.offsetParent === null || b.disabled) return false;
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      return t === 'Save' && !b.closest('[role="dialog"]');
    });
    if (saveBtn) { saveBtn.click(); return true; }
    return false;
  });
  if (saved) await sleep(2000);

  if (!outputDir) return { status: 'segmented', modelId: segId };

  const exp = await controller.exportModels({ modelIds: [segId], format: 'FBX', preset: 'Blender', outputDir });
  return { status: 'segmented_and_exported', modelId: segId, export: exp.items[0] };
}

export async function runRetexture(controller, {
  filePath,
  modelId,
  rotateX = 0,
  rotateY = 90,
  rotateZ = 0,
  smartUV = true,
  frontPng,
  backPng,
  textureQuality = '4K',
  pbr = true,
  removeLighting = false,
  outputDir,
  pollIntervalMs = 6000,
  timeoutMs = 600000,
} = {}) {
  let activeId = modelId;
  if (filePath) {
    const up = await controller.uploadModel({ filePath, rotateX, rotateY, rotateZ });
    activeId = up.modelId;
  }
  if (!activeId) throw new Error('runRetexture requires either "filePath" or "modelId"');
  if (frontPng) await fs.access(path.resolve(frontPng));
  if (backPng) await fs.access(path.resolve(backPng));

  const page = await controller.getTripoPage({ navigateIfNeeded: false });

  // Step A: Optional Smart UV
  if (smartUV) {
    await page.goto(`${TRIPO_BASE}/smart-uv/${activeId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await controller.assertNotBlocked(page);

    // Wait up to 15s for "Unwrap UV" button to hydrate and become enabled
    let clickedUv = false;
    const uvBtnDeadline = Date.now() + 15000;
    const beforeUv = await controller.status();
    const knownUv = new Set(beforeUv.assets.map(a => a.modelId));
    while (Date.now() < uvBtnDeadline) {
      clickedUv = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => {
          if (b.offsetParent === null || b.disabled) return false;
          const r = b.getBoundingClientRect();
          const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
          return r.x < 500 && r.y > window.innerHeight * 0.6 && /unwrap|smart uv|generate|start/i.test(t);
        });
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (clickedUv) break;
      await sleep(1000);
    }
    if (!clickedUv) throw new Error('未能在 Smart UV 面板找到可点击的执行按钮。');

    // Wait for Smart UV completion (either new asset card or in-place completion)
    await sleep(3000);
    const uvDoneDeadline = Date.now() + timeoutMs;
    while (Date.now() < uvDoneDeadline) {
      const snap = await controller.status();
      const newAsset = snap.assets.find(a => !knownUv.has(a.modelId));
      if (newAsset) {
        activeId = newAsset.modelId;
        if (newAsset.status === 'ready') break;
      } else {
        const state = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
          const hasCancel = btns.some(b => /^cancel$/i.test((b.innerText || '').trim()));
          const uvBtnReady = btns.some(b => {
            const r = b.getBoundingClientRect();
            const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
            return r.x < 500 && r.y > window.innerHeight * 0.6 && /unwrap|free retry|retry/i.test(t) && !b.disabled;
          });
          return { hasCancel, uvBtnReady };
        });
        if (!state.hasCancel && state.uvBtnReady) break;
      }
      await sleep(pollIntervalMs);
    }
  }

  // Step B: 4K Texture generation with Front/Back reference PNGs
  await page.goto(`${TRIPO_BASE}/texture/${activeId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  await controller.assertNotBlocked(page);

  // Switch to Multi-view / Image reference in Texture panel if needed & upload Front / Back PNGs
  await controller.withUiShield(page, '配置纹理重绘参数', async (ui) => {
    if (frontPng || backPng) {
      const modeRect = await page.evaluate((hasBoth) => {
        const leftButtons = [...document.querySelectorAll('button')].filter(b => {
          if (b.offsetParent === null) return false;
          const r = b.getBoundingClientRect();
          return r.x > 40 && r.x < 340 && r.y > 90 && r.y < 230 && r.width < 90;
        });
        const iconBtn = leftButtons.find(b =>
          hasBoth
            ? /multi-view|multiview|i-tripo:geometry/i.test(b.innerHTML)
            : /add-image|image/i.test(b.innerHTML)
        );
        if (!iconBtn) return null;
        const r = iconBtn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, Boolean(frontPng && backPng));
      if (modeRect) {
        await ui.click(modeRect.x, modeRect.y);
        await sleep(700);
      }

      const inputs = await page.$$('input[type="file"]');
      const imgInputs = [];
      for (const h of inputs) {
        const ok = await h.evaluate(el => {
          const acc = (el.getAttribute('accept') || '').toLowerCase();
          const r = (el.parentElement || el).getBoundingClientRect();
          return !/fbx|glb|obj/i.test(acc) && r.x < window.innerWidth * 0.5;
        });
        if (ok) imgInputs.push(h);
      }

      if (frontPng && imgInputs[0]) {
        await imgInputs[0].uploadFile(path.resolve(frontPng));
        await sleep(1500);
      }
      if (backPng) {
        // In Multi-view [Front, Left, Right, Back], Back is the last slot (index 3), or index 1 if 2-slot
        const backIdx = imgInputs.length >= 4 ? 3 : 1;
        if (imgInputs[backIdx]) {
          await imgInputs[backIdx].uploadFile(path.resolve(backPng));
          await sleep(3500);
        }
      }
    }

    // Configure 4K / 8K / PBR / Remove Lighting switches & ToggleGroup buttons on Texture panel
    const texQRect = await page.evaluate(({ q, wantPbr, wantDelight }) => {
      const wantUpper = String(q || '4K').trim().toUpperCase();
      const setSw = (patterns, val) => {
        const el = [...document.querySelectorAll('*')].find(n => {
          if (n.children.length > 0 || n.getBoundingClientRect().x >= 380) return false;
          const txt = (n.textContent || '').trim();
          return patterns.some(rx => rx.test(txt));
        });
        if (!el) return;
        let row = el.parentElement;
        while (row && !row.querySelector('[role="switch"]') && row.tagName !== 'MAIN') row = row.parentElement;
        const sw = row?.querySelector('[role="switch"]');
        if (sw && !sw.disabled && (sw.getAttribute('aria-checked') === 'true' || sw.dataset.state === 'checked') !== val) sw.click();
      };
      setSw([/^PBR$/i], Boolean(wantPbr));
      setSw([/^Remove Lighting$/i, /^去光影$/], Boolean(wantDelight));
      setSw([/^8K Texture$/i, /^8K\s*(贴图|纹理)$/i], wantUpper === '8K');
      const findQBtn = target => [...document.querySelectorAll('button')].find(
        b => b.offsetParent !== null && b.getBoundingClientRect().x < 380 && (b.innerText || '').trim().toUpperCase() === target
      );
      const qBtn = findQBtn(wantUpper) || (wantUpper === '8K' ? findQBtn('4K') : null);
      if (!qBtn || qBtn.getAttribute('aria-pressed') === 'true' || qBtn.dataset?.state === 'on') return null;
      qBtn.scrollIntoView({ block: 'nearest' });
      const r = qBtn.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, { q: textureQuality, wantPbr: pbr, wantDelight: removeLighting });
    if (texQRect) {
      await ui.click(texQRect.x, texQRect.y);
    }
    await sleep(500);
  });

  const beforeTex = await controller.status();
  const knownTex = new Set(beforeTex.assets.map(a => a.modelId));

  // Track in-place texture_model operation via /v2/studio/operation/ and /v2/studio/progress
  let createdOpId = null;
  let opStatus = null;
  const onResp = async (res) => {
    const u = res.url();
    if (u.includes('/v2/studio/operation/')) {
      try {
        const j = await res.json();
        if (j?.data?.operator_id) {
          createdOpId = j.data.operator_id;
          opStatus = 'queued';
        }
      } catch {}
    } else if (createdOpId && u.includes('/v2/studio/progress')) {
      try {
        const j = await res.json();
        const hit = (j?.data || []).find(x => (x.operator_id || x.id) === createdOpId);
        if (hit?.status) opStatus = hit.status;
      } catch {}
    }
  };
  page.on('response', onResp);

  let texId = activeId;
  try {
    for (let attempt = 1; attempt <= 4 && !createdOpId; attempt++) {
      const clickedTex = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => {
          if (b.offsetParent === null || b.disabled) return false;
          const r = b.getBoundingClientRect();
          const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
          return r.x < 400 && r.y > window.innerHeight * 0.65 && /generate|texture/i.test(t);
        });
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!clickedTex) throw new Error('未能在 Texture 面板找到可点击的生成按钮。');
      for (let w = 0; w < 8 && !createdOpId; w++) await sleep(1000);
    }

    const texDeadline = Date.now() + timeoutMs;
    while (Date.now() < texDeadline) {
      if (createdOpId) {
        if (opStatus === 'success' || opStatus === 'completed' || opStatus === 'done') {
          await sleep(4000);
          break;
        }
        if (opStatus === 'failed' || opStatus === 'error' || opStatus === 'cancelled') {
          throw new Error(`Tripo 纹理重生成任务失败 (${createdOpId}: ${opStatus})`);
        }
      } else {
        const snap = await controller.status();
        const newAsset = snap.assets.find(a => !knownTex.has(a.modelId));
        if (newAsset) {
          texId = newAsset.modelId;
          if (newAsset.status === 'ready') break;
        }
      }
      await sleep(pollIntervalMs);
    }
  } finally {
    page.off('response', onResp);
  }
  if (!outputDir) return { status: 'retextured', modelId: texId };

  const expRes = String(textureQuality || '4K').trim().toLowerCase();
  const exp = await controller.exportModels({ modelIds: [texId], format: 'FBX', preset: 'Blender', textureResolution: expRes, outputDir });
  return { status: 'retextured_and_exported', modelId: texId, export: exp.items[0] };
}

export async function runRigging(controller, {
  filePath,
  modelId,
  rotateX = 0,
  rotateY = 90,
  rotateZ = 0,
  skeletonPreset = 'VRM',
  exportPreset = 'Blender',
  outputDir,
  pollIntervalMs = 6000,
  timeoutMs = 600000,
} = {}) {
  let activeId = modelId;
  if (filePath) {
    const up = await controller.uploadModel({ filePath, rotateX, rotateY, rotateZ });
    activeId = up.modelId;
  }
  if (!activeId) throw new Error('runRigging requires either "filePath" or "modelId"');

  const page = await controller.getTripoPage({ navigateIfNeeded: false });
  await page.goto(`${TRIPO_BASE}/rigging/${activeId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await controller.assertNotBlocked(page);

  // Explicitly select VRM skeleton preset per tripo-agent-workflow rule (Radix combobox needs real mouse click)!
  const beforeRig = await controller.status();
  const knownRig = new Set(beforeRig.assets.map(a => a.modelId));

  await controller.withUiShield(page, `配置 ${skeletonPreset} 自动绑骨`, async (ui) => {
    const presetInfo = await page.evaluate((wantPreset) => {
      const directBtn = [...document.querySelectorAll('button, [role="radio"], [role="option"]')].find(
        el => el.offsetParent !== null && el.getBoundingClientRect().x < 380 && (el.innerText || '').trim().toUpperCase() === wantPreset.toUpperCase()
      );
      if (directBtn) {
        const r = directBtn.getBoundingClientRect();
        return { kind: 'direct', x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      const combos = [...document.querySelectorAll('[role="combobox"], button')].filter(
        el => el.offsetParent !== null && el.getBoundingClientRect().x < 380 && /preset|skeleton|humanoid|mixamo|vrm/i.test(el.innerText || '')
      );
      for (const c of combos) {
        if ((c.innerText || '').toUpperCase().includes(wantPreset.toUpperCase())) return { kind: 'already_selected' };
        const r = c.getBoundingClientRect();
        return { kind: 'combo', x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return { kind: 'missing' };
    }, skeletonPreset);

    if (presetInfo.kind === 'direct') {
      await ui.click(presetInfo.x, presetInfo.y);
    } else if (presetInfo.kind === 'combo') {
      await ui.click(presetInfo.x, presetInfo.y);
      await sleep(500);
      const optRect = await page.evaluate((wantPreset) => {
        const want = String(wantPreset).trim().toUpperCase();
        const opts = [...document.querySelectorAll('[role="option"], [data-radix-collection-item]')].filter(
          el => el.offsetParent !== null && !el.querySelector('[role="option"], [data-radix-collection-item]')
        );
        const opt = opts.find(o => (o.innerText || '').trim().split(/\s+/)[0].toUpperCase() === want)
          || opts.find(o => (o.innerText || '').toUpperCase().includes(want));
        if (!opt) return null;
        opt.scrollIntoView({ block: 'nearest' });
        const r = opt.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      }, skeletonPreset);
      if (!optRect) {
        await ui.press('Escape');
        throw new Error(`未能在 Tripo Rig 面板找到骨骼预设 "${skeletonPreset}"，已按安全规范中止绑骨。`);
      }
      await ui.click(optRect.x, optRect.y);
    } else if (presetInfo.kind === 'missing') {
      throw new Error(`未能确认 Tripo Rig 面板中的骨骼预设 "${skeletonPreset}"，已按安全规范中止绑骨。`);
    }

    await sleep(500);
    const clickedRig = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => {
        const r = b.getBoundingClientRect();
        const t = (b.innerText || '').trim();
        return r.x < 360 && r.y > window.innerHeight * 0.65 && !b.disabled && /auto-rig|rig|generate|start/i.test(t);
      });
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clickedRig) throw new Error('未能在 Rig 面板找到可点击的绑骨执行按钮。');
  });

  const rigId = await waitForNewAssetId(controller, knownRig, 25000);
  const done = await controller.waitForModels({ modelIds: [rigId], pollIntervalMs, timeoutMs });
  if (!outputDir) return { status: 'rigged', modelId: rigId, skeletonPreset, models: done.models };

  const exp = await controller.exportModels({ modelIds: [rigId], format: 'FBX', preset: exportPreset, outputDir });
  return { status: 'rigged_and_exported', modelId: rigId, skeletonPreset, export: exp.items[0] };
}

async function waitForNewAssetId(controller, knownSet, waitMs = 25000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1200);
    const snap = await controller.status();
    const added = snap.assets.find(a => !knownSet.has(a.modelId));
    if (added) return added.modelId;
  }
  throw new Error('提交任务后 25 秒内未在 Tripo Assets 中检测到新生成的任务卡片。');
}
