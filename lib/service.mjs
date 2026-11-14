// service.mjs — 窗口页背后的本地 service（跑在 Bun 宿主，127.0.0.1）。
// package.json 声明 magpie.page.service {port, option: servicePort}：端口必须
// 从 options 读——magpie 在不服务页面的进程里会把 option 指向的端口改写到
// 空闲端口，避免与常驻 app 的 service 撞端口。
// 页面经 magpie.service（web 模式，反向代理）或直连 127.0.0.1（桌面模式）。
// 沙箱 iframe 的 origin 是 opaque（Origin: null），响应带 CORS 头。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

import { parseRegistry, effectiveTool } from "./core.mjs"

const PLUGIN_DIR = path.dirname(import.meta.dir)
export const DEFAULT_SERVICE_PORT = 3969

/**
 * 页面视图（纯）：registry + state + 用户覆盖 → 一张可直接渲染的表。
 * status 优先级：覆盖钉死 > 探测结果 > unknown；禁用单独标出。
 */
export function pageView(registry, state, userOptions, platform) {
  const overrides = userOptions?.overrides ?? {}
  const states = state?.tools ?? {}
  const tools = (registry.tools ?? []).map((t) => {
    const eff = effectiveTool(t, overrides[t.id], platform)
    const st = states[t.id] ?? {}
    return {
      id: t.id,
      ...(t.name ? { name: t.name } : {}),
      kind: t.kind,
      status: eff.disabled ? "disabled" : (eff.pinned ?? st.status ?? "unknown"),
      ...(st.version ? { version: st.version } : {}),
      ...(t.min ? { min: t.min } : {}),
      ...(st.via ? { via: st.via } : {}),
      ...(st.at ? { at: new Date(st.at).toISOString() } : {}),
      install: t.install,
      ...(t.usage ? { usage: t.usage.trim() } : {}),
      ...(overrides[t.id] ? { override: overrides[t.id] } : {}),
    }
  })
  const projects = (registry.projects ?? []).map((p) => ({
    id: p.id,
    ...(p.name ? { name: p.name } : {}),
    ...(p.vcs ? { vcs: p.vcs } : {}),
    ...(p.url ? { url: p.url } : {}),
    ...(p.note ? { note: p.note } : {}),
  }))
  return {
    tools,
    projects,
    ...(state?.checkedAt ? { checkedAt: new Date(state.checkedAt).toISOString() } : {}),
    ...(userOptions?.index ? { index: userOptions.index } : {}),
  }
}

/** 启动 service。端口：options.servicePort（magpie 或用户给的）。 */ 
export function startService(userOptions) {
  const port = Number(userOptions?.servicePort ?? DEFAULT_SERVICE_PORT)
  const statePath = userOptions?.statePath || defaultStatePath()
  const registryPath = resolveRegistry(userOptions?.registry)
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 30,
      fetch(req) {
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        }
        const url = new URL(req.url)
        if (req.method === "OPTIONS") return new Response(null, { headers: cors })
        if (url.pathname === "/state" && req.method === "GET") {
          let body
          try {
            body = pageView(
              parseRegistry(readFileSync(registryPath, "utf8")),
              readState(statePath),
              userOptions,
              process.platform === "win32" ? "windows" : process.platform,
            )
          } catch (e) {
            body = { error: `state 不可读：${e?.message ?? e}` }
          }
          return Response.json(body, { headers: cors })
        }
        if (url.pathname === "/refresh" && req.method === "POST") {
          // 立即重跑一轮探测（detached worker，不阻塞响应）
          spawnWorker(userOptions)
          return Response.json({ ok: true, note: "探测已触发，稍后 GET /state 查看" }, { status: 202, headers: cors })
        }
        return Response.json({ error: "not found" }, { status: 404, headers: cors })
      },
    })
    console.error(`team-catalog: page service on http://127.0.0.1:${server.port}`)
    return server
  } catch (e) {
    // fail-open：端口占用等失败只记日志，不影响插件其余部分
    console.error(`team-catalog: service not started on ${port}: ${e?.message ?? e}`)
    return null
  }
}

/** 与 index.mjs 同源的 worker spawn（detached，生命周期独立于宿主）。 */
export function spawnWorker(userOptions) {
  const child = spawn(process.execPath, [path.join(PLUGIN_DIR, "worker.mjs")], {
    env: { ...process.env, TC_OPTIONS: JSON.stringify(userOptions ?? {}) },
    stdio: "ignore",
    detached: true,
  })
  child.unref()
  child.on("error", () => {})
  return child
}

function readState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    return null
  }
}

function resolveRegistry(spec) {
  if (typeof spec !== "string" || spec === "") return path.join(PLUGIN_DIR, "registry/registry.yaml")
  const s = spec.replace(/^file:\/\//, "")
  if (path.isAbsolute(s)) return s
  return path.join(PLUGIN_DIR, s)
}

function defaultStatePath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return path.join(base, "magpie", "team-catalog", "catalog-state.json")
}
