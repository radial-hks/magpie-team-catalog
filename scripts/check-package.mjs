// 发布前检查实际 npm 打包文件；不安装/发布、不执行 lifecycle 或插件入口。
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runCmd } from "../lib/probe.mjs"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.chdir(root)
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const result = await runCmd("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], 30000)
if (!result.ok) throw Error(`npm pack failed: ${result.error}`)
const pack = JSON.parse(result.stdout)[0]
const files = new Set(pack.files.map(f => f.path.replace(/\\/g, "/")))
const required = [pkg.main, pkg.exports["./server"], "worker.mjs", pkg.magpie.middleware, pkg.magpie.page.file, "page/boot.js", "page/main.html", "page/session-client.js", "page/ui-kit.js", "page/catalog-ui.js", "page/project-ui.js", "page/catalog-app.js", "registry/registry.yaml", "docs/usage.md", "docs/distribution.md", "README.md", "LICENSE"].map(p => p.replace(/^\.\//, ""))
for (const file of required) if (!files.has(file) || !existsSync(file)) throw Error(`Missing distribution file: ${file}`)
for (const file of files) {
  if (/^(?:test|scripts|\.github|node_modules)\/|(?:^|\/)(?:plugins\.json|local-registry\.yaml|catalog-state\.json)|\.(?:bak|log|tgz)$/.test(file)) throw Error(`Unexpected distribution file: ${file}`)
  if (/\.(?:mjs|js)$/.test(file)) {
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]))
      if (!files.has(imported)) throw Error(`Unpacked relative import: ${file} -> ${imported}`)
    }
  }
}
for (const value of [pkg.magpie.name, ...Object.values(pkg.magpie.summary)]) if (/\r|\n/.test(value)) throw Error("Marketplace metadata must be a single line")
if (Buffer.byteLength(pkg.magpie.name) > 80 || Object.values(pkg.magpie.summary).some(v => Buffer.byteLength(v) > 300)) throw Error("Marketplace metadata too long")
if (!pkg.repository?.url || !pkg.homepage || !pkg.bugs?.url || pkg.license !== "MIT") throw Error("Incomplete repository metadata")
const exports = Object.keys(await import("../index.mjs"))
if (exports.some(key => !["default", "_internal"].includes(key))) throw Error("Unexpected callable entry exports")
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, files: files.size, packageBytes: pack.size, entryExports: exports, status: "PASS (no build/install scripts required)" }, null, 2))
