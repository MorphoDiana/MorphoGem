// MorphoGem Clean-Room Bilingual Node-Graph AI Prompt Generator (zh-CN & en ONLY)
import {
  GRAPH_VIEWS_4,
  GRAPH_VIEWS_3,
  ensureNodeGraph,
  getNode,
  incomingEdges,
  nodeStatus,
  resolveGraphHeadBodyRatio,
  resolveNumericHeadBodyRatio,
} from './node-graph.mjs';
import {normalizeLocale} from './i18n.mjs';

const GENERIC_PART_NAMES = new Set([
  '新部件',
  '自定义部件',
  '新自定义部件',
  '新拆分部件',
  '未命名',
  '未命名部件',
  'New Part',
  'Custom Part',
  'Untitled Part',
]);

function craftRulesForPart(node, isEn) {
  if (node.type === 'balance_views') {
    return [
      isEn
        ? 'Full-Body Assembly Proportion Guide: Draw the assembled character (head + hair + outfit body + attached wings/props) in the exact same T/A pose as the body branch; `side` is the character-right profile facing right (`-->`), used as the metric scale ruler in the 3D Assembly Viewport.'
        : '全身合体比例标尺：完整画出头+发+服装身体（及已选翅膀/武器的装配关系），保持与身体拆件节点完全一致的 T/A 姿态；`side` 为角色自身右侧面（面朝画面右方 `-->`），用于后续 3D 合体视口对齐真实头身比与挂载位置。',
    ];
  }
  const n = `${node.params?.partName || ''} ${node.params?.promptHint || ''}`.toLowerCase();
  const rules = [];

  if (GENERIC_PART_NAMES.has((node.params?.partName || '').trim()) && !(node.params?.promptHint || '').trim()) {
    rules.push(
      isEn
        ? '⚠️ Generic node name detected: briefly ask the user what specific part or prop this node should extract before spending image generation quota.'
        : '⚠️ 当前节点名称仍为默认泛称，开始消耗算力生图前请先简短询问用户确认该节点具体想拆出的目标（如整体角色全身、手持道具或具体部位）。'
    );
  }
  if (/裸脸|裸头|光头|脸|面部|face|bare\s*head/.test(n) && !/发|hair/.test(n)) {
    rules.push(
      isEn
        ? 'Hairless Bare Head Contract: Strip 100% of bangs, sidelocks, back hair, and headwear; reconstruct a clean rounded cranium, forehead, facial features, and both ears; end cleanly under the jaw with no collar or shoulders.'
        : '无发裸脸标准：100% 剥离全部前后头发、刘海、鬓角与头饰，合理补全完整圆润的光头颅骨轮廓、额头、五官与左右双耳；底部不含衣领与肩膀。'
    );
  } else if (/发|马尾|刘海|辫|髻|hair|ponytail|twintail/.test(n) && !/含发头|整体/.test(n)) {
    rules.push(
      isEn
        ? 'Isolated Hair Shell Contract: Hollow out 100% of facial skin, eyes, ears, and neck/torso (leave a clean inner skull cavity to prevent clipping); group stray 1px flyaways into solid volumetric locks so 3D mesh reconstruction stays watertight.'
        : '独立头发标准：彻底挖空面部五官、耳朵与颈部躯干皮肤（内部保留干净头壳内腔防穿模）；将细碎飞丝聚拢为有明确体积厚度的闭合发束块面，防止 3D 重建碎裂。'
    );
  } else if (/头|head/.test(n)) {
    rules.push(
      isEn
        ? 'Isolated Head Contract: Keep facial features, full hair, and hair ornaments intact; cleanly remove the neck, collarbones, and outfit collar (the body part provides the neck cylinder plug).'
        : '独立头部标准：完整保留五官、全部前后头发与发饰，干净去除脖子、锁骨与身体衣领（由身体部件保留脖子柱体向上插接）。'
    );
  }
  if (/外裙|长裙|裙壳|披风|斗篷|外袍|skirt|cape|cloak/.test(n) && !/身|体|body/.test(n)) {
    rules.push(
      isEn
        ? 'Hollow Outer Garment Contract: Render only the standalone hollow skirt/cape shell; hollow out legs, boots, and inner torso completely.'
        : '中空外装标准：仅绘制独立中空裙装/披风外壳，内部挖空不包含双腿、鞋靴或上半身躯干。'
    );
  } else if (/身|体|上衣|下装|服装|汉服|素体|body|outfit|torso|upper|lower/.test(n)) {
    rules.push(
      isEn
        ? 'Clothed Torso Contract: Remove head, long hair, handheld props, and large back wings; keep a smooth cylindrical neck stump on top for head assembly; reconstruct chest/back garment details occluded by hair or arms; maintain clear transparent gaps under armpits, inside wide sleeves, and between shoes.'
        : '着装躯干标准：去除头部、长发、手持道具与背部大翅膀，顶部保留完整圆柱形脖子以便插接头部；脑补还原原画中被道具/头发/翅膀遮挡的胸腹衣襟与后背剪裁；腋下、袖口内侧及双鞋之间必须留出清晰透明间隙防网格粘连。'
    );
  }
  if (/翼|翅膀|背饰|光环|法环|wing|halo/.test(n)) {
    rules.push(
      isEn
        ? 'Wings / Back Attachment Contract: Remove character head and body; draw paired wings horizontally symmetric in front/back views and depict real structural depth/thickness in left/right profile views (never a flat 1px sheet).'
        : '翅膀/背饰标准：移除人物头身，成对翅膀以左右对称水平展开姿态绘制，保留根部连接结构与侧面合理厚度（切忌画成 1px 薄纸片）。'
    );
  }
  if (/剑|刀|枪|弓|杖|盾|扇|武器|道具|weapon|sword|staff|prop/.test(n)) {
    rules.push(
      isEn
        ? 'Weapon / Prop Contract: Completely remove gripping fingers and character limbs; reconstruct the full hilt/grip; orient the primary axis strictly 90° vertical at canvas center (never diagonal) and show true cross-sectional thickness in profile views.'
        : '武器/道具标准：彻底移除握持的手指与人物身体，完整还原握柄与护手；长杆/对称器物主轴必须严格 90° 垂直居中立放（切勿斜放），侧面交代真实厚度。'
    );
  }
  if (!rules.length) {
    rules.push(
      isEn
        ? 'Clean Part Isolation Contract: Render only the specified target component, strip occluding neighbor parts completely, and faithfully reconstruct occluded back/inner surfaces.'
        : '独立部件去遮挡标准：仅绘制节点名称指定的目标主体，彻底剥离其他部件遮挡并按原设计逻辑完整补全背面与被挡结构。'
    );
  }
  return rules;
}

export function computeLockedNodesForViews(graph, targetNodeIds = null) {
  const candidates = (graph?.nodes || []).filter(n => n.type === 'part_views' || n.type === 'balance_views');
  let targets = Array.isArray(targetNodeIds) && targetNodeIds.length
    ? candidates.filter(n => targetNodeIds.includes(n.id))
    : candidates.filter(n => nodeStatus(graph, n.id).state === 'dirty');
  if (!targets.length) targets = candidates;
  const locked = new Set();
  for (const t of targets) {
    locked.add(t.id);
    for (const ie of incomingEdges(graph, t.id)) {
      locked.add(ie.fromNode);
    }
  }
  return {
    targetNodeIds: targets.map(t => t.id),
    lockedNodeIds: [...locked],
  };
}

export function buildNodeGraphViewsPrompt(request, appRoot, origin, p, targetNodeIds = null, locale = 'zh-CN') {
  const isEn = normalizeLocale(locale) === 'en';
  const g = ensureNodeGraph(p);
  const normRoot = String(appRoot || '').replace(/\\/g, '/');
  const sessionScript = `${normRoot}/scripts/mgem-session.mjs`;
  const cliScript = `${normRoot}/scripts/node-graph-cli.mjs`;
  const alignScript = `${normRoot}/scripts/align_views.py`;

  const candidates = g.nodes.filter(n => n.type === 'part_views' || n.type === 'balance_views');
  let targets = Array.isArray(targetNodeIds) && targetNodeIds.length
    ? candidates.filter(n => targetNodeIds.includes(n.id))
    : candidates.filter(n => nodeStatus(g, n.id).state === 'dirty');
  if (!targets.length) targets = candidates;

  const lines = [];
  if (isEn) {
    lines.push('Please complete the **AI Orthographic Multi-View Part Decomposition & Painting** task for the MorphoGem Node-Graph workflow. Report progress and results in **English**.');
    lines.push('');
    lines.push('### Required MorphoGem Skills (MUST read before generating any images!)');
    lines.push(`1. **Orthographic Projection & Part Contracts**: \`${normRoot}/skills/morphogem-orthographic-views/SKILL.md\``);
    lines.push(`2. **Pure Albedo & Ambient Shading Rules**: \`${normRoot}/skills/morphogem-albedo-shading/SKILL.md\``);
    lines.push(`3. **RGBA Pocket Cutout, Pixel Alignment & Lock Protocol**: \`${normRoot}/skills/morphogem-alpha-alignment/SKILL.md\``);
    lines.push('');
    lines.push('### Step 1: Begin Session & Sync Latest `.mgem` Canvas State (Run First)');
    lines.push(`node "${sessionScript}" begin ${origin} ${request.id}`);
    lines.push('Confirm the JSON output includes `"saved": true` and record `path` (active `project.mgem`) and `directory` (project work folder).');
    lines.push('');
    lines.push('### Step 2: Export Reference Inputs, Mask Overlays & Proportion Ruler Grid');
    lines.push(`node "${cliScript}" export-inputs "<path>" "<directory>/work/graph_inputs"`);
    lines.push('Inspect every exported image (including any auto-generated `proportion_ruler_<R>H.png` and `<nodeId>_mask_overlay.png`) with your vision tool. Strictly separate **Source Concept** (100% design identity), **Mask Overlay** (exact pixel extraction region), and **Style Reference** (brushwork/coloring transfer ONLY).');
    lines.push('');
    lines.push('### Step 3: Generate Orthographic Views per Node Contract (Front Anchor First -> Left / Right / Back)');
    lines.push('- **Orientation & Mirror Law**: `front` 0°; `left` **character-left profile facing left (`<--`)**; `right` **character-right profile facing right (`-->`)**; `back` 180° (**horizontally mirrored** relative to `front` for asymmetric accessories!). In T-Pose profiles, the near arm points straight toward the camera — never draw an extra forward-pointing arm.');
    lines.push('- **Pure Albedo & Interior Cutout Law**: Zero perspective, uniform ambient flat lighting (no cast drop-shadows or harsh white specular hotspots), closed dark outer linework on white garments, and punch out enclosed white background pockets inside hair loops, ribbons, and armpit/shoe gaps.');
    lines.push('');
  } else {
    lines.push('请完成 MorphoGem 节点蓝图工作流中的「AI 自定义部件正交多视图拆解与绘制」。请全程使用**简体中文**向用户汇报进度与结果。');
    lines.push('');
    lines.push('### 必读技能规范（动手生图前必须先阅读！）');
    lines.push(`1. **正交投影与独立部件拆解契约（必读）**：\`${normRoot}/skills/morphogem-orthographic-views/SKILL.md\``);
    lines.push(`2. **纯净固有色（Albedo）与均匀平光规范**：\`${normRoot}/skills/morphogem-albedo-shading/SKILL.md\``);
    lines.push(`3. **透明内孔镂空、像素对齐与局部节点锁协议**：\`${normRoot}/skills/morphogem-alpha-alignment/SKILL.md\``);
    lines.push('');
    lines.push('### 第 1 步：开始会话并同步最新 `.mgem` 画布状态（必须最先执行）');
    lines.push(`node "${sessionScript}" begin ${origin} ${request.id}`);
    lines.push('确认输出包含 `"saved": true` 并记录返回的 `path`（主 `project.mgem` 路径）与 `directory`（项目工作目录）。');
    lines.push('');
    lines.push('### 第 2 步：导出画布输入参考图、Mask 高亮边界合成图与头身比标尺图');
    lines.push(`node "${cliScript}" export-inputs "<path>" "<directory>/work/graph_inputs"`);
    lines.push('解包后请务必调用读图工具逐张检视（包括自动生成的 `proportion_ruler_<R>H.png` 分格标尺图与 `<nodeId>_mask_overlay.png` 遮罩高亮合成图），严格遵守「主立绘继承外观设定」、「Mask 决定像素级拆件边界」、「参数化头身比决定解剖长宽比」。');
    lines.push('');
    lines.push('### 第 3 步：按节点契约逐一绘制正交多方向视图（先立正面基准，再推左/右/背）');
    lines.push('- **方向与镜像铁律**：`front` 正面 0°；`left` **角色/物件自身左侧面**（面朝画面左方 `<--`）；`right` **角色/物件自身右侧面**（面朝画面右方 `-->`）；`back` 背面 180°（左右不对称装饰必须与正面严格水平镜像！）。侧面 T-Pose 近端手臂朝镜头方向平伸，严禁多画一条向前伸出的手臂。');
    lines.push('- **纯净光影与内孔镂空铁律**：无透视平行投影（Orthographic），360° 均匀漫射平光（无硬边落影/强高光白斑），浅色衣物保持闭合深色外轮廓线；抠为 RGBA 透明底时务必同步清理发环、蝴蝶结、颈侧发隙与双鞋之间的闭合纯白背景孤岛。');
    lines.push('');
  }

  const modPromptBlocks = new Map();
  if (g.modMeta?.promptRules) {
    modPromptBlocks.set(g.modMeta.id || 'graph-mod', {
      name: g.modMeta.name || (isEn ? 'Template Mod' : '画布模板 Mod'),
      author: g.modMeta.author || '',
      rules: g.modMeta.promptRules,
    });
  }
  const activeModsList = Array.isArray(globalThis.__morphogemLoadedMods) ? globalThis.__morphogemLoadedMods : [];
  for (const t of targets) {
    if (t.params?.modId && !modPromptBlocks.has(t.params.modId)) {
      const matched = activeModsList.find(m => m.enabled && m.id === t.params.modId && m.promptRules);
      if (matched) {
        modPromptBlocks.set(matched.id, {name: matched.name, author: matched.author, rules: matched.promptRules});
      }
    }
  }
  if (modPromptBlocks.size > 0) {
    lines.push(isEn ? '### 🧩 Active Mod Custom Craft Rules (MUST Follow!)' : '### 🧩 已启用 Mod 专属拆图工艺规范（必须一并遵循！）');
    for (const block of modPromptBlocks.values()) {
      lines.push(`#### 📦 Mod: ${block.name}${block.author ? ` (${block.author})` : ''}`);
      lines.push(block.rules);
      lines.push('');
    }
  }

  const globalRatio = resolveGraphHeadBodyRatio(g);
  if (globalRatio) {
    const headPct = (100 / globalRatio).toFixed(1);
    const bodyUnits = Number(Math.max(0.5, globalRatio - 1).toFixed(2));
    const bodyPct = (100 - Number(headPct)).toFixed(1);
    if (isEn) {
      lines.push(`### 📏 HIGH-WEIGHT PARAMETRIC PROPORTION LOCK: **${globalRatio} Heads Tall (${globalRatio}H)**`);
      lines.push(`- **Mandatory Visual Ruler**: Read \`<directory>/work/graph_inputs/proportion_ruler_${globalRatio}H.png\` and pass it as a layout/proportion reference when generating full-body and torso/body views.`);
      lines.push(`- **Hard Anatomical Equation**: Total height = **${globalRatio} × Head Height** -> Head = **1.0H (${headPct}%)** | Neck + Torso + Legs combined = **ONLY ${bodyUnits}H (${bodyPct}%)**.`);
      if (globalRatio <= 3.5) {
        lines.push(`- **Chibi Re-Proportioning Override (CRITICAL)**: Override any tall limbs in the source concept art! For headless body/torso nodes, the entire neck-to-shoes height equals ONLY **${bodyUnits} head-units** — draw a compact rounded chibi torso, dramatically shortened chubby legs/arms, and plump hands/shoes so it never drifts back to a 6–7 head anime body!`);
      } else if (globalRatio <= 5.2) {
        lines.push(`- **Semi-Chibi Build**: Keep a compact **${bodyUnits}H** neck-to-shoes body length with slightly fuller, shorter limbs.`);
      } else {
        lines.push(`- **Slender Proportional Build**: Maintain an exact **${bodyUnits}H** neck-to-shoes vertical span with consistent shoulder-to-hip and torso-to-leg proportions.`);
      }
      lines.push('');
    } else {
      lines.push(`### 📏 最高权重参数化头身比强约束：**严格锁定 ${globalRatio} 头身 (${globalRatio}H)**`);
      lines.push(`- **必看正交分格标尺图**：\`export-inputs\` 已自动生成 \`<directory>/work/graph_inputs/proportion_ruler_${globalRatio}H.png\`，绘制全身三视图及无头身体/服装躯干节点时**必须读取并参照该分格标尺图**！`);
      lines.push(`- **硬性解剖比例公式**：角色全身总高 = **${globalRatio} 个头高** -> 头部占 **1.0H (${headPct}%)**，脖子+躯干+双腿总长严格等于 **${bodyUnits}H (${bodyPct}%)**。`);
      if (globalRatio <= 3.5) {
        lines.push(`- **Q版/盲盒比例强制改写（严禁沿用原画长腿！）**：即使主立绘是修长成女/少年，也必须彻底重塑为 **${globalRatio} 头身 Q版豆豆/粘土体型**！尤其在拆解「无头身体/服装躯干」节点时，无头身体从领口到鞋底总高度仅有 **${bodyUnits} 个头高**，必须大幅缩短大腿小腿与手臂长度、加粗圆润手脚与躯干长宽比，绝不可惯性画回 6~7 头身的修长素体！`);
      } else if (globalRatio <= 5.2) {
        lines.push(`- **轻Q版/半Q体型要求**：无头身体总长锁定为 **${bodyUnits} 个头高**，四肢适度缩短并保持灵动微圆润体块。`);
      } else {
        lines.push(`- **修长标准体型要求**：无头身体从领口至鞋底严格保持 **${bodyUnits} 个头高** 的修长肩胯与上下身比例。`);
      }
      lines.push('');
    }
  }

  targets.forEach((node, idx) => {
    const srcEdge = incomingEdges(g, node.id, 'source')[0];
    const maskEdge = incomingEdges(g, node.id, 'mask')[0];
    const styleEdge = incomingEdges(g, node.id, 'style')[0];
    const ratioEdge = incomingEdges(g, node.id, 'ratio')[0];
    const srcNode = srcEdge ? getNode(g, srcEdge.fromNode) : null;
    const maskNode = maskEdge ? getNode(g, maskEdge.fromNode) : null;
    const styleNode = styleEdge ? getNode(g, styleEdge.fromNode) : null;
    const ratioNode = ratioEdge ? getNode(g, ratioEdge.fromNode) : null;
    const effectiveNodeRatio = resolveNumericHeadBodyRatio(node.params?.headBodyRatio, node.params?.customHeadBodyRatio) || globalRatio;
    const hasMask = Boolean(maskNode?.data?.image || node.data?.maskImage);
    const maskMode = node.params?.maskMode || 'auto';
    const maskColor = node.params?.maskColor || '#ff3b30';

    const poseDesc = node.params?.pose === 'a'
      ? (isEn ? 'A-Pose (arms ~35°-45° downward, clear armpit/waist gaps)' : 'A-Pose（双臂斜向下约 35°~45° 对称张开，腋下与腰侧留足透明间隙）')
      : node.params?.pose === 't'
        ? (isEn ? 'T-Pose (arms 90° horizontal, clear gap between shoes)' : 'T-Pose（双臂水平 90° 展开，双脚微开留出鞋间间隙）')
        : (isEn ? 'Neutral Orthographic Upright Pose (90° vertical axis, zero perspective)' : '物件/局部自然正交标准姿态（主轴 90° 垂直端正、零透视）');
    const res = node.params?.resolution || 1024;
    const viewKeys = node.type === 'balance_views' ? GRAPH_VIEWS_3 : GRAPH_VIEWS_4;
    const craftRules = craftRulesForPart(node, isEn);
    const modCraftRules = Array.isArray(node.params?.modCraftRules) ? node.params.modCraftRules : [];

    if (isEn) {
      lines.push(`${idx + 1}. **Node ID**: \`${node.id}\` | **Target Component**: **"${node.params?.partName || 'Full-Body 3-View Guide'}"**${node.params?.modName ? ` *(Mod: ${node.params.modName})*` : ''}`);
      lines.push(`   - Output Views: ${viewKeys.map(k => `\`${k}\``).join(', ')} (${viewKeys.length} × \`${res}×${res}\` RGBA transparent PNGs)`);
      lines.push(`   - Pose Requirement: ${poseDesc}`);
      if (effectiveNodeRatio) {
        lines.push(`   - Locked Head-to-Body Ratio: **${effectiveNodeRatio}H** (reference \`<directory>/work/graph_inputs/proportion_ruler_${effectiveNodeRatio}H.png\`)`);
      }
      if (node.params?.promptHint) lines.push(`   - User Note: ${node.params.promptHint}`);
      if (hasMask) {
        const maskSrcLabel = maskNode
          ? `upstream Mask node \`${maskNode.id}\` (${maskNode.data?.image?.filename || 'mask'})`
          : `inline node Mask \`${node.id}_mask\` (${node.data?.maskImage?.filename || 'mask'})`;
        const modeExplain = maskMode === 'color'
          ? `Multi-Color ID Mask target color **\`${maskColor}\`**`
          : maskMode === 'alpha'
            ? 'Opaque Alpha pixels = target component'
            : maskMode === 'white'
              ? 'White foreground pixels = target component'
              : 'Auto-detected foreground mask region';
        lines.push(`   - 🎭 **MASK-GUIDED EXTRACTION CONTRACT (100% BOUNDARY PRIORITY)**:`);
        lines.push(`     * Mask Source: ${maskSrcLabel} | Mode: ${modeExplain}${maskNode?.params?.note ? ` | Legend: ${maskNode.params.note}` : ''}`);
        lines.push(`     * **MUST Inspect Composite Guide**: \`<directory>/work/graph_inputs/${node.id}_mask_overlay.png\` (target component is 100% bright inside the \`#00F0FF\` cyan contour; everything dimmed dark outside the mask MUST be excluded!).`);
        lines.push(`     * Reconstruct hidden inner/side/180°-back surfaces of ONLY this masked component cleanly with zero neighboring parts attached.`);
      }
      for (const rule of craftRules) lines.push(`   - 3D Part Rule: ${rule}`);
      for (const mRule of modCraftRules) lines.push(`   - 🧩 Mod Rule: ${mRule}`);
      lines.push(`   - Source Concept: \`${srcNode?.id || 'unconnected'}\` (${srcNode?.data?.image?.filename || 'none'})`);
      if (styleNode?.data?.image) {
        lines.push(`   - Style Reference: \`${styleNode.id}\` (${styleNode.data.image.filename}) — ${styleNode.params?.note || 'match linework & shading only'}`);
      }
      if (ratioNode?.data?.image) {
        lines.push(`   - Legacy Proportion Reference: \`${ratioNode.id}\` (${ratioNode.data.image.filename}) — ${ratioNode.params?.note || 'match head-to-body ratio only'}`);
      }
    } else {
      lines.push(`${idx + 1}. **节点 ID**: \`${node.id}\` | **目标拆出部件**: **「${node.params?.partName || '全身比例三视图'}」**${node.params?.modName ? ` *(来自 Mod: ${node.params.modName})*` : ''}`);
      lines.push(`   - 输出规格: ${viewKeys.map(k => `\`${k}\``).join(', ')}（共 ${viewKeys.length} 张 \`${res}×${res}\` 真实 RGBA 透明底 PNG）`);
      lines.push(`   - 姿态标准: ${poseDesc}`);
      if (effectiveNodeRatio) {
        lines.push(`   - 锁定头身比例: **严格执行 ${effectiveNodeRatio} 头身**（参照标尺图 \`<directory>/work/graph_inputs/proportion_ruler_${effectiveNodeRatio}H.png\`）`);
      }
      if (node.params?.promptHint) lines.push(`   - 用户补充要求: ${node.params.promptHint}`);
      if (hasMask) {
        const maskSrcLabel = maskNode
          ? `上游 Mask 节点 \`${maskNode.id}\` (${maskNode.data?.image?.filename || 'mask'})`
          : `本节点内嵌 Mask \`${node.id}_mask\` (${node.data?.maskImage?.filename || 'mask'})`;
        const modeExplain = maskMode === 'color'
          ? `多色 ID Mask 指定色块 **\`${maskColor}\`**`
          : maskMode === 'alpha'
            ? '不透明 Alpha 区域为目标部件'
            : maskMode === 'white'
              ? '白色高亮区域为目标部件'
              : '自动识别遮罩高亮前景';
        lines.push(`   - 🎭 **Mask 遮罩精准拆件强契约（最高边界优先级！）**:`);
        lines.push(`     * 遮罩来源: ${maskSrcLabel} | 识别规则: ${modeExplain}${maskNode?.params?.note ? ` | 分区说明: ${maskNode.params.note}` : ''}`);
        lines.push(`     * **必读高亮叠加引导图**: \`<directory>/work/graph_inputs/${node.id}_mask_overlay.png\`（图中 \`#00F0FF\` 青色轮廓线内 100% 正常亮度的区域即为本节点唯一要拆出的目标部件，外围压暗区域必须 100% 剔除剥离！）。`);
        lines.push(`     * 请严格仅提取该遮罩选区对应的独立部件，并按主立绘材质逻辑合理补全其在正/左/右/背视角下原本被其他部位遮挡的内部与背面闭环结构。`);
      }
      for (const rule of craftRules) lines.push(`   - 3D 拆件工艺要点: ${rule}`);
      for (const mRule of modCraftRules) lines.push(`   - 🧩 Mod 专属拆解规范: ${mRule}`);
      lines.push(`   - 主立绘输入: \`${srcNode?.id || '未连接'}\` (${srcNode?.data?.image?.filename || '未上传'})`);
      if (styleNode?.data?.image) {
        lines.push(`   - 画风参考输入: \`${styleNode.id}\` (${styleNode.data.image.filename}) — ${styleNode.params?.note || '严格对齐线条与上色质感，切勿混入其服饰发型'}`);
      } else {
        lines.push('   - 画风参考: 未单独连接，100% 保持主立绘的高完成度笔触与上色质感');
      }
      if (ratioNode?.data?.image) {
        lines.push(`   - 头身比参考输入: \`${ratioNode.id}\` (${ratioNode.data.image.filename}) — ${ratioNode.params?.note || '严格对齐头身比与四肢比例，切勿混入其外观设定'}`);
      }
    }
    lines.push('');
  });

  if (isEn) {
    lines.push('### Step 4: Run Mandatory Pixel-Exact Baseline Alignment (`align_views.py`)');
    lines.push('Run `align_views.py` on every node\'s raw views so all views share identical orthographic scale, `topY`, and `bottomY`:');
  } else {
    lines.push('### 第 4 步：强制执行像素级上下基准线对齐（必跑 `align_views.py`！）');
    lines.push('对每个视图节点的原始图运行对齐脚本，自动完成外围抠图、闭合白斑清理，并确保所有方向视图的 `topY` 与 `bottomY` 像素坐标严格一致：');
  }
  lines.push('```bash');
  for (const n of targets) {
    const res = n.params?.resolution || 1024;
    if (n.type === 'balance_views') {
      lines.push(`python "${alignScript}" --front "<directory>/work/${n.id}_raw_front.png" --side "<directory>/work/${n.id}_raw_side.png" --back "<directory>/work/${n.id}_raw_back.png" --out-dir "<directory>/images" --size ${res} --prefix "${n.id}"`);
    } else {
      lines.push(`python "${alignScript}" --front "<directory>/work/${n.id}_raw_front.png" --left "<directory>/work/${n.id}_raw_left.png" --right "<directory>/work/${n.id}_raw_right.png" --back "<directory>/work/${n.id}_raw_back.png" --out-dir "<directory>/images" --size ${res} --prefix "${n.id}"`);
    }
  }
  lines.push('```');
  lines.push('');

  if (isEn) {
    lines.push('### Step 5: Register Aligned PNGs into `.mgem` & Complete Session');
    lines.push('Write `<directory>/work/register-views.json`:');
  } else {
    lines.push('### 第 5 步：将对齐后的 PNG 写回 `.mgem` 节点并通知前端无损热刷新');
    lines.push('准备好 `<directory>/work/register-views.json`：');
  }
  lines.push('```json');
  lines.push(JSON.stringify({
    input: '<path>',
    nodes: targets.map(n => ({
      nodeId: n.id,
      views: Object.fromEntries(
        (n.type === 'balance_views' ? GRAPH_VIEWS_3 : GRAPH_VIEWS_4).map(k => [k, `<directory>/images/${n.id}-${k}.png`])
      ),
    })),
  }, null, 2));
  lines.push('```');
  lines.push(`node "${cliScript}" register-views "<directory>/work/register-views.json" "<path>"`);
  lines.push(`node "${sessionScript}" complete ${origin} ${request.id}`);
  lines.push('');
  if (isEn) {
    lines.push(`Progress update: node "${sessionScript}" progress ${origin} ${request.id} "Generating & aligning views..."`);
    lines.push(`Abort & unlock on error: node "${sessionScript}" fail ${origin} ${request.id} "Reason"`);
  } else {
    lines.push(`进度汇报：node "${sessionScript}" progress ${origin} ${request.id} "正在绘制/对齐某部件视图..."`);
    lines.push(`异常中止（务必调用以解锁节点）：node "${sessionScript}" fail ${origin} ${request.id} "失败原因"`);
  }

  return lines.join('\n');
}
