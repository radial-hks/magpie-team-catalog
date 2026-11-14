// catalog.middleware.js — 网关中间件（moejs，非 Bun）。
// 只做纯注入：索引文本由 Bun 宿主模块探测后写入 plugins.json 里本插件的
// options（ctx.options.index），本文件不探测、不读文件、不发请求。
// 约束：无 fetch / 定时器 / Node API；onRequest 250ms 预算；fail-open。
import { injectSystem } from "./lib/inject.mjs"

export function onRequest(body, ctx) {
  try {
    const index = ctx.options?.index
    if (typeof index !== "string" || index === "") return
    if (typeof body !== "object" || body === null) return
    const out = injectSystem(body, index, ctx.protocol)
    if (out === body) return body
  } catch {
    // fail-open：任何异常都当本中间件不存在
  }
}
