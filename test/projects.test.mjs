import { beforeAll, afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { validateRegistry, buildIndex } from "../lib/core.mjs"
import { projectJSON, safeRemote, projectKind } from "../lib/project-model.mjs"
import { discoverGit, inspectGit, readP4Config, discoverP4, parseP4Tagged, probeProjects } from "../lib/project-discovery.mjs"
import { readLocalRegistry, saveLocalRegistry, mergeRegistries } from "../lib/catalog.mjs"
import { runCycle } from "../lib/cycle.mjs"
import { catalogTool } from "../lib/tool.mjs"

let dir, repo
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tc-projects-")); repo = path.join(dir, "repo with space"); mkdirSync(repo)
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
  writeFileSync(path.join(repo, "file.txt"), "test\n")
  execFileSync("git", ["add", "."], { cwd: repo })
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "test"], { cwd: repo })
  execFileSync("git", ["remote", "add", "origin", "https://user:secret@git.example/team/repo.git?token=secret#private"], { cwd: repo })
}, 15000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("project registry", () => {
  test("兼容旧地址，支持仅本地 Git/P4/目录，拒绝错误路径和凭据", () => {
    expect(projectKind({ vcs: "git@host:x.git" })).toBe("git")
    expect(projectKind({ vcs: "perforce://host//depot/x" })).toBe("p4")
    expect(validateRegistry({ version: 1, projects: [{ id: "repo", kind: "git", localPath: repo }, { id: "p4", kind: "p4", localPath: dir, p4: { port: "ssl:host:1666", user: "test", client: "workspace" } }] }).projects).toHaveLength(2)
    for (const extra of [{ localPath: "relative" }, { kind: "other", localPath: dir }, { kind: "p4", p4: { client: "x", password: "secret" } }]) expect(() => validateRegistry({ version: 1, projects: [{ id: "x", ...extra }] })).toThrow()
    expect(() => validateRegistry({ version: 1, projectBindings: { x: { vcs: "override" } } })).toThrow(/cannot override/)
  })
  test("团队项目本机绑定只影响本机信息；冲突/悬空/错误类型拒绝", () => {
    const team = { version: 1, tools: [], projects: [{ id: "git", vcs: "git@host:x.git" }, { id: "p4", kind: "p4", vcs: "perforce://host//depot/x" }] }
    const local = { version: 1, tools: [], projects: [], projectBindings: { git: { localPath: repo }, p4: { localPath: dir, p4: { port: "host:1666", client: "client", user: "u" } } } }
    const merged = mergeRegistries(team, local, { strict: true })
    expect(merged.registry.projects[0]).toMatchObject({ vcs: "git@host:x.git", localPath: repo, source: "team", bindingSource: "local" })
    expect(team.projects[0].localPath).toBeUndefined()
    expect(() => mergeRegistries(team, { ...local, projectBindings: { missing: { localPath: repo } } }, { strict: true })).toThrow(/没有对应/)
    expect(() => mergeRegistries(team, { ...local, projectBindings: { git: { p4: { client: "x" } } } }, { strict: true })).toThrow(/不是 P4/)
  })
  test("remote 凭据/查询脱敏，索引与 JSON 保留本机路径", () => {
    expect(safeRemote("https://user:secret@host/repo.git?token=x#secret")).toBe("https://host/repo.git")
    const p = { id: "x", kind: "git", localPath: repo }
    expect(projectJSON(p).localPath).toBe(repo)
    expect(buildIndex({ tools: [], projects: [p] }, {})).toContain(repo)
  })
})

describe("local Git discovery", () => {
  test("读取根/分支/HEAD/remote，不 fetch，不改 index/worktree", async () => {
    const index = readFileSync(path.join(repo, ".git", "index"))
    const result = await inspectGit(repo)
    expect(result).toMatchObject({ status: "present", branch: "main", vcs: "https://git.example/team/repo.git" })
    expect(result.head).toMatch(/^[a-f0-9]{40}$/)
    expect(readFileSync(path.join(repo, ".git", "index"))).toEqual(index)
    expect(JSON.stringify(result)).not.toContain("secret")
  })
  test("扫描仅明确根、边界限制、跳过依赖树", async () => {
    const node = path.join(dir, "node_modules"); mkdirSync(node); mkdirSync(path.join(node, "hidden")); mkdirSync(path.join(node, "hidden", ".git"))
    const result = await discoverGit({ root: dir, maxDepth: 1 })
    expect(result.candidates).toHaveLength(1)
    expect(readFileSync(path.join(result.candidates[0].localPath, "file.txt"), "utf8")).toBe(readFileSync(path.join(repo, "file.txt"), "utf8"))
    expect(path.basename(result.candidates[0].localPath)).toBe(path.basename(repo))
    await expect(discoverGit({ root: dir, maxDepth: 99 })).rejects.toThrow(/maxDepth/)
    await expect(discoverGit({ root: "relative" })).rejects.toThrow(/absolute/)
  })
  test("Git worktree .git 文件、detached HEAD", async () => {
    const worktree = path.join(dir, "worktree")
    execFileSync("git", ["worktree", "add", "--detach", worktree], { cwd: repo })
    expect(readFileSync(path.join(worktree, ".git"), "utf8")).toContain("gitdir:")
    const result = await inspectGit(worktree)
    expect(result).toMatchObject({ status: "present", branch: "(detached)" })
    expect((await discoverGit({ root: dir, maxDepth: 1 })).candidates).toHaveLength(2)
    execFileSync("git", ["worktree", "remove", worktree], { cwd: repo })
  })
  test("非仓库/missing/unbound 明确区分，P4 周期绝不查询服务器", async () => {
    let calls = 0
    const result = await probeProjects([{ id: "unbound", vcs: "git@host:x" }, { id: "missing", kind: "git", localPath: path.join(dir, "missing") }, { id: "p4", kind: "p4", localPath: dir, p4: { client: "x" } }], { run: async () => { calls++; throw Error("must not run") } })
    expect(result.unbound.status).toBe("unbound"); expect(result.missing.status).toBe("missing")
    expect(result.p4).toMatchObject({ status: "present", serverChecked: false }); expect(calls).toBe(0)
    expect((await inspectGit(dir)).status).toBe("not-repository")
  })
})

describe("P4 discovery", () => {
  test("P4CONFIG 严格仅返回 allowlist，不读票据/密码", () => {
    const file = path.join(dir, ".p4config")
    writeFileSync(file, "P4PORT=host:1666\nP4USER=test\nP4CLIENT=client\nP4PASSWD=secret\nP4TICKETS=C:/secret\nOTHER=hidden\n")
    const config = readP4Config(file)
    expect(config).toEqual({ configFile: file, port: "host:1666", user: "test", client: "client" })
    expect(JSON.stringify(config)).not.toContain("secret")
  })
  test("只有明确 consent 才查询，固定命令、指定 client spec/View", async () => {
    const commands = []
    const run = async (_bin, args) => {
      commands.push(args)
      return { ok: true, stdout: args.includes("clients") ? `... client client\n... Root ${dir}\n... Host local-host\n... Stream //depot/main\n` : `... Client client\n... Root ${dir}\n... Stream //depot/main\n... View0 //depot/... //client/...\n` }
    }
    await expect(discoverP4({ port: "host:1666", user: "test" }, { run })).rejects.toThrow(/consent/)
    expect(commands).toHaveLength(0)
    const out = await discoverP4({ port: "host:1666", user: "test", client: "client", consent: true }, { run })
    expect(out.candidates[0]).toMatchObject({ kind: "p4", localPath: dir, p4: { client: "client", stream: "//depot/main", view: ["//depot/... //client/..."] } })
    expect(commands).toEqual([["-ztag", "-p", "host:1666", "-u", "test", "clients", "-u", "test"], ["-ztag", "-p", "host:1666", "-u", "test", "client", "-o", "client"]])
  })
  test("权限失败/不存在 client 不自动登录或创建，拒绝参数注入", async () => {
    const run = async () => ({ ok: true, stdout: "... code error\n... severity 3\n... data password expired\n" })
    await expect(discoverP4({ port: "host:1666", user: "test", consent: true }, { run })).rejects.toThrow(/拒绝/)
    await expect(discoverP4({ port: "host:1666", user: "-x", consent: true }, { run })).rejects.toThrow(/unsupported/)
    expect(parseP4Tagged("... client a\n... Root X\n\n... client b\n... Root Y\n")).toHaveLength(2)
  })
})

test("本机项目和团队绑定原子保存、worker/MCP 搜索路径与 client", async () => {
  const options = { registry: path.join(dir, "team.json"), localRegistry: path.join(dir, "personal.json"), statePath: path.join(dir, "state.json") }
  writeFileSync(options.registry, JSON.stringify({ version: 1, projects: [{ id: "team-git", vcs: "git@host:team/project.git" }] }))
  const original = readFileSync(options.registry, "utf8")
  const s = readLocalRegistry(options)
  await saveLocalRegistry({ version: 1, tools: [], projects: [{ id: "p4-local", kind: "p4", localPath: dir, p4: { port: "host:1666", client: "my-client", user: "u", depotPath: "//depot/project/..." } }], projectBindings: { "team-git": { localPath: repo } } }, s.revision, options)
  expect(readLocalRegistry(options).registry.projectBindings["team-git"].localPath).toBe(repo)
  await runCycle(options, { readOptions: () => null, publish: async () => {} })
  const git = await catalogTool({ detail: "team-git" }, options)
  expect(git).toMatchObject({ source: "team", bindingSource: "local", local: { status: "present", branch: "main" } })
  expect((await catalogTool({ query: "my-client" }, options)).projects[0].id).toBe("p4-local")
  expect((await catalogTool({ query: "repo with space" }, options)).projects.some(p => p.id === "team-git")).toBe(true)
  expect(readFileSync(options.registry, "utf8")).toBe(original)
}, 15000)
