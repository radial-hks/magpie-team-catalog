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

/**
 * 「本机实测」块的文本（路径/版本/via + 失效提示）。
 * 刻意不带探测时间：时间每轮都变，会把幂等写入变成每 15 分钟重写一次；
 * 新鲜度看 state 文件/窗口页（那里的探测时间才是准的）。
 */
export function measuredBlock(finding) {
  const lines = [MEASURED_BEGIN, "## 本机实测（自动生成，勿手改）", ""]
  if (finding?.path) lines.push(`- 路径：\`${finding.path}\``)
  if (finding?.version) lines.push(`- 版本：${finding.version}（via: ${finding.via ?? "unknown"}）`)
  else if (finding?.via) lines.push(`- 版本：未解析（via: ${finding.via}）`)
  lines.push("", STALE_HINT, MEASURED_END)
  return lines.join("\n")
}

/**
 * 渲染目标 SKILL.md：源 skill（团队写的正文）+ managed 标记 + 实测块。
 * 纯函数：同输入必同输出（幂等写入靠它比对）。刻意不接收探测时间——
 * 时间每轮都变，会把幂等写入变成周期性重写。
 */
export function renderSkill({ source, tool, finding, prefix }) {
  const { data, body } = parseFrontmatter(source)
  const name = skillName(tool, prefix)
  const description = data.description || fallbackDescription(tool)
  const fm = ["---", `name: ${name}`, `description: ${description}`, "---"].join("\n")
  const bodyText = body.replace(/^\s*\n/, "").replace(/\s+$/, "")
  // 源正文自带标题（首个非空行是 #）就不另造，避免双 H1
  const heading = /^#/.test(bodyText) ? [] : [`# ${tool.name ?? tool.id}`, ""]
  return [fm, "", MANAGED, "", ...heading, bodyText, "", measuredBlock(finding), ""].join("\n")
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
 * 同步一批工具的 skill 到投放点（skillRoot，默认 ~/.agents/skills）。纯 IO，
 * 调用方负责 fail-open。
 *
 * entries: [{ tool, finding, available }]，available=false 表示 missing/disabled。
 * 返回 {written, removed, skipped, sync}：sync=true 表示写过 library 副本，
 * 调用方应 spawn `magpie library sync` 重推给各 Agent（方案 C，F4）。
 *
 * 方案 C：hand-over 后 skill 真源在 magpie library（~/.config/magpie/library）。
 * 指定了 libraryDir 且那里存在同名 skill 时，本函数只维护 library 副本，
 * 不再写共享投放点——避免双写。library 里不带 managed 标记（手工维护/
 * 别的来源）的skill 一律不碰。
 */
export function syncSkills({ entries, sourceRoot, skillRoot, prefix = "", libraryDir }) {
  const written = []
  const removed = []
  const skipped = []
  let sync = false // 是否写过 library 副本
  if (!skillRoot && !libraryDir) throw new Error("skillRoot is required")

  // 该名字的 skill 目标落点：library 有副本 → library；否则共享投放点
  const targetOf = (name) => {
    const libFile = libraryDir ? path.join(libraryDir, name, "SKILL.md") : null
    if (libFile && existsSync(libFile)) {
      const rootFile = path.join(skillRoot ?? "", name, "SKILL.md")
      const oursAtRoot = rootFile && existsSync(rootFile) && isManaged(rootFile)
      return { dir: path.join(libraryDir, name), file: libFile, inLibrary: true, oursAtRoot }
    }
    if (!skillRoot) return null // 没有共享投放点可写
    const dir = path.join(skillRoot, name)
    return { dir, file: path.join(dir, "SKILL.md"), inLibrary: false }
  }

  const known = new Set()
  for (const { tool, finding, available } of entries) {
    const name = skillName(tool, prefix)
    known.add(name)
    const t = targetOf(name)
    if (!t) {
      skipped.push(tool.id)
      continue
    }

    if (!available) {
      // 未安装/禁用：不生成；已生成且是我们写的 → 移除
      //（library 副本不删：hand-over 后所有权归 magpie，移交给用户/管理员处理）
      if (t.oursAtRoot) {
        rmSync(path.join(skillRoot, name), { recursive: true, force: true })
        removed.push(tool.id)
      } else if (!t.inLibrary && isManaged(t.file)) {
        rmSync(t.dir, { recursive: true, force: true })
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
    // 别人的同名 skill 不覆盖（library 里 hand-over 来的副本带我们的标记）
    if (existsSync(t.file) && !isManaged(t.file)) {
      skipped.push(tool.id)
      continue
    }
    const text = renderSkill({
      source: readFileSync(srcFile, "utf8"),
      tool,
      finding,
      prefix,
    })
    // library 副本在搬进去时 frontmatter.name 会被 magpie 规范化，比较时用
    // 渲染产物直接对比即可：不一致就写（首到手后即稳定）
    if (writeIfChanged(t.file, text)) {
      written.push(tool.id)
      if (t.inLibrary) sync = true
      // hand-over 后共享投放点还残留一份我们的旧副本 → 清掉，避免双真源
      if (t.inLibrary && t.oursAtRoot) {
        rmSync(path.join(skillRoot, name), { recursive: true, force: true })
      }
    }
  }

  // 清理：我们写过、但已不在 registry 里的条目（团队删了工具）。只在共享
  // 投放点里扫；library 目录的治理交给 magpie（skill rm），本插件不碰。
  if (skillRoot) {
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
  }

  return { written, removed, skipped, sync }
}
