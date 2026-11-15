// core.mjs — 纯逻辑：registry 校验、平台/用户覆盖合并、状态判定、索引构建。
// 无 IO、无定时器，bun test 全覆盖。状态语义纪律见 docs/design.md §5.2：
// 探测只能证明「该安装途径下存在」（present），不能证明「已配置」。

import { parseYAML } from "./yaml.mjs"
import { validateProjectFields, validateBindings, safeRemote } from "./project-model.mjs"

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const KINDS = new Set(["npm", "pipx", "pip", "brew", "binary"])
const STATUS = new Set(["unknown", "missing", "present", "outdated", "configured"])

/** 解析并校验 registry 文本。不合 schema 即抛错（fail-open 由调用方兜底）。 */
export function parseRegistry(text) {
  const doc = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYAML(text)
  return validateRegistry(doc)
}

/** JSON/页面注册与 YAML 共用同一套校验，不执行任何命令。 */
export function validateRegistry(doc) {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("registry: top level must be a mapping")
  }
  if (doc.version !== 1) throw new Error(`registry: unsupported version ${JSON.stringify(doc.version)}`)
  const tools = doc.tools ?? []
  const projects = doc.projects ?? []
  if (!Array.isArray(tools) || !Array.isArray(projects)) {
    throw new Error("registry: tools and projects must be lists")
  }
  const seen = new Set()
  for (const t of tools) validateTool(t, seen)
  for (const p of projects) validateProject(p, seen)
  if (doc.projectBindings !== undefined) validateBindings(doc.projectBindings)
  return { version: 1, tools, projects, ...(doc.projectBindings !== undefined ? { projectBindings: doc.projectBindings } : {}) }
}

function validateTool(t, seen) {
  if (typeof t !== "object" || t === null) throw new Error("registry: tool entry must be a mapping")
  requireString(t, "id", ID_RE, "tool")
  if (seen.has(t.id)) throw new Error(`registry: duplicate id ${t.id}`)
  seen.add(t.id)
  if (!KINDS.has(t.kind)) throw new Error(`registry: tool ${t.id}: kind must be one of ${[...KINDS].join("|")}`)
  requireString(t, "install", /.+/, `tool ${t.id}`)
  if (t.package !== undefined) {
    requireString(t, "package", /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i, `tool ${t.id}`)
    if (t.package.split("/").some(part => part === "." || part === "..")) throw new Error(`registry: tool ${t.id}: invalid package`)
  }
  if (t.skill !== undefined && t.skill !== "") requireString(t, "skill", ID_RE, `tool ${t.id}`)
  for (const key of ["name", "usage", "doc", "documentation", "skill"]) {
    if (t[key] !== undefined && typeof t[key] !== "string") throw new Error(`registry: tool ${t.id}: ${key} must be a string`)
  }
  if (t.check !== undefined) {
    if (typeof t.check !== "object" || t.check === null || Array.isArray(t.check)) {
      throw new Error(`registry: tool ${t.id}: check must be a mapping`)
    }
    if (t.check.bin !== undefined && typeof t.check.bin !== "string") {
      throw new Error(`registry: tool ${t.id}: check.bin must be a string`)
    }
    // 单条目超时（毫秒）：慢命令（输出多、冷启动）可单独放宽，
    // 默认继承全局 probeTimeoutMs。必须是正整数，不许字符串/表达式。
    if (t.check.timeoutMs !== undefined && (typeof t.check.timeoutMs !== "number" || !Number.isInteger(t.check.timeoutMs) || t.check.timeoutMs <= 0)) {
      throw new Error(`registry: tool ${t.id}: check.timeoutMs must be a positive integer (milliseconds)`)
    }
    // 防注入纪律（schema 层面）：命令字段只能是固定参数数组
    for (const key of ["version", "probe"]) {
      if (t.check[key] === undefined) continue
      if (!Array.isArray(t.check[key]) || t.check[key].some((a) => typeof a !== "string")) {
        throw new Error(`registry: tool ${t.id}: check.${key} must be a list of strings`)
      }
    }
  }
  if (t.platform !== undefined) {
    if (typeof t.platform !== "object" || t.platform === null || Array.isArray(t.platform)) {
      throw new Error(`registry: tool ${t.id}: platform must be a mapping`)
    }
    for (const [platform, config] of Object.entries(t.platform)) {
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`registry: tool ${t.id}: platform.${platform} must be a mapping`)
      if (config.check !== undefined && (!config.check || typeof config.check !== "object" || Array.isArray(config.check))) throw new Error(`registry: tool ${t.id}: platform.${platform}.check must be a mapping`)
      validateTool({ ...t, platform: undefined, install: config.install ?? t.install, check: { ...t.check, ...config.check, ...(config.bin !== undefined ? { bin: config.bin } : {}) } }, new Set())
    }
  }
  if (t.min !== undefined && typeof t.min !== "string") {
    throw new Error(`registry: tool ${t.id}: min must be a version string`)
  }
}

function validateProject(p, seen) {
  if (typeof p !== "object" || p === null) throw new Error("registry: project entry must be a mapping")
  requireString(p, "id", ID_RE, "project")
  if (seen.has(p.id)) throw new Error(`registry: duplicate id ${p.id}`)
  seen.add(p.id)
  validateProjectFields(p)
}

function requireString(entry, key, re, what) {
  const v = entry[key]
  if (typeof v !== "string" || !re.test(v)) {
    throw new Error(`registry: ${what}: ${key} ${JSON.stringify(v)} doesn't match ${re}`)
  }
}

/**
 * 平台差异（platform.darwin/windows 的 install/bin/check）+ 本机用户覆盖
 * （overrides.{id}）合并后的有效条目。覆盖层三键：bin（探测路径）、
 * enabled（false 即禁用）、status（钉死）。
 */
export function effectiveTool(tool, override, platform) {
  const plat = tool.platform?.[platform] ?? {}
  const check = { ...tool.check, ...(plat.check ?? {}) }
  if (typeof plat.bin === "string" && plat.bin !== "") check.bin = plat.bin
  const merged = {
    ...tool,
    install: plat.install ?? tool.install,
    check,
  }
  if (override) {
    if (typeof override.bin === "string" && override.bin !== "") merged.check = { ...merged.check, bin: override.bin }
    if (override.enabled === false) merged.disabled = true
    if (typeof override.status === "string" && STATUS.has(override.status)) merged.pinned = override.status
  }
  return merged
}

/**
 * 探测结果 → 状态。finding: {found: bool, version?: string}。
 * kind 探测上限是 present；只有 probe 通过才 configured（M2 按需触发，M1 不做）。
 */
export function toolStatus(tool, finding) {
  if (tool.disabled) return "disabled"
  if (tool.pinned) return tool.pinned
  if (!finding || !finding.found) return "missing"
  if (tool.min && finding.version && versionLt(finding.version, tool.min)) return "outdated"
  return "present"
}

/** 版本提取：Perforce Rev 行优先（避免误读 OpenSSL），其余取首个 semver。 */
export function firstSemver(text) {
  if (typeof text !== "string") return null
  const perforce = text.match(/^Rev\.\s+(?:P4|P4V)\/[^/\r\n]+\/(\d{4}\.\d+)\/(\d+)\b/m)
  if (perforce) return `${perforce[1]}.${perforce[2]}`
  const m = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  return m ? m[0] : null
}

/** 逐段数值比较；解析不了按相等处理（宁可不标 outdated）。 */
export function versionLt(a, b) {
  const pa = String(a).split(".")
  const pb = String(b).split(".")
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? "0")
    const y = Number(pb[i] ?? "0")
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x !== y) return x < y
  }
  return false
}

/** vcs 地址缩写：github SSH/HTTPS → github:owner/repo；perforce → p4://depot/... */
export function abbreviateVcs(vcs) {
  if (typeof vcs !== "string") return ""
  let m = vcs.match(/^git@github\.com:(.+?)(?:\.git)?$/)
  if (m) return `github:${m[1]}`
  m = vcs.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/)
  if (m) return `github:${m[1]}`
  m = vcs.match(/^perforce:\/\/[^/]+\/\/(.+)$/)
  if (m) return `p4://${m[1]}`
  return vcs
}

/**
 * 压缩索引（常数级 token 成本），middleware 注入的最终文本。
 * 只含本机 available（present/outdated/configured）的工具；disabled 与 missing
 * 不出现（showMissing: true 时 missing 以一行「未安装」清单带出）。
 * 空目录返回 ""（调用方据此不注入）。
 */
export function buildIndex(registry, states, opts = {}) {
  const available = []
  const missing = []
  for (const t of registry.tools) {
    const st = states[t.id] ?? { status: "unknown" }
    if (st.status === "disabled" || st.status === "unknown") continue
    if (st.status === "missing") {
      missing.push(t.id)
      continue
    }
    available.push(renderTool(t, st))
  }
  const lines = []
  if (available.length > 0 || (opts.showMissing && missing.length > 0)) {
    let line = "团队内部工具目录（本机实测）："
    if (available.length > 0) line += available.join(" · ")
    else line += "（本机暂无）"
    lines.push(line)
  }
  if (opts.showMissing && missing.length > 0) {
    lines.push(`未安装：${missing.join(" · ")}`)
  }
  const projects = registry.projects ?? []
  if (projects.length > 0) {
    lines.push(`团队项目地址：${projects.map((p) => `${p.id}=${abbreviateVcs(safeRemote(p.vcs ?? p.url ?? p.localPath ?? (p.p4?.client ? `p4:${p.p4.client}` : "")))}`).join(" · ")}`)
  }
  return lines.length > 0 ? lines.join("\n") : ""
}

function renderTool(tool, st) {
  const id = tool.id
  if (st.status === "outdated") return `${id}(${st.version ?? "?"},需更新)`
  if (st.status === "configured") return st.version ? `${id}(${st.version})` : id
  if (st.version) return `${id}(${st.version})`
  return id
}
