import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../page/session-client.js", import.meta.url), "utf8")
const createCatalogAPI = new Function(`${source}; return createCatalogAPI`)()

describe("page session recovery", () => {
  test("明确过期回调一次，不重放 POST，覆盖调用方旧令牌", async () => {
    let calls = 0, recoveries = 0
    const api = createCatalogAPI({ token: "current", onExpired: () => { recoveries++ }, fetchImpl: async (_url, init) => {
      calls++
      expect(init.method).toBe("POST")
      expect(init.headers["x-catalog-token"]).toBe("current")
      return Response.json({ error: "页面会话已过期", code: "SESSION_EXPIRED" }, { status: 403 })
    } })
    await expect(api("/local-registry", { method: "POST", headers: { "x-catalog-token": "old" } })).rejects.toMatchObject({ sessionExpired: true })
    expect(calls).toBe(1)
    expect(recoveries).toBe(1)
  })
  test("其它 403/校验失败不触发重新加载", async () => {
    let recoveries = 0
    const api = createCatalogAPI({ token: "x", onExpired: () => { recoveries++ }, fetchImpl: async () => Response.json({ error: "Forbidden" }, { status: 403 }) })
    await expect(api("/refresh")).rejects.toThrow("Forbidden")
    expect(recoveries).toBe(0)
  })
  test("合法请求只执行一次，返回业务内容", async () => {
    let calls = 0
    const api = createCatalogAPI({ token: "x", onExpired: () => { throw Error("unexpected") }, fetchImpl: async () => { calls++; return Response.json({ ok: true }) } })
    expect(await api("/refresh", { method: "POST" })).toEqual({ ok: true })
    expect(calls).toBe(1)
  })
})
