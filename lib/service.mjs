// service.mjs — 窗口页背后的本地 service（跑在 Bun 宿主，127.0.0.1）。
//
// 页面架构（官方模式，参照 @magpie-community/page-chat）：
// magpie 插件页跑在 sandbox="allow-scripts" 框架里，CSP connect-src 'none'，
// 唯一能做的联网动作是【把自身导航到别处】——所以插件目录里的 page/ 只是
// 带路页（boot.js location.replace 过来），真正的界面由本 service 的 GET /
// 直接提供。页面文档在沙箱里仍是 opaque origin，所有响应带 CORS 头。
//
// 端口必须从 options.servicePort 读：magpie 在不服务页面的进程（CLI 命令）
// 会把该 option 改写到空闲端口；宿主重启期间旧进程可能还占着端口（retire
// 最多 10 分钟），绑定失败时后台重试而不是放弃。
//
// options 写回：POST /options 由本 service 代执 magpie plugin options CLI
//（与 worker 发布同一条 sanctioned 通道），触发宿主重载与新探测。

import { readFileSync } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

import { parseRegistry, effectiveTool } from "./core.mjs"
import { loadRegistry, defaultStateDir, defaultCacheDir } from "./source.mjs"
import { readUserOptions, writeOptions } from "./cycle.mjs"

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
  const statePath = userOptions?.statePath || path.join(defaultStateDir(), "catalog-state.json")
  const cacheDir = userOptions?.cacheDir || defaultCacheDir()
  const registrySpec = userOptions?.registry
  const mainPage = path.join(PLUGIN_DIR, "page", "main.html")

  const serve = () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 30,
      async fetch(req) {
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        }
        const url = new URL(req.url)
        if (req.method === "OPTIONS") return new Response(null, { headers: cors })

        // 带路页导航过来的主界面（GET /）
        if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
          try {
            return new Response(readFileSync(mainPage, "utf8"), {
              headers: { ...cors, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
            })
          } catch (e) {
            return Response.json({ error: `page not readable: ${e?.message ?? e}` }, { status: 500, headers: cors })
          }
        }

        if (url.pathname === "/state" && req.method === "GET") {
          let body
          try {
            const src = await loadRegistry(registrySpec, { cacheDir })
            body = pageView(
              parseRegistry(readFileSync(src.path, "utf8")),
              readState(statePath),
              readUserOptions() ?? userOptions ?? {},
              process.platform === "win32" ? "windows" : process.platform,
            )
          } catch (e) {
            body = { error: `state 不可读：${e?.message ?? e}` }
          }
          return Response.json(body, { headers: cors })
        }

        if (url.pathname === "/options" && req.method === "GET") {
          return Response.json(readUserOptions() ?? {}, { headers: cors })
        }

        if (url.pathname === "/options" && req.method === "POST") {
          // 页面保存覆盖：以 plugins.json 里的用户 options 为基准合并（保留
          // index 等既有键），经 magpie CLI 写回 → 宿主重载 → worker 重探测
          try {
            const body = await req.json()
            const overrides = body?.overrides
            if (overrides === undefined || overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
              throw new Error("body must be {overrides: {…}}")
            }
            const current = readUserOptions() ?? {}
            await writeOptions({ ...current, overrides })
            return Response.json({ ok: true, note: "已写入；宿主重载与新探测随后生效" }, { headers: cors })
          } catch (e) {
            return Response.json({ error: `保存失败：${e?.message ?? e}` }, { status: 500, headers: cors })
          }
        }

        if (url.pathname === "/refresh" && req.method === "POST") {
          // 立即重跑一轮探测（detached worker，不阻塞响应）
          spawnWorker(userOptions)
          return Response.json({ ok: true, note: "探测已触发，稍后 GET /state 查看" }, { status: 202, headers: cors })
        }

        return Response.json({ error: "not found" }, { status: 404, headers: cors })
      },
    })

  try {
    const server = serve()
    console.error(`team-catalog: page service on http://127.0.0.1:${server.port}`)
    return server
  } catch (e) {
    // 端口被上一个宿主占着（retire 窗口最长 10 分钟）：后台等它松手再绑
    console.error(`team-catalog: port ${port} busy (${e?.message ?? e}); service retries in background`)
    let server = null
    const timer = setInterval(() => {
      try {
        server = serve()
        clearInterval(timer)
        console.error(`team-catalog: page service on http://127.0.0.1:${server.port}`)
      } catch {}
    }, 5000)
    setTimeout(() => clearInterval(timer), 15 * 60 * 1000)
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
