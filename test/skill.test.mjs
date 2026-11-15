// skill.mjs 测试：frontmatter 解析/改写、实测块、幂等、托管边界（临时目录实测 IO）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { parseFrontmatter, skillName, measuredBlock, renderSkill, isManaged, syncSkills, MANAGED, MEASURED_BEGIN, MEASURED_END } from "../lib/skill.mjs"

const SOURCE = `---
name: hermes
description: "Hermes Agent 团队调研编排"
---

# Hermes

hermes chat / kanban / team-research …
`

const tool = (o) => ({ id: "hermes", kind: "binary", install: "x", ...o })
const finding = { found: true, via: "path", path: "/Users/x/.local/bin/hermes", version: "0.23.1" }

describe("纯函数", () => {
  test("parseFrontmatter：有/无 frontmatter、引号值", () => {
    const { data, body } = parseFrontmatter(SOURCE)
    expect(data.name).toBe("hermes")
    expect(data.description).toBe("Hermes Agent 团队调研编排")
    expect(body).toContain("# Hermes")
    const bare = parseFrontmatter("# 无 frontmatter\n正文")
    expect(bare.data).toEqual({})
    expect(bare.body).toContain("无 frontmatter")
  })

  test("skillName：前缀拼接", () => {
    expect(skillName({ id: "hermes" }, "")).toBe("hermes")
    expect(skillName({ id: "hermes" }, "team-")).toBe("team-hermes")
  })

  test("renderSkill：name 强制改写、实测块定界、幂等、自带标题不双 H1", () => {
    const a = renderSkill({ source: SOURCE, tool: tool({}), finding, prefix: "team-" })
    expect(a).toContain("name: team-hermes")
    expect(a).toContain(MANAGED)
    expect(a).toContain(MEASURED_BEGIN)
    expect(a).toContain("`/Users/x/.local/bin/hermes`")
    expect(a).toContain("0.23.1")
    expect(a).toContain("catalog")
    expect(a.match(/^# (?!$)/gm)?.length).toBe(1) // 源有标题：不另造，全篇只 1 个 H1
    const b = renderSkill({ source: SOURCE, tool: tool({}), finding, prefix: "team-" })
    expect(a).toBe(b)
    // 无标题的源：补 H1；无版本（weknora 形态）via 仍如实带出；无时间戳（幂等）
    const c = renderSkill({ source: "只是一段正文", tool: tool({}), finding: { found: true, via: "path", path: "/x/weknora" }, prefix: "" })
    expect(c).toContain("# hermes")
    expect(c).toContain("未解析（via: path）")
    expect(c).not.toContain("探测时间")
  })

  test("measuredBlock：无 finding 也不崩；不带时间戳（幂等前提）", () => {
    expect(measuredBlock(null)).toContain(MEASURED_BEGIN)
    expect(measuredBlock(null)).toContain(MEASURED_END)
    expect(measuredBlock(finding)).not.toContain("探测时间")
  })
})

describe("syncSkills（临时目录实测 IO）", () => {
  let src, root
  beforeAll(() => {
    src = mkdtempSync(path.join(tmpdir(), "tc-sk-src-"))
    root = mkdtempSync(path.join(tmpdir(), "tc-sk-root-"))
    mkdirSync(path.join(src, "skills", "hermes"), { recursive: true })
    writeFileSync(path.join(src, "skills", "hermes", "SKILL.md"), SOURCE)
    mkdirSync(path.join(src, "skills", "weknora"), { recursive: true })
    writeFileSync(path.join(src, "skills", "weknora", "SKILL.md"), SOURCE.replace("hermes", "weknora"))
    // 异物 skill（非本插件管理）
    mkdirSync(path.join(root, "foreign"), { recursive: true })
    writeFileSync(path.join(root, "foreign", "SKILL.md"), "---\nname: foreign\n---\nnot ours\n")
  })
  afterAll(() => {
    rmSync(src, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  const entry = (t, f, available) => ({ tool: t, finding: f, available })

  test("写入 → 幂等 → 禁用移除，全程不碰异物", async () => {
    const e = (avail) => [
      entry(tool({}), finding, avail),
      entry(tool({ id: "weknora" }), { found: true, via: "path", path: "/x/weknora" }, avail),
    ]
    const r1 = syncSkills({ entries: e(true), sourceRoot: src, skillRoot: root })
    expect(r1.written.sort()).toEqual(["hermes", "weknora"])
    expect(r1.removed).toEqual([])
    const f = path.join(root, "hermes", "SKILL.md")
    expect(isManaged(f)).toBe(true)
    expect(readFileSync(f, "utf8")).toContain("name: hermes")

    // 幂等：再跑一轮同样的，不重写（mtimes 也不变）
    const before = statSync(f).mtimeMs
    await new Promise((r) => setTimeout(r, 12))
    const r2 = syncSkills({ entries: e(true), sourceRoot: src, skillRoot: root })
    expect(r2.written).toEqual([])
    expect(r2.removed).toEqual([])
    expect(statSync(f).mtimeMs).toBe(before)

    // 变了才写：探测结果变（版本升级）→ 重写
    const r3 = syncSkills({
      entries: [entry(tool({}), { ...finding, version: "0.24.0" }, true), entry(tool({ id: "weknora" }), { found: true, via: "path", path: "/x/weknora" }, true)],
      sourceRoot: src,
      skillRoot: root,
    })
    expect(r3.written).toEqual(["hermes"])
    expect(readFileSync(f, "utf8")).toContain("0.24.0")

    // 全部不可用 → 都被移除
    const r4 = syncSkills({ entries: e(false), sourceRoot: src, skillRoot: root })
    expect(r4.removed.sort()).toEqual(["hermes", "weknora"])
    expect(existsSync(path.join(root, "hermes"))).toBe(false)
    // 异物完好
    expect(existsSync(path.join(root, "foreign", "SKILL.md"))).toBe(true)
  })

  test("缺源 skill 的条目跳过；别人占的名字不覆盖", () => {
    // foreign 目录占用 "foreign" 名字且无标记 → 即便 registry 有这个 id 也跳过
    const r = syncSkills({
      entries: [entry(tool({ id: "foreign" }), finding, true), entry(tool({ id: "nosuchsrc" }), finding, true)],
      sourceRoot: src,
      skillRoot: root,
    })
    expect(r.skipped.sort()).toEqual(["foreign", "nosuchsrc"])
    expect(r.written).toEqual([])
    expect(readFileSync(path.join(root, "foreign", "SKILL.md"), "utf8")).toContain("not ours")
  })

  test("团队删掉工具后，残留的托管目录被清理", () => {
    syncSkills({ entries: [entry(tool({}), finding, true)], sourceRoot: src, skillRoot: root })
    expect(existsSync(path.join(root, "hermes"))).toBe(true)
    // 下一轮 registry 里没有 hermes 了（entries 为空）
    const r = syncSkills({ entries: [], sourceRoot: src, skillRoot: root })
    expect(r.removed).toEqual(["hermes"])
    expect(existsSync(path.join(root, "hermes"))).toBe(false)
  })

  test("前缀：写入带前缀目录；清理只扫前缀内", () => {
    const r = syncSkills({
      entries: [entry(tool({}), finding, true)],
      sourceRoot: src,
      skillRoot: root,
      prefix: "team-",
    })
    expect(r.written).toEqual(["hermes"])
    expect(existsSync(path.join(root, "team-hermes", "SKILL.md"))).toBe(true)
    expect(existsSync(path.join(root, "hermes"))).toBe(false)
    // 异物目录（无前缀）不会被清理波及
    const r2 = syncSkills({ entries: [], sourceRoot: src, skillRoot: root, prefix: "team-" })
    expect(r2.removed).toEqual(["hermes"])
    expect(existsSync(path.join(root, "foreign", "SKILL.md"))).toBe(true)
  })

  test("方案 C：hand-over 后写 library 副本，共享点残留被清、异物不碰、sync 置位", () => {
    // 初始：F3 写到共享点
    syncSkills({ entries: [entry(tool({}), finding, true)], sourceRoot: src, skillRoot: root, prefix: "team-" })
    expect(existsSync(path.join(root, "team-hermes", "SKILL.md"))).toBe(true)
    // 模拟用户 hand-over：共享点副本被搬进 library（magpie 会保留内容/改名）
    const lib = mkdtempSync(path.join(tmpdir(), "tc-sk-lib-"))
    mkdirSync(path.join(lib, "team-hermes"), { recursive: true })
    const moved = readFileSync(path.join(root, "team-hermes", "SKILL.md"), "utf8")
    writeFileSync(path.join(lib, "team-hermes", "SKILL.md"), moved)
    rmSync(path.join(root, "team-hermes"), { recursive: true, force: true })

    // 下一轮：分流到 library（真实场景：CLI 升级使实测块变化）
    const r1 = syncSkills({
      entries: [entry(tool({}), { ...finding, version: "0.24.0" }, true)],
      sourceRoot: src,
      skillRoot: root,
      prefix: "team-",
      libraryDir: lib,
    })
    expect(r1.written).toEqual(["hermes"])
    expect(r1.sync).toBe(true) // 内容有差 → 触发 sync
    expect(existsSync(path.join(lib, "team-hermes", "SKILL.md"))).toBe(true)
    expect(readFileSync(path.join(lib, "team-hermes", "SKILL.md"), "utf8")).toContain("0.24.0")
    expect(existsSync(path.join(root, "team-hermes"))).toBe(false) // 不重建共享点副本

    // 幂等：内容一致不再写、sync 不置位
    const r2 = syncSkills({
      entries: [entry(tool({}), { ...finding, version: "0.24.0" }, true)],
      sourceRoot: src,
      skillRoot: root,
      prefix: "team-",
      libraryDir: lib,
    })
    expect(r2.written).toEqual([])
    expect(r2.sync).toBe(false)

    // 禁用：library 副本不动（归 magpie 管），共享点无残留
    const r3 = syncSkills({
      entries: [entry(tool({}), finding, false)],
      sourceRoot: src,
      skillRoot: root,
      prefix: "team-",
      libraryDir: lib,
    })
    expect(r3.removed).toEqual([])
    expect(existsSync(path.join(lib, "team-hermes", "SKILL.md"))).toBe(true)

    // library 里异物（无标记）不碰
    mkdirSync(path.join(lib, "team-foreign"), { recursive: true })
    writeFileSync(path.join(lib, "team-foreign", "SKILL.md"), "---\nname: x\n---\nnot ours\n")
    syncSkills({
      entries: [entry(tool({ id: "foreign" }), finding, true)],
      sourceRoot: src,
      skillRoot: root,
      prefix: "team-",
      libraryDir: lib,
    })
    expect(readFileSync(path.join(lib, "team-foreign", "SKILL.md"), "utf8")).toContain("not ours")
    rmSync(lib, { recursive: true, force: true })
  })
})
