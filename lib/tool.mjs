// MCP catalog：缓存只读、分页发现 → 精确详情 → 显式只读 probe。无注册/执行通用入口。
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs"
import path from "node:path"
import { effectiveTool } from "./core.mjs"
import { loadCatalog } from "./catalog.mjs"
import { projectJSON, safeRemote } from "./project-model.mjs"
export { projectJSON } from "./project-model.mjs"
import { which, runCmd } from "./probe.mjs"
import { readRegistryDoc, defaultStateDir } from "./source.mjs"
import { validateArgs, STATUS_SCHEMA } from "./mcp-contract.mjs"
import { freshness, toolFingerprint, projectFingerprint } from "./snapshot.mjs"

const textMatches = (query, values) => { const q = (query ?? "").trim().toLowerCase(); return !q || values.some(v => String(v ?? "").toLowerCase().includes(q)) }
export function matchTools(registry, query) {
  return (registry.tools ?? []).filter(t => textMatches(query, [t.id, t.name, t.usage, t.package]))
}
export function matchProjects(registry, query) {
  return (registry.projects ?? []).filter(p => textMatches(query, [p.id, p.name, p.note, safeRemote(p.vcs), p.localPath, p.p4?.port, p.p4?.client, p.p4?.stream, p.p4?.depotPath]))
}

export function entryJSON(tool, st, { probe } = {}) {
  let status = st?.status ?? "unknown"
  if (probe?.ok && status === "present") status = "configured"
  return {
    id: tool.id, ...(tool.name ? { name: tool.name } : {}), kind: tool.kind,
    ...(tool.source ? { source: tool.source } : {}), ...(tool.package ? { package: tool.package } : {}),
    ...(st?.path ? { path: st.path } : {}), status, ...(st?.version ? { version: st.version } : {}),
    ...(tool.min ? { min: tool.min } : {}), ...(tool.usage ? { usage: tool.usage.trim() } : {}), install: tool.install,
    ...(status === "missing" || status === "outdated" ? { fix: tool.install } : {}),
    ...(probe ? { probe: probe.ok ? "ok" : "failed", ...(probe.output ? { probeOutput: probe.output.slice(0, 400) } : {}) } : {}),
  }
}
const failure = (code, message) => ({ error: message, code })

async function context(options, onStale) {
  const opts = { registry: "./registry/registry.yaml", probeTimeoutMs: 5000, interval: 900, ...options }
  let catalog
  try { catalog = await loadCatalog({ ...opts, cacheOnly: true }) } catch (e) {
    onStale?.()
    return { error: failure("REGISTRY_UNAVAILABLE", `registry 不可读：${e.message}`) }
  }
  let state = null
  try { state = JSON.parse(readFileSync(opts.statePath || path.join(defaultStateDir(), "catalog-state.json"), "utf8")) } catch {}
  const meta = freshness(state, opts)
  if (meta.stale || catalog.warnings.length) onStale?.()
  return { opts, catalog, state, meta }
}
function toolState(tool, state) {
  const st = state?.tools?.[tool.id]
  if (tool.disabled) return { status: "disabled" }
  if (tool.pinned) return { status: tool.pinned, pinned: true }
  if (st?.fingerprint && st.fingerprint !== toolFingerprint(tool)) return { status: "unknown", changed: true }
  return st ?? { status: "unknown" }
}
function projectState(project, state) {
  const st = state?.projects?.[project.id]
  if (st?.fingerprint && st.fingerprint !== projectFingerprint(project)) return { status: "unknown", changed: true }
  if (!st) return { status: project.localPath ? "unknown" : "unbound" }
  const { fingerprint, ...out } = st
  return out
}
function toolEntry(tool, state, summary) {
  const st = toolState(tool, state)
  const out = { ...entryJSON(tool, st), ...(tool.pinned ? { pinned: true } : {}), entryType: "tool" }
  if (summary) {
    if (out.usage) out.usage = out.usage.slice(0, 240)
    if (out.install) out.install = out.install.slice(0, 240)
    if (out.fix) out.fix = out.fix.slice(0, 240)
  }
  return out
}
function projectEntry(project, state, summary) {
  const local = projectState(project, state)
  const out = { ...projectJSON(project, local), entryType: "project" }
  if (summary) {
    if (out.note) out.note = out.note.slice(0, 240)
    if (out.p4) { const { view, ...p4 } = out.p4; out.p4 = p4 }
    out.local = { status: local.status, ...(local.branch ? { branch: local.branch } : {}), ...(local.head ? { head: local.head } : {}), ...(local.serverChecked !== undefined ? { serverChecked: local.serverChecked } : {}) }
  }
  return out
}

export async function catalogTool(args = {}, options, { onStale } = {}) {
  const trigger = onStale
  let triggered = false
  onStale = () => { if (!triggered) { triggered = true; trigger?.() } }
  try { validateArgs(args) } catch (e) { return failure("INVALID_ARGUMENT", e.message) }
  const ctx = await context(options, onStale)
  if (ctx.error) return ctx.error
  const { catalog, state, opts } = ctx
  const { registry, bases, warnings } = catalog
  const metadata = { ...ctx.meta, registryIncomplete: warnings.length > 0, readOnly: args.check !== true, ...(warnings.length ? { warnings } : {}) }
  if (args.detail) {
    const tool = registry.tools.find(t => t.id === args.detail)
    if (tool) {
      const eff = effectiveTool(tool, opts.overrides?.[tool.id], process.platform === "win32" ? "windows" : process.platform)
      const st = toolState(eff, state)
      if (st.changed) { onStale?.(); metadata.stale = true; metadata.reason = "registration-changed" }
      let probe
      if (args.check && !metadata.stale && !metadata.registryIncomplete && !eff.disabled && !eff.pinned && ["present", "outdated"].includes(st.status) && eff.check?.probe?.length) probe = await runProbeCmd(eff, Math.min(5000, Math.max(1, opts.probeTimeoutMs)))
      const out = { ...toolEntry(eff, state, false), ...entryJSON(eff, st, { probe }), meta: metadata,
        stateOrigin: eff.pinned ? "user-pinned" : state?.tools?.[tool.id]?.fingerprint ? "measured" : "legacy-or-unmeasured",
        check: { requested: args.check === true, performed: !!probe, ...(probe ? { ok: probe.ok } : {}), note: probe ? "本次声明 probe 结果，未写回周期状态" : "未执行 CLI（禁用/钉死/未安装/无 probe 时跳过）" },
      }
      const doc = eff.documentation ?? await readDoc(bases[tool.source], eff)
      if (doc !== undefined) {
        const offset = args.docOffset ?? 0, limit = args.docLimit ?? 8000
        out.doc = doc.slice(offset, offset + limit)
        out.documentation = { offset, limit, total: doc.length, truncated: offset + limit < doc.length, nextOffset: offset + limit < doc.length ? offset + limit : null }
      }
      return out
    }
    const project = registry.projects.find(p => p.id === args.detail)
    if (project) {
      if (args.check) return failure("INVALID_ARGUMENT", "check 只用于工具详情；P4 服务器查询请在 GUI 授权")
      if (projectState(project, state).changed) { onStale?.(); metadata.stale = true; metadata.reason = "registration-changed" }
      return { ...projectEntry(project, state, false), meta: metadata,
        safety: { serverVerified: false, worktreeCleanVerified: false, writesAuthorized: false, note: "目录存在不代表 P4 登录/权限；Git 分支不代表工作树干净。修改/同步/提交需明确授权。" },
      }
    }
    return failure("NOT_FOUND", `没有 id 为 ${args.detail} 的条目`)
  }

  const changed = registry.tools.some(t => toolState(effectiveTool(t, opts.overrides?.[t.id], process.platform === "win32" ? "windows" : process.platform), state).changed) || registry.projects.some(p => projectState(p, state).changed)
  if (changed) { onStale?.(); metadata.stale = true; metadata.reason = "registration-changed" }
  const summary = args.summary !== false
  const tools = matchTools(registry, args.query).map(t => effectiveTool(t, opts.overrides?.[t.id], process.platform === "win32" ? "windows" : process.platform))
    .filter(t => !t.disabled || args.status === "disabled").map(t => toolEntry(t, state, summary))
  const projects = matchProjects(registry, args.query).map(p => projectEntry(p, state, summary))
  const normalizePath = s => (s ?? "").replace(/\\/g, "/").toLowerCase()
  const filtered = [...tools, ...projects].filter(e =>
    (!args.type || args.type === "all" || e.entryType === args.type) &&
    (!args.source || args.source === "all" || e.source === args.source) &&
    (!args.kind || e.kind === args.kind) && (!args.status || (e.entryType === "tool" ? e.status : e.local.status) === args.status) &&
    (!args.client || e.p4?.client === args.client) && (!args.port || e.p4?.port === args.port) &&
    (!args.path || normalizePath(e.localPath).includes(normalizePath(args.path)))
  ).sort((a, b) => a.id.localeCompare(b.id))
  const offset = args.offset ?? 0, limit = args.limit ?? 20
  const page = filtered.slice(offset, offset + limit)
  return { tools: page.filter(e => e.entryType === "tool"), projects: page.filter(e => e.entryType === "project"),
    pagination: { offset, limit, total: filtered.length, returned: page.length, nextOffset: offset + page.length < filtered.length ? offset + page.length : null },
    meta: metadata, ...(warnings.length ? { warnings } : {}), ...(ctx.meta.checkedAt ? { checkedAt: ctx.meta.checkedAt } : { note: "本机探测尚未完成，status 可能为 unknown，稍后再查" }),
  }
}

export async function catalogStatus(args = {}, options, { onStale } = {}) {
  const trigger = onStale
  let triggered = false
  onStale = () => { if (!triggered) { triggered = true; trigger?.() } }
  try { validateArgs(args, STATUS_SCHEMA) } catch (e) { return failure("INVALID_ARGUMENT", e.message) }
  const ctx = await context(options, onStale)
  if (ctx.error) return ctx.error
  const count = (entries, key) => entries.reduce((result, entry) => { const value = key(entry); result[value] = (result[value] ?? 0) + 1; return result }, {})
  const tools = ctx.catalog.registry.tools.map(t => effectiveTool(t, ctx.opts.overrides?.[t.id], process.platform === "win32" ? "windows" : process.platform))
  const projects = ctx.catalog.registry.projects
  const changed = tools.some(t => toolState(t, ctx.state).changed) || projects.some(p => projectState(p, ctx.state).changed)
  if (changed) onStale?.()
  return { schemaVersion: 1, meta: { ...ctx.meta, registryIncomplete: ctx.catalog.warnings.length > 0, ...(changed ? { stale: true, reason: "registration-changed" } : {}) }, warnings: ctx.catalog.warnings,
    counts: { tools: tools.length, projects: projects.length, toolStatus: count(tools, t => toolState(t, ctx.state).status), projectStatus: count(projects, p => projectState(p, ctx.state).status), projectKind: count(projects, p => projectJSON(p).kind) },
    capabilities: { readOnlyByDefault: true, registration: "GUI only", p4ServerDiscovery: "GUI consent required", toolCheck: "detail + check=true", pagination: "catalog limit/offset", docs: "detail docOffset/docLimit" },
  }
}

export async function runProbeCmd(effTool, timeoutMs = 5000) {
  const bin = effTool.check?.bin ?? effTool.id
  if (!effTool.check?.probe?.length) return null
  const exe = bin.includes("/") || bin.includes("\\") ? (existsSync(bin) ? bin : null) : await which(bin, timeoutMs)
  if (!exe) return { ok: false, output: "executable not found" }
  const r = await runCmd(exe, effTool.check.probe, timeoutMs)
  return { ok: r.ok, output: (r.stdout || r.stderr || "").trim() }
}
export async function readDoc(base, tool) {
  if (!tool.doc) return undefined
  // MCP 默认不联网读远端文档，避免隐式网络开销；用 registry.documentation 内联全文。
  if (/^https?:\/\//i.test(base ?? "")) return undefined
  if (!base || path.isAbsolute(tool.doc) || path.win32.isAbsolute(tool.doc)) return undefined
  const file = path.resolve(base, tool.doc)
  const relative = path.relative(base, file)
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return undefined
  try {
    const actualRelative = path.relative(realpathSync(base), realpathSync(file))
    if (actualRelative === ".." || actualRelative.startsWith(".." + path.sep) || path.isAbsolute(actualRelative) || statSync(file).size > 1024 * 1024) return undefined
  } catch { return undefined }
  return (await readRegistryDoc(base, tool.doc)) ?? undefined
}
