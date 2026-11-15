// tool.mjs 测试：匹配、响应组装（fix/probe/pinned/disabled）、catalogTool
// 的搜索与详情（含 docs 读取与按需 probe 实测）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { matchTools, matchProjects, entryJSON, projectJSON, catalogTool, runProbeCmd } from "../lib/tool.mjs"
import { parseRegistry } from "../lib/core.mjs"
import { fakeCLI } from "./helpers/fake-cli.mjs"

const REGISTRY = `version: 1
tools:
  - id: deploy-cli
    name: 部署 CLI
    kind: npm
    install: "npm i -g @team/deploy-cli"
    min: 1.4.0
    usage: |
      deploy-cli release --app <name> [--canary]
    doc: docs/deploy-cli.md
    check:
      bin: deploy-cli
      version: ["--version"]
      probe: ["whoami"]
  - id: perf-diag
    kind: binary
    install: "brew install team/tap/perf-diag"
    check:
      bin: perf-diag
      version: ["--version"]
projects:
  - id: billing
    name: 计费服务
    vcs: git@github.com:team/billing.git
  - id: legacy-sync
    vcs: "perforce://p4.internal:1666//depot/legacy-sync"
    note: 历史镜像
`

describe("匹配与响应组装（纯）", () => {
  const reg = parseRegistry(REGISTRY)

  test("matchTools：id/名称/用法命中，空 query 全量", () => {
    expect(matchTools(reg, "deploy").map((t) => t.id)).toEqual(["deploy-cli"])
    expect(matchTools(reg, "部署").map((t) => t.id)).toEqual(["deploy-cli"])
    expect(matchTools(reg, "release").map((t) => t.id)).toEqual(["deploy-cli"])
    expect(matchTools(reg, "").map((t) => t.id)).toEqual(["deploy-cli", "perf-diag"])
    expect(matchTools(reg, "nope-xyz")).toEqual([])
  })

  test("matchProjects：id/vcs/note 命中", () => {
    expect(matchProjects(reg, "bill").map((p) => p.id)).toEqual(["billing"])
    expect(matchProjects(reg, "depot").map((p) => p.id)).toEqual(["legacy-sync"])
    expect(matchProjects(reg, "").map((p) => p.id)).toEqual(["billing", "legacy-sync"])
  })

  test("entryJSON：状态/fix/probe 升级", () => {
    const t = reg.tools[0]
    expect(entryJSON(t, { status: "missing" })).toMatchObject({ id: "deploy-cli", status: "missing", fix: "npm i -g @team/deploy-cli" })
    expect(entryJSON(t, { status: "outdated", version: "1.2.0" })).toMatchObject({ status: "outdated", version: "1.2.0", min: "1.4.0", fix: "npm i -g @team/deploy-cli" })
    expect(entryJSON(t, { status: "present", version: "1.4.0" })).toMatchObject({ status: "present" })
    expect(entryJSON(t, { status: "present" }).fix).toBeUndefined()
    // probe 通过把 present 升为 configured；outdated 保留（更有行动性）
    expect(entryJSON(t, { status: "present" }, { probe: { ok: true } })).toMatchObject({ status: "configured", probe: "ok" })
    expect(entryJSON(t, { status: "outdated", version: "1.2.0" }, { probe: { ok: true } })).toMatchObject({ status: "outdated", probe: "ok" })
  })

  test("projectJSON 字段", () => {
    expect(projectJSON(reg.projects[0])).toEqual({ id: "billing", name: "计费服务", vcs: "git@github.com:team/billing.git" })
  })
})

describe("catalogTool（IO：registry/state/docs/probe）", () => {
  let dir
  const OLD_PATH = process.env.PATH

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tc-tool-"))
    process.env.PATH = `${dir}${path.delimiter}${OLD_PATH ?? ""}`
    // 假 CLI：--version 输出版本，whoami 退出 0
    fakeCLI(dir, "deploy-cli", {
      code: 'console.log(process.argv[2] === "whoami" ? "me@team" : "deploy-cli 1.2.3");\n',
    })
    writeFileSync(path.join(dir, "registry.yaml"), REGISTRY)
    mkdirSync(path.join(dir, "docs"))
    writeFileSync(path.join(dir, "docs", "deploy-cli.md"), "# deploy-cli 用法\n\n详细文档正文。")
  })

  afterAll(() => {
    process.env.PATH = OLD_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  const opts = () => ({ registry: path.join(dir, "registry.yaml"), statePath: path.join(dir, "state.json"), localRegistry: false })

  test("搜索：无 state 时返回 unknown 并触发 onStale", async () => {
    let stale = false
    const out = await catalogTool({ query: "deploy" }, opts(), { onStale: () => (stale = true) })
    expect(stale).toBe(true)
    expect(out.tools[0]).toMatchObject({ id: "deploy-cli", status: "unknown" })
  })

  test("搜索：state 里的 status/version 带出，missing 有 fix", async () => {
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      checkedAt: 1,
      tools: { "deploy-cli": { status: "outdated", version: "1.2.0" }, "perf-diag": { status: "missing" } },
    }))
    const out = await catalogTool({}, opts(), {})
    expect(out.tools[0]).toMatchObject({ id: "deploy-cli", status: "outdated", version: "1.2.0", fix: "npm i -g @team/deploy-cli" })
    expect(out.tools[1]).toMatchObject({ id: "perf-diag", status: "missing", fix: "brew install team/tap/perf-diag" })
    expect(out.checkedAt).toBe(new Date(1).toISOString())
  })

  test("详情：doc 全文 + 按需 probe 通过 → configured", async () => {
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      checkedAt: 1,
      tools: { "deploy-cli": { status: "present", version: "1.2.3" }, "perf-diag": { status: "missing" } },
    }))
    const out = await catalogTool({ detail: "deploy-cli" }, opts(), {})
    expect(out.status).toBe("configured")
    expect(out.probe).toBe("ok")
    expect(out.doc).toContain("详细文档正文")
    expect(out.usage).toContain("deploy-cli release --app")
  })

  test("详情：perf-diag 无 probe 字段 → 保持 state 状态", async () => {
    const out = await catalogTool({ detail: "perf-diag" }, opts(), {})
    expect(out.status).toBe("missing")
    expect(out.probe).toBeUndefined()
    expect(out.doc).toBeUndefined()
  })

  test("详情：project 条目 / 未知 id", async () => {
    expect(await catalogTool({ detail: "billing" }, opts(), {})).toMatchObject({ id: "billing", vcs: "git@github.com:team/billing.git" })
    expect(await catalogTool({ detail: "nope" }, opts(), {})).toMatchObject({ error: expect.stringContaining("nope") })
  })

  test("覆盖层：disabled 不进搜索与详情；bin 覆盖生效；status 钉死", async () => {
    const withOverrides = { ...opts(), overrides: { "perf-diag": { enabled: false }, "deploy-cli": { status: "present" } } }
    const out = await catalogTool({}, withOverrides, {})
    expect(out.tools.map((t) => t.id)).toEqual(["deploy-cli"])
    expect(out.tools[0]).toMatchObject({ status: "present", pinned: true })
    const dis = await catalogTool({ detail: "perf-diag" }, withOverrides, {})
    expect(dis).toMatchObject({ id: "perf-diag", status: "disabled" })
  })

  test("runProbeCmd：可执行文件不存在 → ok:false", async () => {
    const reg = parseRegistry(REGISTRY)
    const r = await runProbeCmd({ ...reg.tools[0], check: { ...reg.tools[0].check, bin: "no-such-bin-xyz" } }, 2000)
    expect(r).toMatchObject({ ok: false })
  })
})
