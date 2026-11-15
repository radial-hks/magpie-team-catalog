// GUI 设置白名单 + 乐观并发校验，不允许覆盖 index / 任意用户键。
import { createHash } from "node:crypto"
export const SETTINGS_KEYS = ["registry", "localRegistry", "interval", "probeTimeoutMs", "concurrency", "magpieBin", "showMissing", "injectIndex", "skillExport", "skillsRepo", "skillPrefix"]
export function optionsRevision(options) {
  const stable = value => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : Array.isArray(value) ? value.map(stable) : value
  const { index, ...editable } = options
  return createHash("sha256").update(JSON.stringify(stable(editable))).digest("hex")
}
export function mergeUIOptions(current, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("配置请求必须为对象")
  if (body.revision !== optionsRevision(current)) throw Error("配置已被其它窗口修改，请重新加载后再保存")
  for (const key of Object.keys(body)) if (!["settings", "overrides", "revision"].includes(key)) throw Error(`不支持的配置字段：${key}`)
  if (body.settings === undefined && body.overrides === undefined) throw Error("请提供 settings 或 overrides")
  const next = { ...current }
  if (body.overrides !== undefined) {
    if (!body.overrides || typeof body.overrides !== "object" || Array.isArray(body.overrides)) throw Error("overrides 必须为对象")
    for (const [id, value] of Object.entries(body.overrides)) {
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id) || !value || typeof value !== "object" || Array.isArray(value)) throw Error("本机覆盖格式无效")
      for (const [key, v] of Object.entries(value)) if (!(key === "bin" && typeof v === "string" && !/[\0\r\n]/.test(v) || key === "enabled" && typeof v === "boolean" || key === "status" && ["unknown", "missing", "present", "outdated", "configured"].includes(v))) throw Error(`无效覆盖：${id}.${key}`)
    }
    next.overrides = body.overrides
  }
  if (body.settings !== undefined) {
    const settings = body.settings
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw Error("settings 必须为对象")
    for (const [key, value] of Object.entries(settings)) {
      if (!SETTINGS_KEYS.includes(key)) throw Error(`不能编辑设置：${key}`)
      if (["interval", "probeTimeoutMs", "concurrency"].includes(key)) {
        const limits = { interval: [60, 86400], probeTimeoutMs: [100, 60000], concurrency: [1, 32] }[key]
        if (!Number.isInteger(value) || value < limits[0] || value > limits[1]) throw Error(`${key} 必须是 ${limits[0]}–${limits[1]} 之间的整数`)
      } else if (["showMissing", "injectIndex", "skillExport"].includes(key)) { if (typeof value !== "boolean") throw Error(`${key} 必须为布尔值`) }
      else if (key === "localRegistry" && value === false) { /* 关闭个人层 */ }
      else if (typeof value !== "string" || /[\0\r\n]/.test(value)) throw Error(`${key} 必须为单行文本`)
      next[key] = value
    }
    if (next.skillExport && !next.skillsRepo) throw Error("开启 Skill 导出时需填写 skillsRepo")
  }
  return next
}
