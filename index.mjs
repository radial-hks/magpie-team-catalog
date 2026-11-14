// index.mjs — Bun 宿主模块（OpenCode 插件入口）。
// 职责只是【触发】：加载时与按周期 spawn 一个 detached worker.mjs（探测 →
// 写 catalog-state.json → 索引写入本插件 options，供 moejs 侧
// catalog.middleware.js 读取注入）。探测与发布放在独立进程里，是因为：
// - 宿主「被用到才启动」、随 CLI 命令退出——异步任务会被宿主早死杀掉；
// - 插件加载有预算（add 验证 20s），不能在加载里同步等探测；
// - 发布要 spawn magpie CLI，对方会再启宿主嵌套加载本插件（plugin.Cached
//   的后台 provider 询问）——worker 里的整轮跨进程锁让嵌套副本直接跳过。
//
// 注意（写代码时必读，来自 magpie 插件文档核对）：
// - options 变更（magpie plugin options）会触发宿主 Restart，但 index 发布
//   只在内容变化时发生，写完一次后计算结果与 options.index 相同即跳过；
// - 入口文件除 default 与 _internal 外不得导出别的（会被当成插件调用）。

import { spawn } from "node:child_process"
import path from "node:path"

import { DEFAULTS } from "./lib/cycle.mjs"
import { catalogTool } from "./lib/tool.mjs"

const PLUGIN_DIR = import.meta.dir

export default async function TeamCatalog(_input, options) {
  const userOptions = options ?? {}
  const interval = Math.max(60, userOptions.interval ?? DEFAULTS.interval)
  triggerCycle(userOptions)
  setInterval(() => triggerCycle(userOptions), interval * 1000)
  return {
    tool: {
      // MCP 名为 <插件短名>_catalog（magpie 汇入 /mcp/magpie/tools）。
      // args 用纯 JSON Schema（文件夹插件就地加载、无 node_modules，不依赖
      // @opencode-ai/plugin 的 zod）。
      catalog: {
        description: "团队内部工具目录与项目地址：按关键词搜索（id/名称/用法），或传 detail=<id> 查用法全文与本机状态（安装/升级命令在 fix 字段）。",
        args: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词，省略则列出全部" },
            detail: { type: "string", description: "要查详情的条目 id（返回用法全文与本机实测状态）" },
          },
          additionalProperties: false,
        },
        execute: async (args) => {
          // 探测不在 execute 里周期跑（55s 预算纪律）；state 缺失时仅触发
          // 后台刷新，本次按 unknown 返回
          return catalogTool(args ?? {}, userOptions, { onStale: () => triggerCycle(userOptions) })
        },
      },
    },
  }
}

/** spawn 一个 detached worker，unref 后生命周期独立于宿主。 */
function triggerCycle(userOptions) {
  const child = spawn(process.execPath, [path.join(PLUGIN_DIR, "worker.mjs")], {
    env: { ...process.env, TC_OPTIONS: JSON.stringify(userOptions) },
    stdio: "ignore",
    detached: true,
  })
  child.unref()
  child.on("error", () => {})
}

// 测试出口：纯函数来自 lib/*。
export const _internal = { DEFAULTS, triggerCycle }
