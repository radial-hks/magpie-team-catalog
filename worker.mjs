// worker.mjs — 一轮探测+发布的独立进程（detached）。
// 由 index.mjs（宿主内）spawn 且 unref：宿主进程随 CLI 命令退出、被问到才启动，
// 探测与发布必须能在宿主死后继续完成。经 TC_OPTIONS 传入当前 options。
// 直接运行：bun worker.mjs '<optionsJson>'
import { runCycle } from "./lib/cycle.mjs"

const opts = process.env.TC_OPTIONS ?? process.argv[2] ?? "{}"
let userOptions = {}
try {
  userOptions = JSON.parse(opts) ?? {}
} catch {
  console.error("team-catalog: TC_OPTIONS is not JSON; running with defaults")
}
await runCycle(userOptions)
