// 命令执行回归：原生 argv 不经 shell；Windows 批处理显式执行且 fail-open。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runCmd, which, fetchListings, probeAll } from "../lib/probe.mjs"
import { fakeCLI } from "./helpers/fake-cli.mjs"

let dir
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tc-command-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("runCmd", () => {
  test("原生程序保留 argv（空格、空值、Unicode、shell 字符）", async () => {
    const args = ["a b", "", "中文", "a&b", "%PATH%", "a\"b", "end\\"]
    const r = await runCmd(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args])
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.stdout)).toEqual(args)
  })

  test("异步失败与同步 spawn 参数异常均返回 ok:false，不 reject", async () => {
    expect(await runCmd(path.join(dir, "nonexistent.exe"), [])).toMatchObject({ ok: false })
    expect(await runCmd(process.execPath, [null])).toMatchObject({ ok: false })
  })

  test("非零退出保留 stdout/stderr", async () => {
    const r = await runCmd(process.execPath, ["-e", 'console.log("out"); console.error("err"); process.exit(7)'])
    expect(r).toMatchObject({ ok: false, stdout: "out\n", stderr: "err\n" })
  })

  test("原生程序超时返回失败", async () => {
    const r = await runCmd(process.execPath, ["-e", "setTimeout(() => console.log('late'), 2000)"], 100)
    expect(r.ok).toBe(false)
    expect(r.stdout).not.toContain("late")
  })
})

describe.skipIf(process.platform !== "win32")("Windows batch", () => {
  test(".cmd/.bat 支持带空格路径及固定参数数组", async () => {
    const root = path.join(dir, "space directory")
    mkdirSync(root)
    const cmd = fakeCLI(root, "echo-args", { code: "console.log(JSON.stringify(process.argv.slice(2)))\n" })
    const args = ["--version", "a b", "", "中文", "(value)", "end\\"]
    const r = await runCmd(cmd, args)
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.stdout)).toEqual(args)
    const bat = cmd.replace(/\.cmd$/, ".bat")
    renameSync(cmd, bat)
    const b = await runCmd(bat, args)
    expect(b.ok).toBe(true)
    expect(JSON.parse(b.stdout)).toEqual(args)
  })

  test("拒绝 shell 操作符/变量展开/引号/换行，不执行批处理", async () => {
    const cmd = fakeCLI(dir, "safe", { output: "ran" })
    for (const arg of ["a&b", "a|b", "a>b", "a<b", "%PATH%", "!VAR!", "a^b", 'a"b', "a\nb"]) {
      const r = await runCmd(cmd, [arg])
      expect(r.ok).toBe(false)
      expect(r.error).toContain("unsupported shell characters")
      expect(r.stdout).toBe("")
    }
  })

  test("单条目命令被拒绝仍完成全量探测，不影响其它条目", async () => {
    const cmd = fakeCLI(dir, "fail-open", { output: "1.2.3" })
    const findings = await probeAll([
      { id: "bad", kind: "binary", check: { bin: cmd, version: ["%PATH%"] } },
      { id: "good", kind: "binary", check: { bin: cmd, version: ["--version"] } },
    ])
    expect(findings.bad.found).toBe(true)
    expect(findings.bad.version).toBeUndefined()
    expect(findings.good.version).toBe("1.2.3")
  })

  test("短名及包管理器解析 .cmd，不选择 npm 的 POSIX 无扩展名启动器", async () => {
    const root = path.join(dir, "npm-bin")
    mkdirSync(root)
    const cmd = fakeCLI(root, "npm", { output: '{"dependencies":{"fake-package":{"version":"1.2.3"}}}' })
    writeFileSync(path.join(root, "npm"), "#!/bin/sh\nexit 1\n")
    const oldPath = process.env.PATH
    try {
      process.env.PATH = `${root}${path.delimiter}${oldPath ?? ""}`
      expect(realpathSync(await which("npm", 2000)).toLowerCase()).toBe(realpathSync(cmd).toLowerCase())
      expect((await runCmd("npm", ["ls", "-g", "--json"])).ok).toBe(true)
      const listings = await fetchListings(new Set(["npm"]), 2000)
      expect(listings.npm.get("fake-package")).toBe("1.2.3")
    } finally {
      process.env.PATH = oldPath
    }
  })
})
