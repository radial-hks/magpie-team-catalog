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
import { randomUUID } from "node:crypto"

import { effectiveTool } from "./core.mjs"
import { defaultStateDir } from "./source.mjs"
import { loadCatalog, readLocalRegistry, saveLocalRegistry } from "./catalog.mjs"
import { discoverNpm } from "./npm-discovery.mjs"
import { projectJSON } from "./project-model.mjs"
import { discoverGit, discoverP4, readP4Config } from "./project-discovery.mjs"
import { readUserOptions, writeOptions } from "./cycle.mjs"
import { optionsRevision, mergeUIOptions } from "./ui-options.mjs"
import { freshness } from "./snapshot.mjs"

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
      source: t.source ?? "team",
      ...(t.package ? { package: t.package } : {}),
      ...(st.path ? { path: st.path } : {}),
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
  const projects = (registry.projects ?? []).map(p => projectJSON({ ...p, source: p.source ?? "team" }, state?.projects?.[p.id]))
  return {
    tools,
    projects,
    ...(state?.checkedAt ? { checkedAt: new Date(state.checkedAt).toISOString() } : {}),
    ...(userOptions?.index ? { index: userOptions.index } : {}),
  }
}

/** 启动 service。端口：options.servicePort（magpie 或用户给的）。 */
export function startService(userOptions, { readOptions = readUserOptions, scanNpm = discoverNpm, scanGit = discoverGit, scanP4 = discoverP4, readP4 = readP4Config, persistOptions = writeOptions, trigger = spawnWorker } = {}) {
  const port = Number(userOptions?.servicePort ?? DEFAULT_SERVICE_PORT)
  const statePath = userOptions?.statePath || path.join(defaultStateDir(), "catalog-state.json")
  const token = randomUUID()
  const session = randomUUID() // 公开实例标识不是权限令牌，仅用于旧页面检测重载
  let scanPromise = null
  const mainPage = path.join(PLUGIN_DIR, "page", "main.html")

  const serve = () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 30,
      maxRequestBodySize: 2 * 1024 * 1024,
      async fetch(req) {
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-catalog-token",
        }
        const url = new URL(req.url)
        // 防 DNS rebinding；修改/扫描必须来自本 service 提供的页面会话。
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return new Response("Forbidden", { status: 403 })
        const protectedRequest = req.method === "POST" || url.pathname === "/local-registry" || url.pathname === "/npm-candidates"
        if (protectedRequest && req.method !== "OPTIONS" && req.headers.get("x-catalog-token") !== token) {
          return Response.json({ error: "页面会话已过期，请重新加载", code: "SESSION_EXPIRED" }, { status: 403, headers: cors })
        }
        if (req.method === "OPTIONS") return new Response(null, { headers: cors })

        // 带路页导航过来的主界面（GET /）
        if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
          try {
            return new Response(readFileSync(mainPage, "utf8")
              .replace("__CATALOG_TOKEN__", token)
              .replace("__CATALOG_SESSION__", session)
              // GUI sandbox/CSP 的外部脚本权限与普通浏览器不同；随主文档内联。
              .replace(/<script src="\/(session-client|ui-kit|catalog-ui|project-ui|catalog-app)\.js"><\/script>/g, (_match, name) => `<script>${readFileSync(path.join(PLUGIN_DIR, "page", `${name}.js`), "utf8")}</script>`), {
              // 主文档含会话令牌：不能 ACAO:*，防其它网站 fetch 后窃取令牌。
              // iframe 导航不需要 CORS；后续 opaque-origin API 仍按 cors 响应。
              headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
            })
          } catch (e) {
            return Response.json({ error: `page not readable: ${e?.message ?? e}` }, { status: 500, headers: cors })
          }
        }

        if (["/catalog-ui.js", "/session-client.js", "/project-ui.js", "/ui-kit.js", "/catalog-app.js"].includes(url.pathname) && req.method === "GET") {
          return new Response(readFileSync(path.join(PLUGIN_DIR, "page", path.basename(url.pathname)), "utf8"), {
            headers: { ...cors, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
          })
        }

        if (url.pathname === "/state" && req.method === "GET") {
          let body
          try {
            const options = readOptions() ?? userOptions ?? {}
            const catalog = await loadCatalog(options)
            body = {
              ...pageView(catalog.registry, readState(statePath), options, process.platform === "win32" ? "windows" : process.platform),
              warnings: catalog.warnings,
              freshness: freshness(readState(statePath), options),
              session,
            }
          } catch (e) {
            body = { error: `state 不可读：${e?.message ?? e}` }
          }
          return Response.json(body, { headers: cors })
        }

        if (url.pathname === "/ui-options" && req.method === "GET") {
          if (req.headers.get("x-catalog-token") !== token) return Response.json({ error: "页面会话已过期，请重新加载", code: "SESSION_EXPIRED" }, { status: 403, headers: cors })
          const options = readOptions() ?? userOptions ?? {}
          return Response.json({ options, revision: optionsRevision(options) }, { headers: cors })
        }

        if (url.pathname === "/options" && req.method === "GET") {
          return Response.json(readOptions() ?? userOptions ?? {}, { headers: cors })
        }

        if (url.pathname === "/local-registry" && req.method === "GET") {
          try { return Response.json(readLocalRegistry(readOptions() ?? userOptions ?? {}), { headers: cors }) }
          catch (e) { return Response.json({ error: e.message }, { status: 422, headers: cors }) }
        }
        if (url.pathname === "/local-registry" && req.method === "POST") {
          try {
            const body = await req.json()
            const options = readOptions() ?? userOptions ?? {}
            const saved = await saveLocalRegistry(body.registry, body.revision, options)
            trigger({ ...userOptions, ...options })
            return Response.json(saved, { headers: cors })
          } catch (e) { return Response.json({ error: e.message }, { status: 409, headers: cors }) }
        }
        if (url.pathname === "/npm-candidates" && req.method === "GET") {
          try {
            // 同时打开多个扫描窗口时只拉一份清单，避免重复启动 npm。
            scanPromise ??= Promise.resolve().then(scanNpm).finally(() => { scanPromise = null })
            return Response.json(await scanPromise, { headers: cors })
          }
          catch (e) { return Response.json({ error: e.message }, { status: 502, headers: cors }) }
        }

        if (url.pathname === "/project-discovery" && req.method === "POST") {
          try {
            const body = await req.json()
            const result = body.kind === "git" ? await scanGit(body) : body.kind === "p4" ? await scanP4(body) : body.kind === "p4-config" ? { config: readP4(body.file) } : null
            if (!result) throw new Error("kind must be git|p4|p4-config")
            return Response.json(result, { headers: cors })
          } catch (e) { return Response.json({ error: e.message }, { status: 422, headers: cors }) }
        }

        if (url.pathname === "/options" && req.method === "POST") {
          // 页面保存覆盖：以 plugins.json 里的用户 options 为基准合并（保留
          // index 等既有键），经 magpie CLI 写回 → 宿主重载 → worker 重探测
          try {
            const body = await req.json()
            const current = readOptions() ?? userOptions ?? {}
            const next = mergeUIOptions(current, body)
            // 同一套加载校验，拒绝损坏 registry/localRegistry 设置，不写盘。
            const catalog = await loadCatalog(next)
            if (catalog.warnings.length) throw Error(catalog.warnings.join("；"))
            // 数据源验证可能耗时，写回前再核对版本，避免期间其它窗口修改。
            const latest = readOptions() ?? userOptions ?? {}
            if (optionsRevision(latest) !== body.revision) throw Error("配置已被其它窗口修改，请重新加载后再保存")
            await persistOptions({ ...next, ...(latest.index !== undefined ? { index: latest.index } : {}) }, latest)
            return Response.json({ ok: true, note: "已写入；宿主重载与新探测随后生效" }, { headers: cors })
          } catch (e) {
            return Response.json({ error: `保存失败：${e?.message ?? e}` }, { status: 409, headers: cors })
          }
        }

        if (url.pathname === "/refresh" && req.method === "POST") {
          // 立即重跑一轮探测（detached worker，不阻塞响应）
          trigger({ ...userOptions, ...(readOptions() ?? {}) })
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
