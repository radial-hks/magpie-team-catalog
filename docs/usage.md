# 使用说明

版本：2026-11-15（对应基线 `9b553f2` 之后的代码）。本文面向**使用者与部署者**：
这台机器上插件做什么、怎么开、开完在 Agent 侧是什么体感、出问题怎么看。
设计取舍见 [design.md](design.md)，字段规范见 [registry-schema.md](registry-schema.md)，
变更流程见 [registry-workflow.md](registry-workflow.md)。

## 一、它解决什么

团队内部有自研 CLI（npm scope / brew tap / 手工二进制）和项目地址（GitHub / P4），
散落在聊天记录与各人脑子里。本插件把它们集中注册，并**逐机探测**：团队说「应该
有什么」与本机「真有什么」是两件事，插件负责把两者对齐后交给 Agent。

三种交付形态，按需自选（可同时开）：

| 形态 | 通道 | 适用 |
| --- | --- | --- |
| **skill**（主路径） | `SKILL.md` 落盘 → (可选) magpie library 分发 | 希望 Agent「按需读、显式调」，不污染每个请求 |
| **工具** | `/mcp/magpie/tools` 的 `catalog` 工具 | 要查用法全文、安装/升级命令、按需实测 |
| **索引注入**（回退） | 网关中间件塞进 system prompt | 想让 Agent 天然知道有个工具，无需调用 |

## 二、选项参考（`options`，写进 `plugins.json` 或 GUI 插件选项）

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `registry` | `./registry/registry.yaml` | registry 数据源：本地路径 / http / git spec（见 workflow 文档） |
| `interval` | `900` | 探测周期（秒），最小 60 |
| `probeTimeoutMs` | `5000` | 全局探测超时；条目可用 `check.timeoutMs` 覆盖 |
| `concurrency` | `8` | 并发探测数 |
| `showMissing` | `false` | 索引/视图中是否带出「未安装」清单 |
| `magpieBin` | 自动查找 | magpie 可执行文件路径；发布索引与 library sync 用 |
| `statePath` | 插件状态目录 | `catalog-state.json` 路径覆盖 |
| `injectIndex` | `false` | **回退开关**：`true` 才把索引注入 system prompt |
| `skillExport` | `false` | 是否把团队 skill 同步到本机投放点 |
| `skillsRepo` | 空 | 团队 skill 仓库：本地路径或 git spec，布局 `skills/<id>/SKILL.md` |
| `skillRoot` | `~/.agents/skills` | skill 投放点 |
| `skillPrefix` | 空 | skill 名前缀（工作机建议 `team-`，避免与既有 skill 撞名） |
| `skillLibraryDir` | `~/.config/magpie/library` | hand-over 后的真源目录（方案 C 分流目标） |

覆盖层（`options.overrides`，按工具 id）：

```jsonc
{
  "deploy-cli": { "bin": "/opt/team/deploy" },  // 探测路径覆盖
  "perf-diag":  { "enabled": false },            // 本机禁用：不探测、不出现
  "legacy-cli": { "status": "present" }          // 钉死状态，跳过探测
}
```

## 三、三条使用路径

### 3.1 只想让 Agent 能查（最小可用）

不需要任何 `skill*` 选项。Agent 调 `catalog` 工具：

```text
catalog({query: "部署"})      → 命中条目的 id/名称/用法/本机状态
catalog({detail: "deploy-cli"}) → 用法全文 + docs + 按需实测（probe 通过 → configured）
```

### 3.2 让 Agent 按需读 skill（推荐）

```jsonc
{
  "skillExport": true,
  "skillsRepo": "git@github.com:team/cli-skills.git",
  "skillPrefix": "team-"
}
```

每轮探测后，对每个**本机可用**的工具生成 `~/.agents/skills/team-<id>/SKILL.md`：

```markdown
---
name: team-hermes
description: <团队写的 description，或由 name/usage 推>
---

<!-- team-catalog:managed -->

# <团队写的正文>

<!-- team-catalog:measured begin -->
## 本机实测（自动生成，勿手改）
- 路径：`/Users/xxx/.local/bin/hermes`
- 版本：0.23.1（via: path）

> 若上面的路径在本机失效……用 `catalog` 工具查最新实测结果
<!-- team-catalog:measured end -->
```

行为边界：

- 只有该目录里**读得到**的 Agent 会看到（本机实测：pi、hermes 类工具读
  `~/.agents/skills`；Claude Code 读 `~/.claude/skills`、Codex 读 `~/.codex/skills`，
  需要走 3.3 分发）；
- 未安装 / 禁用的工具**不生成** skill，已生成的会被移除；
- 只覆盖/删除带 `<!-- team-catalog:managed -->` 标记的文件，手工维护或别人的
  skill 一律不碰；
- 有效内容（路径/版本/via）变化才重写；时间戳刻意不写进文件，避免每轮空转。

### 3.3 分发给所有 Agent（magpie library）

`~/.agents/skills` 只是个装卸点，真正跨 Agent 分发走 magpie 自己的 library：

```sh
magpie library skill hand-over team-hermes   # 搬进 library，成为真源
magpie library skill agents team-hermes claude,codex,pi   # 指定 Agent
magpie library skill router on               # 或者：给每个 Agent 一个聚合入口 magpie-skills
magpie library skill how link|copy           # 软链 or 副本
magpie library                       # 看现状（Instructions / MCP servers / Skills）
```

**hand-over 之后的行为（方案 C）**：插件发现 `<library>/team-<id>/` 存在，就不再写
`~/.agents/skills`，改为维护 library 副本，并在内容变化时自动触发
`magpie library sync`（magpie 官方语义：手改后 sync 重写进各 Agent）。所以实测数据
不会冻结在 hand-over 那一刻。

> 未验证项：hand-over 与 library sync 这一步是 magpie 官方命令，本机尚未实机走通
> （个人机不启用 skill 导出，测试都在 `/tmp` 里做）。工作机首次部署时按
> 「四、部署清单」逐步验收。

## 四、工作机部署清单

```sh
# 1. 装插件（folder 插件就地加载，或团队 npm 包）
magpie plugin add /path/to/magpie-team-catalog

# 2. 写选项（GUI 的插件行选项编辑器等价）
magpie plugin options magpie-team-catalog '{
  "registry": "git@github.com:team/team-catalog.git",
  "skillsRepo": "git@github.com:team/cli-skills.git",
  "skillExport": true,
  "skillPrefix": "team-",
  "magpieBin": "/Applications/magpie.app/Contents/MacOS/magpie"
}'

# 3. 等一轮探测（或窗口页点「立即重跑探测」），核对产物
ls ~/.agents/skills/team-*
magpie library            # Skills: none yet

# 4. 分发（按需，可只做部分工具）
magpie library skill hand-over team-<id>
magpie library skill agents team-<id> claude,codex,pi
magpie library skill router on     # 可选：聚合入口

# 5. 回到插件视角确认分流生效：下一轮探测日志应是
#    team-catalog: skills synced (+0 -0 ~N)，且 ~/.agents/skills/team-<id> 不再出现
```

验收要点（对应 plan.md 的 F3/F4 勾选项）：

- [ ] `~/.agents/skills/team-<id>/SKILL.md` 里 frontmatter name 与目录名一致，实测块路径为真实绝对路径；
- [ ] CLI 升级/重装后，下一轮只重写该 skill，未变的条目 mtime 不变；
- [ ] 禁用某工具 → 其 skill 消失；重新启用 → 重建；
- [ ] hand-over 后：library 里能看到，且共享投放点不再被重建；
- [ ] `magpie library sync` 能把手改内容重写进各 Agent。

## 五、出问题怎么看

| 现象 | 排查 |
| --- | --- |
| Agent 看不到任何工具 | `catalog({})` 是否返回条目；再看 `injectIndex` 是否开（回退形态才靠注入） |
| skill 没生成 | `skillExport`/`skillsRepo` 是否设；`skillsRepo` 里有没有 `skills/<id>/SKILL.md`；worker 日志 `skill sync skipped:` 原因 |
| 版本号缺失 | 该命令输出里没有 semver（如 `weknora dev (commit none)`），属探测语义；或超时（可加 `check.timeoutMs`） |
| 状态全部 unknown | `catalog-state.json` 不存在/不可读，等一轮探测或看 worker 日志 |
| 索引不更新 | `magpie plugin options` 是否被无页面进程改写；发布基准取 `plugins.json` 原值 |
| 端口占用 | 宿主重启窗口会占住 service 端口，插件后台每 5 秒重试，最长 15 分钟 |

日志：worker 与 service 都写 stderr（`team-catalog: …`）。magpie 本身不写日志文件。

## 六、关闭与卸载

- 临时关闭：`magpie plugin off team-catalog` → 索引、工具、页面、skill 同步全部停止；
- 已生成的 skill：`~/.agents/skills/team-*` 可手删；library 里的走 `magpie library skill rm <name>`；
- 彻底移除：`magpie plugin rm team-catalog`；插件只写 `plugins.json`、`catalog-state.json`
  与（开启时的）skill 投放点，其余零残留。
