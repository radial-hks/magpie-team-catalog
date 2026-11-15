// probe.mjs — 本机探测（IO 层，跑在 Bun 宿主）。
// 语义纪律：kind 探测（npm/pipx/brew/PATH）命中上限是 present，不升 configured；
// probe 命令按需触发是 M2。每命令 5s 超时，整体并发 ≤8（由 probeAll 控制）。
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { firstSemver } from "./core.mjs"

const DEFAULT_TIMEOUT_MS = 5000

/** 按当前 PATH/PATHEXT 找 Windows 原生启动器，不选 npm 同名的 POSIX 脚本。 */
function windowsExecutable(bin) {
  if (typeof bin !== "string" || bin === "") return null
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin) ? bin : null
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    .filter((ext) => /^\.(exe|com|cmd|bat)$/i.test(ext))
  const names = /\.(exe|com|cmd|bat)$/i.test(bin) ? [bin] : extensions.map((ext) => bin + ext)
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.resolve(dir.replace(/^"|"$/g, ""), name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

// GUI 启动的 magpie 宿主进程 PATH 可能只有系统默认（无 /opt/homebrew/bin 等），
// 探测命令都带一份常见绝对路径回退。
const CMD_FALLBACKS = {
  npm: ["/opt/homebrew/bin/npm", "/usr/local/bin/npm"],
  brew: ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"],
  pipx: [path.join(homedir(), ".local/bin/pipx"), "/opt/homebrew/bin/pipx", "/usr/local/bin/pipx"],
}

function resolveCmd(name) {
  for (const p of CMD_FALLBACKS[name] ?? []) {
    if (existsSync(p)) return p
  }
  return name
}

/**
 * execFile 封装：超时即杀；异步失败、同步 spawn 异常都返回 {ok:false}。
 * Windows 批处理必须经 cmd.exe，不能直接 execFile（新版 Bun/Node 报 EINVAL）。
 * 仅该分支使用命令解释器：逐项引用、关闭 AutoRun/延迟展开，并拒绝 shell
 * 特殊字符（包括变量展开），不把 registry 参数变成任意 shell 字符串。
 */
export function runCmd(cmd, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const finish = (e, stdout, stderr) => {
      if (e) resolve({ ok: false, error: e.message, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
      else resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
    }
    try {
      const options = { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true }
      // 按平台 PATHEXT 解析短名（npm 等），不要误选 npm 的 POSIX 无扩展名启动器。
      const exe = process.platform === "win32" ? (windowsExecutable(cmd) ?? cmd) : cmd
      if (process.platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
        const words = [exe, ...args]
        if (words.some((s) => typeof s !== "string" || /["%!^&|<>\r\n\0]/.test(s))) {
          throw new Error("Windows batch command contains unsupported shell characters")
        }
        // 保留空参数/空格；末尾反斜杠翻倍，避免被目标程序的 argv 解析吞掉引号。
        const quote = (s) => `"${s.replace(/(\\+)$/, "$1$1")}"`
        const command = `"${words.map(quote).join(" ")}"`
        execFile(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/v:off", "/c", command], { ...options, windowsVerbatimArguments: true }, finish)
      } else {
        execFile(exe, args, options, finish)
      }
    } catch (e) {
      finish(e)
    }
  })
}

/** 每类包管理器全局清单，一次刷新只拉一遍。结构：{npm: Map(name→version), …}。 */
export async function fetchListings(kinds, timeoutMs) {
  const listings = {}
  const jobs = []
  if (kinds.has("npm")) jobs.push(listing("npm", listings, timeoutMs))
  if (kinds.has("pipx")) jobs.push(listing("pipx", listings, timeoutMs))
  if (kinds.has("brew")) jobs.push(listing("brew", listings, timeoutMs))
  await Promise.allSettled(jobs)
  return listings
}

async function listing(kind, out, timeoutMs) {
  const m = new Map()
  if (kind === "npm") {
    const r = await runCmd(resolveCmd("npm"), ["ls", "-g", "--json"], timeoutMs)
    if (r.ok) {
      try {
        const deps = JSON.parse(r.stdout)?.dependencies ?? {}
        for (const [name, v] of Object.entries(deps)) {
          if (v && typeof v.version === "string") m.set(name, v.version)
        }
      } catch {}
    }
  } else if (kind === "pipx") {
    const r = await runCmd(resolveCmd("pipx"), ["list", "--json"], timeoutMs)
    if (r.ok) {
      try {
        const venvs = JSON.parse(r.stdout)?.venvs ?? {}
        for (const [name, v] of Object.entries(venvs)) {
          const ver = v?.main_package?.package_version
          if (typeof ver === "string") m.set(name, ver)
        }
      } catch {}
    }
  } else if (kind === "brew") {
    const r = await runCmd(resolveCmd("brew"), ["list", "--versions"], timeoutMs)
    if (r.ok) {
      for (const line of r.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 2) m.set(parts[0], parts[1])
      }
    }
  }
  out[kind] = m
}

/** PATH 查找：Windows 直接查 PATH/PATHEXT；POSIX which + 常见 bin 目录回退。 */
const PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(homedir(), ".local/bin"),
  "/usr/bin",
  "/bin",
]

export async function which(bin, timeoutMs) {
  if (typeof bin !== "string" || bin === "") return null
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin) ? bin : null
  // 无需子进程，短预算不消耗在 where 启动上；读取当前而非运行时缓存的 PATH。
  if (process.platform === "win32") return windowsExecutable(bin)
  const r = await runCmd("/usr/bin/which", [bin], timeoutMs)
  if (r.ok) {
    const line = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0]
    if (line) return line
  }
  for (const d of PATH_DIRS) {
    const p = path.join(d, bin)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 单个工具探测。tool 为 effectiveTool 合并后的条目。
 * 返回 finding：{found, via, version?}；状态判定（missing/present/outdated）在 core。
 */
export async function probeTool(tool, { listings = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // 单条目预算优先：check.timeoutMs 声明了就用它，否则继承全局
  const entryTimeout = tool.check?.timeoutMs ?? timeoutMs
  const bin = tool.check?.bin ?? tool.id
  const absolute = bin.includes("/") || bin.includes("\\") || bin.includes("\\\\")
  let found = false
  let via = null
  let version = null
  let exe = null // 解析出的可执行文件（version 探测用它，不靠 PATH）

  if (absolute) {
    if (existsSync(bin)) {
      found = true
      via = "override"
      exe = bin
    }
  } else {
    // 显式 package 优先，旧条目仍兼容包名 === bin / scope/<bin>。
    const list = listings[tool.kind]
    if (list) {
      for (const [name, ver] of list) {
        if (tool.package ? name === tool.package : (name === bin || name.endsWith("/" + bin))) {
          found = true
          via = tool.kind
          version = ver
          break
        }
      }
    }
    // 包清单命中也解析真实可执行路径，Skill 不应缺失本机路径。
    const p = await which(bin, entryTimeout)
    if (p) {
      if (!found) via = "path"
      found = true
      exe = p
    }
  }

  // 版本：声明了 check.version 才跑；kind 清单里读到的优先级低于实测
  if (found && !version && exe && Array.isArray(tool.check?.version) && tool.check.version.length > 0) {
    const r = await runCmd(exe, tool.check.version, entryTimeout)
    if (r.ok) version = firstSemver(r.stdout)
  }
  // path：解析出的可执行文件绝对路径（skill 落盘用）；kind 清单命中时可能没有
  return {
    found,
    via,
    ...(exe ? { path: exe } : {}),
    ...(version ? { version } : {}),
  }
}

/**
 * 全量探测：listings 先各拉一遍，再按并发池逐条探测。
 * overrides 走 effectiveTool（core）由调用方先合并好；这里拿到的是 effective 列表。
 * 返回 states：{id: {status, version?, via?, at}}——disabled/pinned 不探测。
 */
export async function probeAll(effectiveTools, { timeoutMs = DEFAULT_TIMEOUT_MS, concurrency = 8, onStatus } = {}) {
  const kinds = new Set(effectiveTools.filter((t) => !t.disabled && !t.pinned).map((t) => t.kind))
  const listings = await fetchListings(kinds, timeoutMs)
  const states = {}
  const queue = effectiveTools.filter((t) => !t.disabled && !t.pinned)
  let next = 0
  async function worker() {
    while (next < queue.length) {
      const t = queue[next++]
      const finding = await probeTool(t, { listings, timeoutMs })
      states[t.id] = { ...finding, at: Date.now() }
      if (onStatus) onStatus(t.id, states[t.id])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  const now = Date.now()
  for (const t of effectiveTools) {
    if (t.disabled) states[t.id] = { found: false, status: "disabled", at: now }
    else if (t.pinned) states[t.id] = { found: t.pinned !== "missing", status: t.pinned, at: now }
  }
  return states
}
