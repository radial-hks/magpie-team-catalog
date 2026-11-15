import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { startService } from "../lib/service.mjs"
import { optionsRevision } from "../lib/ui-options.mjs"

let dir, server, base, headers, triggers = 0, scans = 0, persisted = []
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "tc-personal-http-"))
  writeFileSync(path.join(dir, "team.yaml"), "version: 1\ntools:\n  - id: team\n    kind: binary\n    install: team install\n")
  server = startService({ registry: path.join(dir, "team.yaml"), localRegistry: path.join(dir, "local.yaml"), statePath: path.join(dir, "state.json"), servicePort: 0 }, {
    readOptions: () => null,
    trigger: () => { triggers++ },
    persistOptions: async options => { persisted.push(options) },
    scanGit: async body => ({ candidates: [{ kind: "git", localPath: body.root, suggestedId: "git-project", name: "Git project" }], warnings: [] }),
    scanP4: async body => { if (body.consent !== true) throw Error("consent required"); return { candidates: [], warnings: [] } },
    readP4: () => ({ port: "host:1666", user: "test", client: "workspace" }),
    scanNpm: async () => { scans++; return { root: dir, candidates: [{ package: "@team/ueb", bin: "ueb", suggestedId: "ueb", version: "1.0.0" }], warnings: [] } },
  })
  base = `http://127.0.0.1:${server.port}`
  const html = await (await fetch(base)).text()
  headers = { "x-catalog-token": html.match(/name="catalog-token" content="([^"]+)"/)[1], "content-type": "application/json" }
})
afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }) })

test("新增接口及现有 POST 无页面令牌均拒绝；DNS rebinding 拒绝", async () => {
  for (const route of ["/local-registry", "/npm-candidates"]) expect((await fetch(base + route)).status).toBe(403)
  for (const route of ["/refresh", "/options", "/local-registry", "/project-discovery"]) expect((await fetch(base + route, { method: "POST" })).status).toBe(403)
  expect((await fetch(base + "/state", { headers: { host: "evil.example" } })).status).toBe(403)
  expect(triggers).toBe(0)
  expect(scans).toBe(0)
})
test("旧页面令牌被拒绝并返回可恢复代码，不触发操作", async () => {
  const r = await fetch(base + "/refresh", { method: "POST", headers: { "x-catalog-token": "old-session" } })
  expect(r.status).toBe(403)
  expect((await r.json()).code).toBe("SESSION_EXPIRED")
  expect(triggers).toBe(0)
})
test("npm 发现只给候选，无注册/worker 副作用", async () => {
  const r = await fetch(base + "/npm-candidates", { headers })
  expect(r.status).toBe(200)
  expect((await r.json()).candidates[0].bin).toBe("ueb")
  expect(triggers).toBe(0)
  expect((await (await fetch(base + "/local-registry", { headers })).json()).registry.tools).toEqual([])
})
test("HTTP 保存/编辑/删除个人 CLI，团队冲突/过期修订拒绝且不触发探测", async () => {
  let snapshot = await (await fetch(base + "/local-registry", { headers })).json()
  const initialRevision = snapshot.revision
  const post = body => fetch(base + "/local-registry", { method: "POST", headers, body: JSON.stringify(body) })
  let r = await post({ registry: { version: 1, tools: [{ id: "ueb", kind: "npm", package: "@team/build", install: "从源码更新", usage: "ueb build -n", check: { bin: "ueb", version: ["--version"] } }] }, revision: snapshot.revision })
  snapshot = await r.json(); expect(snapshot.error).toBeUndefined(); expect(r.status).toBe(200)
  expect(triggers).toBe(1)
  const state = await (await fetch(base + "/state")).json()
  expect(state.tools.map(t => [t.id, t.source])).toEqual([["team", "team"], ["ueb", "local"]])
  expect((await post({ registry: snapshot.registry, revision: initialRevision })).status).toBe(409)
  expect((await post({ registry: { version: 1, tools: [{ id: "team", kind: "binary", install: "x" }] }, revision: snapshot.revision })).status).toBe(409)
  expect(triggers).toBe(1)
  snapshot.registry.tools[0].usage = "edited"
  r = await post({ registry: snapshot.registry, revision: snapshot.revision }); snapshot = await r.json()
  expect(snapshot.registry.tools[0].usage).toBe("edited")
  r = await post({ registry: { version: 1, tools: [], projects: [] }, revision: snapshot.revision })
  expect(r.status).toBe(200)
  expect(triggers).toBe(3)
  expect(JSON.parse(readFileSync(path.join(dir, "local.yaml"), "utf8")).tools).toEqual([])
})
test("项目发现授权接口、Git/P4/P4CONFIG 与项目绑定保存", async () => {
  const post = body => fetch(base + "/project-discovery", { method: "POST", headers, body: JSON.stringify(body) })
  const git = await (await post({ kind: "git", root: dir })).json()
  expect(git.candidates[0].kind).toBe("git")
  expect((await post({ kind: "p4", port: "host:1666", user: "test" })).status).toBe(422)
  expect((await post({ kind: "p4", port: "host:1666", user: "test", consent: true })).status).toBe(200)
  expect((await (await post({ kind: "p4-config", file: "file" })).json()).config.client).toBe("workspace")
  const s = await (await fetch(base + "/local-registry", { headers })).json()
  s.registry.projectBindings = { team: { localPath: dir } }
  // team 是工具 ID，不是项目，不能绑定。
  const r = await fetch(base + "/local-registry", { method: "POST", headers, body: JSON.stringify({ registry: s.registry, revision: s.revision }) })
  expect(r.status).toBe(409)
})

test("GUI设置读取/保存有会话和revision校验，不写其它配置键", async () => {
  expect((await fetch(base + "/ui-options")).status).toBe(403)
  const s = await (await fetch(base + "/ui-options", { headers })).json()
  expect(s.revision).toBe(optionsRevision(s.options))
  const save = body => fetch(base + "/options", { method: "POST", headers, body: JSON.stringify(body) })
  expect((await save({ revision: "stale", settings: { interval: 120 } })).status).toBe(409)
  expect(persisted).toHaveLength(0)
  expect((await save({ revision: s.revision, settings: { interval: 120 } })).status).toBe(200)
  expect(persisted[0].interval).toBe(120)
  expect(persisted[0].registry).toBe(s.options.registry)
})

test("页面包含编辑器入口与令牌，脚本可读且无动态 innerHTML", async () => {
  const response = await fetch(base, { headers: { origin: "https://evil.example" } })
  expect(response.headers.get("access-control-allow-origin")).toBe(null)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const html = await response.text()
  expect(html).toContain("function createCatalogManager")
  expect(html).not.toContain('<script src="/catalog-ui.js">')
  expect(html).toContain("function createCatalogAPI")
  expect(html).toContain("function createProjectManager")
  expect(html).toContain("发现 P4 工作区")
  expect(html).not.toContain('<script src="/session-client.js">')
  expect(html).not.toContain("__CATALOG_TOKEN__")
  expect(html).not.toContain("__CATALOG_SESSION__")
  const state = await (await fetch(base + "/state")).json()
  expect(html).toContain(`name="catalog-session" content="${state.session}"`)
  expect(state.session).not.toBe(headers["x-catalog-token"])
  const js = await (await fetch(base + "/catalog-ui.js")).text()
  expect(js).toContain("新增个人 CLI")
  expect(js).toContain("扫描 npm CLI")
  expect(js).not.toContain("innerHTML =")
  new Function(js)
  for (const script of html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)) new Function(script[1])
})
