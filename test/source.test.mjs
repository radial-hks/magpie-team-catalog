// source.mjs 测试：spec 形态判定、本地解析、http 下载（真 Bun.serve）、
// git 拉取（本地 git 仓库 + git+file://）、文档读取两种基址。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

import { specKind, loadRegistry, readRegistryDoc } from "../lib/source.mjs"

const REGISTRY = `version: 1
tools:
  - id: fakecli
    kind: binary
    install: "x"
    doc: docs/fakecli.md
projects:
  - id: proj
    vcs: git@github.com:team/proj.git
`
const DOC = "# fakecli\n\n用法全文。"

describe("specKind", () => {
  test("本地 / http / git 三形态", () => {
    expect(specKind("./registry/registry.yaml")).toBe("local")
    expect(specKind("/abs/path.yaml")).toBe("local")
    expect(specKind("file:///abs/path.yaml")).toBe("local")
    expect(specKind("https://git.internal/team/catalog/raw/main/registry.yaml")).toBe("http")
    expect(specKind("http://host/registry.yaml")).toBe("http")
    expect(specKind("git@github.com:team/catalog.git")).toBe("git")
    expect(specKind("git+https://github.com/team/catalog.git")).toBe("git")
    expect(specKind("https://github.com/team/catalog.git")).toBe("git")
    expect(specKind("git+https://github.com/team/catalog.git#v2")).toBe("git")
  })
})

describe("loadRegistry", () => {
  let dir
  let cache
  let httpServer
  let httpBase

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tc-src-"))
    cache = mkdtempSync(path.join(tmpdir(), "tc-cache-"))
    // http 源
    writeFileSync(path.join(dir, "registry.yaml"), REGISTRY)
    mkdirSync(path.join(dir, "docs"))
    writeFileSync(path.join(dir, "docs", "fakecli.md"), DOC)
    httpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const p = new URL(req.url).pathname
        const f = path.join(dir, p.slice(1))
        try {
          return new Response(readFileSync(f, "utf8"))
        } catch {
          return new Response("not found", { status: 404 })
        }
      },
    })
    httpBase = `http://127.0.0.1:${httpServer.port}`
    // git 源（本地仓库）
    const repo = path.join(dir, "repo")
    mkdirSync(repo)
    writeFileSync(path.join(repo, "registry.yaml"), REGISTRY)
    mkdirSync(path.join(repo, "docs"))
    writeFileSync(path.join(repo, "docs", "fakecli.md"), DOC)
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
    execFileSync("git", ["add", "."], { cwd: repo })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo })
  })

  afterAll(() => {
    httpServer?.stop?.(true)
    rmSync(dir, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  })

  test("local：路径与目录基址", async () => {
    const src = await loadRegistry(path.join(dir, "registry.yaml"), { cacheDir: cache })
    expect(src.kind).toBe("local")
    expect(src.path).toBe(path.join(dir, "registry.yaml"))
    expect(src.base).toBe(dir)
  })

  test("http：下载到缓存，文档按 URL 基址拉取", async () => {
    const src = await loadRegistry(`${httpBase}/registry.yaml`, { cacheDir: cache })
    expect(src.kind).toBe("http")
    expect(readFileSync(src.path, "utf8")).toBe(REGISTRY)
    expect(src.base).toBe(`${httpBase}/`)
    expect(await readRegistryDoc(src.base, "docs/fakecli.md")).toBe(DOC)
    expect(await readRegistryDoc(src.base, "docs/none.md")).toBe(null)
  })

  test("git：git+file:// clone 后可读，二次 load 走刷新分支", async () => {
    const src = await loadRegistry(`git+file://${path.join(dir, "repo")}#main`, { cacheDir: cache })
    expect(src.kind).toBe("git")
    expect(src.path.endsWith("registry-repo/registry.yaml")).toBe(true)
    expect(readFileSync(src.path, "utf8")).toBe(REGISTRY)
    expect(src.base.endsWith("registry-repo")).toBe(true)
    expect(await readRegistryDoc(src.base, "docs/fakecli.md")).toBe(DOC)
    // 再来一轮（已 clone，走 fetch+reset 分支）
    const again = await loadRegistry(`git+file://${path.join(dir, "repo")}#main`, { cacheDir: cache })
    expect(readFileSync(again.path, "utf8")).toBe(REGISTRY)
  })

  test("git：仓库更新后刷新能拉到新内容", async () => {
    const repo = path.join(dir, "repo")
    writeFileSync(path.join(repo, "registry.yaml"), REGISTRY.replace("fakecli", "fakecli2"))
    execFileSync("git", ["add", "."], { cwd: repo })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "rename"], { cwd: repo })
    const src = await loadRegistry(`git+file://${repo}#main`, { cacheDir: cache })
    expect(readFileSync(src.path, "utf8")).toContain("fakecli2")
  })

  test("拉取失败抛错（调用方 fail-open）", async () => {
    await expect(loadRegistry(`${httpBase}/nope.yaml`, { cacheDir: cache })).rejects.toThrow()
  })
})
