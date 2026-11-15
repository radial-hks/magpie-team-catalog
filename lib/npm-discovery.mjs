// 只读 npm 候选发现：仅运行 npm 清单/root，不执行候选 CLI、不自动注册。
import { readFileSync } from "node:fs"
import path from "node:path"
import { runCmd } from "./probe.mjs"

/** 只把 npm 包自身声明的 bin 作为候选，不把普通依赖库当 CLI。 */
export function npmCandidates(dependencies, readPackage) {
  const candidates = []
  const warnings = []
  for (const [name, info] of Object.entries(dependencies ?? {})) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) continue
    if (name.split("/").some(part => part === "." || part === "..")) continue
    try {
      const pkg = readPackage(name)
      const bins = typeof pkg.bin === "string" ? { [name.split("/").pop()]: pkg.bin } : pkg.bin
      if (!bins || typeof bins !== "object" || Array.isArray(bins)) continue
      for (const [bin, entry] of Object.entries(bins)) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bin) || typeof entry !== "string") continue
        candidates.push({ package: name, bin, version: info.version ?? pkg.version, description: typeof pkg.description === "string" ? pkg.description : "", suggestedId: bin.toLowerCase().replace(/[._]/g, "-").slice(0, 48) })
      }
    } catch (e) { warnings.push(`${name}: ${e.message}`) }
  }
  return { candidates: candidates.sort((a, b) => a.bin.localeCompare(b.bin) || a.package.localeCompare(b.package)), warnings }
}

export async function discoverNpm({ timeoutMs = 10000 } = {}) {
  const [list, root] = await Promise.all([
    runCmd("npm", ["ls", "-g", "--depth=0", "--json"], timeoutMs),
    runCmd("npm", ["root", "-g"], timeoutMs),
  ])
  // npm ls 在部分依赖损坏时可能非零但仍返回可用 JSON。
  let dependencies
  try { dependencies = JSON.parse(list.stdout).dependencies } catch { throw new Error(`npm 清单读取失败：${list.error ?? list.stderr}`) }
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error("npm 清单不含有效 dependencies")
  if (!root.ok || !root.stdout.trim()) throw new Error(`npm root 读取失败：${root.error ?? root.stderr}`)
  const directory = root.stdout.trim()
  return { ...npmCandidates(dependencies, name => JSON.parse(readFileSync(path.join(directory, ...name.split("/"), "package.json"), "utf8"))), root: directory }
}
