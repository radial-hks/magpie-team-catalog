// inject.mjs — 把索引文本 prepend 进各协议请求体的 system 提示词。
// 纯函数，无依赖：Bun 侧测试与 moejs 侧 middleware 共用（moejs 只允许相对导入）。
// 不认识的请求体形状返回 null（调用方保持原样——fail-open）。
// 注入位置（头部 prepend）是 M1 默认；design.md 开放问题 2 实测后再定。

const SEP = "\n\n"

/**
 * 把索引文本 prepend 进请求体的 system 提示词。返回改写后的 body（原地
 * 修改同一对象），或 null 表示不动。
 * protocol（anthropic/chat/responses/gemini）由 middleware 的 ctx.protocol 传入，
 * 是权威信号；缺省时按形状精猜（仅测试用）：认不出的返回 null（fail-open）。
 * 注入位置（头部 prepend）是 M1 默认；design.md 开放问题 2 实测后再定。
 */
export function injectSystem(body, text, protocol) {
  if (typeof body !== "object" || body === null || typeof text !== "string" || text === "") return null
  if (protocol === "anthropic") return injectAnthropic(body, text)
  if (protocol === "chat") return injectChat(body, text)
  if (protocol === "responses") return injectResponses(body, text)
  if (protocol === "gemini") return injectGemini(body, text)
  if (body.system !== undefined) return injectAnthropic(body, text)
  if (Array.isArray(body.messages)) return injectChat(body, text)
  if (body.instructions !== undefined) return injectResponses(body, text)
  if (body.systemInstruction !== undefined) return injectGemini(body, text)
  return null
}

// Anthropic Messages：system 是字符串或内容块数组
function injectAnthropic(body, text) {
  if (typeof body.system === "string") {
    body.system = text + SEP + body.system
  } else if (Array.isArray(body.system)) {
    body.system.unshift({ type: "text", text })
  } else {
    body.system = [{ type: "text", text }]
  }
  return body
}

// OpenAI Chat Completions：前导 system 消息；没有则插一条
function injectChat(body, text) {
  const first = body.messages.find((m) => m && m.role === "system")
  if (!first) {
    body.messages.unshift({ role: "system", content: text })
    return body
  }
  if (typeof first.content === "string") {
    first.content = text + SEP + first.content
  } else if (Array.isArray(first.content)) {
    first.content.unshift({ type: "text", text })
  } else {
    first.content = [{ type: "text", text }]
  }
  return body
}

// OpenAI Responses API：instructions 字符串
function injectResponses(body, text) {
  if (typeof body.instructions === "string") {
    body.instructions = text + SEP + body.instructions
  } else {
    body.instructions = text
  }
  return body
}

// Gemini：systemInstruction {parts:[{text}]}（可能带 role）
function injectGemini(body, text) {
  const si = body.systemInstruction
  if (typeof si === "string") {
    body.systemInstruction = { parts: [{ text }] }
  } else if (si && Array.isArray(si.parts)) {
    si.parts.unshift({ text })
  } else if (si && typeof si === "object") {
    si.parts = [{ text }]
  } else {
    body.systemInstruction = { parts: [{ text }] }
  }
  return body
}
