// inject.mjs + catalog.middleware.js 测试：四种协议形状、fail-open。
import { describe, expect, test } from "bun:test"
import { injectSystem } from "../lib/inject.mjs"
import * as mw from "../catalog.middleware.js"

const TEXT = "团队内部工具目录（本机实测）：deploy-cli(1.2.0,需更新)"

describe("injectSystem", () => {
  test("anthropic string / array / 缺省（需协议）", () => {
    const a = { system: "keep me", model: "x" }
    injectSystem(a, TEXT)
    expect(a.system.startsWith(TEXT)).toBe(true)
    expect(a.system.endsWith("keep me")).toBe(true)
    const b = { system: [{ type: "text", text: "old" }] }
    injectSystem(b, TEXT)
    expect(b.system[0]).toEqual({ type: "text", text: TEXT })
    expect(b.system[1].text).toBe("old")
    const c = { model: "x", messages: [{ role: "user", content: "hi" }] }
    injectSystem(c, TEXT, "anthropic")
    expect(c.system).toEqual([{ type: "text", text: TEXT }])
  })

  test("chat：已有 system / 没有 system", () => {
    const a = { messages: [{ role: "system", content: "old" }, { role: "user", content: "hi" }] }
    injectSystem(a, TEXT)
    expect(a.messages[0].content.startsWith(TEXT)).toBe(true)
    expect(a.messages[0].role).toBe("system")
    const b = { messages: [{ role: "user", content: "hi" }] }
    injectSystem(b, TEXT)
    expect(b.messages[0]).toEqual({ role: "system", content: TEXT })
    const c = { messages: [{ role: "system", content: [{ type: "text", text: "old" }] }] }
    injectSystem(c, TEXT)
    expect(c.messages[0].content[0].text).toBe(TEXT)
  })

  test("responses instructions / gemini systemInstruction", () => {
    const a = { instructions: "old" }
    injectSystem(a, TEXT)
    expect(a.instructions.startsWith(TEXT)).toBe(true)
    const b = { systemInstruction: { parts: [{ text: "old" }] } }
    injectSystem(b, TEXT)
    expect(b.systemInstruction.parts[0].text).toBe(TEXT)
    const c = {}
    injectSystem(c, TEXT, "gemini")
    expect(c.systemInstruction.parts[0].text).toBe(TEXT)
  })

  test("不认识形状返回 null；非对象、空文本不动", () => {
    expect(injectSystem({ foo: 1 }, TEXT)).toBe(null)
    expect(injectSystem(null, TEXT)).toBe(null)
    expect(injectSystem({ system: "x" }, "")).toBe(null)
  })
})

describe("catalog.middleware onRequest", () => {
  test("ctx.options.index 注入并返回新 body（协议权威分派）", () => {
    const body = { system: "old" }
    const out = mw.onRequest(body, { options: { index: TEXT }, protocol: "anthropic" })
    expect(out).toBe(body)
    expect(body.system.startsWith(TEXT)).toBe(true)
  })

  test("无 options / 无 index：不动请求", () => {
    const body = { system: "old" }
    expect(mw.onRequest(body, {})).toBeUndefined()
    expect(mw.onRequest(body, { options: {} })).toBeUndefined()
    expect(mw.onRequest(body, { options: { index: "" } })).toBeUndefined()
    expect(body.system).toBe("old")
  })

  test("抛错被吞（fail-open）", () => {
    const boom = { get options() { throw new Error("x") } }
    expect(mw.onRequest({ system: "old" }, boom)).toBeUndefined()
  })
})
