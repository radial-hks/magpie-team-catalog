import { beforeAll, afterAll, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { catalogTool, catalogStatus } from "../lib/tool.mjs"
import { CATALOG_SCHEMA, validateArgs } from "../lib/mcp-contract.mjs"
import { toolFingerprint, projectFingerprint } from "../lib/snapshot.mjs"
import { fakeCLI } from "./helpers/fake-cli.mjs"
import { loadRegistry } from "../lib/source.mjs"

let dir, opts, tool, projects, state
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tc-mcp-"))
  opts = { registry: path.join(dir, "registry.json"), statePath: path.join(dir, "state.json"), localRegistry: false }
  const marker = path.join(dir, "probe-marker")
  const bin = fakeCLI(dir, "checked", { code: `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');console.log('ok');\n` })
  tool = { id: "cli", kind: "binary", install: "install text", usage: "usage", check: { bin, probe: ["status"] }, documentation: "0123456789".repeat(1500) }
  projects = Array.from({ length: 35 }, (_, i) => ({ id: `project-${String(i).padStart(2, "0")}`, kind: "p4", localPath: path.join(dir, `project-${i}`), p4: { client: i < 15 ? "client-a" : "client-b", port: "host:1666", user: "u", view: ["//depot/... //client/..."] }, note: "n".repeat(1000) }))
  writeFileSync(opts.registry, JSON.stringify({ version: 1, tools: [tool], projects }))
  state = { checkedAt: Date.now(), tools: { cli: { status: "present", version: "1.0.0", path: bin, fingerprint: toolFingerprint(tool) } }, projects: Object.fromEntries(projects.map(p => [p.id, { status: "present", fingerprint: projectFingerprint(p), serverChecked: false }])) }
  writeFileSync(opts.statePath, JSON.stringify(state))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("schema/runtime 输入校验和模式互斥", async () => {
  expect(CATALOG_SCHEMA.properties.limit.maximum).toBe(100)
  for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { query: 1 }, { detail: "cli", query: "x" }, { check: true }, { extra: true }, { type: "tool", client: "c" }]) {
    expect((await catalogTool(args, opts)).code).toBe("INVALID_ARGUMENT")
  }
  expect(() => validateArgs({ query: "x", limit: 10 })).not.toThrow()
})
test("默认20条稳定分页，无重复，简略输出不含View/全文", async () => {
  const a = await catalogTool({}, opts), b = await catalogTool({ offset: a.pagination.nextOffset }, opts)
  expect(a.pagination).toMatchObject({ total: 36, returned: 20, nextOffset: 20 })
  expect(b.pagination).toMatchObject({ returned: 16, nextOffset: null })
  expect(new Set([...a.tools, ...a.projects, ...b.tools, ...b.projects].map(e => e.id)).size).toBe(36)
  expect(a.projects[0].p4.view).toBeUndefined()
  expect(a.projects[0].note.length).toBe(240)
})
test("project client/port/path/source/kind/status 筛选", async () => {
  const out = await catalogTool({ type: "project", kind: "p4", client: "client-a", port: "host:1666", source: "team", status: "present", limit: 100 }, opts)
  expect(out.projects).toHaveLength(15)
  expect(out.tools).toHaveLength(0)
  expect((await catalogTool({ path: projects[2].localPath.replace(/\\/g, "/"), type: "project" }, opts)).projects.some(p => p.id === projects[2].id)).toBe(true)
})
test("详情默认不执行probe，显式check才执行，不写周期state", async () => {
  const before = readFileSync(opts.statePath, "utf8")
  const read = await catalogTool({ detail: "cli" }, opts)
  expect(read.check.performed).toBe(false)
  expect(read.status).toBe("present")
  expect(existsSync(path.join(dir, "probe-marker"))).toBe(false)
  const checked = await catalogTool({ detail: "cli", check: true }, opts)
  expect(checked).toMatchObject({ status: "configured", check: { requested: true, performed: true, ok: true } })
  expect(readFileSync(opts.statePath, "utf8")).toBe(before)
})
test("文档有界分段、精确ID错误、P4禁止check并保留安全说明", async () => {
  const first = await catalogTool({ detail: "cli", docLimit: 100 }, opts)
  expect(first.doc).toHaveLength(100)
  expect(first.documentation).toMatchObject({ total: 15000, nextOffset: 100, truncated: true })
  const next = await catalogTool({ detail: "cli", docOffset: 14900, docLimit: 100 }, opts)
  expect(next.documentation.nextOffset).toBe(null)
  expect((await catalogTool({ detail: "absent" }, opts)).code).toBe("NOT_FOUND")
  expect((await catalogTool({ detail: projects[0].id, check: true }, opts)).code).toBe("INVALID_ARGUMENT")
  const p = await catalogTool({ detail: projects[0].id }, opts)
  expect(p.p4.view).toHaveLength(1)
  expect(p.safety).toMatchObject({ serverVerified: false, writesAuthorized: false })
})
test("过期状态标记并触发后台刷新，不自动probe", async () => {
  writeFileSync(opts.statePath, JSON.stringify({ ...state, checkedAt: 1 }))
  let triggered = 0
  const result = await catalogTool({ detail: "cli", check: true }, opts, { onStale: () => triggered++ })
  expect(result.meta.stale).toBe(true)
  expect(result.check.performed).toBe(false)
  expect(triggered).toBe(1)
  writeFileSync(opts.statePath, JSON.stringify(state))
})
test("修改check/项目绑定使旧实测失效，钉死状态不伪装实测", async () => {
  const changed = { ...tool, check: { ...tool.check, bin: path.join(dir, "new.exe") } }
  writeFileSync(opts.registry, JSON.stringify({ version: 1, tools: [changed], projects: projects.map((p, i) => i ? p : { ...p, localPath: path.join(dir, "changed") }) }))
  expect(await catalogTool({ detail: "cli" }, opts)).toMatchObject({ status: "unknown", meta: { stale: true, reason: "registration-changed" } })
  expect((await catalogTool({ detail: projects[0].id }, opts)).local.status).toBe("unknown")
  const pinned = await catalogTool({ detail: "cli", check: true }, { ...opts, overrides: { cli: { status: "present" } } })
  expect(pinned.stateOrigin).toBe("user-pinned")
  expect(pinned.path).toBeUndefined()
  expect(pinned.check.performed).toBe(false)
  writeFileSync(opts.registry, JSON.stringify({ version: 1, tools: [tool], projects }))
})
test("status概览无全文/命令执行，返回数量与能力", async () => {
  const out = await catalogStatus({}, opts)
  expect(out.counts).toMatchObject({ tools: 1, projects: 35, projectKind: { p4: 35 } })
  expect(out.capabilities.readOnlyByDefault).toBe(true)
  expect(out.projects).toBeUndefined()
  expect((await catalogStatus({ query: "x" }, opts)).code).toBe("INVALID_ARGUMENT")
})
test("远程 registry MCP 仅读缓存、缺缓存/数据源变更不下载", async () => {
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return Response.json({ version: 1, tools: [], projects: [] }) } })
  const url = `http://127.0.0.1:${server.port}/registry.yaml`, cacheDir = path.join(dir, "cache")
  try {
    expect((await catalogTool({}, { ...opts, registry: url, cacheDir })).code).toBe("REGISTRY_UNAVAILABLE")
    expect(requests).toBe(0)
    await loadRegistry(url, { cacheDir })
    expect(requests).toBe(1)
    expect((await catalogTool({}, { ...opts, registry: url, cacheDir })).pagination.total).toBe(0)
    expect((await catalogTool({}, { ...opts, registry: url + "?other", cacheDir })).code).toBe("REGISTRY_UNAVAILABLE")
    expect(requests).toBe(1)
  } finally { server.stop(true) }
})
