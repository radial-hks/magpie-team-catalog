import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { emptyRegistry, loadCatalog, mergeRegistries, readLocalRegistry, saveLocalRegistry, localRegistryPath } from "../lib/catalog.mjs"
import { validateRegistry, parseRegistry } from "../lib/core.mjs"
import { catalogTool } from "../lib/tool.mjs"
import { runCycle, findMagpie } from "../lib/cycle.mjs"
import { fakeCLI } from "./helpers/fake-cli.mjs"

const tool = (id, extra = {}) => ({ id, kind: "binary", install: "本地维护", ...extra })
let dir, opts
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tc-personal-"))
  opts = { registry: path.join(dir, "team.yaml"), localRegistry: path.join(dir, "personal.yaml"), statePath: path.join(dir, "state.json") }
  writeFileSync(opts.registry, JSON.stringify({ version: 1, tools: [tool("team-cli")], projects: [{ id: "team-project", vcs: "git@host:team/project.git" }] }))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("personal registry", () => {
  test("无文件零副作用、默认路径随 statePath 隔离、false 关闭", () => {
    expect(readLocalRegistry(opts).registry).toEqual(emptyRegistry())
    expect(existsSync(opts.localRegistry)).toBe(false)
    expect(localRegistryPath({ statePath: opts.statePath })).toBe(path.join(dir, "local-registry.yaml"))
    expect(readLocalRegistry({ localRegistry: false }).path).toBe(null)
    expect(() => localRegistryPath({ localRegistry: "https://host/registry.yaml" })).toThrow(/local file/)
    expect(() => localRegistryPath({ localRegistry: path.resolve("registry/personal.yaml") })).toThrow(/插件目录之外/)
  })

  test("JSON/YAML 校验一致，package 与命令可不同，错误类型拒绝", () => {
    const r = { version: 1, tools: [tool("ueb", { kind: "npm", package: "@team/build-tool", check: { bin: "ueb", version: ["--version"] } })] }
    expect(parseRegistry(JSON.stringify(r))).toEqual(validateRegistry(r))
    expect(() => validateRegistry({ version: 1, tools: [tool("x", { package: "../../escape" })] })).toThrow(/package/)
    expect(() => validateRegistry({ version: 1, tools: [tool("x", { usage: {} })] })).toThrow(/usage/)
    expect(() => validateRegistry({ version: 1, tools: [tool("x", { skill: "../../outside" })] })).toThrow(/skill/)
    expect(() => validateRegistry({ version: 1, tools: [tool("x", { platform: { windows: { check: { version: "shell" } } } })] })).toThrow(/check.version/)
  })

  test("新增/编辑/删除、文档与额外字段持久化；团队文件不变", async () => {
    const team = readFileSync(opts.registry, "utf8")
    let s = readLocalRegistry(opts)
    s = await saveLocalRegistry({ version: 1, tools: [tool("personal", { documentation: "说明\n正文", platform: { windows: { bin: "p.exe" } } })], projects: [] }, s.revision, opts)
    expect(s.registry.tools[0].documentation).toBe("说明\n正文")
    s.registry.tools[0].usage = "new usage"
    s = await saveLocalRegistry(s.registry, s.revision, opts)
    expect(readLocalRegistry(opts).registry.tools[0].usage).toBe("new usage")
    const catalog = await loadCatalog(opts)
    expect(catalog.registry.tools.map(t => [t.id, t.source])).toEqual([["team-cli", "team"], ["personal", "local"]])
    expect(catalog.bases.local).toBe(dir)
    await saveLocalRegistry(emptyRegistry(), s.revision, opts)
    expect(readFileSync(opts.registry, "utf8")).toBe(team)
    expect(readLocalRegistry(opts).registry.tools).toEqual([])
  })

  test("ID 跨 tools/projects 冲突拒绝；新团队冲突运行时跳过并提示", async () => {
    const s = readLocalRegistry(opts)
    for (const id of ["team-cli", "team-project"]) {
      await expect(saveLocalRegistry({ version: 1, tools: [tool(id)] }, s.revision, opts)).rejects.toThrow(/冲突/)
    }
    const merged = mergeRegistries({ version: 1, tools: [tool("x")], projects: [] }, { version: 1, tools: [tool("x"), tool("y")], projects: [] })
    expect(merged.registry.tools.map(t => t.id)).toEqual(["x", "y"])
    expect(merged.warnings).toHaveLength(1)
  })

  test("过期 revision / 非法参数 / 并发写锁不写盘", async () => {
    const s = readLocalRegistry(opts)
    const text = readFileSync(opts.localRegistry, "utf8")
    await expect(saveLocalRegistry(emptyRegistry(), "stale", opts)).rejects.toThrow(/其它窗口/)
    await expect(saveLocalRegistry({ version: 1, tools: [tool("x", { check: { version: "shell string" } })] }, s.revision, opts)).rejects.toThrow(/version/)
    mkdirSync(`${opts.localRegistry}.write-lock`)
    try { await expect(saveLocalRegistry(emptyRegistry(), s.revision, opts)).rejects.toThrow(/正在保存/) }
    finally { rmSync(`${opts.localRegistry}.write-lock`, { recursive: true }) }
    expect(readFileSync(opts.localRegistry, "utf8")).toBe(text)
  })

  test("个人文件损坏保留原文且团队仍可读；团队坏了个人仍可读", async () => {
    const before = readFileSync(opts.localRegistry, "utf8")
    writeFileSync(opts.localRegistry, "invalid yaml")
    const broken = await loadCatalog(opts)
    expect(broken.registry.tools[0].source).toBe("team")
    expect(broken.warnings[0]).toContain("个人 registry")
    await expect(saveLocalRegistry(emptyRegistry(), "x", opts)).rejects.toThrow()
    expect(readFileSync(opts.localRegistry, "utf8")).toBe("invalid yaml")
    writeFileSync(opts.localRegistry, JSON.stringify({ version: 1, tools: [tool("personal")] }))
    const catalog = await loadCatalog({ ...opts, registry: path.join(dir, "absent.yaml") })
    expect(catalog.registry.tools[0].source).toBe("local")
    expect(catalog.warnings[0]).toContain("团队 registry")
    writeFileSync(opts.localRegistry, before)
  })

  test("目录坏了不清理已导出 Skill，不发布不完整索引", async () => {
    const root = path.join(dir, "skills")
    const managed = path.join(root, "personal-run", "SKILL.md")
    mkdirSync(path.dirname(managed), { recursive: true })
    writeFileSync(managed, "<!-- team-catalog:managed -->\nkeep")
    const original = readFileSync(opts.localRegistry, "utf8")
    writeFileSync(opts.localRegistry, "broken")
    try {
      await runCycle({ ...opts, skillsRepo: dir, skillExport: true, skillRoot: root }, { readOptions: () => null })
      expect(readFileSync(managed, "utf8")).toContain("keep")
    } finally { writeFileSync(opts.localRegistry, original) }
  })

  test("显式 magpieBin 无效时不得回退到本机安装", () => {
    expect(findMagpie({ magpieBin: path.join(dir, "nonexistent-magpie.exe") })).toBe(null)
  })

  test("个人 CLI 经真实 worker/MCP 可见、版本与路径入 state、文档基址正确", async () => {
    const bin = fakeCLI(dir, "personal-run", { output: "1.2.3" })
    writeFileSync(path.join(dir, "personal-doc.md"), "个人目录文档")
    const s = readLocalRegistry(opts)
    await saveLocalRegistry({ version: 1, tools: [tool("personal-run", { check: { bin, version: ["--version"] }, doc: "personal-doc.md" })], projects: [] }, s.revision, opts)
    // 读配置和发布通道均注入，不允许测试调用本机 magpie。
    let publications = 0
    await runCycle(opts, { readOptions: () => null, publish: async () => { publications++ } })
    expect(publications).toBe(1)
    const state = JSON.parse(readFileSync(opts.statePath, "utf8"))
    expect(state.tools["personal-run"]).toMatchObject({ status: "present", version: "1.2.3", path: bin })
    const detail = await catalogTool({ detail: "personal-run" }, opts)
    expect(detail).toMatchObject({ source: "local", version: "1.2.3", path: bin, doc: "个人目录文档" })
    const disabled = { ...opts, overrides: { "personal-run": { enabled: false } } }
    await runCycle(disabled, { readOptions: () => null, publish: async () => {} })
    expect(JSON.parse(readFileSync(opts.statePath, "utf8")).tools["personal-run"].status).toBe("disabled")
    expect((await catalogTool({}, disabled)).tools.map(t => t.id)).not.toContain("personal-run")
  })
})
