<div align="center">

<img src="docs/images/morphogem-banner.jpg" alt="MorphoGem Banner" width="100%" style="border-radius: 14px;" />

<br />

<img src="docs/images/morphogem-icon.png" alt="MorphoGem Icon" width="88" height="88" style="border-radius: 20px; margin-top: 12px;" />

# MorphoGem（蝶双星 · 节点式 3D 角色工坊）

**Visual Node-Graph 2D-to-3D Character & Prop Studio · `.mgmod` Community Mod Ecosystem · Silent Tripo MCP**

[![License: MIT](https://img.shields.io/badge/License-MIT-38bdf8.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/MorphoDiana/MorphoGem?color=10b981&label=Download%20Setup)](https://github.com/MorphoDiana/MorphoGem/releases)
[![Recommended Agent](https://img.shields.io/badge/Recommended%20Agent-Google%20Antigravity%20(Neon%20%2F%20Carbon)-f59e0b)](docs/TUTORIAL.zh-CN.md)
[![Languages](https://img.shields.io/badge/UI%20%26%20Prompts-简体中文%20%7C%20English-a855f7)](docs/TUTORIAL.en.md)

**[📥 下载 Windows 安装包 (`MorphoGem-Setup-*.exe`)](https://github.com/MorphoDiana/MorphoGem/releases)** · **[📖 中文保姆级完整教程](docs/TUTORIAL.zh-CN.md)** · **[📖 Full English Tutorial](docs/TUTORIAL.en.md)**

</div>

---

## ✨ 项目简介 | Overview

**MorphoGem** 是由 **MorphoDiana × Gemini** 从零自研打造的 **MIT 开源可视化节点（Node-Graph）2D 转 3D 角色与道具创作工坊**。

不同于传统固定死板的分步表单，MorphoGem 将「多参考图输入 → AI 正交多视图拆解 → Tripo 逐部件独立参数 3D 建模 / Smart UV 重展开上色 → Three.js 实时空间合体对位 → Blender 一键合并导出」彻底重构为自由连线的可视化节点蓝图，并原生支持 **`.mgmod` 社区节点与模板扩展包**。

**MorphoGem** is an **MIT-licensed**, clean-room visual **Node-Graph 2D-to-3D Character & Prop Studio**. Instead of rigid linear wizards, MorphoGem turns multi-reference concept art, AI orthographic 4-view part extraction, per-part Tripo HD / Smart-Mesh + Smart-UV Retexture generation, interactive Three.js 3D assembly, and Blender merged export (`FBX / GLB / Blend`) into a Blender-style node graph with a shareable **`.mgmod` Mod ecosystem**.

> 🌐 **语言支持 / Languages**: 界面与 AI 拆图指令支持 **简体中文 (`zh-CN`)** 与 **English (`en`)** 一键无缝切换。

---

## 🧭 保姆级快速上手（5 分钟跑通！）| Quick Start Tutorial

> 📌 **详细图文与进阶技巧请查阅**：**[📖 中文完整教程 (TUTORIAL.zh-CN.md)](docs/TUTORIAL.zh-CN.md)** | **[📖 English Guide (TUTORIAL.en.md)](docs/TUTORIAL.en.md)**

### 🌟 最佳 AI 搭档推荐 | Recommended AI Agent
目前我们**最优先推荐使用 [Google Antigravity（谷歌反重力）](https://antigravity.google/)**，并在模型列表中选择 **`Neon`** 或 **`Carbon`** 模型！它们在多模态立绘细节拆解、正交四视图高一致性绘制以及本地自动化脚本执行上表现最佳。（同时兼容 Claude Code / Cursor / Codex 等支持生图与终端的 Agent；本机建议预装 `pip install pillow` 供自动像素对齐脚本使用。）

*We strongly recommend **[Google Antigravity](https://antigravity.google/)** using the **`Neon`** or **`Carbon`** model for the best multi-view consistency and seamless tool execution.*

### 第 1 步：安装后首次初始化（只做一次！）| One-Time Setup
1. **下载安装**：从 **[GitHub Releases](https://github.com/MorphoDiana/MorphoGem/releases)** 下载 `MorphoGem-Setup-*.exe` 双击安装并启动。
2. **先复制 Agent 配置交给 AI 安装（关键！）**：
   点击客户端最顶栏右侧的 **`[复制 Agent 配置]`** 按钮 → 打开 **Google Antigravity（切到 `Neon` 或 `Carbon`）**，直接发给它：
   > `请帮我把下面这段 MorphoGem 的 MCP 配置安装写入到我的 MCP 配置文件里：` + `Ctrl+V` 粘贴刚刚复制的 JSON！
3. **登录一次 Tripo & 绑定 Blender**：
   - 点击顶栏左上角 **`[Tripo 账号工作区]`** 登录一次邮箱账号（Cookie 自动持久保存在本地 `userdata/`，后续免登），再切回 **`[节点角色工坊]`**。
   - 点击顶栏 **`⚠ 点击配置 Blender 路径`**（或右上角 `⚙ 设置` → `自动扫描`）选中本机安装的 `blender.exe`（推荐 Blender 4.2 ~ 5.2）。

### 第 2 步：选模板、锁头身比 & 传原画 / Mask | Pick Template, Ratio & Mask
- 在画布左上角**模板下拉框**选择预设模板（选中即刻切换，如 `精细角色拆分`、`豪华多件复合`、`Mask 遮罩精准拆件` 或内置 Mod `Q版盲盒三件套`），也可以按 **`Space` 键**搜索添加任意节点或专属分支。
- **📏 参数化头身比强约束**：在顶部工具栏直接选择目标头身比（如 `2.0` 粘土豆豆人、`2.5` 潮玩盲盒、`3.0` Q版小人、`6.8` 二次元标准、`7.5` 修长成女或自定义数值），系统自动生成正交分格标尺图并同步驱动 3D 视口头身缩放，权重远高于传统参考图！
- **🎭 Mask 图精准拆件**：在左侧 **`主立绘`** 节点上传角色原画；支持通过 **`🎭 Mask 分区遮罩图`** 节点连线或直接在拆图节点卡片内拖入黑白遮罩 / 透明蒙版 / 多色 ID 图（自带 **`💧 图上吸色`** 拾色器），自动合成青色轮廓高亮引导图实现零歧义拆件！

### 第 3 步：复制拆图指令发给反重力 (`Neon` / `Carbon`) | AI 4-View Decomposition
- 点击工具栏蓝色的 **`✨ 复制 AI 拆图指令`**（此时关联节点自动进入 `🔒 锁定` 保护，画布其余分支仍可自由编辑）。
- 切换到 **Google Antigravity（`Neon` / `Carbon`）** 直接粘贴发送！AI 会自动读取内置 3D 拆件 Skill、生成无遮挡的正/左/右/背透明底四视图、运行 `align_views.py` 挖空闭合白斑并对齐上下像素基准线，完成后**自动无损热刷新回你的画布节点并解锁**！

### 第 4 步：一键直跑 3D 建模 & Smart UV 重展开上色 | Generate 3D & Smart UV
- 头发/复杂衣裙可选 **`高精度 HD (H3.5 · 最高500万面)`**；武器道具或规整四边面低模可切换为 **`Smart 智能拓扑 (P2.0)`**（默认自动开启 **`☑ 重展开 Smart UV`** + **`☑ 四视图自动上色 Retexture`**，也可按 `Space` 添加独立的 **`🎨 UV 重展开与贴图上色`** 节点实现一模多皮换色！）。
- 点击 **`▶ 一键直跑 3D 节点`**，客户端自动在后台完成建模、UV 展开、贴图烘焙并入库。

### 第 5 步：3D 合体对位 & 导出最终资产 | 3D Assembly & Export
- 切换到顶栏中央的 **`🧍 3D 合体对位视口`**，用正交相机与三视图比例垫图微调部件位置、输入目标总身高（米）一键等比贴地校准，选择 **`PBR`** 或 **`Anime Toon`** 着色器，点击 **`📦 合并导出最终模型 (FBX + GLB + Blend)`**！

---

## 🚀 核心特性亮点 | Key Highlights

- **🔍 四视图同屏并排检视 & 像素对齐激光线**：点击任意拆图槽位或 **`🔍 同屏展开四视图对比`** 即可一次并排展开 `正 / 左 / 右 / 背` 全部大图，自带头顶/脚底像素水平对齐激光参考线与 `棋盘格 / 纯黑 / 纯白 / 品红检白边` 一键切换底色。
- **🕸️ Blender 级丝滑节点画布**：`Space / Shift+A` 浮动搜索、拖线到空白处松手自动过滤建节点、`Alt + 左键划过` 小刀切线、`Shift+D` 克隆、`G` 抓取、`B` 框选、`Del / X` 删除、`Ctrl+Z / Y` 撤销重做，配合**局部执行节点锁**实现边跑边改。
- **🧩 `.mgmod` 社区 Mod 扩展生态**：支持直接拖拽 `.mgmod` 入画布安装，也可通过工具栏 **`🧩 Mod`** 将你的整图模板、专属分支与独门 AI 拆图规则一键打包分享。内置 `chibi-blindbox-kit`（Q版盲盒手办包）与 `mecha-fantasy-arsenal`（幻想武装羽翼包）。
- **🤖 原创 3D 拆件技能矩阵 (`skills/`)**：包含 [`morphogem-orthographic-views`](skills/morphogem-orthographic-views/SKILL.md)、[`morphogem-albedo-shading`](skills/morphogem-albedo-shading/SKILL.md)、[`morphogem-alpha-alignment`](skills/morphogem-alpha-alignment/SKILL.md) 与自研像素级对齐脚本 [`scripts/align_views.py`](scripts/align_views.py)。
- **🛡️ 无损覆盖升级架构**：Windows 安装包与 `🔄 检查更新` 在线增量更新自动保护 `<InstallDir>` 下的 `Projects/`、`Exports/`、`Mods/` 与 `userdata/` 目录，升级或卸载绝不丢工程与登录态。

---

## 💻 开发者源码运行 | Run From Source

> 仓库严禁提交任何 `.exe` 二进制文件，所有发行安装包均由 GitHub Actions 自动构建发布至 Releases。

```bash
# Prerequisites: Node.js >= 22, Python 3 + Pillow, Blender >= 4.2 (optional for merged export)
npm start                  # 启动本地 Web 工作台 (http://127.0.0.1:8766)

# 启动完整 Electron 桌面端
cd tripo_mcp && npm ci && cd ..
cd desktop && npm ci && cd ..
npm run desktop

# 运行自动化冒烟校验
npm test
npm run desktop:smoke
```

---

## 💖 致谢与鸣谢 | Credits & Acknowledgments

- **🎨 角色形象插画鸣谢 (`ZipZipPipe`)**
  项目横幅介绍图与 Q 版应用图标基于画师 **ZipZipPipe** 创作的 Gemini 二次元同人形象结合蓝色闪蝶（Morpho）元素衍生设计，特此致以诚挚感谢！
  *(Character banner & chibi icon adapted with blue morpho butterfly motifs from the Gemini anime fan-art originally illustrated by **ZipZipPipe**.)*

- **💡 工作流思路启发致谢 (`Charakuru`)**
  特别感谢 **Charakuru** 项目在「AI Agent 协同辅助 2D 立绘转 3D 角色创作」方向上带来的早期工作流思路启发！MorphoGem 在此启发之上，采用全自研的节点蓝图（Node-Graph）架构、`.mgem` 工程容器、`.mgmod` 社区扩展生态与原创技能体系进行了独立洁净室构建。
  *(Special thanks to the **Charakuru** project for early workflow inspiration around AI-agent-assisted 2D-to-3D character creation. MorphoGem is an independent clean-room implementation built around a visual Node-Graph architecture, `.mgem` archives, and the `.mgmod` Mod ecosystem.)*

---

## 📄 开源协议 | License

本项目基于 **[MIT License](LICENSE)** 开源发布。第三方开源依赖声明详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
