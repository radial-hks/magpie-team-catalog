// yaml.mjs — registry.yaml 的最小 YAML 子集解析器。
// 只支持 docs/registry-schema.md 声明的语法：嵌套映射、映射列表、
// 纯文本/单双引号标量、块标量 `|`、流式数组 ["a","b"] 与流式映射 {k:v}、
// 注释（整行与行尾）。不支持锚点、多文档、标签——超出即报错，宁可拒绝
// 也不静默丢字段。纯函数，无 IO，供 bun test 直接覆盖。

const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/

/** 解析一段 YAML 文本，返回 JS 值；结构不合法时抛 Error（带行号）。 */
export function parseYAML(text) {
  const raw = text.split(/\r?\n/)
  const lines = scanLines(text)
  if (lines.length === 0) return {}
  const [value, next] = parseBlock(lines, 0, lines[0].indent, raw)
  if (next < lines.length) {
    throw err(lines[next], "unexpected content")
  }
  return value
}

/** 一行：{indent, text, no}（no 为 1 起行号）。块标量内容由调用方另行截取。 */
function scanLines(text) {
  const out = []
  const raw = text.split(/\r?\n/)
  for (let no = 1; no <= raw.length; no++) {
    let line = raw[no - 1]
    const full = stripComment(line)
    if (full.trim() === "") continue
    out.push({ indent: full.length - full.trimStart().length, text: full.trim(), no, raw: line })
  }
  return out
}

/** 行尾注释剥离：引号外的 ` #` 之后截断；整行注释返回空串。 */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote && line[i - 1] !== "\\") quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i)
    }
  }
  return line
}

/** 解析 lines[i] 起始、基准缩进为 indent 的块（映射或序列）。 */
function parseBlock(lines, i, indent, raw) {
  const line = lines[i]
  if (line.text.startsWith("- ") || line.text === "-") return parseSeq(lines, i, indent, raw)
  return parseMap(lines, i, indent, raw)
}

function parseMap(lines, i, indent, raw) {
  const map = {}
  let j = i
  while (j < lines.length) {
    const line = lines[j]
    if (line.indent < indent) break
    if (line.indent > indent) throw err(line, "unexpected indentation")
    if (line.text.startsWith("- ")) throw err(line, "sequence item where a mapping key was expected")
    const colon = findColon(line.text)
    if (colon < 0) throw err(line, "expected `key: value`")
    const key = scalar(line.text.slice(0, colon).trim(), line)
    if (typeof key !== "string") throw err(line, "mapping key must be a string")
    const rest = line.text.slice(colon + 1).trim()
    if (rest === "") {
      // 值在下方更深的缩进块里；没有则值为 null
      if (j + 1 < lines.length && lines[j + 1].indent > indent) {
        const [v, next] = parseBlock(lines, j + 1, lines[j + 1].indent, raw)
        map[key] = v
        j = next
      } else {
        map[key] = null
        j++
      }
    } else if (rest === "|" || rest === "|-") {
      const [v, next] = parseBlockScalar(raw, lines, j, indent, rest)
      map[key] = v
      j = next
    } else {
      map[key] = scalar(rest, line)
      j++
    }
  }
  return [map, j]
}

function parseSeq(lines, i, indent, raw) {
  const items = []
  let j = i
  while (j < lines.length) {
    const line = lines[j]
    if (line.indent < indent) break
    if (line.indent > indent) throw err(line, "unexpected indentation")
    if (!line.text.startsWith("- ")) {
      if (line.text === "-") {
        items.push(null)
        j++
        continue
      }
      throw err(line, "expected a `- ` item")
    }
    const inner = line.text.slice(2)
    const innerIndent = indent + 2
    if (inner === "") throw err(line, "empty sequence item")
    const colon = findColon(inner)
    if (colon >= 0) {
      // `- key: value`：映射项，后续键在 innerIndent 列对齐（或更深）
      // 借用 parseMap：把它伪造成一行
      const first = { indent: innerIndent, text: inner, no: line.no }
      const rest = [first]
      let k = j + 1
      while (k < lines.length && lines[k].indent >= innerIndent) {
        rest.push(lines[k])
        k++
      }
      // 收集到的行整体交给 parseMap，其中首行已折算缩进
      const [v] = parseMap(rest, 0, innerIndent, raw)
      items.push(v)
      j = k
    } else {
      items.push(scalar(inner, line))
      j++
    }
  }
  return [items, j]
}

/**
 * `|` 块标量：从原始文本行取（空行与 # 开头行都是字面内容，不能经过
 * scanLines 的注释剥离）。块体 = key 行之后缩进 > keyIndent 的连续原文行。
 */
function parseBlockScalar(raw, lines, j, keyIndent, style) {
  const body = []
  let blockIndent = null
  let k = lines[j].no // 0-based 原始行下标：key 行是 no-1，下一点从 no 开始
  for (; k < raw.length; k++) {
    const line = raw[k]
    if (line.trim() === "") {
      body.push("")
      continue
    }
    const ind = line.length - line.trimStart().length
    if (ind <= keyIndent) break
    if (blockIndent === null) blockIndent = ind
    body.push(line.slice(blockIndent))
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop()
  let text = body.join("\n")
  if (style === "|" && text !== "") text += "\n"
  // k 停在第一条非 body 原始行（0-based）；下一个待解析行是 no > k 的首条
  let next = j + 1
  while (next < lines.length && lines[next].no <= k) next++
  return [text, next]
}

/** 找行首层级的 `: `（不在引号内）。返回 -1 表示没有。 */
function findColon(text) {
  let quote = null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === "[" || c === "{") depth++
    else if (c === "]" || c === "}") depth--
    else if (c === ":" && depth === 0 && (i === text.length - 1 || text[i + 1] === " ")) return i
  }
  return -1
}

/** 标量：引号串原样、流式数组/映射递归、其余按裸标量转换。 */
function scalar(text, line) {
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text, line)
  if (text.startsWith("[") || text.startsWith("{")) return parseFlow(text, line)
  if (text === "true") return true
  if (text === "false") return false
  if (text === "null" || text === "~") return null
  if (PLAIN_NUMBER.test(text)) return Number(text)
  if (text.includes(": ") && !text.startsWith("http") && !text.startsWith("perforce")) {
    // 形如 `a: b` 的裸标量多半是漏了引号的映射，拒绝而不是吞掉冒号
    throw err(line, `ambiguous scalar ${JSON.stringify(text)}: quote it`)
  }
  return text
}

function unquote(text, line) {
  const q = text[0]
  if (text.length < 2 || text[text.length - 1] !== q) throw err(line, "unterminated quote")
  const body = text.slice(1, -1)
  if (q === "'") return body.replace(/''/g, "'")
  return body.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
}

/** 流式数组/映射：按逗号切顶层，递归解析各项。 */
function parseFlow(text, line) {
  const close = text[0] === "[" ? "]" : "}"
  if (text[text.length - 1] !== close) throw err(line, `unterminated flow ${text[0] === "[" ? "sequence" : "mapping"}`)
  const inner = text.slice(1, -1).trim()
  if (inner === "") return text[0] === "[" ? [] : {}
  const parts = splitTop(inner)
  if (text[0] === "[") return parts.map((p) => scalar(p, line))
  const map = {}
  for (const p of parts) {
    const c = findColon(p)
    if (c < 0) throw err(line, `flow mapping item ${JSON.stringify(p)} has no key`)
    const k = scalar(p.slice(0, c).trim(), line)
    if (typeof k !== "string") throw err(line, "flow mapping key must be a string")
    map[k] = scalar(p.slice(c + 1).trim(), line)
  }
  return map
}

/** 按引号/括号外的逗号切分。 */
function splitTop(text) {
  const parts = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === "[" || c === "{") depth++
    else if (c === "]" || c === "}") depth--
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last !== "" || parts.length > 0) parts.push(last)
  return parts.filter((p) => p !== "")
}

function err(line, why) {
  return new Error(`yaml: line ${line.no}: ${why}`)
}
