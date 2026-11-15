// skill.mjs — 把「团队 skill 仓库里的 SKILL.md + 本机实测数据」合成为可用的
// skill 文件，并同步到 skill 投放点（默认 ~/.agents/skills）。
//
// 为什么落 skill 而不是往 system prompt 注入：非项目任务里塞工具索引对模型不
// 友好；skill 是 Agent 侧「按需读取、显式调用」的既有机制。分发交给 magpie
// 自己的 library（`magpie library skill hand-over / agents / router`），本模块
// 只负责生成与更新文件，不碰 library 记账。
//
// 双仓库形态（决策 B）：registry 与 skill 是两个公共仓库，各自与 CLI 一起发版；
// skill 仓库布局 skills/<id>/SKILL.md，id 默认为工具 id。
//
// 安全边界：只覆盖/删除带 MANAGED 标记的文件与目录——不碰别人的 skill。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

export const MANAGED = "<!-- team-catalog:managed -->"
export const MEASURED_BEGIN = "<!-- team-catalog:measured begin -->"
export const MEASURED_END = "<!-- team-catalog:measured end -->"

const STALE_HINT =
  "> 若上面的路径在本机失效（重装/换版本导致位置变化），用 `catalog` 工具查最新实测结果，或重跑一轮探测。"

/**
 * 极简 frontmatter 解析：只认 `---` 包围的顶层 `key: value` 行。
 * 返回 {data, body}；没有 frontmatter 时 data 为空、body 是全文。
 */
export function parseFrontmatter(text) {
  const src = String(text ?? "")
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: src }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    data[kv[1]] = v
  }
  return { data, body: src.slice(m[0].length) }
}

/** skill 名：前缀 + 条目 id（前缀为空时就是 id）。 */
export function skillName(tool, prefix = "") {
  return `${prefix ?? ""}${tool.id}`
}

/** 从 registry 条目推一句 description（源 skill 没写 frontmatter 时兜底）。 */
function fallbackDescription(tool) {
  const usage = typeof tool.usage === "string" ? tool.usage.trim().split("\n")[0] : ""
  const label = tool.name ?? tool.id
  return usage ? `${label}：${usage}` : `${label}（团队内部 CLI）`
}

/** 「本机实测」块的文本（路径/版本/via/时间 + 失效提示）。 */
export function measuredBlock(finding, checkedAt) {
  const at = checkedAt ? new Date(checkedAt).toISOString() : ""
  const lines = [MEASURED_BEGIN, "## 本机实测（自动生成，勿手改）", ""]
  if (finding?.path) lines.push(`- 路径：\`${finding.path}\``)
  if (finding?.version) lines.push(`- 版本：${finding.version}（via: ${finding.via ?? "unknown"}）`)
  else if (finding?.via) lines.push(`- 版本：未解析（via: ${finding.via}）`)
  if (at) lines.push(`- 探测时间：${at}`)
  lines.push("", STALE_HINT, MEASURED_END)
  return lines.join("\n")
}

/**
 * 渲染目标 SKILL.md：源 skill（团队写的正文）+ managed 标记 + 实测块。
 * 纯函数：同输入必同输出（幂等写入靠它比对）。
 */
export function renderSkill({ source, tool, finding, checkedAt, prefix }) {
  const { data, body } = parseFrontmatter(source)
  const name = skillName(tool, prefix)
  const description = data.description || fallbackDescription(tool)
  const fm = ["---", `name: ${name}`, `description: ${description}`, "---"].join("\n")
  const bodyText = body.replace(/^\s*\n/, "").replace(/\s+$/, "")
  // 源正文自带标题（首个非空行是 #）就不另造，避免双 H1
  const heading = /^#/.test(bodyText) ? [] : [`# ${tool.name ?? tool.id}`, ""]
  return [fm, "", MANAGED, "", ...heading, bodyText, "", measuredBlock(finding, checkedAt), ""].join("\n")
}

/** 目标目录里那个文件是否由本插件管理（决定能否覆盖/删除）。 */
export function isManaged(skillFile) {
  try {
    return readFileSync(skillFile, "utf8").includes(MANAGED)
  } catch {
    return false
  }
}

function writeIfChanged(file, text) {
  try {
    if (readFileSync(file, "utf8") === text) return false
  } catch {
    // 不存在 → 写
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
  return true
}

/**
 * 同步一批工具的 skill 到 skillRoot。纯 IO，调用方负责 fail-open。
 *
 * entries: [{ tool, finding, available }]，available=false 表示 missing/disabled。
 * 返回 {written, removed, skipped}（id 列表），便于日志与测试断言。
 */
export function syncSkills({ entries, sourceRoot, skillRoot, prefix = "", checkedAt }) {
  const written = []
  const removed = []
  const skipped = []
  if (!skillRoot) throw new Error("skillRoot is required")

  const known = new Set()
  for (const { tool, finding, available } of entries) {
    const name = skillName(tool, prefix)
    known.add(name)
    const dir = path.join(skillRoot, name)
    const file = path.join(dir, "SKILL.md")

    if (!available) {
      // 未安装/禁用：不生成；已生成且是我们写的 → 移除
      if (existsSync(file) && isManaged(file)) {
        rmSync(dir, { recursive: true, force: true })
        removed.push(tool.id)
      } else {
        skipped.push(tool.id)
      }
      continue
    }

    const srcId = typeof tool.skill === "string" && tool.skill !== "" ? tool.skill : tool.id
    const srcFile = path.join(sourceRoot, "skills", srcId, "SKILL.md")
    if (!existsSync(srcFile)) {
      skipped.push(tool.id)
      continue
    }
    // 别人的同名 skill 不覆盖
    if (existsSync(file) && !isManaged(file)) {
      skipped.push(tool.id)
      continue
    }
    const text = renderSkill({
      source: readFileSync(srcFile, "utf8"),
      tool,
      finding,
      checkedAt,
      prefix,
    })
    if (writeIfChanged(file, text)) written.push(tool.id)
  }

  // 清理：我们写过、但已不在 registry 里的条目（团队删了工具）
  try {
    for (const name of readdirSync(skillRoot)) {
      if (known.has(name)) continue
      if (prefix && !name.startsWith(prefix)) continue
      const dir = path.join(skillRoot, name)
      const file = path.join(dir, "SKILL.md")
      if (existsSync(file) && isManaged(file)) {
        rmSync(dir, { recursive: true, force: true })
        removed.push(name.slice(prefix.length))
      }
    }
  } catch {
    // skillRoot 不存在等：没有可清理的
  }

  return { written, removed, skipped }
}
