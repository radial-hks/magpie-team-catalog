// tool.mjs — catalog 工具的实现：搜索（id/名称/关键词）与详情（docs/<id>.md
// 全文 + 按需 probe）。匹配与响应组装是纯函数（matchTools/matchProjects/
// entryJSON），IO（读 registry/state/docs、跑 probe）集中在 catalogTool。
//
// 语义纪律（design.md §5.2）：probe 命令只在查详情时按需执行（≤5s），周期
// 探测永远不进 execute（M2 验收：55s 上限不被探测阻塞）。

import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

import { effectiveTool, parseRegistry } from "./core.mjs"
import { which, runCmd } from "./probe.mjs"
import { loadRegistry, readRegistryDoc, defaultStateDir, defaultCacheDir } from "./source.mjs"

/** 搜索匹配（纯）：query 小写子串，命中 id / name / usage。空 query 全量。 */
export function matchTools(registry, query) {
  const q = (query ?? "").trim().toLowerCase()
  return (registry.tools ?? []).filter((t) => {
    if (q === "") return true
    return (
      t.id.toLowerCase().includes(q) ||
      (t.name ?? "").toLowerCase().includes(q) ||
      (t.usage ?? "").toLowerCase().includes(q)
    )
  })
}

export function matchProjects(registry, query) {
  const q = (query ?? "").trim().toLowerCase()
  return (registry.projects ?? []).filter((p) => {
    if (q === "") return true
    return (
      p.id.toLowerCase().includes(q) ||
      (p.name ?? "").toLowerCase().includes(q) ||
      (p.note ?? "").toLowerCase().includes(q) ||
      (p.vcs ?? "").toLowerCase().includes(q)
    )
  })
}

/**
 * 工具条目的响应对象（纯）。st 为 state 里的探测结果：
 * {status, version?, via?}。fix 只在 missing/outdated 时给出（install 命令
 * 文本，不由插件执行）。probe 为详情模式按需探测的结果：{ok, output?}。
 */
export function entryJSON(tool, st, { probe } = {}) {
  let status = st?.status ?? "unknown"
  if (probe && probe.ok && status === "present") status = "configured"
  const out = {
    id: tool.id,
    ...(tool.name ? { name: tool.name } : {}),
    kind: tool.kind,
    status,
    ...(st?.version ? { version: st.version } : {}),
    ...(tool.min ? { min: tool.min } : {}),
    ...(tool.usage ? { usage: tool.usage.trim() } : {}),
    install: tool.install,
    ...(status === "missing" || status === "outdated" ? { fix: tool.install } : {}),
    ...(probe ? { probe: probe.ok ? "ok" : "failed", ...(probe.output ? { probeOutput: probe.output.slice(0, 400) } : {}) } : {}),
  }
  return out
}

export function projectJSON(p) {
  return {
    id: p.id,
    ...(p.name ? { name: p.name } : {}),
    ...(p.vcs ? { vcs: p.vcs } : {}),
    ...(p.url ? { url: p.url } : {}),
    ...(p.note ? { note: p.note } : {}),
  }
}

/**
 * catalog 工具入口。args: {query?: string, detail?: string}。
 * userOptions 为本插件当前 options（registry/overrides/statePath…）。
 * onStale 在 state 缺失时被调用（index.mjs 用它触发一次后台刷新）。
 * 返回对象（宿主会以 JSON 发回给 Agent）。
 */
export async function catalogTool(args, userOptions, { onStale } = {}) {
  const opts = { registry: "./registry/registry.yaml", probeTimeoutMs: 5000, ...userOptions }
  const statePath = opts.statePath || path.join(defaultStateDir(), "catalog-state.json")
  const overrides = userOptions?.overrides ?? {}
  const platform = process.platform === "win32" ? "windows" : process.platform

  let registry
  let srcBase = ""
  try {
    const src = await loadRegistry(opts.registry, { cacheDir: opts.cacheDir || defaultCacheDir() })
    registry = parseRegistry(readFileSync(src.path, "utf8"))
    srcBase = src.base
  } catch (e) {
    return { error: `registry 不可读：${e?.message ?? e}` }
  }

  let state = null
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    if (onStale) onStale() // 后台补一轮，不阻塞本次响应
  }
  const states = state?.tools ?? {}

  if (args.detail) {
    const id = String(args.detail).trim()
    const tool = (registry.tools ?? []).find((t) => t.id === id)
    if (tool) {
      const eff = effectiveTool(tool, overrides[id], platform)
      if (eff.disabled) return { id, status: "disabled", note: "本机已禁用（overrides.enabled=false）" }
      const st = eff.pinned ? { status: eff.pinned, ...(states[id]?.version ? { version: states[id].version } : {}) } : (states[id] ?? {})
      // 按需 probe：只对未钉死的 present/outdated 且声明了 check.probe 的条目
      let probe = null
      if (!eff.pinned && (st.status === "present" || st.status === "outdated") && Array.isArray(eff.check?.probe) && eff.check.probe.length > 0) {
        probe = await runProbeCmd(eff, opts.probeTimeoutMs)
      }
      const out = entryJSON(eff, st, { probe: probe ?? undefined })
      if (eff.pinned) out.pinned = true
      return { ...out, doc: await readDoc(srcBase, tool) }
    }
    const p = (registry.projects ?? []).find((x) => x.id === id)
    if (p) return projectJSON(p)
    return { error: `没有 id 为 ${id} 的条目` }
  }

  // 搜索模式
  const tools = matchTools(registry, args.query)
    .map((t) => {
      const eff = effectiveTool(t, overrides[t.id], platform)
      if (eff.disabled) return null
      const st = states[t.id] ?? {}
      const out = entryJSON(eff, eff.pinned ? { status: eff.pinned } : st)
      if (eff.pinned) out.pinned = true
      return out
    })
    .filter(Boolean)
  const projects = matchProjects(registry, args.query).map(projectJSON)
  const out = {
    tools,
    projects,
    ...(state?.checkedAt ? { checkedAt: new Date(state.checkedAt).toISOString() } : { note: "本机探测尚未完成，status 可能为 unknown，稍后再查" }),
  }
  return out
}

/** 按需 probe：解析可执行文件后跑 check.probe，退出 0 → {ok:true}。 */
export async function runProbeCmd(effTool, timeoutMs = 5000) {
  const bin = effTool.check?.bin ?? effTool.id
  if (!Array.isArray(effTool.check?.probe) || effTool.check.probe.length === 0) return null
  let exe = null
  if (bin.includes("/") || bin.includes("\\")) {
    if (existsSync(bin)) exe = bin
  } else {
    exe = await which(bin, timeoutMs)
  }
  if (!exe) return { ok: false, output: "executable not found" }
  const r = await runCmd(exe, effTool.check.probe, timeoutMs)
  return { ok: r.ok, output: (r.stdout || r.stderr || "").trim() }
}

/** docs/<id>.md：base 为目录 → 本地读；为 URL → 拉取。没有或不读本 null。 */
export async function readDoc(base, tool) {
  if (typeof tool.doc !== "string" || tool.doc === "") return undefined
  return (await readRegistryDoc(base, tool.doc)) ?? undefined
}
