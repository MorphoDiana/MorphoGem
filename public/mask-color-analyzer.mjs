// MorphoGem Clean-Room Multi-Color ID Mask Analyzer & Live Region Highlight Compositor (MIT)
// Shared between Browser Canvas UI (auto-detecting color blocks + live node previews) and Node CLI export.

export function hexToRgb(hexStr) {
  const s = String(hexStr || '#ff3b30').trim().replace(/^#/, '');
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if (!Number.isNaN(r + g + b)) return [r, g, b];
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (!Number.isNaN(r + g + b)) return [r, g, b];
  }
  return [255, 59, 48];
}

export function rgbToHex(r, g, b) {
  const cl = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${cl(r)}${cl(g)}${cl(b)}`;
}

export function friendlyColorName(r, g, b, isEn = false) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 26) {
    if (max >= 215) return isEn ? 'White' : '白色';
    if (max <= 45) return isEn ? 'Black' : '深黑';
    return isEn ? 'Gray' : '灰色';
  }
  let hue = 0;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;

  if (hue < 16 || hue >= 345) return isEn ? 'Red' : '红色';
  if (hue < 42) return isEn ? 'Orange' : '橙色';
  if (hue < 70) return isEn ? 'Yellow' : '黄色';
  if (hue < 162) return isEn ? 'Green' : '绿色';
  if (hue < 202) return isEn ? 'Cyan' : '青色';
  if (hue < 258) return isEn ? 'Blue' : '蓝色';
  if (hue < 298) return isEn ? 'Purple' : '紫色';
  return isEn ? 'Pink' : '品红';
}

function detectBorderBackground(rgba, w, h) {
  let transparentBorder = 0;
  let whiteBorder = 0;
  let blackBorder = 0;
  let totalBorder = 0;

  const sample = (x, y) => {
    const o = (y * w + x) * 4;
    const r = rgba[o]; const g = rgba[o + 1]; const b = rgba[o + 2]; const a = rgba[o + 3];
    totalBorder++;
    if (a < 64) {
      transparentBorder++;
    } else if (r >= 236 && g >= 236 && b >= 236) {
      whiteBorder++;
    } else if (r <= 24 && g <= 24 && b <= 24) {
      blackBorder++;
    }
  };

  const stepX = Math.max(1, Math.floor(w / 120));
  const stepY = Math.max(1, Math.floor(h / 120));
  for (let x = 0; x < w; x += stepX) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += stepY) { sample(0, y); sample(w - 1, y); }

  // Also check 4 exact corners
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let cornerWhite = 0;
  let cornerBlack = 0;
  for (const [cx, cy] of corners) {
    const o = (cy * w + cx) * 4;
    if (rgba[o + 3] >= 64) {
      if (rgba[o] >= 236 && rgba[o + 1] >= 236 && rgba[o + 2] >= 236) cornerWhite++;
      if (rgba[o] <= 24 && rgba[o + 1] <= 24 && rgba[o + 2] <= 24) cornerBlack++;
    }
  }

  return {
    ignoreTransparent: true,
    ignoreWhite: (whiteBorder / Math.max(1, totalBorder)) > 0.28 || cornerWhite >= 3,
    ignoreBlack: (blackBorder / Math.max(1, totalBorder)) > 0.28 || cornerBlack >= 3,
  };
}

function isBackgroundPixel(r, g, b, a, bgInfo) {
  if (a < 64) return true;
  if (bgInfo.ignoreWhite && r >= 236 && g >= 236 && b >= 236) return true;
  if (bgInfo.ignoreBlack && r <= 24 && g <= 24 && b <= 24) return true;
  return false;
}

/**
 * Automatically clusters a Multi-Color ID Mask (or single-color mask) into distinct flat-color regions,
 * immune to anti-aliased brush edges and sorted top-to-bottom (Head -> Torso -> Legs).
 */
export function analyzeMaskColorBlocks(rgba, width, height, {
  minCoveragePct = 0.18,
  maxRegions = 12,
} = {}) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const totalPx = w * h;
  const bgInfo = detectBorderBackground(rgba, w, h);

  // Step 1: Collect flat interior pixels (skip 1-2px anti-aliased boundary transitions)
  const buckets = new Map(); // 15-bit key -> { count, sr, sg, sb }
  let interiorAccepted = 0;

  const addBucket = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let bkt = buckets.get(key);
    if (!bkt) {
      bkt = {count: 0, sr: 0, sg: 0, sb: 0};
      buckets.set(key, bkt);
    }
    bkt.count++;
    bkt.sr += r;
    bkt.sg += g;
    bkt.sb += b;
  };

  const dStep = Math.max(1, Math.min(2, Math.round(Math.max(w, h) / 256)));
  for (let y = dStep; y < h - dStep; y++) {
    for (let x = dStep; x < w - dStep; x++) {
      const o = (y * w + x) * 4;
      const r = rgba[o]; const g = rgba[o + 1]; const b = rgba[o + 2]; const a = rgba[o + 3];
      if (isBackgroundPixel(r, g, b, a, bgInfo)) continue;

      // Gradient check against 4-neighbors to reject anti-aliased transition pixels
      let edgeJump = false;
      for (const [nx, ny] of [[x - dStep, y], [x + dStep, y], [x, y - dStep], [x, y + dStep]]) {
        const no = (ny * w + nx) * 4;
        if (rgba[no + 3] < 96 ||
            Math.abs(rgba[no] - r) > 34 ||
            Math.abs(rgba[no + 1] - g) > 34 ||
            Math.abs(rgba[no + 2] - b) > 34) {
          edgeJump = true;
          break;
        }
      }
      if (!edgeJump) {
        addBucket(r, g, b);
        interiorAccepted++;
      }
    }
  }

  // Fallback for very thin line/stroke masks if interior flat pixels were sparse
  if (interiorAccepted < totalPx * 0.002) {
    for (let i = 0; i < totalPx; i++) {
      const o = i * 4;
      const r = rgba[o]; const g = rgba[o + 1]; const b = rgba[o + 2]; const a = rgba[o + 3];
      if (!isBackgroundPixel(r, g, b, a, bgInfo)) addBucket(r, g, b);
    }
  }

  const sortedBuckets = [...buckets.values()].sort((a, b) => b.count - a.count);
  const clusters = []; // { r, g, b, seedCount, sr, sg, sb }
  const mergeDistSq = 54 * 54;

  for (const bkt of sortedBuckets) {
    const mr = bkt.sr / bkt.count;
    const mg = bkt.sg / bkt.count;
    const mb = bkt.sb / bkt.count;
    let bestIdx = -1;
    let bestD2 = mergeDistSq;
    for (let ci = 0; ci < clusters.length; ci++) {
      const c = clusters[ci];
      const d2 = (mr - c.r) ** 2 + (mg - c.g) ** 2 + (mb - c.b) ** 2;
      if (d2 <= bestD2) {
        bestD2 = d2;
        bestIdx = ci;
      }
    }
    if (bestIdx >= 0) {
      const c = clusters[bestIdx];
      // Keep dominant mode color sharp by weighting heavily toward primary peak
      c.sr += bkt.sr;
      c.sg += bkt.sg;
      c.sb += bkt.sb;
      c.seedCount += bkt.count;
    } else if (clusters.length < 24) {
      clusters.push({
        r: Math.round(mr),
        g: Math.round(mg),
        b: Math.round(mb),
        seedCount: bkt.count,
        sr: bkt.sr,
        sg: bkt.sg,
        sb: bkt.sb,
      });
    }
  }

  if (!clusters.length) return [];

  // Step 2: Assign all foreground pixels competitively to nearest cluster centroid
  const stats = clusters.map(c => ({
    r: c.r,
    g: c.g,
    b: c.b,
    hex: rgbToHex(c.r, c.g, c.b),
    pixelCount: 0,
    sumX: 0,
    sumY: 0,
    minX: w,
    minY: h,
    maxX: 0,
    maxY: 0,
  }));

  const assignLimitSq = 82 * 82;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r = rgba[o]; const g = rgba[o + 1]; const b = rgba[o + 2]; const a = rgba[o + 3];
      if (isBackgroundPixel(r, g, b, a, bgInfo)) continue;
      let winIdx = -1;
      let winD2 = assignLimitSq;
      for (let ci = 0; ci < stats.length; ci++) {
        const c = stats[ci];
        const d2 = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
        if (d2 < winD2) {
          winD2 = d2;
          winIdx = ci;
        }
      }
      if (winIdx >= 0) {
        const st = stats[winIdx];
        st.pixelCount++;
        st.sumX += x;
        st.sumY += y;
        if (x < st.minX) st.minX = x;
        if (y < st.minY) st.minY = y;
        if (x > st.maxX) st.maxX = x;
        if (y > st.maxY) st.maxY = y;
      }
    }
  }

  let valid = stats
    .map(st => ({
      ...st,
      coveragePct: Number(((st.pixelCount / totalPx) * 100).toFixed(2)),
      centerY: st.pixelCount > 0 ? st.sumY / st.pixelCount : h * 0.5,
      centerX: st.pixelCount > 0 ? st.sumX / st.pixelCount : w * 0.5,
    }))
    .filter(st => st.coveragePct >= minCoveragePct);

  // Keep at least the single largest region if user painted a very small accessory mask
  if (!valid.length) {
    const topOne = stats.sort((a, b) => b.pixelCount - a.pixelCount)[0];
    if (topOne && topOne.pixelCount > 0) {
      valid = [{
        ...topOne,
        coveragePct: Number(((topOne.pixelCount / totalPx) * 100).toFixed(2)),
        centerY: topOne.sumY / topOne.pixelCount,
        centerX: topOne.sumX / topOne.pixelCount,
      }];
    }
  }

  // Sort top-to-bottom by vertical centroid so character parts order naturally (Head -> Upper -> Lower)
  valid.sort((a, b) => b.pixelCount - a.pixelCount);
  valid = valid.slice(0, maxRegions).sort((a, b) => a.centerY - b.centerY);

  return valid.map((st, idx) => {
    const colZh = friendlyColorName(st.r, st.g, st.b, false);
    const colEn = friendlyColorName(st.r, st.g, st.b, true);
    return {
      index: idx,
      hex: st.hex,
      rgb: [st.r, st.g, st.b],
      pixelCount: st.pixelCount,
      coveragePct: st.coveragePct,
      centerY: st.centerY / h,
      bbox: [st.minX, st.minY, st.maxX, st.maxY],
      colorNameZh: colZh,
      colorNameEn: colEn,
      suggestedPartNameZh: `${colZh}分区部件 ${idx + 1}`,
      suggestedPartNameEn: `${colEn} Part ${idx + 1}`,
    };
  });
}

/**
 * Extracts a clean 0/1 Uint8Array foreground mask for the chosen `mode` & `colorHex`,
 * using competitive rival-color separation when `mode === 'color'` to prevent color bleeding!
 */
export function extractTargetMaskBinary(mskRgba, width, height, {
  mode = 'auto',
  colorHex = '#ff3b30',
  rivalColors = null,
} = {}) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const n = w * h;
  const fg = new Uint8Array(n);

  let effMode = String(mode || 'auto').toLowerCase();
  const bgInfo = detectBorderBackground(mskRgba, w, h);

  if (effMode === 'auto') {
    let trans = 0;
    let opaq = 0;
    let sat = 0;
    for (let i = 0; i < n; i += 16) {
      const o = i * 4;
      const r = mskRgba[o]; const g = mskRgba[o + 1]; const b = mskRgba[o + 2]; const a = mskRgba[o + 3];
      if (a < 128) trans++; else opaq++;
      if (a >= 64 && (Math.max(r, g, b) - Math.min(r, g, b)) > 42) sat++;
    }
    const tot = Math.max(1, trans + opaq);
    if (trans > 0 && opaq / tot >= 0.02 && opaq / tot <= 0.94) effMode = 'alpha';
    else if (sat / tot > 0.03) effMode = 'painted';
    else if (bgInfo.ignoreWhite && !bgInfo.ignoreBlack) effMode = 'black_on_white';
    else effMode = 'white';
  }

  if (effMode === 'color') {
    const [tr, tg, tb] = hexToRgb(colorHex);
    // Auto-discover rival color blocks if not passed explicitly so adjacent ID colors stay razor-sharp!
    const detectedRivals = Array.isArray(rivalColors)
      ? rivalColors.map(c => Array.isArray(c) ? c : hexToRgb(c))
      : analyzeMaskColorBlocks(mskRgba, w, h, {minCoveragePct: 0.15, maxRegions: 14})
          .map(b => b.rgb)
          .filter(([rr, rg, rb]) => ((rr - tr) ** 2 + (rg - tg) ** 2 + (rb - tb) ** 2) > 38 * 38);

    const maxTolSq = 76 * 76;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const r = mskRgba[o]; const g = mskRgba[o + 1]; const b = mskRgba[o + 2]; const a = mskRgba[o + 3];
      if (a < 48) continue;
      if (bgInfo.ignoreBlack && (tr + tg + tb) > 90 && r <= 20 && g <= 20 && b <= 20) continue;
      if (bgInfo.ignoreWhite && (tr + tg + tb) < 690 && r >= 240 && g >= 240 && b >= 240) continue;

      const dTargetSq = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
      if (dTargetSq > maxTolSq) continue;

      let beatenByRival = false;
      for (let ri = 0; ri < detectedRivals.length; ri++) {
        const [rr, rg, rb] = detectedRivals[ri];
        const dRivalSq = (r - rr) ** 2 + (g - rg) ** 2 + (b - rb) ** 2;
        if (dRivalSq < dTargetSq) {
          beatenByRival = true;
          break;
        }
      }
      if (!beatenByRival) fg[i] = 1;
    }

    // 1px pinhole closure inside solid brushwork
    const cleaned = new Uint8Array(fg);
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = row + x;
        const sum4 = fg[idx - 1] + fg[idx + 1] + fg[idx - w] + fg[idx + w];
        if (!fg[idx] && sum4 >= 3) cleaned[idx] = 1;
        else if (fg[idx] && sum4 === 0) cleaned[idx] = 0;
      }
    }
    return cleaned;
  }

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = mskRgba[o]; const g = mskRgba[o + 1]; const b = mskRgba[o + 2]; const a = mskRgba[o + 3];
    if (effMode === 'alpha') {
      if (a >= 96) fg[i] = 1;
    } else if (effMode === 'painted') {
      if (a >= 64 && (Math.max(r, g, b) - Math.min(r, g, b)) > 38) fg[i] = 1;
    } else if (effMode === 'black_on_white') {
      if (a >= 64 && (r + g + b) < 380) fg[i] = 1;
    } else {
      if (a >= 64 && (r + g + b) >= 350) fg[i] = 1;
    }
  }
  return fg;
}

/**
 * Composites `srcRgba` (optional; if null, uses `mskRgba` itself) with `mskRgba` so ONLY the target
 * mask region stays 100% bright outlined in neon cyan while everything outside is dimmed to 18%.
 */
export function compositeMaskHighlightRgba(srcRgba, srcW, srcH, mskRgba, mskW, mskH, {
  mode = 'auto',
  colorHex = '#ff3b30',
  rivalColors = null,
  outlineRgb = [0, 240, 255],
} = {}) {
  const w = srcRgba ? srcW : mskW;
  const h = srcRgba ? srcH : mskH;
  const n = w * h;

  // Resample mask nearest-neighbor if dimensions differ from source
  const mskAligned = (mskW === w && mskH === h) ? mskRgba : (() => {
    const buf = new Uint8Array(n * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(mskH - 1, Math.floor((y * mskH) / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(mskW - 1, Math.floor((x * mskW) / w));
        const si = (sy * mskW + sx) * 4;
        const di = (y * w + x) * 4;
        buf[di] = mskRgba[si]; buf[di + 1] = mskRgba[si + 1]; buf[di + 2] = mskRgba[si + 2]; buf[di + 3] = mskRgba[si + 3];
      }
    }
    return buf;
  })();

  const basePx = srcRgba || mskAligned;
  const fg = extractTargetMaskBinary(mskAligned, w, h, {mode, colorHex, rivalColors});
  const out = new Uint8ClampedArray(n * 4);
  const rad = Math.max(1, Math.min(4, Math.round(Math.max(w, h) / 320)));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const af = basePx[o + 3] / 255;
      const r = Math.round(basePx[o] * af + 22 * (1 - af));
      const g = Math.round(basePx[o + 1] * af + 26 * (1 - af));
      const b = Math.round(basePx[o + 2] * af + 36 * (1 - af));

      if (fg[i]) {
        let isEdge = false;
        for (const dy of [-rad, 0, rad]) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) { isEdge = true; break; }
          for (const dx of [-rad, 0, rad]) {
            const nx = x + dx;
            if (nx < 0 || nx >= w || !fg[ny * w + nx]) { isEdge = true; break; }
          }
          if (isEdge) break;
        }
        if (isEdge) {
          out[o] = outlineRgb[0]; out[o + 1] = outlineRgb[1]; out[o + 2] = outlineRgb[2]; out[o + 3] = 255;
        } else {
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        }
      } else {
        out[o] = Math.round(r * 0.18 + 10);
        out[o + 1] = Math.round(g * 0.18 + 14);
        out[o + 2] = Math.round(b * 0.20 + 22);
        out[o + 3] = 255;
      }
    }
  }
  return {width: w, height: h, rgba: out, fg};
}
