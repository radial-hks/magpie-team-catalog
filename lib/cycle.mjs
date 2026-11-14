// cycle.mjs — 一轮完整刷新：读 registry → 探测 → 写 state → 索引有变则发布。
// 由 worker.mjs（detached 进程）调用，与宿主生命周期解耦：宿主被问到才启动、
// 随 CLI 命令退出，探测+发布必须能在宿主死后继续完成。

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { parseRegistry, effectiveTool, toolStatus, buildIndex } from "./core.mjs"
import { probeAll, runCmd } from "./probe.mjs"
import { loadRegistry, defaultStateDir, defaultCacheDir } from "./source.mjs"
const PLUGIN_DIR = path.dirname(import.meta.dir)
const PLATFORM = process.platform === "win32" ? "windows" : process.platform

export const DEFAULTS = {
  registry: "./registry/registry.yaml", // 相对路径按插件目录解析
  interval: 900, // 秒
  probeTimeoutMs: 5000,
  concurrency: 8,
  showMissing: false,
  magpieBin: "", // 覆盖 magpie 可执行文件路径
  statePath: "", // 覆盖 state 文件路径
}

/** 一轮刷新。userOptions 为 plugins.json 里本插件当前 options（可 undefined）。 */
export async function runCycle(hostOptions) {
  // 发布基准用 plugins.json 里的原始用户 options（只读）：宿主传入的
  // hostOptions 可能被 magpie 改写过（无页面进程会把 servicePort 挪到
  // 空闲端口），写回时会污染用户配置；运行时行为仍用 hostOptions。
  const userOptions = readUserOptions() ?? hostOptions ?? {}
  const cfg = { ...DEFAULTS, ...hostOptions }
  const statePath = cfg.statePath || path.join(defaultStateDir(), "catalog-state.json")
  const cacheDir = cfg.cacheDir || defaultCacheDir()
  const lockDir = path.join(path.dirname(statePath), "cycle.lock")
  // 整轮一把跨进程锁：并发/嵌套副本（发布子 CLI 再启宿主加载本插件时
  // spawn 出的下一轮）直接跳过，链条就此收敛。
  if (!takeLock(lockDir)) {
    console.error("team-catalog: another cycle in flight; skipping")
    return
  }
  try {
    // registry 拉取（本地/http/git，见 source.mjs）；拉不到时 fail-open 抛错
    const src = await loadRegistry(cfg.registry, { cacheDir })
    const text = readFileSync(src.path, "utf8")
    const registry = parseRegistry(text)
    const overrides = userOptions?.overrides ?? {}
    const effective = registry.tools.map((t) => effectiveTool(t, overrides[t.id], PLATFORM))
    const findings = await probeAll(effective, {
      timeoutMs: cfg.probeTimeoutMs,
      concurrency: cfg.concurrency,
    })
    const states = {}
    for (const t of effective) {
      const f = findings[t.id] ?? { found: false }
      states[t.id] = {
        status: toolStatus(t, f),
        ...(f.version ? { version: f.version } : {}),
        ...(f.via ? { via: f.via } : {}),
        at: f.at ?? Date.now(),
      }
    }
    writeState(statePath, { checkedAt: Date.now(), tools: states })
    const index = buildIndex(registry, states, { showMissing: cfg.showMissing })
    // 空索引且从未发布过：不发（避免空目录触发无意义的发布链）
    const published = userOptions?.index ?? null
    const want = index !== "" || published !== null ? index : null
    if (want !== null && want !== published) await publishIndex(userOptions, index, cfg)
  } catch (e) {
    // fail-open：探测/解析挂了当这轮没发生，保留旧 state 与旧索引
    console.error(`team-catalog: cycle skipped: ${e?.message ?? e}`)
  } finally {
    releaseLock(lockDir)
  }
}

/**
 * 只读 plugins.json 里本插件的用户 options（发布基准）。匹配规则与
 * magpie plugin options 的名字解析对齐：文件夹插件按目录名，npm 包按
 * 去掉 scope 的包名；另兼容 spec 直接等于本插件目录。读不到返回 null。
 */
export function readUserOptions() {
  try {
    const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
    const list = JSON.parse(readFileSync(path.join(base, "magpie", "plugins.json"), "utf8"))
    const entries = list?.plugins ?? []
    const entry = entries.find(
      (e) => e?.spec === PLUGIN_DIR || specName(e?.spec) === pluginName(),
    )
    return entry?.options ?? {}
  } catch {
    return null
  }
}

function specName(spec) {
  if (typeof spec !== "string" || spec === "") return ""
  const parts = spec.replace(/\/+$/, "").replace(/\.git$/, "").split("[/\\\\]+")
  return parts[parts.length - 1] ?? ""
}

/** state 原子写（tmp + rename），目录不存在则建。 */
function writeState(statePath, state) {
  const dir = path.dirname(statePath)
  mkdirSync(dir, { recursive: true })
  const tmp = `${statePath}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, statePath)
}

/**
 * 索引发布：shell 出 magpie CLI 写本插件 options（SetOptions → 写 plugins.json
 * + 网关侧 1s 内热重载 middleware）。写回的对象保留用户键，只更新 index；
 * 只在内容变化时调用（runCycle 已判断），避免宿主重启循环。
 */
async function publishIndex(userOptions, index, cfg) {
  const bin = findMagpie(cfg)
  if (!bin) {
    console.error("team-catalog: magpie binary not found; index not published (set options.magpieBin)")
    return
  }
  const payload = JSON.stringify({ ...userOptions, index })
  const r = await runCmd(bin, ["plugin", "options", pluginName(), payload], 30000)
  if (!r.ok) {
    console.error(`team-catalog: magpie plugin options ${pluginName()} failed: ${r.error}`)
  }
}

/** magpie 可执行文件：options 覆盖 > PATH > 平台默认安装位。 */
export function findMagpie(cfg = {}) {
  const candidates = []
  if (cfg.magpieBin) candidates.push(cfg.magpieBin)
  try {
    const w = typeof Bun !== "undefined" ? Bun.which("magpie") : null
    if (w) candidates.push(w)
  } catch {}
  if (process.platform === "darwin") {
    candidates.push("/Applications/magpie.app/Contents/MacOS/magpie")
    candidates.push(path.join(homedir(), "Applications/magpie.app/Contents/MacOS/magpie"))
  } else if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA
    if (la) candidates.push(path.join(la, "Programs", "magpie", "magpie.exe"))
  } else {
    candidates.push("/usr/local/bin/magpie")
    candidates.push(path.join(homedir(), ".local/bin/magpie"))
  }
  return candidates.find((c) => c && existsSync(c)) ?? null
}

/** magpie plugin options 用的名字：文件夹插件取目录名，npm 包取包名。 */
export function pluginName() {
  return path.basename(PLUGIN_DIR) || "magpie-team-catalog"
}

/** 跨进程锁：目录创建即得锁；陈锁（>5 分钟）视为残留，夺锁。 */
function takeLock(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    // 目录已存在则视为锁被占（mkdirSync recursive 不报 EEXIST，需显式判断）
    if (!existsSync(path.join(dir, "info"))) {
      writeFileSync(path.join(dir, "info"), String(Date.now()))
      return true
    }
    if (Date.now() - statSync(path.join(dir, "info")).mtimeMs > 5 * 60 * 1000) {
      rmSync(dir, { recursive: true, force: true })
      return takeLock(dir)
    }
    return false
  } catch {
    return false
  }
}

function releaseLock(dir) {
  rmSync(dir, { recursive: true, force: true })
}
