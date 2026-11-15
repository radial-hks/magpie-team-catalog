// 单一 MCP contract：入口 schema 与 runtime validation 共用，默认只读/有界。
export const CATALOG_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 500, description: "关键词：工具/包名、项目名/路径、P4 Client/Depot" },
    detail: { type: "string", maxLength: 48, description: "精确条目 ID；不能与筛选/分页参数混用" },
    type: { type: "string", enum: ["all", "tool", "project"], description: "条目类型，默认 all" },
    source: { type: "string", enum: ["all", "team", "local"], description: "团队/本机来源，默认 all" },
    kind: { type: "string", enum: ["npm", "pipx", "pip", "brew", "binary", "git", "p4", "directory"] },
    status: { type: "string", enum: ["unknown", "missing", "present", "outdated", "configured", "disabled", "unbound", "not-repository"] },
    client: { type: "string", maxLength: 200, description: "P4 Client 精确匹配，仅 project" },
    port: { type: "string", maxLength: 200, description: "P4 server 精确匹配，仅 project" },
    path: { type: "string", maxLength: 2000, description: "本机目录包含筛选（大小写不敏感，统一斜杠），仅 project" },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "列表合计条目数，默认 20" },
    offset: { type: "integer", minimum: 0, maximum: 100000, description: "列表偏移，默认 0；按 ID 稳定排序" },
    summary: { type: "boolean", description: "列表默认 true：不返回全文/View；false 返回展开字段" },
    check: { type: "boolean", description: "仅工具 detail；默认 false，不执行 CLI。true 执行声明的只读 probe（最多 5 秒），不验证 P4 服务器" },
    docOffset: { type: "integer", minimum: 0, maximum: 1000000, description: "detail 文档字符偏移，默认 0" },
    docLimit: { type: "integer", minimum: 1, maximum: 20000, description: "detail 文档字符上限，默认 8000" },
  },
  additionalProperties: false,
}
export const STATUS_SCHEMA = { type: "object", properties: {}, additionalProperties: false }

export function validateArgs(args, schema = CATALOG_SCHEMA) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args must be an object")
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key]
    if (!prop) throw new Error(`unknown argument: ${key}`)
    if (prop.type === "integer" ? !Number.isInteger(value) : typeof value !== prop.type) throw new Error(`${key} must be ${prop.type}`)
    if (prop.enum && !prop.enum.includes(value)) throw new Error(`${key} invalid value`)
    if (prop.minimum !== undefined && value < prop.minimum || prop.maximum !== undefined && value > prop.maximum) throw new Error(`${key} out of range`)
    if (prop.maxLength && value.length > prop.maxLength) throw new Error(`${key} too long`)
  }
  if (args.detail !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(args.detail)) throw new Error("detail must be a valid exact ID")
    for (const key of ["query", "type", "source", "kind", "status", "client", "port", "path", "limit", "offset", "summary"]) if (args[key] !== undefined) throw new Error(`detail cannot combine with ${key}`)
  } else for (const key of ["check", "docOffset", "docLimit"]) if (args[key] !== undefined) throw new Error(`${key} requires detail`)
  if (!args.detail && ["docOffset", "docLimit"].some(k => args[k] !== undefined)) throw new Error("documentation requires detail")
  if (args.type === "tool" && ["client", "port", "path"].some(k => args[k] !== undefined)) throw new Error("client/port/path are project filters")
  return args
}
