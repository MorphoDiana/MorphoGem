<div align="center">

<img src="docs/images/morphogem-banner.jpg" alt="MorphoGem Banner" width="100%" style="border-radius: 14px;" />

<br />

<img src="docs/images/morphogem-icon.png" alt="MorphoGem Icon" width="88" height="88" style="border-radius: 20px; margin-top: 12px;" />

# MorphoGem（蝶双星 · 节点式 3D 角色工坊）

**Visual Node-Graph 2D-to-3D Character & Prop Studio · `.mgmod` Community Mod Ecosystem · Silent Tripo MCP**

[![License: MIT](https://img.shields.io/badge/License-MIT-38bdf8.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/MorphoDiana/MorphoGem?color=10b981&label=Download%20Setup)](https://github.com/MorphoDiana/MorphoGem/releases)
[![Languages](https://img.shields.io/badge/UI%20%26%20Prompts-简体中文%20%7C%20English-a855f7)](README.md)

**[📥 前往 GitHub Releases 下载 Windows 安装包 (`MorphoGem-Setup-*.exe`)](https://github.com/MorphoDiana/MorphoGem/releases)**

</div>

---

## ✨ 项目简介 | Overview

**MorphoGem** 是由 **MorphoDiana × Gemini** 从零自研打造的 **MIT 开源可视化节点（Node-Graph）2D 转 3D 角色与道具创作工坊**。

不同于传统固定死板的分步表单，MorphoGem 将「多参考图输入 → AI 正交多视图拆解 → Tripo 逐部件独立参数 3D 建模 → Three.js 实时空间合体对位 → Blender 一键合并导出」彻底重构为自由连线的可视化节点蓝图，并原生支持 **`.mgmod` 社区节点与模板扩展包**。

**MorphoGem** is an **MIT-licensed**, clean-room visual **Node-Graph 2D-to-3D Character & Prop Studio**. Instead of rigid linear wizards, MorphoGem turns multi-reference concept art, AI orthographic 4-view part extraction, per-part Tripo 3D mesh generation, interactive Three.js 3D assembly, and Blender merged export (`FBX / GLB / Blend`) into a Blender-style node graph with a shareable **`.mgmod` Mod ecosystem**.

> 🌐 **语言支持 / Languages**: 界面与 AI 拆图指令支持 **简体中文 (`zh-CN`)** 与 **English (`en`)** 一键无缝切换。

---

## 🚀 核心特性 | Key Features

- **🕸️ Blender 级丝滑节点蓝图画布 (Interactive Node-Graph Canvas)**
  - 支持任意数量部件自由拆分（如：`无发裸头` + `独立双马尾` + `汉服躯干` + `悬浮星芒翅膀` + `专属法杖`），每个部件均可独立连接**主立绘**、**画风参考图**与**头身比参考图**，并独立配置 Tripo 面数上限（最高 500 万面）、4K/8K 贴图与去高光参数。
  - 完整快捷键交互：`Space` / `Shift+A` 浮动搜索秒加节点与分支、拖线到空白处松手自动过滤建节点并连线、`Alt + 左键划过` 小刀切断连线、`Shift+D` 克隆分支、`G` 抓取移动、`B` 框选、`Del / X` 删除、`Ctrl+Z / Ctrl+Y` 撤销重做。
  - **局部执行节点锁 (Granular Node Locking)**：AI 拆图或 Tripo 建模期间，仅关联节点进入保护锁定，画布上其他无关分支依然可自由增删改连，任务完成后无损增量合并回画布！

- **🧩 `.mgmod` 社区节点与模板 Mod 生态 (Community Mod System)**
  - 支持将整图节点拓扑、专属拆分分支以及 `prompt-rules.md` 独门 AI 拆图工艺规则一键打包为单个 `.mgmod` 文件分享交流。
  - 内置两款官方示例 Mod：**Q版盲盒潮玩手办拆件包 (`chibi-blindbox-kit`)** 与 **机娘武装与奇幻羽翼武器库 (`mecha-fantasy-arsenal`)**。

- **🤖 原创 3D 拆件技能矩阵与像素级对齐 (`skills/` & `align_views.py`)**
  - 内置原创三大核心技能规范：[`morphogem-orthographic-views`](skills/morphogem-orthographic-views/SKILL.md)、[`morphogem-albedo-shading`](skills/morphogem-albedo-shading/SKILL.md)、[`morphogem-alpha-alignment`](skills/morphogem-alpha-alignment/SKILL.md)，配合自研 [`scripts/align_views.py`](scripts/align_views.py) 自动清理闭合纯白内孔并对齐四视图 `topY / bottomY` 像素基准线。

- **⚡ 内置静默 Tripo Studio 工作区与 MCP 守护 (`tripo_mcp`)**
  - 桌面端内置独立持久登录态的 Tripo Web 视图与 9 个标准 MCP 工具，无需外部 Chrome 远程调试弹窗，不抢占鼠标焦点，支持卡片一键直跑 3D 节点。

- **🧍 纯 Three.js 3D 合体对位视口与安全升级架构**
  - 支持正交多视角（正/左/右/背/顶）与自由透视相机、三视图半透明比例垫图、总身高（米）等比校准，以及调用本机 Blender（推荐 4.2 ~ 5.2）一键合并导出 `FBX + GLB + Blend`（支持标准 PBR 与 Anime Toon 赛璐璐着色器）。
  - Windows NSIS 安装向导自动将 `Projects/`、`Exports/`、`Mods/`、`userdata/` 隔离保护，客户端通过 GitHub Releases 在线升级或卸载时**绝不丢失任何用户工程、Mod 与登录态**。

---

## 📦 安装与快速上手 | Installation & Quick Start

### 方式一：下载 Windows 客户端安装包（推荐 / Recommended）

1. 前往 **[GitHub Releases](https://github.com/MorphoDiana/MorphoGem/releases)** 下载最新版本的 `MorphoGem-Setup-*.exe` 并安装（可自由选择安装盘符与目录）。
2. 启动 `MorphoGem`，首次使用时：
   - 点击顶部栏 **`[Tripo 账号工作区]`** 登录一次你的 Tripo Studio 账号（Cookie 自动持久保存在本地 `userdata/`）。
   - 如需使用最终多部件合并导出功能，点击顶栏或右上角 **`⚙ 设置 / Settings`** 指定本机安装的 `blender.exe` 路径（支持一键自动扫描常见安装位置）。

### 方式二：源码运行（开发者 / From Source）

> 仓库中不提交任何 `.exe` 二进制包，所有安装包均通过 GitHub Actions 自动构建并发布至 Releases。

```bash
# 环境要求 / Prerequisites: Node.js >= 22, Python 3 + Pillow (for align_views.py), Blender >= 4.2 (optional, for merged export)

# 1. 启动本地 Web 工作台 (http://127.0.0.1:8766)
npm start

# 2. 启动 Electron 桌面整合端（先安装依赖）
cd tripo_mcp && npm ci && cd ..
cd desktop && npm ci && cd ..
npm run desktop

# 3. 运行自动化冒烟测试
npm test
npm run desktop:smoke
```

---

## 🗂️ 仓库目录结构 | Repository Structure

```text
MorphoGem/
├── public/                 # 纯自研前端：统一工作台、节点蓝图画布、Three.js 3D 合体视口、.mgem 归档与中英双语模块
├── desktop/                # Electron 桌面外壳、GitHub 自动更新器与安全保留用户数据的 NSIS 安装脚本
├── builtin-mods/           # 官方内置 .mgmod 示例扩展包（Q版盲盒潮玩包 / 机娘奇幻武装包）
├── skills/                 # 原创 MorphoGem AI 正交拆件、纯净固有色光影与透明对齐技能矩阵
├── scripts/                # mgem-session.mjs 会话锁 CLI、node-graph-cli.mjs、align_views.py 与 Blender 合并导出脚本
├── tripo_mcp/              # 静默后台 Tripo Studio MCP Server & CLI（9 个自动化 3D 工具）
├── server*.mjs             # 本地零外部重依赖 HTTP 服务、Mod 热加载引擎与节点直跑路由
└── .github/workflows/      # v* 标签自动打包 Windows NSIS 安装包并发布至 GitHub Releases
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
