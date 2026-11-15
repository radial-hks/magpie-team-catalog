// 团队 registry + 个人注册层；页面、worker、MCP 共用，个人文件从不写进插件目录。
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { parseRegistry, validateRegistry } from "./core.mjs"
import { projectKind } from "./project-model.mjs"
import { loadRegistry, defaultStateDir, defaultCacheDir } from "./source.mjs"

export const emptyRegistry = () => ({ version: 1, tools: [], projects: [] })
export function localRegistryPath(options = {}) {
  if (options.localRegistry === false) return null
  if (typeof options.localRegistry === "string" && /^(?:https?:|git\+|git@)/i.test(options.localRegistry)) throw new Error("localRegistry must be a local file")
  if (options.localRegistry && typeof options.localRegistry !== "string") throw new Error("localRegistry must be a local path or false")
  const file = options.localRegistry ? (options.localRegistry.startsWith("file://") ? fileURLToPath(options.localRegistry) : path.resolve(options.localRegistry)) : path.join(options.statePath ? path.dirname(options.statePath) : defaultStateDir(), "local-registry.yaml")
  const pluginDir = path.dirname(import.meta.dir)
  const relative = path.relative(pluginDir, file)
  if (relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) throw new Error("个人 registry 必须保存在插件目录之外，避免升级覆盖")
  return file
}
const revisionOf = (text) => createHash("sha256").update(text).digest("hex")

/** 缺省文件不存在是正常状态；坏文件不得静默覆盖。 */
export function readLocalRegistry(options = {}) {
  const file = localRegistryPath(options)
  if (!file) return { registry: emptyRegistry(), path: null, revision: null }
  let text
  try { text = readFileSync(file, "utf8") } catch (e) {
    if (e.code === "ENOENT") return { registry: emptyRegistry(), path: file, revision: revisionOf("") }
    throw e
  }
  return { registry: parseRegistry(text), path: file, revision: revisionOf(text) }
}

/** 本机条目不能占用团队 ID（tools/projects 共用命名空间）。 */
export function mergeRegistries(team, local, { strict = false } = {}) {
  const ids = new Set([...team.tools, ...team.projects].map(e => e.id))
  const warnings = []
  const append = (entries) => entries.filter(e => {
    if (!ids.has(e.id)) return true
    const message = `个人条目 ${e.id} 与团队 ID 冲突，请重命名；修改团队工具请使用本机覆盖`
    if (strict) throw new Error(message)
    warnings.push(message)
    return false
  }).map(e => ({ ...e, source: "local" }))
  const bindings = local.projectBindings ?? {}
  const teamProjects = new Map(team.projects.map(p => [p.id, p]))
  for (const [id, binding] of Object.entries(bindings)) {
    const project = teamProjects.get(id)
    const message = !project ? `本机项目绑定 ${id} 没有对应团队项目` : binding.p4 && projectKind(project) !== "p4" ? `团队项目 ${id} 不是 P4 项目，不能绑定 P4 Client` : null
    if (message) { if (strict) throw new Error(message); warnings.push(message) }
  }
  return {
    registry: { version: 1, tools: [...team.tools.map(e => ({ ...e, source: "team" })), ...append(local.tools)], projects: [...team.projects.map(e => {
      const binding = bindings[e.id]
      return { ...e, source: "team", ...(binding && (!binding.p4 || projectKind(e) === "p4") ? { ...binding, p4: binding.p4 ? { ...e.p4, ...binding.p4 } : e.p4, bindingSource: "local" } : {}) }
    }), ...append(local.projects)] },
    warnings,
  }
}

export async function loadTeamRegistry(options = {}) {
  const src = await loadRegistry(options.registry, { cacheDir: options.cacheDir || defaultCacheDir(), cacheOnly: options.cacheOnly === true })
  return { registry: parseRegistry(readFileSync(src.path, "utf8")), base: src.base }
}

/** 一层坏了另一层仍可用，但总是携带诊断；两层都失败才抛错。 */
export async function loadCatalog(options = {}) {
  const warnings = []
  let team, local, teamBase = "", teamError
  try { const t = await loadTeamRegistry(options); team = t.registry; teamBase = t.base } catch (e) {
    teamError = e
    warnings.push(`团队 registry 不可读：${e.message}`)
    team = emptyRegistry()
  }
  try { local = readLocalRegistry(options) } catch (e) {
    warnings.push(`个人 registry 不可读（未修改文件）：${e.message}`)
    if (teamError) throw new Error(warnings.join("；"))
    local = { registry: emptyRegistry(), path: null }
  }
  if (teamError && local.registry.tools.length + local.registry.projects.length === 0) throw teamError
  const merged = mergeRegistries(team, local.registry)
  return { ...merged, warnings: [...warnings, ...merged.warnings], bases: { team: teamBase, local: local.path ? path.dirname(local.path) : "" }, local }
}

/** 原子写 + 跨进程写锁 + revision CAS；未通过校验/冲突检查不写盘。 */
export async function saveLocalRegistry(registry, expectedRevision, options = {}) {
  registry = validateRegistry(registry)
  if (typeof expectedRevision !== "string") throw new Error("revision is required; reload before saving")
  const file = localRegistryPath(options)
  if (!file) throw new Error("个人注册层已关闭（localRegistry=false）")
  // 写入时必须能确认团队 ID，远端不可读则拒绝写，不猜测冲突。
  const team = await loadTeamRegistry(options)
  mergeRegistries(team.registry, registry, { strict: true })
  mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.write-lock`
  try { mkdirSync(lock) } catch (e) { if (e.code === "EEXIST") throw new Error("个人目录正在保存，请稍后重试"); throw e }
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    const current = readLocalRegistry(options)
    if (current.revision !== expectedRevision) throw new Error("个人目录已被其它窗口修改，请重新加载后保存")
    // JSON 是 YAML 子集；页面保存为规范 JSON，保留所有声明字段，不落盘来源标记。
    const clean = { version: 1, tools: registry.tools.map(({ source, ...entry }) => entry), projects: registry.projects.map(({ source, bindingSource, ...entry }) => entry), ...(registry.projectBindings ? { projectBindings: registry.projectBindings } : {}) }
    const text = JSON.stringify(clean, null, 2) + "\n"
    writeFileSync(tmp, text, { flag: "wx" })
    renameSync(tmp, file)
    return readLocalRegistry(options)
  } finally {
    rmSync(tmp, { force: true })
    rmSync(lock, { recursive: true, force: true })
  }
}
