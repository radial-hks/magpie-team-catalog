// 用户触发的只读发现。Git 不访问 remote；P4 仅明确授权后查询 server specs。
import { execFile } from "node:child_process"
import { existsSync, statSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { validateLocalPath, validateP4, projectKind, safeRemote } from "./project-model.mjs"

function command(bin, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    try {
      execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout ?? ""), error: error ? String(stderr || error.message).slice(0, 300) : undefined }))
    } catch (e) { resolve({ ok: false, stdout: "", error: e.message }) }
  })
}
const suggestedId = name => name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project"

/** 本地 Git 指定目录，兼容 .git 文件/worktree；只运行固定只读 argv。 */
export async function inspectGit(root, { gitBin = "git", timeoutMs = 5000, deadline = Infinity, run = command } = {}) {
  validateLocalPath(root)
  const args = ["--no-optional-locks", "-C", root]
  const top = await run(gitBin, [...args, "rev-parse", "--show-toplevel"], timeoutMs)
  if (!top.ok) return { status: "not-repository", error: "目录不是可读 Git 工作树（或 Git 未安装）" }
  const localPath = top.stdout.trim()
  timeoutMs = Math.max(1, Math.min(timeoutMs, deadline - Date.now()))
  const [branch, head, remotes, gitdir] = await Promise.all([
    run(gitBin, [...args, "symbolic-ref", "--quiet", "--short", "HEAD"], timeoutMs),
    run(gitBin, [...args, "rev-parse", "--verify", "HEAD"], timeoutMs),
    run(gitBin, [...args, "config", "--local", "--get-regexp", "^remote\\..*\\.url$"], timeoutMs),
    run(gitBin, [...args, "rev-parse", "--absolute-git-dir"], timeoutMs),
  ])
  const remoteList = remotes.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const match = line.match(/^remote\.(.+)\.url\s+(.+)$/)
    return match ? { name: match[1], url: safeRemote(match[2]) } : null
  }).filter(Boolean)
  const vcs = remoteList.find(r => r.name === "origin")?.url ?? remoteList[0]?.url
  return { status: "present", kind: "git", localPath, name: path.basename(localPath), suggestedId: suggestedId(path.basename(localPath)), ...(vcs ? { vcs } : {}), branch: branch.ok ? branch.stdout.trim() : head.ok ? "(detached)" : "(unborn)", ...(head.ok ? { head: head.stdout.trim() } : {}), ...(gitdir.ok ? { gitDir: gitdir.stdout.trim() } : {}), remotes: remoteList }
}

export async function discoverGit({ root, maxDepth = 2, maxResults = 50 }, deps = {}) {
  validateLocalPath(root)
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 5) throw new Error("maxDepth must be 0..5")
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) throw new Error("maxResults must be 1..100")
  if (!statSync(root).isDirectory()) throw new Error("Git scan root must be a directory")
  const candidates = [], warnings = [], seen = new Set(), queue = [{ dir: root, depth: 0 }]
  const ignore = new Set([".git", "node_modules", ".cache", "Binaries", "Intermediate", "Saved", "Library"])
  let visited = 0, truncated = false
  const deadline = Date.now() + 15000
  while (queue.length) {
    if (Date.now() >= deadline || ++visited > 1000 || candidates.length >= maxResults) { truncated = true; break }
    const { dir, depth } = queue.shift()
    try {
      const resolved = realpathSync(dir)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      if (existsSync(path.join(dir, ".git"))) {
        const result = await inspectGit(dir, { ...deps, deadline, timeoutMs: Math.max(1, Math.min(deps.timeoutMs ?? 2000, deadline - Date.now())) })
        if (result.status === "present") candidates.push(result)
        else warnings.push(`${dir}: ${result.error}`)
        // 不进入已发现仓库的内容；避免大型 UE/依赖树遍历。
        continue
      }
      if (depth < maxDepth) for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !ignore.has(entry.name) && !entry.name.startsWith(".")) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    } catch { warnings.push(`${dir}: 无法读取，已跳过`) }
  }
  return { root, candidates, warnings, truncated, visited }
}

/** 仅提取允许的 P4CONFIG 字段；不返回密码、票据或未知配置。不递归读父目录。 */
export function readP4Config(file) {
  validateLocalPath(file, "configFile")
  if (statSync(file).size > 64 * 1024) throw new Error("P4CONFIG exceeds 64KB")
  const config = { configFile: file }
  const keys = { P4PORT: "port", P4USER: "user", P4CLIENT: "client" }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(P4PORT|P4USER|P4CLIENT)\s*=\s*(.*?)\s*$/)
    if (match) config[keys[match[1]]] = match[2]
  }
  validateP4(config)
  return config
}

/** p4 -ztag clients/client -o 的机器输出（不解析密码/ticket）。 */
export function parseP4Tagged(text) {
  const records = []; let record = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\.\.\. (\S+)(?: (.*))?$/)
    if (!m) continue
    if ((m[1] === "client" || m[1] === "Client") && (record.client || record.Client)) { records.push(record); record = {} }
    record[m[1]] = m[2] ?? ""
  }
  if (Object.keys(record).length) records.push(record)
  return records
}
export async function discoverP4(request, { p4Bin = "p4", run = command, timeoutMs = 8000 } = {}) {
  if (request.consent !== true) throw new Error("查询 P4 服务器需要用户明确确认（consent=true）")
  const connection = { port: request.port, user: request.user, ...(request.client ? { client: request.client } : {}) }
  validateP4(connection)
  if (!connection.port || !connection.user) throw new Error("请明确指定 P4 server port 和 user")
  const args = ["-ztag", "-p", connection.port, "-u", connection.user, "clients", "-u", connection.user]
  const list = await run(p4Bin, args, timeoutMs)
  if (!list.ok) throw new Error("P4 工作区查询失败：请检查连接、登录和权限；不会自动登录")
  const records = parseP4Tagged(list.stdout)
  if (records.some(r => r.code === "error" || r.severity === "3")) throw new Error("P4 拒绝工作区查询（登录或权限未满足）")
  const candidates = records.filter(r => r.client).slice(0, 100).map(r => ({
    kind: "p4", name: r.client, suggestedId: suggestedId(r.client), ...(r.Root && r.Root !== "null" ? { localPath: r.Root } : {}),
    p4: { ...connection, client: r.client, ...(r.Stream ? { stream: r.Stream } : {}) },
    ...(r.Host ? { host: r.Host } : {}),
  }))
  if (connection.client) {
    const candidate = candidates.find(c => c.p4.client === connection.client)
    if (!candidate) throw new Error("指定 Client 不在当前用户查询结果中，不读取/推断新工作区")
    const result = await run(p4Bin, ["-ztag", "-p", connection.port, "-u", connection.user, "client", "-o", connection.client], timeoutMs)
    if (!result.ok) throw new Error("P4 Client spec 读取失败")
    const spec = parseP4Tagged(result.stdout)[0] ?? {}
    if (spec.code === "error" || spec.Client !== connection.client) throw new Error("P4 Client spec 未返回已存在的指定 Client")
    candidate.p4.view = Object.entries(spec).filter(([key]) => /^View\d+$/.test(key)).sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4))).map(([, value]) => value).slice(0, 200)
    if (spec.Stream) candidate.p4.stream = spec.Stream
    if (spec.Root && spec.Root !== "null") candidate.localPath = spec.Root
  }
  // server 返回的数据也必须通过字段校验，不能作为任意配置/命令参数回写。
  for (const candidate of candidates) {
    validateP4(candidate.p4)
    if (candidate.localPath) validateLocalPath(candidate.localPath)
  }
  return { candidates, warnings: records.length > 100 ? ["仅显示前 100 个 Client，请指定 Client 缩小范围"] : [] }
}

/** 周期只检查本机路径/Git 元数据，绝不查询 P4 server。 */
export async function probeProjects(projects, { concurrency = 4, ...deps } = {}) {
  const findings = {}; let next = 0
  async function worker() {
    while (next < projects.length) {
      const project = projects[next++]; const at = Date.now()
      if (!project.localPath) { findings[project.id] = { status: "unbound", at }; continue }
      try {
        if (!statSync(project.localPath).isDirectory()) throw new Error("not directory")
        if (projectKind(project) === "git") findings[project.id] = { ...(await inspectGit(project.localPath, deps)), at }
        else findings[project.id] = { status: "present", localPath: project.localPath, serverChecked: false, at }
      } catch { findings[project.id] = { status: "missing", localPath: project.localPath, at } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker))
  return findings
}
