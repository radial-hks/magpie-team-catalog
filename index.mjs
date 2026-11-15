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
import { catalogTool, catalogStatus } from "./lib/tool.mjs"
import { CATALOG_SCHEMA, STATUS_SCHEMA } from "./lib/mcp-contract.mjs"
import { startService } from "./lib/service.mjs"

const PLUGIN_DIR = import.meta.dir

export default async function TeamCatalog(_input, options) {
  const userOptions = options ?? {}
  const interval = Math.max(60, userOptions.interval ?? DEFAULTS.interval)
  triggerCycle(userOptions)
  setInterval(() => triggerCycle(userOptions), interval * 1000)
  // 窗口页的本地 service：端口必须读 options.servicePort（magpie 在无页面
  // 进程里会把它改到空闲端口，避免与常驻实例撞端口）
  startService(userOptions)
  let lastStaleRefresh = 0
  const onStale = () => {
    // 并发 MCP 查询共享一次触发预算，不为每次旧快照查询 spawn worker。
    if (Date.now() - lastStaleRefresh < 10000) return
    lastStaleRefresh = Date.now()
    triggerCycle(userOptions)
  }
  return {
    tool: {
      // MCP 名为 <插件短名>_catalog（magpie 汇入 /mcp/magpie/tools）。
      // args 用纯 JSON Schema（文件夹插件就地加载、无 node_modules，不依赖
      // @opencode-ai/plugin 的 zod）。
      catalog: {
        description: "只读团队/本机 CLI 与 Git/P4 项目目录：先用 query/type/kind/client/path 和 limit/offset 分页发现（默认简略20条），再 detail=<精确ID> 查用法、路径、P4 Client/Depot和分段文档。默认不执行CLI、不联网刷新；工具详情 check=true 才执行声明的只读probe。present不代表已配置，P4目录不代表已登录；不安装/注册/同步/提交。",
        args: CATALOG_SCHEMA,
        execute: async (args) => {
          // 探测不在 execute 里周期跑（55s 预算纪律）；state 缺失时仅触发
          // 后台刷新，本次按 unknown 返回
          return catalogTool(args ?? {}, userOptions, { onStale })
        },
      },
      catalog_status: {
        description: "轻量只读目录概览：工具/项目数量、状态分布、快照时间/是否过期及能力边界。不列出全文或执行CLI/P4命令；条目查询请用catalog。",
        args: STATUS_SCHEMA,
        execute: async (args) => catalogStatus(args ?? {}, userOptions, { onStale }),
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
