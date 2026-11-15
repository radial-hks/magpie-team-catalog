// 安装 spec 的身份解析：Git URL/#ref、npm 版本与就地目录均匹配包名。
import path from "node:path"
export function specName(spec) {
  if (typeof spec !== "string" || !spec) return ""
  const clean = spec.split("#")[0].split("?")[0].replace(/[/\\]+$/, "").replace(/\.git$/i, "")
  const leaf = clean.split(/[/\\]/).pop() ?? ""
  return leaf.replace(/@[^@]+$/, "").replace(/^npm:/, "")
}
export function pluginPackageName(pluginDir) {
  // packageName 在 cycle 层读取，单独函数避免入口被当插件调用。
  return path.basename(pluginDir) || "magpie-team-catalog"
}
export function findPluginEntry(entries, { pluginDir, packageName }) {
  return entries.find(entry => typeof entry?.spec === "string" && (
    entry.spec === pluginDir || specName(entry.spec) === packageName || specName(entry.spec) === pluginPackageName(pluginDir)
  ))
}
