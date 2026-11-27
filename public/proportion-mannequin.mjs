// MorphoGem Clean-Room Parametric Body Proportion Model & Real-Time Orthographic Mannequin Renderer (MIT)
// Shared 1:1 between Browser Live Interactive Preview (<1.5ms at 512px) and Node CLI PNG Export (1024px).

export const PROPORTION_ARCHETYPES = Object.freeze([
  {
    id: 'keep',
    zh: '保持原画默认比例（不覆盖体型）',
    en: 'Keep Source Concept Proportions',
    enabled: false,
    headRatio: 6.8,
    headWidth: 0.74,
    neckLen: 0.17,
    shoulderWidth: 1.34,
    chestWidth: 1.10,
    waistWidth: 0.72,
    hipWidth: 1.32,
    legRatio: 0.56,
    limbThickness: 0.88,
    armSpan: 0.98,
    pose: 't',
  },
  {
    id: 'chibi_20',
    zh: '2.0 头身 · 超萌粘土豆豆人（窄溜肩/圆肚短腿）',
    en: '2.0H · Nendoroid Super Chibi',
    enabled: true,
    headRatio: 2.0,
    headWidth: 1.05,
    neckLen: 0.05,
    shoulderWidth: 0.76,
    chestWidth: 0.76,
    waistWidth: 0.80,
    hipWidth: 0.88,
    legRatio: 0.42,
    limbThickness: 1.38,
    armSpan: 0.82,
    pose: 'a',
  },
  {
    id: 'blindbox_25',
    zh: '2.5 头身 · 潮玩盲盒手办（圆润手脚/A字躯干）',
    en: '2.5H · Blindbox Chibi Figure',
    enabled: true,
    headRatio: 2.5,
    headWidth: 0.98,
    neckLen: 0.07,
    shoulderWidth: 0.86,
    chestWidth: 0.84,
    waistWidth: 0.80,
    hipWidth: 0.94,
    legRatio: 0.45,
    limbThickness: 1.28,
    armSpan: 0.86,
    pose: 'a',
  },
  {
    id: 'sd_30',
    zh: '3.0 头身 · SD 游戏小人',
    en: '3.0H · SD Game Character',
    enabled: true,
    headRatio: 3.0,
    headWidth: 0.92,
    neckLen: 0.10,
    shoulderWidth: 0.98,
    chestWidth: 0.90,
    waistWidth: 0.78,
    hipWidth: 0.98,
    legRatio: 0.48,
    limbThickness: 1.15,
    armSpan: 0.90,
    pose: 't',
  },
  {
    id: 'semi_40',
    zh: '4.0 头身 · 轻Q版二游体型',
    en: '4.0H · Semi-Chibi',
    enabled: true,
    headRatio: 4.0,
    headWidth: 0.84,
    neckLen: 0.13,
    shoulderWidth: 1.12,
    chestWidth: 0.98,
    waistWidth: 0.76,
    hipWidth: 1.08,
    legRatio: 0.51,
    limbThickness: 1.02,
    armSpan: 0.94,
    pose: 't',
  },
  {
    id: 'loli_58',
    zh: '5.8 头身 · 娇小萝莉/少男（窄肩纤细）',
    en: '5.8H · Petite Youth / Loli',
    enabled: true,
    headRatio: 5.8,
    headWidth: 0.78,
    neckLen: 0.15,
    shoulderWidth: 1.18,
    chestWidth: 0.98,
    waistWidth: 0.72,
    hipWidth: 1.14,
    legRatio: 0.54,
    limbThickness: 0.88,
    armSpan: 0.96,
    pose: 't',
  },
  {
    id: 'anime_fem_68',
    zh: '6.8 头身 · 标准二次元少女（收腰修长）',
    en: '6.8H · Standard Anime Female',
    enabled: true,
    headRatio: 6.8,
    headWidth: 0.74,
    neckLen: 0.17,
    shoulderWidth: 1.34,
    chestWidth: 1.10,
    waistWidth: 0.72,
    hipWidth: 1.32,
    legRatio: 0.56,
    limbThickness: 0.88,
    armSpan: 0.98,
    pose: 't',
  },
  {
    id: 'tall_lady_75',
    zh: '7.5 头身 · 修长御姐/成女（饱满胸胯大长腿）',
    en: '7.5H · Tall Mature Female',
    enabled: true,
    headRatio: 7.5,
    headWidth: 0.71,
    neckLen: 0.19,
    shoulderWidth: 1.46,
    chestWidth: 1.22,
    waistWidth: 0.74,
    hipWidth: 1.48,
    legRatio: 0.59,
    limbThickness: 0.92,
    armSpan: 1.02,
    pose: 't',
  },
  {
    id: 'anime_male_75',
    zh: '7.5 头身 · 少年/青年男体（宽肩窄胯倒三角）',
    en: '7.5H · Slender Anime Male',
    enabled: true,
    headRatio: 7.5,
    headWidth: 0.74,
    neckLen: 0.18,
    shoulderWidth: 1.86,
    chestWidth: 1.48,
    waistWidth: 1.04,
    hipWidth: 1.26,
    legRatio: 0.56,
    limbThickness: 1.02,
    armSpan: 1.03,
    pose: 't',
  },
  {
    id: 'heroic_male_82',
    zh: '8.2 头身 · 魁梧成男/重装机甲（超宽肩厚实四肢）',
    en: '8.2H · Heroic / Heavy Mecha',
    enabled: true,
    headRatio: 8.2,
    headWidth: 0.74,
    neckLen: 0.18,
    shoulderWidth: 2.26,
    chestWidth: 1.84,
    waistWidth: 1.28,
    hipWidth: 1.48,
    legRatio: 0.55,
    limbThickness: 1.28,
    armSpan: 1.05,
    pose: 't',
  },
  {
    id: 'custom',
    zh: '✨ 自定义精调体型参数…',
    en: '✨ Custom Parametric Proportions...',
    enabled: true,
    headRatio: 6.8,
    headWidth: 0.74,
    neckLen: 0.17,
    shoulderWidth: 1.34,
    chestWidth: 1.10,
    waistWidth: 0.72,
    hipWidth: 1.32,
    legRatio: 0.56,
    limbThickness: 0.88,
    armSpan: 0.98,
    pose: 't',
  },
]);

// Map legacy numeric strings ('2.0', '2.5', '3.0', '4.0', '6.0', '6.8', '7.5', '8.5') smoothly
const LEGACY_ID_MAP = Object.freeze({
  '2.0': 'chibi_20',
  '2.5': 'blindbox_25',
  '3.0': 'sd_30',
  '4.0': 'semi_40',
  '6.0': 'loli_58',
  '6.8': 'anime_fem_68',
  '7.5': 'tall_lady_75',
  '8.5': 'heroic_male_82',
});

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

export function createProportionSpecFromArchetype(archetypeId = 'keep') {
  const mappedId = LEGACY_ID_MAP[archetypeId] || archetypeId || 'keep';
  const found = PROPORTION_ARCHETYPES.find(a => a.id === mappedId) || PROPORTION_ARCHETYPES[0];
  return {
    enabled: Boolean(found.enabled),
    archetype: found.id,
    headRatio: found.headRatio,
    headWidth: found.headWidth,
    neckLen: found.neckLen,
    shoulderWidth: found.shoulderWidth,
    chestWidth: found.chestWidth,
    waistWidth: found.waistWidth,
    hipWidth: found.hipWidth,
    legRatio: found.legRatio,
    limbThickness: found.limbThickness,
    armSpan: found.armSpan,
    pose: found.pose,
  };
}

export function normalizeProportionSpec(raw, legacyRatio = null, legacyCustom = 6.8) {
  if (!raw || typeof raw !== 'object') {
    if (legacyRatio && legacyRatio !== 'keep') {
      if (LEGACY_ID_MAP[legacyRatio]) {
        return createProportionSpecFromArchetype(LEGACY_ID_MAP[legacyRatio]);
      }
      const num = Number(legacyRatio === 'custom' ? legacyCustom : legacyRatio);
      if (Number.isFinite(num) && num >= 1.5 && num <= 9.5) {
        const base = createProportionSpecFromArchetype(num <= 2.3 ? 'chibi_20' : num <= 3.3 ? 'blindbox_25' : num <= 4.8 ? 'semi_40' : 'anime_fem_68');
        base.enabled = true;
        base.archetype = 'custom';
        base.headRatio = Number(num.toFixed(2));
        return base;
      }
    }
    return createProportionSpecFromArchetype('keep');
  }

  const arch = PROPORTION_ARCHETYPES.some(a => a.id === raw.archetype) ? raw.archetype : 'custom';
  const def = createProportionSpecFromArchetype(arch === 'custom' ? 'anime_fem_68' : arch);
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : arch !== 'keep';
  return {
    enabled: arch === 'keep' ? false : enabled,
    archetype: enabled ? (arch === 'keep' ? 'custom' : arch) : 'keep',
    headRatio: Number(clamp(raw.headRatio, 1.5, 9.5, def.headRatio).toFixed(2)),
    headWidth: Number(clamp(raw.headWidth, 0.55, 1.25, def.headWidth).toFixed(2)),
    neckLen: Number(clamp(raw.neckLen, 0.02, 0.38, def.neckLen).toFixed(2)),
    shoulderWidth: Number(clamp(raw.shoulderWidth, 0.60, 2.65, def.shoulderWidth).toFixed(2)),
    chestWidth: Number(clamp(raw.chestWidth, 0.60, 2.30, def.chestWidth).toFixed(2)),
    waistWidth: Number(clamp(raw.waistWidth, 0.40, 1.90, def.waistWidth).toFixed(2)),
    hipWidth: Number(clamp(raw.hipWidth, 0.60, 2.25, def.hipWidth).toFixed(2)),
    legRatio: Number(clamp(raw.legRatio, 0.30, 0.68, def.legRatio).toFixed(2)),
    limbThickness: Number(clamp(raw.limbThickness, 0.50, 1.70, def.limbThickness).toFixed(2)),
    armSpan: Number(clamp(raw.armSpan, 0.70, 1.25, def.armSpan).toFixed(2)),
    pose: raw.pose === 'a' ? 'a' : 't',
  };
}

export function proportionSpecStamp(spec) {
  const s = normalizeProportionSpec(spec);
  if (!s.enabled) return 'keep';
  return [
    s.headRatio,
    s.headWidth,
    s.neckLen,
    s.shoulderWidth,
    s.chestWidth,
    s.waistWidth,
    s.hipWidth,
    s.legRatio,
    s.limbThickness,
    s.armSpan,
    s.pose,
  ].join(':');
}

export function formatProportionSummary(spec, isEn = false) {
  const s = normalizeProportionSpec(spec);
  if (!s.enabled) return isEn ? 'Original Concept Ratio' : '保持原画默认比例';
  const legPct = Math.round(s.legRatio * 100);
  return isEn
    ? `${s.headRatio}H · Shld ${s.shoulderWidth}× · Hip ${s.hipWidth}× · Legs ${legPct}%`
    : `${s.headRatio}头身 · 肩${s.shoulderWidth}× · 胯${s.hipWidth}× · 腿${legPct}%`;
}

// --- Crisp 5x7 Pixel Font for Zero-Dependency Chart Callouts ---
const GLYPHS_5X7 = Object.freeze({
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '%': ['11001', '11010', '00100', '01000', '10110', '00110', '00000'],
  'x': ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
});

const smoothstep = (edge0, edge1, x) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const cosInterp = (a, b, u) => {
  const f = (1 - Math.cos(Math.max(0, Math.min(1, u)) * Math.PI)) * 0.5;
  return a * (1 - f) + b * f;
};

/**
 * Renders an anti-aliased orthographic mannequin + head-unit ruler chart into a `Uint8ClampedArray` RGBA buffer.
 */
export function renderProportionMannequinRgba(rawSpec, {
  size = 512,
  theme = 'light', // 'light' (best for AI export) | 'blueprint' (dark UI option)
  transparentBg = false,
  showLabels = true,
} = {}) {
  const spec = normalizeProportionSpec(rawSpec);
  const s = Math.max(160, Math.min(2048, Math.round(size)));
  const rgba = new Uint8ClampedArray(s * s * 4);

  const isDark = theme === 'blueprint';
  const bgR = isDark ? 12 : 255;
  const bgG = isDark ? 19 : 255;
  const bgB = isDark ? 34 : 255;
  const bgA = transparentBg ? 0 : 255;

  for (let i = 0; i < s * s; i++) {
    const o = i * 4;
    rgba[o] = bgR;
    rgba[o + 1] = bgG;
    rgba[o + 2] = bgB;
    rgba[o + 3] = bgA;
  }

  const blendPx = (x, y, r, g, b, alpha01) => {
    if (x < 0 || x >= s || y < 0 || y >= s || alpha01 <= 0) return;
    const o = (y * s + x) * 4;
    const srcA = Math.max(0, Math.min(1, alpha01));
    const dstA = rgba[o + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 1e-5) return;
    rgba[o] = Math.round((r * srcA + rgba[o] * dstA * (1 - srcA)) / outA);
    rgba[o + 1] = Math.round((g * srcA + rgba[o + 1] * dstA * (1 - srcA)) / outA);
    rgba[o + 2] = Math.round((b * srcA + rgba[o + 2] * dstA * (1 - srcA)) / outA);
    rgba[o + 3] = Math.round(outA * 255);
  };

  const drawHLine = (x0, x1, y, thick, r, g, b, alpha = 1, dashed = false) => {
    const ax = Math.max(0, Math.round(Math.min(x0, x1)));
    const bx = Math.min(s - 1, Math.round(Math.max(x0, x1)));
    const half = Math.max(0, Math.floor((thick - 1) / 2));
    for (let dy = -half; dy <= Math.ceil((thick - 1) / 2); dy++) {
      const py = Math.round(y) + dy;
      if (py < 0 || py >= s) continue;
      for (let px = ax; px <= bx; px++) {
        if (dashed && ((px >> 3) & 1)) continue;
        blendPx(px, py, r, g, b, alpha);
      }
    }
  };

  const drawVLine = (x, y0, y1, thick, r, g, b, alpha = 1, dashed = false) => {
    const ay = Math.max(0, Math.round(Math.min(y0, y1)));
    const by = Math.min(s - 1, Math.round(Math.max(y0, y1)));
    const half = Math.max(0, Math.floor((thick - 1) / 2));
    for (let dx = -half; dx <= Math.ceil((thick - 1) / 2); dx++) {
      const px = Math.round(x) + dx;
      if (px < 0 || px >= s) continue;
      for (let py = ay; py <= by; py++) {
        if (dashed && ((py >> 3) & 1)) continue;
        blendPx(px, py, r, g, b, alpha);
      }
    }
  };

  const drawText = (text, startX, startY, scale, r, g, b, alpha = 1) => {
    let cx = Math.round(startX);
    const cy = Math.round(startY);
    const str = String(text || '');
    for (let idx = 0; idx < str.length; idx++) {
      const ch = str[idx];
      const glyph = GLYPHS_5X7[ch] || GLYPHS_5X7[ch.toUpperCase()] || GLYPHS_5X7[' '];
      for (let gy = 0; gy < 7; gy++) {
        const rowStr = glyph[gy];
        for (let gx = 0; gx < 5; gx++) {
          if (rowStr[gx] === '1') {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                blendPx(cx + gx * scale + sx, cy + gy * scale + sy, r, g, b, alpha);
              }
            }
          }
        }
      }
      cx += 6 * scale;
    }
  };

  // Anti-aliased tapered capsule segment with dark outline
  const drawTaperedCapsule = (x0, y0, r0, x1, y1, r1, fillRgb, strokeRgb, strokeW = 1.6) => {
    const maxR = Math.max(r0, r1) + strokeW + 2;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - maxR));
    const maxX = Math.min(s - 1, Math.ceil(Math.max(x0, x1) + maxR));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - maxR));
    const maxY = Math.min(s - 1, Math.ceil(Math.max(y0, y1) + maxR));
    const vx = x1 - x0;
    const vy = y1 - y0;
    const lenSq = Math.max(1e-6, vx * vx + vy * vy);

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const t = Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / lenSq));
        const qx = x0 + t * vx;
        const qy = y0 + t * vy;
        const rad = r0 + (r1 - r0) * t;
        const dist = Math.hypot(px - qx, py - qy) - rad;
        if (dist > 1.2) continue;
        const outerCov = 1 - smoothstep(-0.6, 0.9, dist);
        const innerCov = 1 - smoothstep(-0.6, 0.9, dist + strokeW);
        const cr = Math.round(fillRgb[0] * innerCov + strokeRgb[0] * (1 - innerCov));
        const cg = Math.round(fillRgb[1] * innerCov + strokeRgb[1] * (1 - innerCov));
        const cb = Math.round(fillRgb[2] * innerCov + strokeRgb[2] * (1 - innerCov));
        blendPx(px, py, cr, cg, cb, outerCov);
      }
    }
  };

  const drawJointCircle = (cx, cy, rad, fillRgb, strokeRgb, strokeW = 1.4) => {
    drawTaperedCapsule(cx, cy, rad, cx, cy, rad, fillRgb, strokeRgb, strokeW);
  };

  // --- Compute Exact Metric Layout in Normalized Head Units ---
  const R = spec.headRatio;
  const bodyTotalU = Math.max(0.5, R - 1.0); // Neck + Torso + Legs in Head Units
  const neckU = Math.min(bodyTotalU * 0.25, spec.neckLen);
  const remainBodyU = Math.max(0.35, bodyTotalU - neckU);
  const legU = remainBodyU * spec.legRatio;
  const torsoU = Math.max(0.2, remainBodyU - legU);

  const headW_U = spec.headWidth; // Head width in Head Units
  const shoulderW_U = headW_U * spec.shoulderWidth;
  const chestW_U = headW_U * spec.chestWidth;
  const waistW_U = headW_U * spec.waistWidth;
  const hipW_U = headW_U * spec.hipWidth;

  // Natural anime arm length (shoulder joint -> fingertip reaches upper thigh when relaxed)
  const armTotalU = (torsoU * 0.84 + legU * 0.13) * spec.armSpan;
  const armAngRad = (spec.pose === 'a' ? 40 : 5) * (Math.PI / 180);
  const totalHorizSpanU = Math.max(headW_U, shoulderW_U + 2 * Math.cos(armAngRad) * armTotalU + 0.30, hipW_U + 0.4);

  // Fit cleanly inside [7% .. 93%] vertically AND [8% .. 92%] horizontally without ever clipping arms!
  const availH = s * 0.85;
  const availW = s * 0.82;
  const pxPerHead = Math.min(availH / R, availW / totalHorizSpanU);

  const totalCharPx = R * pxPerHead;
  const topY = (s - totalCharPx) * 0.5;
  const botY = topY + totalCharPx;
  const chinY = topY + pxPerHead;
  const shoulderY = chinY + neckU * pxPerHead;
  const crotchY = shoulderY + torsoU * pxPerHead;
  const cx = s * 0.5;

  const strokeW = Math.max(1.2, s / 360);
  const headFill = isDark ? [56, 189, 248] : [186, 230, 253];
  const headStroke = isDark ? [186, 230, 253] : [14, 116, 144];
  const bodyFill = isDark ? [51, 65, 85] : [208, 218, 230];
  const limbFill = isDark ? [71, 85, 105] : [191, 204, 220];
  const jointFill = isDark ? [125, 211, 252] : [148, 163, 184];
  const bodyStroke = isDark ? [148, 163, 184] : [51, 65, 85];

  // 1. Subtle Background Grid & Zone Bands
  if (!transparentBg) {
    const gridStep = Math.max(16, Math.round(pxPerHead * 0.5));
    const gridCol = isDark ? [30, 41, 59] : [241, 245, 249];
    for (let gx = gridStep; gx < s; gx += gridStep) drawVLine(gx, 0, s - 1, 1, gridCol[0], gridCol[1], gridCol[2], 0.85);
    for (let gy = gridStep; gy < s; gy += gridStep) drawHLine(0, s - 1, gy, 1, gridCol[0], gridCol[1], gridCol[2], 0.85);
    // Center symmetry axis
    drawVLine(cx, topY - pxPerHead * 0.15, botY + pxPerHead * 0.15, 1, isDark ? 56 : 148, isDark ? 189 : 163, isDark ? 248 : 184, 0.55, true);
  }

  // 2. Horizontal Head-Unit Division Lines (drawn behind mannequin first, ticks overlaid on sides)
  const marginX0 = Math.round(s * 0.05);
  const marginX1 = Math.round(s * 0.95);
  const wholeHeads = Math.floor(R + 1e-6);
  for (let k = 0; k <= wholeHeads; k++) {
    const yk = topY + k * pxPerHead;
    const isKey = k === 0 || k === 1;
    const col = isKey ? [225, 29, 72] : (isDark ? [100, 116, 139] : [148, 163, 184]);
    drawHLine(marginX0, marginX1, yk, isKey ? Math.max(2, Math.round(s / 380)) : 1, col[0], col[1], col[2], isKey ? 0.9 : 0.65);
  }
  drawHLine(marginX0, marginX1, botY, Math.max(2, Math.round(s / 380)), 225, 29, 72, 0.92);

  // Landmark dashed guides: Shoulder & Crotch
  drawHLine(marginX0 + 10, marginX1 - 10, shoulderY, 1, 2, 132, 199, 0.55, true);
  drawHLine(marginX0 + 10, marginX1 - 10, crotchY, 1, 16, 185, 129, 0.6, true);

  // 3. Draw Neck
  const neckHalfPx = Math.max(3, headW_U * pxPerHead * (R <= 3.2 ? 0.22 : 0.17) * Math.sqrt(spec.limbThickness));
  drawTaperedCapsule(cx, chinY - pxPerHead * 0.06, neckHalfPx * 0.92, cx, shoulderY + pxPerHead * 0.06, neckHalfPx * 1.12, limbFill, bodyStroke, strokeW);

  // 4. Draw Legs (Thigh -> Knee -> Calf -> Foot resting at botY)
  const hipHalfPx = (hipW_U * pxPerHead) * 0.5;
  const legLenPx = Math.max(10, botY - crotchY);
  const thighR0 = Math.max(3.5, Math.min(hipHalfPx * 0.52, pxPerHead * 0.155 * spec.limbThickness));
  const kneeR = thighR0 * 0.76;
  const ankleR = kneeR * (R <= 3.3 ? 0.85 : 0.64);
  // Keep clean gap between thighs!
  const hipJointOffset = Math.max(thighR0 + Math.max(2.5, pxPerHead * 0.045), hipHalfPx - thighR0 * 0.68);
  const ankleOffset = hipJointOffset * (R <= 3.2 ? 1.05 : 0.96);
  const kneeY = crotchY + legLenPx * 0.47;
  const ankleY = botY - Math.max(4, legLenPx * 0.065);

  for (const sign of [-1, 1]) {
    const hx = cx + sign * hipJointOffset;
    const kx = cx + sign * ((hipJointOffset + ankleOffset) * 0.5);
    const ax = cx + sign * ankleOffset;
    drawTaperedCapsule(hx, crotchY, thighR0, kx, kneeY, kneeR, limbFill, bodyStroke, strokeW);
    drawTaperedCapsule(kx, kneeY, kneeR * 0.98, ax, ankleY, ankleR, limbFill, bodyStroke, strokeW);
    // Clean rounded foot resting flush on botY
    const footRx = ankleR * (R <= 3.3 ? 1.15 : 1.25);
    const footCy = botY - footRx - strokeW * 0.5;
    drawTaperedCapsule(ax, ankleY, ankleR * 0.96, ax, Math.max(ankleY, footCy), footRx, headFill, bodyStroke, strokeW);
    drawJointCircle(kx, kneeY, kneeR * 0.52, jointFill, bodyStroke, 1.0);
  }

  // 5. Draw Smooth Sculpted Torso (Clavicle -> Chest -> Waist -> Pelvis -> Groin Arch)
  const shHalfPx = (shoulderW_U * pxPerHead) * 0.5;
  const chHalfPx = (chestW_U * pxPerHead) * 0.5;
  const waHalfPx = (waistW_U * pxPerHead) * 0.5;
  const torsoTop = Math.round(shoulderY);
  const torsoBot = Math.round(crotchY + thighR0 * 0.22);
  const torsoSpan = Math.max(6, torsoBot - torsoTop);

  const halfWidthAtU = u => {
    if (u <= 0.26) return cosInterp(shHalfPx * 0.92, chHalfPx, u / 0.26);
    if (u <= 0.62) return cosInterp(chHalfPx, waHalfPx, (u - 0.26) / 0.36);
    if (u <= 0.88) return cosInterp(waHalfPx, hipHalfPx, (u - 0.62) / 0.26);
    return cosInterp(hipHalfPx, Math.max(neckHalfPx * 0.8, hipHalfPx * 0.28), (u - 0.88) / 0.12);
  };

  for (let py = torsoTop; py <= torsoBot; py++) {
    const u = (py - torsoTop) / torsoSpan;
    const hw = halfWidthAtU(u);
    // Slight collarbone dome at very top
    const topCapFade = py < torsoTop + 3 ? smoothstep(0, 3, py - torsoTop + 1) : 1;
    const effHw = hw * topCapFade;
    const maxPx = Math.ceil(effHw + strokeW + 2);
    for (let dx = -maxPx; dx <= maxPx; dx++) {
      const dist = Math.abs(dx) - effHw;
      if (dist > 1.2) continue;
      const isCapBorder = py <= torsoTop + strokeW || py >= torsoBot - strokeW;
      const outerCov = 1 - smoothstep(-0.6, 0.9, dist);
      const innerCov = isCapBorder ? 0 : (1 - smoothstep(-0.6, 0.9, dist + strokeW));
      const cr = Math.round(bodyFill[0] * innerCov + bodyStroke[0] * (1 - innerCov));
      const cg = Math.round(bodyFill[1] * innerCov + bodyStroke[1] * (1 - innerCov));
      const cb = Math.round(bodyFill[2] * innerCov + bodyStroke[2] * (1 - innerCov));
      blendPx(Math.round(cx) + dx, py, cr, cg, cb, outerCov);
    }
  }

  // 6. Draw Arms (Deltoid Shoulder Joint -> Upper Arm -> Elbow -> Forearm -> Hand)
  const armLenPx = armTotalU * pxPerHead;
  const upperArmR = Math.max(3.5, pxPerHead * 0.132 * spec.limbThickness);
  const elbowR = upperArmR * 0.82;
  const wristR = elbowR * (R <= 3.3 ? 0.92 : 0.72);
  const shJointY = shoulderY + upperArmR * 0.85;
  const shAttachHalf = Math.max(neckHalfPx + 2, shHalfPx - upperArmR * 0.35);

  for (const sign of [-1, 1]) {
    const sx0 = cx + sign * shAttachHalf;
    const sy0 = shJointY;
    const ca = Math.cos(armAngRad);
    const sa = Math.sin(armAngRad);
    const ex = sx0 + sign * ca * (armLenPx * 0.44);
    const ey = sy0 + sa * (armLenPx * 0.44);
    const wx = sx0 + sign * ca * (armLenPx * 0.82);
    const wy = sy0 + sa * (armLenPx * 0.82);
    const hx = sx0 + sign * ca * armLenPx;
    const hy = sy0 + sa * armLenPx;

    drawTaperedCapsule(sx0, sy0, upperArmR, ex, ey, elbowR, limbFill, bodyStroke, strokeW);
    drawTaperedCapsule(ex, ey, elbowR * 0.96, wx, wy, wristR, limbFill, bodyStroke, strokeW);
    drawTaperedCapsule(wx, wy, wristR * 1.15, hx, hy, wristR * 0.82, headFill, bodyStroke, strokeW);
    drawJointCircle(sx0, sy0, upperArmR * 0.72, jointFill, bodyStroke, 1.0);
    drawJointCircle(ex, ey, elbowR * 0.52, jointFill, bodyStroke, 1.0);
  }

  // 7. Draw Sculpted Anime Head (Seamless Rounded Cranium + Puffy Chibi Cheeks or Tapered Anime Jaw)
  const headHalfW = (headW_U * pxPerHead) * 0.5;
  const chibiBlend = Math.max(0, Math.min(1, (4.0 - R) / 1.8));
  const hTop = Math.round(topY);
  const hBot = Math.round(chinY);
  const hSpan = Math.max(8, hBot - hTop);

  for (let py = hTop; py <= hBot; py++) {
    const uc = Math.max(0, Math.min(1, (py - hTop) / hSpan));
    let hw = 0;
    if (uc <= 0.55) {
      const t = (uc - 0.55) / 0.55; // -1 at crown -> 0 at cheek widest
      hw = headHalfW * Math.sqrt(Math.max(0, 1 - t * t));
    } else {
      const v = (uc - 0.55) / 0.45; // 0 at cheek -> 1 at chin
      // Chibi has round mochi cheeks (superellipse power 1.85), tall anime has sleek tapered jaw
      const roundFace = headHalfW * Math.sqrt(Math.max(0, 1 - Math.pow(v, 2.2)));
      const sleekJaw = headHalfW * Math.cos(v * Math.PI * 0.47) * (1 - 0.28 * v * v);
      hw = roundFace * chibiBlend + sleekJaw * (1 - chibiBlend);
    }
    const maxDx = Math.ceil(hw + strokeW + 2);
    const isPoleBorder = py <= hTop + strokeW || py >= hBot - strokeW;
    for (let dx = -maxDx; dx <= maxDx; dx++) {
      const dist = Math.abs(dx) - hw;
      if (dist > 1.2) continue;
      const outerCov = 1 - smoothstep(-0.6, 0.9, dist);
      const innerCov = isPoleBorder ? 0 : (1 - smoothstep(-0.6, 0.9, dist + strokeW));
      const cr = Math.round(headFill[0] * innerCov + headStroke[0] * (1 - innerCov));
      const cg = Math.round(headFill[1] * innerCov + headStroke[1] * (1 - innerCov));
      const cb = Math.round(headFill[2] * innerCov + headStroke[2] * (1 - innerCov));
      blendPx(Math.round(cx) + dx, py, cr, cg, cb, outerCov);
    }
  }
  // Facial eye-line & center crosshair inside head
  const eyeY = topY + pxPerHead * (R <= 3.2 ? 0.58 : 0.52);
  drawHLine(cx - headHalfW * 0.78, cx + headHalfW * 0.78, eyeY, 1, headStroke[0], headStroke[1], headStroke[2], 0.55);
  drawVLine(cx, topY + pxPerHead * 0.08, chinY - pxPerHead * 0.06, 1, headStroke[0], headStroke[1], headStroke[2], 0.55);

  // 8. Shoulder Width Caliper Bracket above head/shoulders
  const calY = Math.max(8, shoulderY - pxPerHead * 0.08);
  drawHLine(cx - shHalfPx, cx + shHalfPx, calY, 1, 2, 132, 199, 0.85);
  drawVLine(cx - shHalfPx, calY - 4, calY + 4, 1, 2, 132, 199, 0.9);
  drawVLine(cx + shHalfPx, calY - 4, calY + 4, 1, 2, 132, 199, 0.9);

  // 9. Crisp Dimension Labels (when size >= 280 and showLabels === true)
  if (showLabels && s >= 280) {
    const fontScale = s >= 850 ? 2 : 1;
    const lx = marginX0 + 4;
    drawText('0.0H CROWN', lx, Math.max(4, topY - 9 * fontScale), fontScale, 225, 29, 72, 0.95);
    drawText('1.0H CHIN', lx, chinY + 3, fontScale, 225, 29, 72, 0.95);
    for (let k = 2; k <= wholeHeads; k++) {
      const yk = topY + k * pxPerHead;
      if (Math.abs(yk - botY) > 14 * fontScale) {
        drawText(`${k}.0H`, lx, yk - 8 * fontScale, fontScale, isDark ? 148 : 71, isDark ? 163 : 85, isDark ? 184 : 105, 0.9);
      }
    }
    drawText(`${R}H SOLES`, lx, Math.min(s - 9 * fontScale, botY + 4), fontScale, 225, 29, 72, 0.95);

    // Right-hand side anatomical spec summary tags
    const rx = Math.round(s * 0.66);
    drawText(`SHLD ${spec.shoulderWidth}xHW`, rx, Math.max(6, shoulderY - 9 * fontScale), fontScale, 2, 132, 199, 0.95);
    drawText(`HIP ${spec.hipWidth}xHW`, rx, Math.max(18, crotchY - 18 * fontScale), fontScale, 16, 185, 129, 0.95);
    drawText(`LEGS ${Math.round(spec.legRatio * 100)}%`, rx, crotchY + 4, fontScale, 16, 185, 129, 0.95);
  }

  return rgba;
}

/**
 * Convenience helper for Browser `<canvas>` elements.
 */
export function drawProportionMannequinToCanvas(canvas, rawSpec, opts = {}) {
  if (!canvas) return;
  const sz = opts.size || canvas.width || 512;
  if (canvas.width !== sz) canvas.width = sz;
  if (canvas.height !== sz) canvas.height = sz;
  const rgba = renderProportionMannequinRgba(rawSpec, {...opts, size: sz});
  const ctx = canvas.getContext('2d');
  const imgData = new ImageData(rgba, sz, sz);
  ctx.putImageData(imgData, 0, 0);
}
