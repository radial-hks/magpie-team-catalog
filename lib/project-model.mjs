// 项目/本机绑定纯校验与响应组装。不执行 Git/P4，不包含凭据。
import path from "node:path"

export function projectKind(project) {
  return project.kind ?? (project.p4 || /^perforce:|^p4:/i.test(project.vcs ?? "") ? "p4" : project.localPath || project.vcs ? "git" : "directory")
}
export function validateLocalPath(value, label = "localPath") {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value) || !(path.isAbsolute(value) || path.win32.isAbsolute(value))) throw new Error(`${label} must be an absolute local path`)
}
export function validateP4(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("p4 must be a mapping")
  const allowed = new Set(["port", "user", "client", "stream", "depotPath", "view", "configFile"])
  for (const [key, v] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`p4.${key} is unsupported (credentials must not be registered)`)
    if (key === "view") {
      if (!Array.isArray(v) || v.some(line => typeof line !== "string" || /[\0\r\n]/.test(line)) || v.length > 200) throw new Error("p4.view must be a list of mapping lines (max 200)")
    } else if (typeof v !== "string" || /[\0\r\n]/.test(v)) throw new Error(`p4.${key} must be a string`)
    if (["port", "user", "client"].includes(key) && v && (/^[\s-]/.test(v) || /[\s"';&|<>%]/.test(v))) throw new Error(`p4.${key} contains unsupported characters`)
    if (["stream", "depotPath"].includes(key) && v && !v.startsWith("//")) throw new Error(`p4.${key} must start with //`)
    if (key === "configFile" && v) validateLocalPath(v, "p4.configFile")
  }
}
export function validateProjectFields(project) {
  if (project.kind !== undefined && !["git", "p4", "directory"].includes(project.kind)) throw new Error("project.kind must be git|p4|directory")
  for (const key of ["name", "vcs", "url", "note"]) if (project[key] !== undefined && typeof project[key] !== "string") throw new Error(`project.${key} must be a string`)
  if (project.localPath !== undefined) validateLocalPath(project.localPath)
  if (project.p4 !== undefined) validateP4(project.p4)
  if (!project.vcs && !project.url && !project.localPath && !project.p4?.client) throw new Error("project needs vcs or url or localPath or p4.client")
  if (project.p4 && projectKind(project) !== "p4") throw new Error("p4 metadata requires kind=p4")
}
export function validateBindings(bindings) {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new Error("projectBindings must be a mapping")
  for (const [id, binding] of Object.entries(bindings)) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) throw new Error("projectBindings key must be a project id")
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error(`projectBindings.${id} must be a mapping`)
    for (const key of Object.keys(binding)) if (!["localPath", "p4"].includes(key)) throw new Error(`projectBindings.${id}.${key} cannot override team metadata`)
    if (binding.localPath !== undefined) validateLocalPath(binding.localPath)
    if (binding.p4 !== undefined) validateP4(binding.p4)
  }
}

/** 远端 URL 不暴露 embedded credentials、query/fragment；不访问远端。 */
export function safeRemote(value) {
  if (typeof value !== "string") return ""
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href } catch { return "" }
  }
  return value.replace(/[\r\n\0]/g, "").replace(/([?&#](?:token|password|key)=).*/i, "$1[redacted]")
}
export function projectJSON(project, state) {
  return {
    id: project.id,
    ...(project.name ? { name: project.name } : {}),
    ...(project.source ? { source: project.source } : {}),
    kind: projectKind(project),
    ...(project.vcs ? { vcs: safeRemote(project.vcs) } : {}),
    ...(project.url ? { url: safeRemote(project.url) } : {}),
    ...(project.note ? { note: project.note } : {}),
    ...(project.localPath ? { localPath: project.localPath } : {}),
    ...(project.p4 ? { p4: project.p4 } : {}),
    ...(project.bindingSource ? { bindingSource: project.bindingSource } : {}),
    ...(state ? { local: state } : {}),
  }
}
