# 设计文档 · magpie-team-catalog

版本：v3（2026-11-15，本机 CLI/Git/P4 与 MCP 核心完成）。历史 M/F 分期见 plan.md，
当前验收与部署边界见 [milestone-projects-mcp.md](milestone-projects-mcp.md)。

## 1. 背景与问题

团队内部有两类"大家都会用到但没人说得全"的资源：

1. **CLI 工具**：自研或公共服务提供，安装途径不一——npm scope（`@team/…`）、pipx / pip 内部 index、Homebrew 内部 tap、手动放置的二进制。npm / pip 本身有集中注册（registry + 每台机器一份 `.npmrc` / `pip.conf`），但团队自研工具没有等价物。
2. **项目地址**：GitHub 仓库、P4 depot 路径等，散落在聊天记录、README 和各人脑子里。

Agent 普及后多出第三个需求：**让 Agent 在任何机器上开箱即知**本机有哪些内部工具可用、怎么用、项目地址在哪——而不是靠人把信息转述进 prompt。

核心矛盾：**注册表是声明式的**（团队说"应该有"），**每台机器的安装事实是杂乱的**（装没装、装在哪、版本如何，只有本机知道，且途径各异、无法断定"用户一定注册了"）。因此本插件的定位是三层之间的 reconcile（协调）层：

```
团队声明（registry.yaml，git 仓库，PR 审核）      团队 skill 仓库（skills/<id>/SKILL.md，独立发版）
        │ 拉取                                        │ 拉取（options.skillsRepo）
Bun 宿主模块 ──本机探测──> catalog-state.json（本机实测态）
        │                        │
        │ tool: catalog/status   │ skill: 团队正文 + 实测块 → SKILL.md 落盘（主路径，F3/F4）
        │                        │        └─ hand-over 后改维护 magpie library 副本 + library sync
        │ middleware: 索引注入 system prompt（回退，injectIndex 才生效）
        ▼
/mcp/magpie/tools          Agent skill 目录 / magpie library
        │
   所有 Agent（magpie 现成的工具分发 / MCP 路由）
        +
   magpie.page 窗口页：CLI/项目注册 + Git/P4 发现 + 本机覆盖/绑定
   个人 registry（插件目录外）与团队声明合并；不自动修改 Git/P4
```

## 2. Non-goals

- **不管分发安装**：CLI 的安装继续交给 npm scope / brew tap / pip index / mise。插件给出安装命令文本，由用户（或用户明确授权的 Agent）执行。
- **不管鉴权分发**：registry 里不放密钥。token 走各机器自己的 `.npmrc` / 环境变量。
- **不写任何 Agent 自己的配置**：不碰 `~/.claude.json`、`~/.codex/config.toml` 等。暴露全部通过 magpie 自己的通道（工具 MCP 服务器 + 网关中间件）。
- **不替用户下"已注册"结论**：探测只陈述事实（见 §5 状态语义纪律）。

## 3. 配置分层（要求 1：易于用户自行配置）

解析顺序：**团队 registry + 个人 registry / projectBindings → 平台声明 → 本机 overrides → 探测快照**。
团队/个人 ID 冲突不能静默覆盖，团队项目本机绑定只补路径/P4 上下文。

| 层 | 存放位置 | 维护者 | 内容 |
| --- | --- | --- | --- |
| 团队声明 | catalog git 仓库的 `registry.yaml` | 团队，PR 审核 | 工具 id、类型、安装命令、探测规则、版本下限、项目地址 |
| 建议默认 | 插件包 `package.json` 的 `"magpie": {"options": {…}}` | 插件作者 | registry 仓库地址、检查周期等 |
| 用户覆盖 | 本机 `plugins.json` 中该插件项的 `options` | 每个用户 | 路径覆盖、禁用条目、状态钉死 |
| 个人注册/绑定 | 插件状态目录 `local-registry.yaml`（可自定义） | 用户确认 | CLI、Git/P4 项目、团队项目本机路径/Client |

用户覆盖示例：

```jsonc
// magpie plugin options team-catalog '<json>'，或 GUI 插件行的选项编辑器
{
  "registry": "https://git.internal/team/catalog.git",   // 或 file:/// 本地路径（单机试运行）
  "overrides": {
    "deploy-cli": { "bin": "D:\\tools\\deploy.exe" },     // Windows 路径覆盖
    "perf-diag":  { "enabled": false }                    // 本机没装，不报给 Agent
  }
}
```

options 变更经 magpie CLI 触发宿主 reload；个人文件经本地 service 原子保存并触发 worker，
不改团队仓库。页面内联脚本、会话令牌和公开实例标识用于沙箱加载/过期恢复，细节见 personal-registry.md。

## 4. 数据源：registry.yaml

一个对人类友好的共享 git 仓库（PR 审核准入），字段规范见 [registry-schema.md](registry-schema.md)。要点：

- 条目分 `tools`（CLI）与 `projects`（项目地址）两类；
- 每个 tool 条目带**声明式探测规则** `check`（可被用户覆盖）；
- 每个条目可挂 `docs/<id>.md` 详细用法，`catalog` 工具按需读取；
- registry 更新与插件更新**解耦**：加一个工具只是 merge 一个 YAML PR，各机器的插件按周期自己拉到，无需发版。

单机试运行阶段，registry 就是本地一个 YAML 文件（`file://` 路径），成本为零。

## 5. 探测设计（要求 3：检测 CLI 可用性 / 版本）

### 5.1 状态模型

```
unknown ──探测──> missing ──binary found──> present ──probe──> configured
                                                    │
                                     版本比对 min ──└> outdated
用户禁用 / 钉死: disabled / pinned:<status>
```

| 状态 | 含义 | 判定依据 |
| --- | --- | --- |
| `unknown` | 尚未探测 | 初始态 |
| `missing` | 本机找不到可执行文件 | 按类型的探测全部落空 |
| `present` | 二进制存在，版本已读出（或不可读版本） | which / where / 包管理器列表 |
| `outdated` | 存在但低于 registry 的 `min` | `check.version` 输出解析 |
| `configured` | 存在且 probe 通过（说明真的可用，如 `whoami` 退出 0） | `check.probe`，按需执行 |
| `disabled` | 用户本机禁用 | 用户覆盖 `enabled: false` |

### 5.2 语义纪律（本设计的核心约束）

**探测只能证明"这个安装途径下该类型存在"，不能证明"用户注册/使用了该工具"。** 因此：

- kind 探测（npm/pipx/brew/PATH）的结果上限是 `present`；
- 只有声明的 probe 命令通过才可能升到 `configured`；MCP 必须显式 `detail + check:true`，默认详情/页面查询不执行 probe，不写回周期状态；
- 用户可用 `"status": "present"` 钉死状态，跳过探测；
- 对外（索引、工具返回）永远附带状态，不把 `present` 说成"已配置"。

### 5.3 探测执行（Bun 宿主模块）

探测跑在 **Bun 宿主**里——middleware 所在的 moejs 引擎没有定时器和 child_process，干不了这活，这是两个模块分工的根因：

- 按类型探测：npm/pipx/brew 清单、PATH 与绝对路径；Windows 直接按 PATH/PATHEXT 查找原生/.cmd/.bat，批处理单独安全执行；package 可与 bin 不同；
- 每项命令 5s 超时；整体并发上限 8，避免一排 CLI 卡住宿主；
- 周期：加载时全量 + 每 15 分钟刷新（可用 options 调整）；
- 结果 + 时间戳缓存到 magpie 配置目录下插件自己的 `catalog-state.json`；
- 版本解析：Perforce Rev 行优先，其余取首个 semver，解析失败仍为 present；
- Git/P4 项目路径和本机元数据检查见 local-projects.md；周期不访问 P4 server/Git remote。
  指纹识别注册身份变化，MCP 明确快照是否过期。

## 6. Agent 暴露（要求 2）

### 6.1 发现层：tool 钩子

OpenCode `tool` 钩子，经 magpie 汇入 `/mcp/magpie/tools`，所有支持 MCP 的 Agent 可调；开 MCP 路由的 Agent 直接在路由里看到（`<插件短名>__<工具>`）。工具清单：

- `catalog`：缓存只读的 CLI / Git / P4 项目发现，支持关键词、类型/来源/Client/路径筛选和分页（默认20条简略列表）；精确 detail 返回条目及分段文档。默认不执行 probe，显式 check=true 才进行声明的只读检查。
- `catalog_status`：轻量目录概览、数量/状态分布、快照是否过期和能力边界。
- contract、兼容性调整、IO/安全边界与调用示例见 [mcp-design.md](mcp-design.md)。

返回示例：

```json
{ "id": "deploy-cli", "status": "outdated", "version": "1.2.0", "min": "1.4.0",
  "usage": "deploy-cli release --app <name>", "fix": "npm i -g @team/deploy-cli@latest" }
```

### 6.2 感知层：skill 落盘（F3/F4 主路径）

**设计变更（2026-11-15，F3）**：原方案是向每个请求的 system prompt 注入索引（见
6.4 回退通道）。实测体感不佳：非项目任务里，每个请求都带着一份 CLI/项目清单，
对模型是噪声。改为 **skill 形态**：Agent 侧本就有「按需读取、显式调用」的 skill
机制，插件把团队 skill 与本机实测合成后落盘，Agent 在自己的 skill 目录里看到它。

- **来源**：独立公共 skill 仓库（与 CLI 一起发版，决策 B），布局
  `skills/<id>/SKILL.md`；registry 条目可用 `skill: <id>` 映射（缺省同工具 id）；
- **渲染**：源 frontmatter（name 强制改写为 `skillPrefix + id`）+ 团队正文 +
  实测块（本机绝对路径/版本/via，`<!-- team-catalog:measured -->` 定界，刻意不带
  时间戳以保证幂等）+ 「路径失效则用 catalog 工具查最新」提示；
- **落点**：默认 `~/.agents/skills/team-<id>/`（跨工具共享投放点）；
- **托管边界**：只覆盖/删除带 `<!-- team-catalog:managed -->` 标记的文件；
  未安装/禁用不生成，已生成则移除；内容不变不重写；
- **分发（F4，方案 C）**：落点只是装卸点，跨 Agent 分发走 magpie library
  （`skill hand-over / agents / router`，官方管理面）。hand-over 后插件检测到
  `<library>/team-<id>/` 存在即改维护 library 副本（不重建共享点副本，避免双
  真源），内容变化时自动 `magpie library sync` 重推给各 Agent；library 里无
  标记的 skill 一律不碰，禁用也不删 library 副本（所有权归 magpie）。

选 C 弃 B（hand-over 后关同步）的原因：实测块暴露的是本机路径/版本，CLI 升级
换路径后若无人刷新，skill 会越来越假；插件是唯一知道真实路径的角色，所以必须
由它持续维护 library 副本。

### 6.3 感知层回退：gateway middleware（原主路径，默认关）

`*.middleware.js` 的 `onRequest`（magpie 官方支持的"往系统提示词里加内容"场景），向每个请求的 system prompt 头部注入**一行压缩索引**。**仅在 `options.injectIndex === true` 时生效**（F3 起默认关闭，代码与测试完整保留作为回退通道）：

- **只包含本机 available（present / configured / outdated）的工具**——missing 的不注入（或留一行"未安装项可用 catalog 工具查"，由 options 决定）；
- middleware 跑在 moejs，**没有 fetch / 定时器**：索引文本由 Bun 侧刷新后写入插件 options（`ctx.options.index`），middleware 只做纯注入；
- fail-open：middleware 抛错 / 超时（onRequest 250ms 预算）时请求原样直过；
- 注入格式（常数级 token 成本）：

```
团队内部工具目录（用 catalog 工具查详情）：deploy-cli(1.2.0,需更新) · perf-report · …
团队项目地址：billing=github:team/billing · legacy-sync=p4://depot/legacy-sync
```

### 6.4 管理层：窗口页（M3）

`magpie.page` 的带路页（`page/index.html` + `page/boot.js`）导航到插件自己的本地
service（`magpie.page.service`，`lib/service.mjs`）：主界面由 service 的 `GET /`
直接提供（沙箱 iframe 无网络权限，官方带路页模式），数据走同源 `/state`
`/options`；表格列条目/状态/版本/探测时间，每行可编辑覆盖，保存经 `POST
/options` → service 代执 `magpie plugin options` CLI（与 worker 发布同一条通道）→
宿主重载 + 重探测。

## 7. 安全边界

- **只读（对探测对象）**：catalog 工具与 middleware 都不安装、不写 Agent 配置、不修改探测对象；
- **skill 写入有边界**（F3/F4）：只写 `skillRoot`（默认 `~/.agents/skills`）与 hand-over 后的 library 副本，且只碰带 `<!-- team-catalog:managed -->` 标记的文件；library 里无标记的 skill 一律不碰；
- **fail-open**：探测挂了当 missing，middleware 挂了原请求直过，skill 同步失败不影响探测与索引，索引缺失不报错；
- **可整体关闭**：停止目录工具与同步；个人注册、状态/缓存、托管 Skill 按需保留/手动清理，不卸载 CLI 或删除项目目录；
- **无密钥**：registry 与 state 文件里只有地址、命令、版本号；插件以用户权限在宿主里运行（magpie 的通用约束），探测命令来自 PR 审核过的 registry + 用户本地覆盖，`check` 里的命令字段在 schema 层面限制为已声明的模式（bin + 固定参数数组），不允许任意 shell 字符串。

## 8. 与现成方案的关系

| 方案 | 覆盖 | 本插件的取舍 |
| --- | --- | --- |
| npm scope / pip index / brew tap | 分发 | 不做，直接复用；registry 记录 install 命令 |
| mise | 跨语言工具注册表 + 团队共享配置 | 分发层竞品/互补；发现层不面向 Agent |
| Backstage | 人类侧项目/服务目录 | 重型平台；registry.yaml 是其轻量替代 |
| MCP（通用） | Agent 侧工具暴露 | 本插件复用 magpie 的 MCP 管道，不自建服务器 |

## 9. magpie 扩展点约束备忘（写代码时必读）

来自 magpie 官方插件文档（usemagpie.ai/docs/plugins）：

- tool 钩子在 Bun 宿主运行，单次执行上限 55s，`ctx.abort` 超时触发；工具名自动冠 `<插件短名>_` 前缀；
- middleware 在网关进程的 moejs 里运行：只能相对导入、无 Node API / 定时器 / fetch、`console.log` 每分钟 60 行上限；`onRequest` 250ms 预算；声明方式为 `package.json` `"magpie": {"middleware": "./mw.js"}` 或 `*.middleware.js` 单文件；文件变更 magpie 每秒检查并热重载；
- options 变更触发宿主 reload（Bun 模块重新运行）；
- 一个包可同时是 tool + middleware + page（三者声明并存）；
- 测试用独立 `HOME` 沙箱：`env HOME=$(mktemp -d) XDG_CONFIG_HOME=… MAGPIE_ADDR=… magpie …`；
- 单文件/文件夹插件 `magpie plugin add ./路径` 就地加载，改动后终端命令每次按当前内容加载。

## 10. 开放问题（状态）

1. **registry 拉取途径**——已收口：local / http / git 三形态（`lib/source.mjs`），git 凭据走本机配置；
2. **索引注入位置（prepend vs append）**——**已作废**（F3）：主路径改为 skill 落盘，不再往 system prompt 注入；middleware 仅作回退通道（`injectIndex: true`），位置维持 prepend；
3. **`catalog-state.json` 的存放与多 magpie 实例**——已收口：`statePath` 可覆盖，缺省在 magpie 配置目录下插件自己的子目录，沙箱实例各用各的；
4. **probe 命令的副作用边界**——已收口：schema 层限制为固定参数数组 + 作者纪律（PR 审核）；
5. **skill 与 library 的所有权**（新）——F4 方案 C 已定：hand-over 后真源在 library，插件只维护副本 + 触发 sync；但 `hand-over`/`library sync` 尚未实机验收（个人机不启用）。
