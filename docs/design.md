# 设计文档 · magpie-team-catalog

版本：draft-1（2026-11-15，设计阶段，尚未实现）

## 1. 背景与问题

团队内部有两类"大家都会用到但没人说得全"的资源：

1. **CLI 工具**：自研或公共服务提供，安装途径不一——npm scope（`@team/…`）、pipx / pip 内部 index、Homebrew 内部 tap、手动放置的二进制。npm / pip 本身有集中注册（registry + 每台机器一份 `.npmrc` / `pip.conf`），但团队自研工具没有等价物。
2. **项目地址**：GitHub 仓库、P4 depot 路径等，散落在聊天记录、README 和各人脑子里。

Agent 普及后多出第三个需求：**让 Agent 在任何机器上开箱即知**本机有哪些内部工具可用、怎么用、项目地址在哪——而不是靠人把信息转述进 prompt。

核心矛盾：**注册表是声明式的**（团队说"应该有"），**每台机器的安装事实是杂乱的**（装没装、装在哪、版本如何，只有本机知道，且途径各异、无法断定"用户一定注册了"）。因此本插件的定位是三层之间的 reconcile（协调）层：

```
团队声明（registry.yaml，git 仓库，PR 审核）
        │ 拉取
Bun 宿主模块 ──本机探测──> catalog-state.json（本机实测态）
        │                        │
        │ tool: catalog          │ middleware: 只注入本机 available 的索引
        ▼                        ▼
/mcp/magpie/tools          每个请求的 system prompt
        │
   所有 Agent（magpie 现成的工具分发 / MCP 路由）
        +
   magpie.page 窗口页：人看的目录表格 + 覆盖编辑
```

## 2. Non-goals

- **不管分发安装**：CLI 的安装继续交给 npm scope / brew tap / pip index / mise。插件给出安装命令文本，由用户（或用户明确授权的 Agent）执行。
- **不管鉴权分发**：registry 里不放密钥。token 走各机器自己的 `.npmrc` / 环境变量。
- **不写任何 Agent 自己的配置**：不碰 `~/.claude.json`、`~/.codex/config.toml` 等。暴露全部通过 magpie 自己的通道（工具 MCP 服务器 + 网关中间件）。
- **不替用户下"已注册"结论**：探测只陈述事实（见 §5 状态语义纪律）。

## 3. 配置分层（要求 1：易于用户自行配置）

复用 magpie 插件机制现成的三层，解析顺序 **用户覆盖 > 团队声明 > 自动探测**（同 git config / mise 的心智模型）：

| 层 | 存放位置 | 维护者 | 内容 |
| --- | --- | --- | --- |
| 团队声明 | catalog git 仓库的 `registry.yaml` | 团队，PR 审核 | 工具 id、类型、安装命令、探测规则、版本下限、项目地址 |
| 建议默认 | 插件包 `package.json` 的 `"magpie": {"options": {…}}` | 插件作者 | registry 仓库地址、检查周期等 |
| 用户覆盖 | 本机 `plugins.json` 中该插件项的 `options` | 每个用户 | 路径覆盖、禁用条目、状态钉死 |

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

配置变更触发宿主 reload 是 magpie 现成行为，不自建热加载。窗口页（M3）通过 `magpie.options.get/set` 提供表单式编辑，降低手编 JSON 的门槛。

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
- 只有工具自己的 probe 命令（如 `deploy-cli whoami`）通过才升到 `configured`，且 probe 是**按需触发**（Agent 查详情 / 页面打开时），不进周期任务；
- 用户可用 `"status": "present"` 钉死状态，跳过探测；
- 对外（索引、工具返回）永远附带状态，不把 `present` 说成"已配置"。

### 5.3 探测执行（Bun 宿主模块）

探测跑在 **Bun 宿主**里——middleware 所在的 moejs 引擎没有定时器和 child_process，干不了这活，这是两个模块分工的根因：

- 按类型探测：npm（`npm ls -g --json`）、pipx（`pipx list --json`）、brew（`brew list --versions`）、PATH（`which` / `where.exe`）、以及用户覆盖指定的绝对路径；
- 每项命令 5s 超时；整体并发上限 8，避免一排 CLI 卡住宿主；
- 周期：加载时全量 + 每 15 分钟刷新（可用 options 调整）；
- 结果 + 时间戳缓存到 magpie 配置目录下插件自己的 `catalog-state.json`；
- 版本解析：`check.version` 的输出取首个 semver 片段，解析失败不算错误（仍为 `present`）。

## 6. Agent 暴露（要求 2）

### 6.1 发现层：tool 钩子

OpenCode `tool` 钩子，经 magpie 汇入 `/mcp/magpie/tools`，所有支持 MCP 的 Agent 可调；开 MCP 路由的 Agent 直接在路由里看到（`<插件短名>__<工具>`）。工具清单：

- `catalog`：按关键词 / id 搜索，返回条目 + 当前本机状态；带 `detail` 参数时读 `docs/<id>.md` 返回用法全文。

返回示例：

```json
{ "id": "deploy-cli", "status": "outdated", "version": "1.2.0", "min": "1.4.0",
  "usage": "deploy-cli release --app <name>", "fix": "npm i -g @team/deploy-cli@latest" }
```

### 6.2 感知层：gateway middleware

`*.middleware.js` 的 `onRequest`（magpie 官方支持的"往系统提示词里加内容"场景），向每个请求的 system prompt 头部注入**一行压缩索引**：

- **只包含本机 available（present / configured / outdated）的工具**——missing 的不注入（或留一行"未安装项可用 catalog 工具查"，由 options 决定）；
- middleware 跑在 moejs，**没有 fetch / 定时器**：索引文本由 Bun 侧刷新后写入插件 options（`ctx.options.index`），middleware 只做纯注入；
- fail-open：middleware 抛错 / 超时（onRequest 250ms 预算）时请求原样直过；
- 注入格式（常数级 token 成本）：

```
团队内部工具目录（用 catalog 工具查详情）：deploy-cli(1.2.0,需更新) · perf-report · …
团队项目地址：billing=github:team/billing · legacy-sync=p4://depot/legacy-sync
```

### 6.3 管理层：窗口页（M3，可选）

`magpie.page` + Bun 模块起的本地 service（`magpie.page.service`）：表格列出全部条目、状态、版本、探测时间；每行可编辑覆盖（写回 `magpie.options.set`）。纯页面能力（`magpie.read` 的 `usage:summary` / `providers:list`）与本插件关系不大，页面数据主要走本地 service。

## 7. 安全边界

- **只读**：catalog 工具与 middleware 都不安装、不写 Agent 配置、不修改探测对象；
- **fail-open**：探测挂了当 missing，middleware 挂了原请求直过，索引缺失不报错；
- **可整体关闭**：`magpie plugin off team-catalog` 后索引、工具、页面全部消失，`plugins.json` / `catalog-state.json` 之外零残留；移除插件用 `magpie plugin rm`；
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

## 10. 开放问题（实现前需收口）

1. **registry 拉取途径**：git URL（需凭据）/ HTTP raw / npm 包内携带，M1 先支持 `file://` 与 HTTP，git 凭据复用本机 git 配置；
2. **索引注入位置**：prepend 到 system 首条 vs 追加到末尾，需实测各 Agent 的行为后定；
3. **`catalog-state.json` 的存放与多 magpie 实例**（沙箱 vs 常驻）互不干扰；
4. probe 命令的副作用边界：要求 registry 作者只声明幂等只读命令（写进 schema 文档的作者纪律）。
