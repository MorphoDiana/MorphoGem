# MorphoGem — Agent Global Workflow Guide (中文 / English)

**MorphoGem** is an open-source (MIT) visual **Node-Graph 2D-to-3D Character & Prop Studio** created by **MorphoDiana × Gemini**. It combines arbitrary node-based multi-reference part decomposition, community `.mgmod` extensions, an embedded silent Tripo Studio MCP daemon, and Three.js / Blender multi-part assembly export.

> **Supported Languages**: Simplified Chinese (`zh-CN`) and English (`en`) ONLY. Always reply to the user in the language requested by the prompt (`zh-CN` or `en`).

---

## 1. Core Architecture & File Formats

- **`.mgem` Project Archive**: Standard ZIP store archive containing `project.json` (`format: "morphogem-project"`, `version: 2`) and content-addressed binary blobs under `documents/node-graph/*` (PNG/JPG/WebP references, aligned RGBA multi-view PNGs, FBX meshes, and textures).
- **`.mgmod` Community Mod Package**: Distributable Mod archive loaded from `builtin-mods/` and `<InstallDir>/Mods/`, providing custom whole-graph templates, `Space`-menu branch presets, and specialized AI craft rules (`prompt-rules.md`).
- **User Data Safety**: User projects (`Projects/`), merged 3D exports (`Exports/`), community mods (`Mods/`), and login sessions (`userdata/`) are isolated from application code and preserved across client upgrades and uninstallations.

---

## 2. Standard AI Multi-View Decomposition Protocol

When the user pastes a MorphoGem AI decomposition prompt into your chat:

1. **Read Required MorphoGem Skills First**:
   - [`skills/morphogem-orthographic-views/SKILL.md`](skills/morphogem-orthographic-views/SKILL.md) — Reference separation (`source_image` vs `style_ref` vs `ratio_ref`), zero-perspective orthographic camera rules, `front -> left / right / back` mirror laws, and watertight 3D part isolation contracts.
   - [`skills/morphogem-albedo-shading/SKILL.md`](skills/morphogem-albedo-shading/SKILL.md) — Uniform 360° ambient lighting, zero cast shadows, closed outer contours on white garments, and pure albedo painting.
   - [`skills/morphogem-alpha-alignment/SKILL.md`](skills/morphogem-alpha-alignment/SKILL.md) — Interior enclosed white-pocket cutout checklist, pixel-exact vertical baseline alignment, and granular node lock safety.
2. **Begin Session (`saved: true`)**:
   ```bash
   node "<MorphoGemRoot>/scripts/mgem-session.mjs" begin <origin> <requestId>
   ```
3. **Export & Visually Inspect Reference Images**:
   ```bash
   node "<MorphoGemRoot>/scripts/node-graph-cli.mjs" export-inputs "<path>" "<directory>/work/graph_inputs"
   ```
4. **Generate & Align RGBA Orthographic PNGs**:
   - Generate `front` first as the master design & scale anchor, then derive `left` (`<--`), `right` (`-->`), and horizontally mirrored `back`.
   - Always run [`scripts/align_views.py`](scripts/align_views.py) so all views share identical `topY` and `bottomY` pixel coordinates and clean interior alpha holes.
5. **Register Views & Complete Session (or Unlock on Failure)**:
   ```bash
   node "<MorphoGemRoot>/scripts/node-graph-cli.mjs" register-views "<directory>/work/register-views.json" "<path>"
   node "<MorphoGemRoot>/scripts/mgem-session.mjs" complete <origin> <requestId>
   ```
   - On any error or early pause, ALWAYS run `node "<MorphoGemRoot>/scripts/mgem-session.mjs" fail <origin> <requestId> "<reason>"` to unlock the user's canvas nodes!

---

## 3. Built-in Silent Tripo Studio MCP (`tripo_mcp`)

Users can either click **`▶ Run Tripo 3D Nodes`** directly on the MorphoGem canvas, or connect external AI Agents via [`tripo_mcp/server.mjs`](tripo_mcp/server.mjs) (9 MCP tools: `tripo_status`, `tripo_generate`, `tripo_wait`, `tripo_export`, `tripo_generate_and_export`, `tripo_upload_model`, `tripo_segment`, `tripo_retexture`, `tripo_rig`). See [`tripo_mcp/README.md`](tripo_mcp/README.md) for CLI and MCP configuration details.
