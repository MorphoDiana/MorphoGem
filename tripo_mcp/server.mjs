#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TripoController } from './src/tripo-controller.mjs';
import { runSegmentation, runRetexture, runRigging } from './src/tripo-postprocess.mjs';
import { DAEMON_STATE_FILE } from './daemon.mjs';

async function tryDaemonRpc(action, params) {
  let state;
  try {
    state = JSON.parse(await fs.readFile(DAEMON_STATE_FILE, 'utf8'));
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ action, params }), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: state.port,
        path: '/rpc',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-tripo-token': state.token },
        timeout: 20 * 60 * 1000,
      },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode === 200 && parsed.ok) resolve({ ok: true, result: parsed.result });
            else if (res.statusCode === 500 && parsed.error) resolve({ ok: false, error: new Error(parsed.error) });
            else resolve(undefined);
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.write(data);
    req.end();
  });
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ws-endpoint' && argv[i + 1]) opts.wsEndpoint = argv[++i];
    else if (arg.startsWith('--ws-endpoint=')) opts.wsEndpoint = arg.slice('--ws-endpoint='.length);
    else if (arg === '--browser-url' && argv[i + 1]) opts.browserURL = argv[++i];
    else if (arg.startsWith('--browser-url=')) opts.browserURL = arg.slice('--browser-url='.length);
  }
  return opts;
}

const controller = new TripoController(parseCliArgs(process.argv.slice(2)));

const server = new McpServer({
  name: 'tripo-studio',
  version: '1.0.0',
});

function jsonResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: err?.message || String(err) }],
  };
}

function wrapTool(action, handler) {
  return async (args) => {
    try {
      const viaDaemon = await tryDaemonRpc(action, args);
      if (viaDaemon) {
        if (!viaDaemon.ok) return errorResult(viaDaemon.error);
        return jsonResult(viaDaemon.result);
      }
      return jsonResult(await handler(args));
    } catch (err) {
      return errorResult(err);
    }
  };
}

server.tool(
  'tripo_status',
  '检查桌面 Chrome 或 MorphoGem 内置视图中 Tripo Studio 的连接状态、登录状态、剩余积分、当前模型设置及最近生成的资产列表（不会改动或刷新本地 MorphoGem 应用标签页）。',
  {
    screenshotPath: z.string().optional().describe('可选：保存当前 Tripo 视口截图的绝对路径'),
  },
  wrapTool('status', args => controller.status(args))
);

server.tool(
  'tripo_generate',
  '在桌面 Chrome 已登录的 Tripo Studio 中一键完成四方向多视图（Front/Left/Right/Back）或单图参数设置、旧图清理、图片上传与候选模型提交（支持并发提交 1~4 个候选，可选本地静默等待完成而无需消耗大模型轮次）。',
  {
    mode: z.enum(['multiview', 'single']).default('multiview').describe('生成输入模式：multiview（四视图）或 single（单图）'),
    front: z.string().optional().describe('正视图 PNG 绝对路径（multiview 必填）'),
    left: z.string().optional().describe('左视图 PNG 绝对路径（角色/物件自身左侧，multiview 必填）'),
    right: z.string().optional().describe('右视图 PNG 绝对路径（角色/物件自身右侧，multiview 必填）'),
    back: z.string().optional().describe('背视图 PNG 绝对路径（multiview 必填）'),
    image: z.string().optional().describe('单图模式下的图片绝对路径'),
    smartMesh: z.boolean().default(false).describe('false = HD Model 高精度网格模式（最高 500 万面）；true = 智能网格 Smart Mesh（P2.0，默认 Quad 四边面 500~25,000 面，可选 Triangle 三角面 500~50,000 面）'),
    aiModel: z.string().optional().describe('AI 模型版本，如 "H3.5"、"H3.1"、"P2.0"（默认：HD 模式用 H3.5，Smart Mesh 用 P2.0）'),
    ultraMesh: z.boolean().optional().describe('是否启用 Ultra Mesh Quality 超高精度网格（HD 模式默认 true）'),
    texture: z.boolean().default(true).describe('是否生成贴图（默认 true）'),
    textureQuality: z.enum(['2K', '4K', '8K']).default('4K').describe('贴图分辨率（默认 4K，可选 8K）'),
    pbr: z.boolean().default(true).describe('是否启用 PBR 材质贴图（默认 true）'),
    removeLighting: z.boolean().default(false).describe('是否启用 Remove Lighting 去光影（MorphoGem 默认 false）'),
    topology: z.enum(['Triangle', 'Quad']).optional().describe('网格拓扑：Quad（智能网格默认四边面）或 Triangle（三角面）'),
    polycount: z.number().int().optional().describe('最大面数上限（HD 模式 500~5,000,000 默认 500 万面；智能网格 Quad 500~25,000 / Triangle 500~50,000 默认 25,000）'),
    generateInParts: z.boolean().default(false).describe('是否开启 Generate in Parts（默认 false）'),
    count: z.number().int().min(1).max(4).default(1).describe('连续提交生成的候选数量（1~4）'),
    wait: z.boolean().default(true).describe('是否在本地静默轮询直至全部候选模型构建完成（默认 true）'),
    pollIntervalMs: z.number().int().min(2000).default(6000).describe('等待轮询间隔毫秒数'),
    timeoutMs: z.number().int().min(30000).default(600000).describe('等待完成的最大超时毫秒数（默认 10 分钟）'),
    screenshotDir: z.string().optional().describe('可选：生成完成后保存每个候选视口截图的目录路径'),
  },
  wrapTool('generate', args => controller.generate(args))
);

server.tool(
  'tripo_wait',
  '在本地静默等待指定的 Tripo 任务 modelIds 全部生成完成（零大模型 Token 消耗），返回各模型的面数、顶点数与可选视口预览截图。',
  {
    modelIds: z.array(z.string()).optional().describe('要等待的 Tripo 模型 UUID 列表；留空则等待当前所有正在生成的任务'),
    pollIntervalMs: z.number().int().min(2000).default(6000).describe('轮询间隔毫秒数'),
    timeoutMs: z.number().int().min(30000).default(600000).describe('最大超时毫秒数'),
    screenshotDir: z.string().optional().describe('可选：完成后为每个模型保存预览截图的目录路径'),
  },
  wrapTool('wait', args => controller.waitForModels(args))
);

server.tool(
  'tripo_export',
  '按顺序将指定的已完成 Tripo 模型导出为 FBX 或 GLB（默认 FBX + Blender 预设 + 4K 贴图），自动监听本机 Downloads 文件夹直至下载完成，校验二进制文件头与 SHA256，安全解压 FBX 及 .fbm 贴图到 outputDir 并生成 download-record.json。',
  {
    modelIds: z.array(z.string()).optional().describe('要导出的 Tripo 模型 UUID 列表；若省略则导出当前视口打开的模型'),
    format: z.enum(['FBX', 'GLB']).default('FBX').describe('导出格式：FBX 或 GLB'),
    preset: z.enum(['Blender', 'Mixamo', '3dsmax']).default('Blender').describe('FBX 导出预设（默认 Blender）'),
    textureResolution: z.enum(['8k', '4k', '2k']).default('4k').describe('导出贴图分辨率（默认 4k，可选 8k）'),
    outputDir: z.string().describe('保存解压后 FBX、贴图及 download-record.json 的本地目标目录绝对路径'),
    subdirs: z.array(z.string()).optional().describe('可选：导出多个候选时每个候选对应的子目录名（如 ["prop-c1", "prop-c2"]）'),
    downloadTimeoutMs: z.number().int().min(15000).default(600000).describe('单个模型等待下载完成的最大毫秒数（默认 10 分钟）'),
  },
  wrapTool('export', args => controller.exportModels(args))
);

server.tool(
  'tripo_generate_and_export',
  '端到端一键生成并导出候选模型：完成四方向视图上传、提交 1~4 个候选、本地静默等待全部构建完成、自动逐个导出 FBX + 4K PBR 贴图并安全解压校验到 outputDir，直接返回可供 scripts/tripo-project.mjs 注册的 fbx 与 resources 路径清单。',
  {
    front: z.string().describe('正视图 PNG 绝对路径'),
    left: z.string().describe('左视图 PNG 绝对路径'),
    right: z.string().describe('右视图 PNG 绝对路径'),
    back: z.string().describe('背视图 PNG 绝对路径'),
    smartMesh: z.boolean().default(false).describe('false = HD Model 高精度模式（H3.5 · 最高 500 万面）；true = 智能网格 Smart Mesh P2.0（默认 Quad 四边面 500~25,000，可选 Triangle 500~50,000）'),
    aiModel: z.string().optional().describe('AI 模型版本，如 "H3.5"、"H3.1"、"P2.0"（默认：HD 模式用 H3.5，Smart Mesh 用 P2.0）'),
    ultraMesh: z.boolean().optional().describe('是否启用 Ultra Mesh Quality（HD 模式默认 true）'),
    topology: z.enum(['Triangle', 'Quad']).optional().describe('网格拓扑：Quad（智能网格默认四边面）或 Triangle（三角面）'),
    polycount: z.number().int().optional().describe('最大面数上限（HD 模式默认 5000000；智能网格默认 25000）'),
    textureQuality: z.enum(['2K', '4K', '8K']).default('4K').describe('贴图分辨率（默认 4K，可选 8K）'),
    pbr: z.boolean().default(true).describe('是否启用 PBR（默认 true）'),
    removeLighting: z.boolean().default(false).describe('是否开启去光影（默认 false）'),
    count: z.number().int().min(1).max(4).default(1).describe('候选生成数量（1~4）'),
    outputDir: z.string().describe('保存所有候选解压后 FBX 与贴图的根目录（例如 .../models/candidates）'),
    subdirs: z.array(z.string()).optional().describe('可选：各候选子目录名，如 ["prop-c1", "prop-c2"]'),
    screenshotDir: z.string().optional().describe('可选：保存各候选视口截图的目录'),
    timeoutMs: z.number().int().min(60000).default(600000).describe('生成等待超时毫秒数'),
  },
  wrapTool('generate_and_export', async (args) => {
    const gen = await controller.generate({
      ...args,
      mode: 'multiview',
      wait: true,
    });
    const modelIds = gen.models.map(m => m.modelId);
    const exp = await controller.exportModels({
      modelIds,
      format: 'FBX',
      preset: 'Blender',
      textureResolution: args.textureQuality.toLowerCase(),
      outputDir: args.outputDir,
      subdirs: args.subdirs,
    });
    return {
      status: 'generated_and_exported',
      creditsRemaining: gen.creditsRemaining,
      models: gen.models,
      exports: exp.items,
    };
  })
);

server.tool(
  'tripo_upload_model',
  '将本地 FBX / GLB 模型上传至 Tripo 右侧 Assets 面板，并自动应用朝向角度（Y-up 烘焙 FBX 默认设置 X=0°, Y=90°, Z=0° 朝正前方）。',
  {
    filePath: z.string().describe('本地 .fbx 或 .glb 文件绝对路径'),
    rotateX: z.number().default(0).describe('上传朝向 X 角度（默认 0）'),
    rotateY: z.number().default(90).describe('上传朝向 Y 角度（默认 90）'),
    rotateZ: z.number().default(0).describe('上传朝向 Z 角度（默认 0）'),
  },
  wrapTool('upload_model', args => controller.uploadModel(args))
);

server.tool(
  'tripo_segment',
  '上传 GLB（或指定已有 modelId）并在 Tripo Segmentation 工作区执行粗分割，等待完成后可选直接导出分割后的基准 FBX。',
  {
    filePath: z.string().optional().describe('可选：待上传分割的本地 .glb 文件绝对路径'),
    modelId: z.string().optional().describe('可选：已在 Tripo Assets 中的模型 UUID'),
    rotateY: z.number().default(90).describe('上传朝向 Y 角度（默认 90）'),
    outputDir: z.string().optional().describe('可选：若填写则自动将分割完成结果导出为 FBX 到该目录'),
  },
  wrapTool('segment', args => runSegmentation(controller, args))
);

server.tool(
  'tripo_retexture',
  '对部件 FBX（或指定 modelId）自动执行可选的 Smart UV 重展，并在 Tripo Texture 工作区上传正/背面参考 PNG 生成 4K PBR 纹理，等待完成后导出结果 FBX 及贴图。',
  {
    filePath: z.string().optional().describe('可选：待上传的本地部件 .fbx 文件绝对路径'),
    modelId: z.string().optional().describe('可选：已在 Tripo Assets 中的模型 UUID'),
    rotateY: z.number().default(90).describe('上传朝向 Y 角度（默认 90）'),
    smartUV: z.boolean().default(true).describe('是否先执行独立 Smart UV（8 万面以上高模请传 false）'),
    frontPng: z.string().optional().describe('正面参考图 PNG 绝对路径'),
    backPng: z.string().optional().describe('背面参考图 PNG 绝对路径'),
    textureQuality: z.enum(['2K', '4K', '8K']).default('4K').describe('贴图分辨率（默认 4K，可选 8K）'),
    pbr: z.boolean().default(true).describe('是否启用 PBR（默认 true）'),
    removeLighting: z.boolean().default(false).describe('是否启用去光影（默认 false）'),
    outputDir: z.string().optional().describe('可选：保存导出结果 FBX 及贴图的目录路径'),
  },
  wrapTool('retexture', args => runRetexture(controller, args))
);

server.tool(
  'tripo_rig',
  '上传合并后的无发身体+头部 FBX（或指定 modelId），在 Tripo Rig 工作区强制选定 VRM 骨骼预设执行自动绑骨，等待完成后以 Blender 预设导出含骨骼 FBX。',
  {
    filePath: z.string().optional().describe('可选：待上传绑骨的本地 .fbx 文件绝对路径'),
    modelId: z.string().optional().describe('可选：已在 Tripo Assets 中的模型 UUID'),
    rotateY: z.number().default(90).describe('上传朝向 Y 角度（默认 90）'),
    skeletonPreset: z.string().default('VRM').describe('骨骼预设（MorphoGem 默认为 VRM）'),
    exportPreset: z.enum(['Blender', 'Mixamo', '3dsmax']).default('Blender').describe('FBX 导出预设（默认 Blender）'),
    outputDir: z.string().optional().describe('可选：保存绑骨后导出 FBX 的目录路径'),
  },
  wrapTool('rig', args => runRigging(controller, args))
);

process.on('SIGINT', async () => {
  await controller.disconnect();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await controller.disconnect();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
