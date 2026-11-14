// yaml.mjs 测试：合法 registry 全量解析 + 各语法特性 + 非法输入拒绝。
import { describe, expect, test } from "bun:test"
import { parseYAML } from "../lib/yaml.mjs"

const EXAMPLE = `version: 1

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
    platform:
      darwin: { install: "brew install team/tap/deploy-cli" }
      windows: { bin: "deploy-cli.exe" }

projects:
  - id: billing
    name: 计费服务
    vcs: git@github.com:team/billing.git
    url: https://wiki.internal/billing
    note: 主仓库，P4 镜像见 legacy-sync # 尾注
`

describe("parseYAML", () => {
  test("example registry 全量解析", () => {
    const doc = parseYAML(EXAMPLE)
    expect(doc.version).toBe(1)
    expect(doc.tools).toHaveLength(1)
    const t = doc.tools[0]
    expect(t.id).toBe("deploy-cli")
    expect(t.name).toBe("部署 CLI")
    expect(t.kind).toBe("npm")
    expect(t.install).toBe("npm i -g @team/deploy-cli")
    expect(t.min).toBe("1.4.0")
    expect(t.usage).toBe("deploy-cli release --app <name> [--canary]\n")
    expect(t.doc).toBe("docs/deploy-cli.md")
    expect(t.check.bin).toBe("deploy-cli")
    expect(t.check.version).toEqual(["--version"])
    expect(t.check.probe).toEqual(["whoami"])
    expect(t.platform.darwin).toEqual({ install: "brew install team/tap/deploy-cli" })
    expect(t.platform.windows).toEqual({ bin: "deploy-cli.exe" })
    const p = doc.projects[0]
    expect(p.id).toBe("billing")
    expect(p.vcs).toBe("git@github.com:team/billing.git")
    expect(p.url).toBe("https://wiki.internal/billing")
    expect(p.note).toBe("主仓库，P4 镜像见 legacy-sync")
  })

  test("空文档与非映射顶层", () => {
    expect(parseYAML("")).toEqual({})
    expect(parseYAML("# 只剩注释\n\n")).toEqual({})
    // 顶层序列是合法 YAML；registry 层面再拒（parseRegistry 校验）
    expect(parseYAML("- a\n- b\n")).toEqual(["a", "b"])
  })

  test("标量类型：数字/布尔/null/引号", () => {
    const doc = parseYAML("a: 1\nb: 2.5\nc: true\nd: false\ne: null\nf: 'x: y'\ng: " + '"q\\nr"')
    expect(doc.a).toBe(1)
    expect(doc.b).toBe(2.5)
    expect(doc.c).toBe(true)
    expect(doc.d).toBe(false)
    expect(doc.e).toBe(null)
    expect(doc.f).toBe("x: y")
    expect(doc.g).toBe("q\nr")
  })

  test("流式数组与嵌套流式", () => {
    const doc = parseYAML('l: ["--version", "whoami"]\nm: { a: 1, b: ["x"] }\nn: []')
    expect(doc.l).toEqual(["--version", "whoami"])
    expect(doc.m).toEqual({ a: 1, b: ["x"] })
    expect(doc.n).toEqual([])
  })

  test("块标量：缩进裁剪与空行保留", () => {
    const doc = parseYAML("a: |\n    line1\n    line2\n\n    line3\nb: 1\n")
    expect(doc.a).toBe("line1\nline2\n\nline3\n")
    expect(doc.b).toBe(1)
  })

  test("整行注释与尾注剥离（引号内 # 不剥离）", () => {
    const doc = parseYAML("# full\na: v # tail\nb: 'has # hash'\n")
    expect(doc.a).toBe("v")
    expect(doc.b).toBe("has # hash")
  })

  test("序列里的裸标量项", () => {
    expect(parseYAML("l:\n  - a\n  - b\n").l).toEqual(["a", "b"])
  })

  test("非法输入拒绝（带行号）", () => {
    expect(() => parseYAML("a: b\nc\n")).toThrow(/line 2/)
    expect(() => parseYAML('a: "unterminated\n')).toThrow()
    expect(() => parseYAML("a: [1, 2\n")).toThrow()
    expect(() => parseYAML("a: 1\n  b: 2\n")).toThrow(/line 2/)
    expect(() => parseYAML("a: b: c\n")).toThrow(/ambiguous/)
  })

  test("perforce URL 是合法裸标量（含冒号不歧义）", () => {
    const doc = parseYAML('vcs: "perforce://p4.internal:1666//depot/x"\nurl: https://wiki.internal/billing\n')
    expect(doc.vcs).toBe("perforce://p4.internal:1666//depot/x")
    expect(doc.url).toBe("https://wiki.internal/billing")
  })
})
