import { describe, expect, test } from "bun:test"
import { npmCandidates } from "../lib/npm-discovery.mjs"
import { probeTool } from "../lib/probe.mjs"
import { fakeCLI } from "./helpers/fake-cli.mjs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

describe("npm discovery", () => {
  test("多 bin / scoped 包 / 字符串 bin；依赖库忽略，不执行候选", () => {
    const packages = { "@team/build": { bin: { ueb: "dist/main.js", uebx: "dist/x.js" }, description: "内部 UE 工具" }, simple: { bin: "main.js" }, library: {} }
    const out = npmCandidates({ "@team/build": { version: "1.2.3" }, simple: { version: "2.0.0" }, library: {} }, name => packages[name])
    expect(out.candidates.map(c => [c.bin, c.package])).toEqual([["simple", "simple"], ["ueb", "@team/build"], ["uebx", "@team/build"]])
    expect(out.candidates[1]).toMatchObject({ version: "1.2.3", description: "内部 UE 工具", suggestedId: "ueb" })
  })
  test("损坏元数据有 warning，拒绝路径穿越包名与危险 bin", () => {
    const read = []
    const out = npmCandidates({ "../../escape": {}, broken: {}, valid: {} }, name => {
      read.push(name)
      if (name === "broken") throw new Error("bad JSON")
      return { bin: { "bad&bin": "x", "safe.cli": "x" } }
    })
    expect(read).not.toContain("../../escape")
    expect(out.warnings).toHaveLength(1)
    expect(out.candidates[0].suggestedId).toBe("safe-cli")
  })
  test("显式 package 精确匹配包清单；清单命中也输出 Skill 路径", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tc-package-"))
    const oldPath = process.env.PATH
    try {
      const bin = fakeCLI(dir, "ueb", { output: "9.9.9" })
      process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`
      const finding = await probeTool({ id: "ueb", kind: "npm", package: "@team/build-tool", check: { bin: "ueb", version: ["--version"] } }, { listings: { npm: new Map([["@team/build-tool", "1.2.3"], ["@other/ueb", "0.0.1"]]) } })
      expect(finding).toMatchObject({ found: true, via: "npm", version: "1.2.3" })
      expect(finding.path.toLowerCase()).toBe(bin.toLowerCase())
    } finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }) }
  })
})
