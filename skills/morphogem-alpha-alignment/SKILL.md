---
name: morphogem-alpha-alignment
description: MorphoGem 透明通道内孔镂空检查、像素级上下基准线对齐与局部节点锁 CLI 协作协议
---

# MorphoGem 透明通道镂空、像素对齐与会话锁协议

本规范确保 AI 生成的多方向 PNG 在写回 `.mgem` 节点蓝图前满足像素级几何对齐，并正确配合 MorphoGem 的局部节点锁定机制。

## 1. RGBA 透明底与「闭合内孔白斑」必查清单

将多方向视图转为 RGBA 透明底 PNG 时，单纯从画布四边泛洪抠图往往会漏掉被角色线条闭合包围的内部背景区域。落盘前必须逐张检查以下高频死角：

1. **发型与头饰孔洞**：环形发髻中心、呆毛卷曲闭环、蝴蝶结丝带镂空处、耳侧垂发与脸颊/脖颈之间的三角形空隙。
2. **肢体与服装间隙**：A-Pose 手臂与腰侧之间、宽大汉服/法师袖摆内侧、双腿与两只鞋靴之间的细缝。
3. **武器护手与法杖镂空**：剑柄护手环孔、悬浮星芒与主杖身之间的间隙。

> 注意：镂空内部背景孤岛时切勿误伤眼白（巩膜）、牙齿或带有闭合线稿的纯白衣领。

## 2. 强制运行 `align_views.py` 对齐上下像素基准线

Tripo 多视图重建要求同一部件的 `front / left / right / back` 在统一正方形画布（`1024×1024` 或 `2048×2048`）上具有完全一致的正交比例与头顶 `topY` / 底部 `bottomY` 像素坐标。请务必调用内置对齐脚本自动完成外围抠图、闭合白斑清理与等高居中对齐：

```bash
python "<MorphoGemRoot>/scripts/align_views.py" \
  --front "<directory>/work/<nodeId>_raw_front.png" \
  --left  "<directory>/work/<nodeId>_raw_left.png" \
  --right "<directory>/work/<nodeId>_raw_right.png" \
  --back  "<directory>/work/<nodeId>_raw_back.png" \
  --out-dir "<directory>/images" \
  --size 1024 \
  --prefix "<nodeId>"
```

检查脚本输出的 JSON 中四张图的 `topY` 与 `bottomY` 是否一致（允许抗锯齿半透明边缘 `≤ 2px` 误差）。

## 3. 局部节点锁与无损写回生命周期

当用户在 MorphoGem 画布点击「复制 AI 拆图指令」时，仅目标视图节点及其直接上游参考图节点处于锁定保护状态，**用户在你绘图期间仍可能在画布上自由编辑其他无关节点**。请严格遵守以下 CLI 顺序：

1. **启动会话**：`node "<MorphoGemRoot>/scripts/mgem-session.mjs" begin <origin> <requestId>`，确认返回 `"saved": true` 并读取最新的 `path`（`project.mgem`）与 `directory`。
2. **汇报进度**：每完成一个关键阶段可调用 `progress` 更新画布横幅提示。
3. **注册视图并完成**：调用 `node "<MorphoGemRoot>/scripts/node-graph-cli.mjs" register-views "<directory>/work/register-views.json" "<path>"`，随后立即调用 `complete`。前端会自动仅合并目标节点的新视图并解锁，绝不覆盖用户在其他节点上的并行修改。
4. **异常解锁兜底**：若遇到任何中断或需要向用户提问确认，退前务必执行 `node "<MorphoGemRoot>/scripts/mgem-session.mjs" fail <origin> <requestId> "<原因>"` 立即释放画布节点锁！
