// source.mjs — registry 数据源统一入口：本地路径 / http(s) / git。
// 三种形态最终都归结为「一个本地文件路径 + 文档基址（目录或 URL）」：
//   local: 直接读
//   http:  每轮下载到缓存目录（失败时沿用上一次缓存——fail-open）
//   git:   缓存目录里 clone（首次）/fetch+reset（之后），凭据走本机 git 配置
// cycle / tool / service 共用这里，替代此前各自的 resolveRegistry 副本。

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"

const PLUGIN_DIR = path.dirname(import.meta.dir)

/** spec 形态判定。 */
export function specKind(spec) {
  if (typeof spec !== "string" || spec === "") return "local"
  if (/^https?:\/\//i.test(spec)) {
    // 末段以 .git 结尾的是仓库地址，否则当 http 文件直链
    const noFrag = spec.split("#")[0]
    return /\/[^\/?#]+\.git$/.test(noFrag) ? "git" : "http"
  }
  if (spec.startsWith("git+")) return "git"
  if (spec.startsWith("git@")) return "git"
  return "local"
}

/**
 * 解析 spec → 可读的 registry.yaml 路径与文档基址。
 * base: 本地目录路径（local/git），或 URL 字符串（http，文档按 URL 拼接）。
 * 失败时抛错（调用方 fail-open：沿用旧缓存或跳过本轮）。
 */
export async function loadRegistry(spec, { cacheDir, timeoutMs = 15000 } = {}) {
  const kind = specKind(spec)
  if (kind === "local") {
    const p = resolveLocal(spec)
    return { path: p, base: path.dirname(p), kind }
  }
  if (kind === "http") {
    const cache = await downloadToCache(spec, cacheDir, timeoutMs)
    return { path: cache, base: dirUrl(spec), kind }
  }
  // git
  const { url, ref } = splitGitRef(spec)
  const repoDir = path.join(cacheDir, "registry-repo")
  await syncGitRepo(url, ref, repoDir, timeoutMs * 4)
  const p = findRegistryYaml(repoDir)
  return { path: p, base: path.dirname(p), kind }
}

/**
 * 解析「仓库根」spec → 本地目录路径（skill 仓库用：要的是目录，不是单文件）。
 * local：目录路径；git：clone 到 <cacheDir>/skills-repo 后返回；http 不支持
 * 目录，抛错（调用方 fail-open）。
 */
export async function loadRepo(spec, { cacheDir, timeoutMs = 15000 } = {}) {
  const kind = specKind(spec)
  if (kind === "local") {
    const dir = path.dirname(resolveLocal(spec))
    if (!existsSync(dir)) throw new Error(`repo dir not found: ${dir}`)
    return { root: dir, kind }
  }
  if (kind === "http") throw new Error(`http spec 不支持目录仓库（skill 仓库请用本地路径或 git spec）: ${spec}`)
  const { url, ref } = splitGitRef(spec)
  const repoDir = path.join(cacheDir, "skills-repo")
  await syncGitRepo(url, ref, repoDir, timeoutMs * 4)
  return { root: repoDir, kind }
}

/** 文档读取：base 是目录 → 本地文件；是 URL → 按相对路径拼接抓取。 */
export async function readRegistryDoc(base, docPath, timeoutMs = 10000) {
  if (typeof docPath !== "string" || docPath === "") return null
  if (/^https?:\/\//i.test(String(base))) {
    try {
      const r = await fetch(new URL(docPath, base).href, { signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) return null
      return await r.text()
    } catch {
      return null
    }
  }
  try {
    const p = path.join(base, docPath)
    if (!existsSync(p)) return null
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

// —— local ——

function resolveLocal(spec) {
  if (typeof spec !== "string" || spec === "") return path.join(PLUGIN_DIR, "registry/registry.yaml")
  const s = spec.replace(/^file:\/\//, "")
  if (path.isAbsolute(s)) return s
  return path.join(PLUGIN_DIR, s)
}

// —— http ——

async function downloadToCache(url, cacheDir, timeoutMs) {
  mkdirSync(cacheDir, { recursive: true })
  const target = path.join(cacheDir, "registry.yaml")
  const tmp = `${target}.tmp`
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`registry ${url} answered ${r.status}`)
  const text = await r.text()
  writeFileSync(tmp, text)
  renameSync(tmp, target)
  return target
}

/** http registry 的文档基址：URL 目录部分（…/registry.yaml → …/）。 */
function dirUrl(url) {
  try {
    return new URL(".", url).href
  } catch {
    return url
  }
}

// —— git ——

function splitGitRef(spec) {
  let url = spec
  let ref = ""
  if (spec.startsWith("git+")) url = spec.slice(4)
  const hash = url.indexOf("#")
  if (hash >= 0) {
    ref = url.slice(hash + 1)
    url = url.slice(0, hash)
  }
  return { url, ref }
}

/** clone（首次）或 fetch+reset（之后）。失败抛错；克隆后更新失败不算致命。 */
async function syncGitRepo(url, ref, repoDir, timeoutMs) {
  if (!existsSync(path.join(repoDir, ".git"))) {
    mkdirSync(path.dirname(repoDir), { recursive: true })
    const args = ["clone", "--depth", "1"]
    if (ref) args.push("--branch", ref)
    args.push("--", url, repoDir)
    await git(args, timeoutMs)
    return
  }
  // 已有克隆：刷新。失败时保留旧内容（fail-open），只记日志
  try {
    if (ref) {
      await git(["-C", repoDir, "fetch", "--depth", "1", "origin", ref], timeoutMs)
      await git(["-C", repoDir, "reset", "--hard", "FETCH_HEAD"], timeoutMs)
    } else {
      await git(["-C", repoDir, "pull", "--ff-only"], timeoutMs)
    }
  } catch (e) {
    console.error(`team-catalog: registry repo refresh skipped: ${e?.message ?? e}`)
  }
}

function findRegistryYaml(repoDir) {
  for (const name of ["registry.yaml", "registry.yml"]) {
    const p = path.join(repoDir, name)
    if (existsSync(p)) return p
  }
  throw new Error(`no registry.yaml in ${repoDir}`)
}

function git(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) reject(new Error(`git ${args[0]} ${args[1] ?? ""}: ${(stderr || stdout || e.message).trim().slice(0, 200)}`))
      else resolve({ stdout, stderr })
    })
  })
}

// —— 供 cycle/tool/service 共用的路径约定 ——

export function defaultStateDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return path.join(base, "magpie", "team-catalog")
}

export function defaultCacheDir() {
  return path.join(defaultStateDir(), "registry-cache")
}
