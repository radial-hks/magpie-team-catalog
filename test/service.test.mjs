// service.mjs / pageView 测试：纯视图组装 + 真 service HTTP 行为（Bun.serve）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { pageView, startService, DEFAULT_SERVICE_PORT } from "../lib/service.mjs"
import { parseRegistry } from "../lib/core.mjs"
import { fakeCLI } from "./helpers/fake-cli.mjs"

const REGISTRY = `version: 1
tools:
  - id: deploy-cli
    name: 部署 CLI
    kind: npm
    install: "npm i -g @team/deploy-cli"
    min: 1.4.0
    check: {bin: deploy-cli, version: ["--version"]}
  - id: perf-diag
    kind: binary
    install: "brew install team/tap/perf-diag"
projects:
  - id: billing
    vcs: git@github.com:team/billing.git
`

describe("pageView（纯）", () => {
  const reg = parseRegistry(REGISTRY)

  test("探测状态、覆盖、钉死、禁用各有其位", () => {
    const state = { checkedAt: 12345, tools: { "deploy-cli": { status: "outdated", version: "1.2.0", via: "path", at: 12345 } } }
    const overrides = { "perf-diag": { enabled: false } }
    const v = pageView(reg, state, { overrides, index: "某索引" }, "darwin")
    expect(v.tools[0]).toMatchObject({ id: "deploy-cli", status: "outdated", version: "1.2.0", min: "1.4.0", via: "path", at: new Date(12345).toISOString() })
    expect(v.tools[1]).toMatchObject({ id: "perf-diag", status: "disabled" })
    expect(v.projects[0]).toMatchObject({ id: "billing", vcs: "git@github.com:team/billing.git" })
    expect(v.checkedAt).toBe(new Date(12345).toISOString())
    expect(v.index).toBe("某索引")
  })

  test("钉死状态优先于探测结果", () => {
    const state = { checkedAt: 1, tools: { "deploy-cli": { status: "missing" } } }
    const v = pageView(reg, state, { overrides: { "deploy-cli": { status: "configured" } } }, "darwin")
    expect(v.tools[0].status).toBe("configured")
    expect(v.tools[0].override).toEqual({ status: "configured" })
  })

  test("无 state → unknown", () => {
    const v = pageView(reg, null, {}, "darwin")
    expect(v.tools.every((t) => t.status === "unknown")).toBe(true)
    expect(v.checkedAt).toBeUndefined()
  })
})

describe("service HTTP（真 Bun.serve）", () => {
  let dir
  let server
  let base
  let headers

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "tc-svc-"))
    // 刷新只探测临时 CLI：不读取本机 npm 全局包，也不依赖本机 PATH。
    const bin = fakeCLI(dir, "deploy-cli", { output: "1.4.2" })
    const isolated = REGISTRY.replace("kind: npm", "kind: binary")
      .replace("bin: deploy-cli", `bin: ${JSON.stringify(bin)}`)
      .replace('    install: "brew install team/tap/perf-diag"', `    install: "brew install team/tap/perf-diag"\n    check: {bin: ${JSON.stringify(path.join(dir, "missing.exe"))}}`)
    writeFileSync(path.join(dir, "registry.yaml"), isolated)
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({ checkedAt: 999, tools: { "deploy-cli": { status: "present", version: "1.4.2", via: "npm", at: 999 } } }))
    const port = 34000 + Math.floor(Math.random() * 2000)
    server = startService({ registry: path.join(dir, "registry.yaml"), statePath: path.join(dir, "state.json"), servicePort: port, localRegistry: false, magpieBin: path.join(dir, "no-magpie.exe") }, { readOptions: () => null })
    base = `http://127.0.0.1:${server.port}`
    const html = await (await fetch(base)).text()
    headers = { "x-catalog-token": html.match(/name="catalog-token" content="([^"]+)"/)[1] }
  })

  afterAll(() => {
    server?.stop?.(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("GET /state 返回视图与 CORS 头", async () => {
    const r = await fetch(`${base}/state`)
    expect(r.status).toBe(200)
    expect(r.headers.get("access-control-allow-origin")).toBe("*")
    const v = await r.json()
    expect(v.tools[0]).toMatchObject({ id: "deploy-cli", status: "present", version: "1.4.2" })
    expect(v.projects[0].id).toBe("billing")
  })

  test("OPTIONS 预检放行；404 兜底", async () => {
    expect((await fetch(`${base}/state`, { method: "OPTIONS" })).status).toBe(200)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })

  test("POST /refresh 202 并触发 worker（state 变新）", async () => {
    const r = await fetch(`${base}/refresh`, { method: "POST", headers })
    expect(r.status).toBe(202)
    // worker 探测临时 CLI 与不存在的绝对路径 → state 更新 checkedAt。
    // Windows worker 冷启动可能超过 bun test 默认的 5s。
    let changed = false
    for (let i = 0; i < 24 && !changed; i++) {
      await new Promise((res) => setTimeout(res, 500))
      const v = await (await fetch(`${base}/state`)).json()
      changed = v.checkedAt !== new Date(999).toISOString()
    }
    expect(changed).toBe(true)
  }, 15000)

  test("GET / 出带路页导航过去的主界面（service 自己服务）", async () => {
    const r = await fetch(`${base}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get("access-control-allow-origin")).toBe(null)
    expect(r.headers.get("content-type")).toContain("text/html")
    const html = await r.text()
    // 主界面是 service 端的，不依赖沙箱页的网络权限（官方带路页模式）
    expect(html).toContain("团队目录")
    expect(html).toContain('fetch("/state")')
  })

  test("POST /options 校验 body：非对象拒绝，不写盘", async () => {
    for (const bad of [{}, { overrides: [] }, { overrides: null }, { overrides: "x" }]) {
      const r = await fetch(`${base}/options`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(bad),
      })
      expect(r.status).toBe(500)
      expect((await r.json()).error).toContain("overrides")
    }
  })

  test("默认端口常量与 package.json 声明一致", () => {
    expect(DEFAULT_SERVICE_PORT).toBe(3969)
  })
})
