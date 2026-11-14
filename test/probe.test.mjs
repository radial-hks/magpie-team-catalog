// probe.mjs 测试：临时目录造假 CLI，PATH 注入后实测探测链路。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { which, probeTool, probeAll } from "../lib/probe.mjs"
import { effectiveTool, toolStatus } from "../lib/core.mjs"

let dir
const OLD_PATH = process.env.PATH

function fakeBin(name, out) {
  const p = path.join(dir, name)
  writeFileSync(p, `#!/bin/sh\necho "${out}"\n`)
  chmodSync(p, 0o755)
  return p
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tc-probe-"))
  process.env.PATH = `${dir}:${OLD_PATH}`
})

afterAll(() => {
  process.env.PATH = OLD_PATH
  rmSync(dir, { recursive: true, force: true })
})

const tool = (o) => ({ id: "x", kind: "binary", install: "i", check: { bin: "x" }, ...o })

describe("which / probeTool", () => {
  test("PATH 找到假 CLI 并读出版本", async () => {
    fakeBin("fakehello", "fakehello 1.2.3")
    const t = tool({ id: "fakehello", check: { bin: "fakehello", version: ["--version"] } })
    const f = await probeTool(t, {})
    expect(f.found).toBe(true)
    expect(f.via).toBe("path")
    expect(f.version).toBe("1.2.3")
    expect(toolStatus(t, f)).toBe("present")
  })

  test("min 比对 → outdated", async () => {
    fakeBin("fakeold", "fakeold 0.9.0")
    const t = tool({ id: "fakeold", min: "2.0.0", check: { bin: "fakeold", version: ["--version"] } })
    const f = await probeTool(t, {})
    expect(toolStatus(t, f)).toBe("outdated")
  })

  test("不存在 → missing；不跑 version 命令", async () => {
    const t = tool({ id: "nope-xyz", check: { bin: "nope-xyz", version: ["--version"] } })
    const f = await probeTool(t, {})
    expect(f.found).toBe(false)
    expect(f.version).toBeUndefined()
    expect(toolStatus(t, f)).toBe("missing")
  })

  test("绝对路径覆盖（override bin）", async () => {
    const p = fakeBin("anyname", "1.1.1")
    const t = effectiveTool(tool({ id: "ov", check: { bin: "ov", version: ["--version"] } }), { bin: p }, process.platform === "win32" ? "windows" : "darwin")
    const f = await probeTool(t, {})
    expect(f.found).toBe(true)
    expect(f.via).toBe("override")
    expect(f.version).toBe("1.1.1")
  })

  test("kind 清单命中（brew 形态）", async () => {
    const t = tool({ id: "brewthing", kind: "brew", check: { bin: "brewthing" } })
    const f = await probeTool(t, { listings: { brew: new Map([["brewthing", "4.5.6"]]) } })
    expect(f.found).toBe(true)
    expect(f.via).toBe("brew")
    expect(f.version).toBe("4.5.6")
  })

  test("version 输出无 semver：present 不带版本", async () => {
    fakeBin("plainout", "no version string")
    const t = tool({ id: "plainout", check: { bin: "plainout", version: ["--version"] } })
    const f = await probeTool(t, {})
    expect(f.found).toBe(true)
    expect(f.version).toBeUndefined()
  })

  test("which 对空名/含斜杠路径的行为", async () => {
    expect(await which("")).toBe(null)
    expect(await which("definitely-not-here-xyz")).toBe(null)
  })
})

describe("probeAll", () => {
  test("并发全量：disabled/pinned 不探测", async () => {
    fakeBin("many1", "1.0.0")
    const tools = [
      effectiveTool(tool({ id: "many1", check: { bin: "many1", version: ["--version"] } }), null, "darwin"),
      effectiveTool(tool({ id: "off1", check: { bin: "off1" } }), { enabled: false }, "darwin"),
      effectiveTool(tool({ id: "pin1", check: { bin: "pin1" } }), { status: "present" }, "darwin"),
    ]
    const findings = await probeAll(tools, { concurrency: 2 })
    expect(findings.many1.found).toBe(true)
    expect(findings.many1.version).toBe("1.0.0")
    expect(findings.off1).toEqual({ found: false, status: "disabled", at: expect.any(Number) })
    expect(findings.pin1.status).toBe("present")
  })
})
