# MorphoGem — Claude Code & Cross-Agent Entrypoint

Welcome to **MorphoGem** (MIT Open-Source Node-Based 2D-to-3D Character & Prop Studio).
Supported UI and prompt languages: **Simplified Chinese (`zh-CN`)** and **English (`en`)**.

Before processing a user's MorphoGem prompt, read in order:

1. **[Global Agent Workflow Guide (`AGENTS.md`)](AGENTS.md)** — `.mgem` archive contract, granular node lock lifecycle, and CLI workflow.
2. **Core MorphoGem Skills**:
   - [`skills/morphogem-orthographic-views/SKILL.md`](skills/morphogem-orthographic-views/SKILL.md) — Orthographic multi-view projection, mirror geometry, and 3D part isolation contracts.
   - [`skills/morphogem-albedo-shading/SKILL.md`](skills/morphogem-albedo-shading/SKILL.md) — Pure albedo coloring, ambient flat lighting, and closed outer linework on pale garments.
   - [`skills/morphogem-alpha-alignment/SKILL.md`](skills/morphogem-alpha-alignment/SKILL.md) — Interior white-pocket cutout hygiene, `scripts/align_views.py` pixel baseline lock, and `scripts/mgem-session.mjs` session protocol.
3. **CLI & MCP Utilities**:
   - Session sync & node lock control: [`scripts/mgem-session.mjs`](scripts/mgem-session.mjs)
   - Node-Graph asset I/O: [`scripts/node-graph-cli.mjs`](scripts/node-graph-cli.mjs)
   - Orthographic PNG alpha & baseline aligner: [`scripts/align_views.py`](scripts/align_views.py)
   - Silent Tripo Studio MCP & CLI: [`tripo_mcp/README.md`](tripo_mcp/README.md)
