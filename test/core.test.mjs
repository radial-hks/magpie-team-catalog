// core.mjs 测试：registry 校验、覆盖合并、状态判定、索引构建。
import { describe, expect, test } from "bun:test"
import {
  parseRegistry,
  effectiveTool,
  toolStatus,
  firstSemver,
  versionLt,
  abbreviateVcs,
  buildIndex,
} from "../lib/core.mjs"

const BASE = `version: 1
tools:
  - id: deploy-cli
    kind: npm
    install: "npm i -g @team/deploy-cli"
    min: 1.4.0
    check: {bin: deploy-cli, version: ["--version"]}
  - id: perf-diag
    kind: binary
    install: "brew install team/tap/perf-diag"
    check: {bin: perf-diag, version: ["--version"]}
projects:
  - id: billing
    vcs: git@github.com:team/billing.git
  - id: legacy-sync
    vcs: "perforce://p4.internal:1666//depot/legacy-sync"
`

describe("parseRegistry 校验", () => {
  test("合法 registry", () => {
    const r = parseRegistry(BASE)
    expect(r.version).toBe(1)
    expect(r.tools).toHaveLength(2)
    expect(r.projects).toHaveLength(2)
  })

  test("id 不合规 / kind 非法 / 缺 install / 重复 id", () => {
    expect(() => parseRegistry(`version: 1\ntools:\n  - id: Bad_ID\n    kind: npm\n    install: x\n`)).toThrow(/id/)
    expect(() => parseRegistry(`version: 1\ntools:\n  - id: x\n    kind: winget\n    install: x\n`)).toThrow(/kind/)
    expect(() => parseRegistry(`version: 1\ntools:\n  - id: x\n    kind: npm\n`)).toThrow(/install/)
    expect(() =>
      parseRegistry(`version: 1\ntools:\n  - id: x\n    kind: npm\n    install: a\n  - id: x\n    kind: npm\n    install: b\n`),
    ).toThrow(/duplicate/)
  })

  test("check 命令字段必须是字符串数组（防注入）", () => {
    const bad = `version: 1\ntools:\n  - id: x\n    kind: binary\n    install: y\n    check: {version: "rm -rf /"}\n`
    expect(() => parseRegistry(bad)).toThrow(/check.version/)
  })

  test("projects 需要 vcs 或 url", () => {
    expect(() => parseRegistry(`version: 1\nprojects:\n  - id: x\n`)).toThrow(/vcs or url/)
  })
})

describe("effectiveTool 覆盖合并", () => {
  const tool = {
    id: "deploy-cli",
    kind: "npm",
    install: "npm i -g @team/deploy-cli",
    check: { bin: "deploy-cli" },
    platform: { windows: { bin: "deploy-cli.exe" } },
  }

  test("平台差异生效", () => {
    expect(effectiveTool(tool, null, "windows").check.bin).toBe("deploy-cli.exe")
    expect(effectiveTool(tool, null, "darwin").check.bin).toBe("deploy-cli")
  })

  test("用户覆盖 bin / enabled / status", () => {
    expect(effectiveTool(tool, { bin: "/opt/x" }, "darwin").check.bin).toBe("/opt/x")
    expect(effectiveTool(tool, { enabled: false }, "darwin").disabled).toBe(true)
    expect(effectiveTool(tool, { status: "present" }, "darwin").pinned).toBe("present")
    // 覆盖键优先于平台
    expect(effectiveTool(tool, { bin: "D:\\tools\\deploy.exe" }, "windows").check.bin).toBe("D:\\tools\\deploy.exe")
  })
})

describe("toolStatus / 版本", () => {
  const t = (o) => ({ id: "x", kind: "npm", install: "i", ...o })

  test("missing / present / outdated", () => {
    expect(toolStatus(t({}), null)).toBe("missing")
    expect(toolStatus(t({}), { found: false })).toBe("missing")
    expect(toolStatus(t({}), { found: true })).toBe("present")
    expect(toolStatus(t({ min: "1.4.0" }), { found: true, version: "1.2.0" })).toBe("outdated")
    expect(toolStatus(t({ min: "1.4.0" }), { found: true, version: "1.4.0" })).toBe("present")
    // 版本读不出来：宁可不标 outdated
    expect(toolStatus(t({ min: "1.4.0" }), { found: true, version: null })).toBe("present")
  })

  test("钉死状态优先于探测", () => {
    expect(toolStatus(t({ pinned: "present" }), { found: false })).toBe("present")
  })

  test("firstSemver", () => {
    expect(firstSemver("deploy-cli version 1.2.3 (build 9)")).toBe("1.2.3")
    expect(firstSemver("v2.0.1-rc.1")).toBe("2.0.1-rc.1")
    expect(firstSemver("no version here")).toBe(null)
  })

  test("versionLt", () => {
    expect(versionLt("1.2.0", "1.4.0")).toBe(true)
    expect(versionLt("1.10.0", "1.9.0")).toBe(false)
    expect(versionLt("1.4", "1.4.0")).toBe(false)
    expect(versionLt("x.y", "1.0.0")).toBe(false)
  })
})

describe("abbreviateVcs", () => {
  test("四种形态", () => {
    expect(abbreviateVcs("git@github.com:team/billing.git")).toBe("github:team/billing")
    expect(abbreviateVcs("https://github.com/team/billing")).toBe("github:team/billing")
    expect(abbreviateVcs("perforce://p4.internal:1666//depot/legacy-sync")).toBe("p4://depot/legacy-sync")
    expect(abbreviateVcs("git@gitlab.internal:team/x.git")).toBe("git@gitlab.internal:team/x.git")
  })
})

describe("buildIndex", () => {
  test("只含 available；outdated 标注；missing/disabled 不出现", () => {
    const r = parseRegistry(BASE)
    const states = {
      "deploy-cli": { status: "outdated", version: "1.2.0" },
      "perf-diag": { status: "missing" },
    }
    const idx = buildIndex(r, states)
    expect(idx).toContain("deploy-cli(1.2.0,需更新)")
    expect(idx).not.toContain("perf-diag")
    expect(idx).toContain("团队内部工具目录（本机实测）：")
    expect(idx).toContain("团队项目地址：billing=github:team/billing · legacy-sync=p4://depot/legacy-sync")
  })

  test("showMissing 带出未安装清单", () => {
    const r = parseRegistry(BASE)
    const idx = buildIndex(r, { "deploy-cli": { status: "missing" }, "perf-diag": { status: "missing" } }, { showMissing: true })
    expect(idx).toContain("未安装：deploy-cli · perf-diag")
  })

  test("disabled 与 unknown 不出现；空 registry 返回空串", () => {
    const r = parseRegistry(BASE)
    expect(buildIndex(r, { "deploy-cli": { status: "disabled" }, "perf-diag": { status: "unknown" } })).not.toContain("目录")
    expect(buildIndex(parseRegistry("version: 1\n"), {})).toBe("")
  })

  test("present 带版本括注，无版本裸名", () => {
    const r = parseRegistry("version: 1\ntools:\n  - id: a\n    kind: binary\n    install: i\n  - id: b\n    kind: binary\n    install: i\n")
    const idx = buildIndex(r, { a: { status: "present", version: "3.1.0" }, b: { status: "present" } })
    expect(idx).toBe("团队内部工具目录（本机实测）：a(3.1.0) · b")
  })
})
