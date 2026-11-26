# MorphoGem Tripo Studio MCP (`tripo_mcp`)

将 Tripo Studio 网页端的高频建模操作封装为**确定性高层 MCP 工具与持久守护 CLI**，既可在 `MorphoGem.exe` 桌面端内静默嵌入直跑，也可在外部桌面 Chrome（通过 `DevToolsActivePort` / CDP）复用已登录会话，直接消耗网页订阅积分，无需反复抓取大体积 DOM 快照。

## 特性与安全边界

- **`MorphoGem.exe` 内置静默守护优先 + 桌面 Chrome 兼容**：在桌面端运行时自动挂载内置 `persist:tripo` 视图与 `.daemon-state.json`；独立运行时优先直连 `http://127.0.0.1:9222/json/version` 或回退读取 `DevToolsActivePort`。
- **零 Token 静默轮询与自动校验解压**：`tripo_generate` / `tripo_wait` 在本地后台静默轮询进度；`tripo_export` 精准选择 `FBX`（`Blender` 预设），内置 3 次自愈重试与二次校验（防格式误切），校验 FBX 二进制文件头（`Kaydara FBX Binary` 7.1–7.x）与 SHA-256，安全解压 `.zip` 内的 `.fbx` 与 `.fbm/*` 贴图并输出 `download-record.json`。
- **操作期防误触硬锁定（UI Input Shield）**：在实际点击配置控件期间自动注入防误触锁屏层，吞掉人工误滚轮与误点，点击动作一结束立即自动解锁。
- **合规安全门禁**：遇到未登录或人机验证页面时立即返回 `[BLOCKED]` 状态并提示人工在 `Tripo 账号工作区` 处理，绝不尝试自动点击绕过或触发任何充值按钮。

---

## 1. MCP Server 配置

点击 `MorphoGem.exe` 窗口右上角 **`[复制 Agent 配置]`** 可直接获取本机即用配置；或在 `~/.gemini/config/mcp_config.json` 中配置：

```json
{
  "mcpServers": {
    "tripo-studio": {
      "command": "node",
      "args": ["E:\\Ai_Tripo\\MorphoGem\\tripo_mcp\\server.mjs"]
    }
  }
}
```

---

## 2. CLI 模式

```bash
# 查看状态与积分
node "E:/Ai_Tripo/MorphoGem/tripo_mcp/cli.mjs" status

# 一键四视图生成 1 个 500 万面高精度候选并直接导出解压
node "E:/Ai_Tripo/MorphoGem/tripo_mcp/cli.mjs" generate_and_export \
  --front ".../front.png" \
  --left ".../left.png" \
  --right ".../right.png" \
  --back ".../back.png" \
  --smart-mesh false \
  --ai-model H3.5 \
  --polycount 5000000 \
  --ultra-mesh true \
  --texture-quality 4K \
  --pbr true \
  --remove-lighting false \
  --count 1 \
  --output-dir ".../out" \
  --subdirs part-c1
```
