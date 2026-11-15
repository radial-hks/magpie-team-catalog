# 使用指南手册 · magpie-team-catalog

更新：2026-11-15 · 对应工具 / 项目 / 插件设置分区 UI。
面向使用者与部署者；本手册为主操作入口，设计与字段细节见末尾文档索引。

## 目录

1. [先了解操作边界](#一先了解操作边界)
2. [安装与第一次使用](#二安装与第一次使用)
3. [浏览、搜索和状态](#三浏览搜索和状态)
4. [注册与维护 CLI](#四注册与维护-cli)
5. [本机覆盖：暂存与保存](#五本机覆盖暂存与保存)
6. [Git / P4 项目与工作区](#六git--p4-项目与工作区)
7. [插件设置](#七插件设置)
8. [让 Agent 通过 MCP 查询](#八让-agent-通过-mcp-查询)
9. [可选 Skill 导出与分发](#九可选-skill-导出与分发)
10. [备份、迁移、关闭与卸载](#十备份迁移关闭与卸载)
11. [问题排查与日常检查](#十一问题排查与日常检查)

## 一、先了解操作边界

插件把团队声明、个人注册与本机探测结果集中展示，**不是工具安装器或版本管理客户端**。

| 操作 | 会做什么 | 不会做什么 |
| --- | --- | --- |
| 新增 / 编辑 / 移除注册 | 保存个人目录，触发后台本机检查 | 不安装或卸载 CLI，不删除项目目录 |
| 扫描 npm CLI | 读取 npm 全局包清单与包的 bin 元数据 | 不执行候选 CLI，不自动注册 |
| 发现 Git 目录 | 扫描明确目录、读取 Git 根 / 分支 / HEAD / remote | 不 clone、fetch、pull、checkout 或提交 |
| P4 服务器只读查询 | 用户确认后查询已有 Client，指定 Client 时读取 Root / View / Stream | 不 login、trust、创建 Client、sync、revert 或 submit |
| 离线 P4CONFIG | 读取指定文件的 P4PORT / P4USER / P4CLIENT | 不读取密码、票据，不访问服务器 |
| 刷新视图 | 重新读取目录、配置和已有快照 | 不等于重新检查 CLI / 项目；远端团队目录可能被 GUI 重新拉取 |
| 立即重跑探测 | 后台检查已注册工具、本机目录和 Git 元数据 | 不运行真实 API 用例，不查询 P4 服务器 |
| MCP catalog 默认查询 | 仅读本机声明 / 远端 registry 缓存和已有快照 | 不执行 CLI，不等待全量检查，不下载远端文档 |

CLI 的 `check.version` 必须可信、只读、无交互。安装说明只是展示文本，绝不由插件执行。
“已发现”不代表“已登录”“权限正常”或“工作树干净”，更不意味着 Agent 获得写操作授权。

## 二、安装与第一次使用

### 2.1 安装插件

需要 magpie；本项目运行在 magpie 的 Bun 插件宿主内。开发测试另需 Bun。

```powershell
# Windows：本地目录插件
magpie plugin add "D:/workspace/magpie-team-catalog"
```

```sh
# macOS / Linux：换成实际克隆目录
magpie plugin add /path/to/magpie-team-catalog
```

如果 PATH 中没有 `magpie`，使用实际可执行文件的完整路径调用。
这是安装目录插件，不是 npm 发布；使用团队 npm 包前应先确认包已实际发布。

### 2.2 打开页面

1. 在 magpie 侧边栏的插件区域点击 **团队目录**。
2. 等待后台首轮检查，必要时点击 **立即重跑探测**。
3. 页签为 **工具**、**项目**、**插件设置**；数字随注册数量变化。
4. 检查工具路径、项目目录和状态是否符合本机情况。

本机浏览器可备用访问 `http://127.0.0.1:3969/`；这是默认端口，实际以 `servicePort` 为准。
页面由插件宿主服务，单独退出宿主后 URL 可能不可用。

### 2.3 建议初始配置

在 **插件设置** 中：

- 团队 registry 保持默认试运行文件，或换成团队提供的本地 / HTTP / Git 数据源。
- 个人注册层保持开启，个人注册文件留空使用默认目录。
- 检查周期保持 900 秒，命令超时 5000 毫秒，并发 8。
- 如找不到 magpie，填写 **magpie 可执行路径**。
- **Skill 导出**与**提示词索引注入**保持关闭，先验收目录与 MCP。

点击 **保存插件设置**。保存会重载宿主，新页面恢复时可能短暂显示服务不可达。

## 三、浏览、搜索和状态

### 3.1 页面布局

- 顶部统计：CLI 工具、项目 / 工作区、本机已发现、需关注。
- **工具**：工具卡片、搜索及来源 / 类型 / 状态筛选。
- **项目**：项目卡片、同类筛选，另有 P4 工作区筛选。
- **插件设置**：常用配置与折叠的高级分发 / 回退配置。

统计中的“本机已发现”包含可用工具与存在的项目目录，不等于完成服务器连接验证。
“需关注”通常包括未找到、待检查、需更新、未绑定或非仓库。

### 3.2 搜索与折叠

- 工具搜索可输入名称、包名、用法或路径。
- 项目搜索可输入名称、本机路径、Client 或 Depot；多个关键词需都匹配条目。
- 切换目录页签会清空搜索 / 筛选，避免旧关键词隐藏另一类条目。
- P4 项目按 **服务器 + Client** 分组，组标题显示条目数；点击可折叠。
- 点击 **安装 / 更新说明**或**项目地址与说明**展开长内容。
- 当前目录索引收在 **插件设置**底部，只有开启 `injectIndex` 才注入提示词。

筛选与折叠仅改变视图，不修改注册。折叠状态只保存在当前页面内存，刷新页面会重置。

### 3.3 状态对应

| 界面文字 | 数据值 | 含义 |
| --- | --- | --- |
| 已发现 | present | 找到工具 / 本机目录；P4 服务器未因此验证 |
| 检查通过 | configured | 本次工具声明的 probe 通过；也可能是手工钉死状态，需检查来源 |
| 未找到 | missing | 工具或本机目录未找到 |
| 需更新 | outdated | 已读出的版本低于声明 min |
| 已禁用 | disabled | 用户本机覆盖禁用 |
| 待检查 | unknown | 无实测或注册改变后需重新检查 |
| 未绑定 | unbound | 项目有地址但没有本机根目录 |
| 非仓库 | not-repository | Git 目录不是可读工作树或 Git 不可用 |

P4 `serverChecked:false` 表示周期只检查本机目录。Git 分支 / HEAD 不证明没有未提交修改。
界面可能短暂显示旧快照；MCP 的 `meta.stale` / `stateOrigin` 提供进一步来源说明。

## 四、注册与维护 CLI

### 4.1 手工新增

**工具 → 新增个人 CLI**：

1. 填 **ID**：小写字母、数字和连字符，最长 48 字符，与所有工具 / 项目 ID 不重复。
2. 填名称、安装渠道、包名（如果适用）、**命令名 / 绝对路径**。
3. 填 **安装 / 更新说明**（必填）及用法摘要。
4. 需要时展开 **高级探测与文档**。
5. 点击 **保存并探测**；目录立即登记，后台实测稍后更新。

| 字段 | 示例 / 说明 |
| --- | --- |
| 安装渠道 | 本机二进制 / npm / pipx / pip / Homebrew |
| 包名 | `@team/build-tool`，可与启动命令不同 |
| 命令名 / 绝对路径 | `ueb` 或 `D:/tools/tool.exe`；留空时按 ID 查找 |
| 版本参数 | JSON 字符串数组，如 `["--version"]`；P4 为 `["-V"]` |
| 超时（毫秒） | 正整数，默认 5000 |
| 最低版本 | 可选；只提示过旧，不自动升级 |
| 文档相对路径 | 相对该条目的来源目录，MCP 拒绝越界文档 |
| 详细文档 | 可直接内联说明；MCP 按段读取 |
| Skill ID | 可选，需另外提供技能源，不因填写就自动生成 Skill |

不支持版本命令的 CLI 可填 `[]`。npm 包的版本可从清单读取；纯二进制可能只显示已发现而无版本。
不要把构建、登录、同步、真实验证用例或任意写操作填写为版本探测参数。

### 4.2 扫描 npm 候选

1. **工具 → 扫描 npm CLI**。
2. 插件读取全局包清单与 `package.json.bin`，普通依赖库不会作为 CLI 候选。
3. 使用 **筛选候选**查找命令 / 包名。
4. 点击 **选择注册**，核对预填信息并补安装维护说明。
5. 点击 **保存并探测**。

匹配到已注册的个人包 / 命令会显示不可点击的 **已注册**。
团队 ID 冲突仍由保存校验拒绝，不能通过个人注册覆盖团队条目。
只有 npm 全局命令是本入口的扫描范围，不包括项目 node_modules 或全磁盘二进制。

### 4.3 示例

| 工具 | 安装渠道 | 包名 | 命令 | 版本参数 |
| --- | --- | --- | --- | --- |
| ueb | npm | ueb | ueb | `["--version"]` |
| WDP API 验证工具 | npm | wdp-api-verify | wdp-verify | 当前 0.2.0 使用 `[]`，不支持 --help / --version |
| Perforce CLI | 本机二进制 | 不填 | p4 | `["-V"]` |

这些是填写示例，不会自动安装或注册。P4V 是 GUI；Agent 使用的是配套 `p4` CLI。

### 4.4 编辑与移除

个人卡片提供 **编辑注册**与**移除注册**；团队卡片只提供本机覆盖。
移除需要二次确认，仅删除个人注册，不卸载 npm 包或二进制。
编辑过程中取消 / Escape 会确认是否放弃未保存输入。

## 五、本机覆盖：暂存与保存

本机覆盖适用于团队工具和个人工具，只改变本机行为。

1. 工具卡片点击 **本机覆盖**。
2. 填 **启动路径覆盖**，或改 **启用**和**状态模式**。
3. 点击 **应用到待保存修改**：**此时只暂存到页面，尚未写盘**。
4. 下方保存条点击 **保存本机覆盖**，才写入插件选项并触发宿主重载。

- **恢复自动**：清空该条目路径、禁用和钉死草稿；仍需应用并保存。
- **放弃修改**：二次确认后恢复最近读取的配置，不写磁盘。
- 状态模式建议保持自动；手工指定不是实测，不应用于掩盖缺失工具。
- 刷新视图、切换目录页签、后台快照更新不会丢失覆盖草稿。
- 进入设置后若有覆盖草稿，先保存或放弃；设置保存会阻止交叉覆盖。

## 六、Git / P4 项目与工作区

### 6.1 手工注册项目

**项目 → 新增本机项目**：

1. 填项目 ID、名称与 **版本管理**（Git / Perforce P4 / 普通本机目录）。
2. 填本机根目录（绝对路径）及远端地址 / 项目 URL。
3. P4 项目填写服务器、用户、Client，以及适当的 Depot 范围。
4. 需要时展开 **高级映射与项目说明**，登记 Stream、View、P4CONFIG 与说明。
5. 点击 **保存项目**。

纯本机项目可以仅有目录；P4 信息只登记，不自动验证或修改工作区。

### 6.2 发现 Git 仓库

**项目 → 发现 Git 目录**：

1. 填扫描根目录，例如 `D:/workspace`。
2. 设置 **最大深度**（默认 2，范围 0–5）。
3. 点击 **开始发现**，选择目标仓库的 **选择注册**。
4. 核对本机路径、远端地址和 ID，点击 **保存项目**。

GUI 默认最多 50 个候选；另有最多 1000 目录 / 15 秒预算。
扫描不跟随目录符号链接，跳过依赖 / 构建目录，发现仓库后不再递归其内部。
Git worktree 的 `.git` 文件形式受支持；bare 仓库和嵌套子模块不在默认扫描范围。
有扫描上限提示时缩小根目录，不应把部分结果当作完整清单。

### 6.3 发现 P4 工作区：服务器模式

**项目 → 发现 P4 工作区**，选择 **服务器只读查询**：

1. 填 **P4 服务器**、**P4 用户**；已有连接可以用 **已有 P4 连接**预填。
2. 可填 **P4 Client（可选）**：指定后读取该 Client 的 View / Stream。
3. 勾选授权只读查询复选框，点击 **开始发现**。
4. 核对候选 Root 确实是本机目标，点击 **选择注册**。
5. 在项目表单核对字段，点击 **保存项目**。

预填不访问服务器，并会取消此前的授权勾选；每次查询仍需确认。
查询只执行已有 Client 列表与 `client -o`，不自动登录、trust、创建或同步。
没有 Client / Root 不匹配 / 权限失败时停止确认，先用团队正常流程解决连接或权限。

### 6.4 发现 P4 工作区：离线模式

同一弹窗将 **P4 读取方式**改为 **离线 P4CONFIG 文件**：

1. 填明确的绝对文件路径。
2. 点击 **开始发现**，仅提取 P4PORT / P4USER / P4CLIENT。
3. 核对预填的项目和根目录后 **保存项目**。

不访问服务器，也不读取 P4PASSWD / P4TICKETS。父目录配置不会被自动猜测。
由配置文件父目录预填的根目录可能是项目子目录，不保证就是 Client Root，请按实际情况修正。

### 6.5 工作区容器、具体项目与团队绑定

- 一个 P4 Client 可以有一个工作区容器条目，并有多个具体项目条目。
- 具体项目可用 **从已注册工作区填充**复用 port / user / client；Depot 范围单独确认，避免扩大到全 depot。
- 同项目的不同 Client 副本、同目录多个 `.uproject` 分别使用唯一 ID。
- 项目文件及 EngineAssociation 可记入项目说明；GUID 不等于 UE 版本。
- 当前 GUI 自动发现提供 Git 仓库 / P4 Client，**不包含通用 UE 项目批量扫描 / 一键导入**。

团队项目卡片点击 **绑定本机目录**：团队名称 / ID / 地址只读，仅补本机根和 P4 信息。
**保存项目**后绑定保存在个人文件；**解除绑定**二次确认后只移除本机绑定。
个人项目用 **编辑项目**或**移除项目**；移除注册不删除目录或服务器 Client。

## 七、插件设置

进入 **插件设置**，修改后点击 **保存插件设置**。

### 7.1 常用与高级字段

| UI 字段 / option | 默认 | GUI 范围 / 用途 |
| --- | --- | --- |
| 团队 registry / registry | `./registry/registry.yaml` | 本地路径、HTTP 文件或 Git spec |
| 个人注册文件 / localRegistry | 默认状态目录 | 留空使用默认；插件目录外本地路径，关闭层时写 false |
| 个人注册层 | 开启 | 关闭只停止合并，不删除文件 |
| 检查周期（秒） / interval | 900 | 60–86400 |
| 单命令超时（毫秒） / probeTimeoutMs | 5000 | 100–60000，条目 timeoutMs 可覆盖 |
| 并发检查数 / concurrency | 8 | 1–32，调整过大会增加本机负载 |
| magpie 可执行路径 / magpieBin | 自动查找 | 显式路径失效不回退到另一份安装 |
| 索引中显示未安装 / showMissing | false | 只影响索引的 missing 清单，不是卡片显示开关 |
| 提示词索引注入 / injectIndex | false | 旧形态回退，建议关闭 |
| Skill 导出 / skillExport | false | 开启时必须填 skillsRepo |
| skillsRepo | 空 | 本地 / Git 技能源，布局 skills/&lt;id&gt;/SKILL.md |
| Skill 前缀 / skillPrefix | 空 | 建议 `team-`，避免和手工 Skill 撞名 |

高级配置不在本表单提供：`statePath`、`cacheDir`、`skillRoot`、`skillLibraryDir`、`servicePort`。
它们不会被普通表单覆盖；特殊部署通过 magpie 插件选项配置，字段见专题文档。

### 7.2 保存、冲突与会话恢复

- 保存前校验 registry / localRegistry，有问题时显示错误并保留输入。
- 请求附带读取时的 revision；其它窗口更改配置后会拒绝旧窗口保存。
- 后台发布 index 不使设置 revision 失效；未知用户配置键保持原值。
- 不要在页面会话过期时反复提交；点击 **重新加载页面**重新读取后再编辑。
- 未保存设置切换页签要确认；点击 **取消**保留输入。刷新视图不重建设置草稿。
- 编辑弹窗保存期间字段被冻结，避免响应回来前输入被覆盖。

三种保存区别：CLI / 项目写个人文件；覆盖 / 设置写插件 options；后两者会重载宿主。
旧版 GUI 首次升级可能需要重新打开页面；若仍保留旧文档，退出并重新启动 magpie。
整个服务重启会短暂影响网关，不应在重要请求进行中随意退出。

## 八、让 Agent 通过 MCP 查询

插件工具汇入 magpie 的 `/mcp/magpie/tools`；分发可见性由插件 **交给智能体**或 MCP 路由管理。
不是安装后所有 Agent 必然自动可见，也不需要开启提示词注入才能使用 MCP。
实际前缀由宿主决定，常见工具名为：

- `magpie-team-catalog_catalog_status`
- `magpie-team-catalog_catalog`

建议 **概览 → 筛选 → 精确详情 → 必要时显式检查**：

```js
catalog_status({})
catalog({ type: "tool", query: "构建", limit: 10 })
catalog({ type: "project", kind: "p4", client: "your-client", port: "p4.example:1666" })
catalog({ type: "project", path: "D:/workspace/project" })
catalog({ detail: "exact-project-id" })
catalog({ detail: "exact-tool-id", check: true })
```

- 列表默认合计 20 条简略记录，按 `pagination.nextOffset` 续页，最大 limit 100。
- 详情和筛选 / 分页参数互斥。
- 文档默认最多 8000 字符，使用 `docOffset/docLimit` 按段读取。
- 默认详情不执行 CLI；check=true 只检查声明的 probe，不是通用执行接口，不验证 P4 服务器。
- `meta.stale` 表示快照过期 / 注册身份变化 / 缺实测；会触发后台刷新，不等待整轮完成。
- MCP 不下载远程 registry 或文档；缺少来源匹配缓存时先完成后台刷新。

CLI 排障命令：

```sh
magpie tools magpie-team-catalog_catalog
magpie tool magpie-team-catalog_catalog_status --json
magpie tool magpie-team-catalog_catalog --type project --kind p4 --limit 10 --json
```

完整 contract、参数范围和错误码见 [mcp-design.md](mcp-design.md)。

## 九、可选 Skill 导出与分发

目录 / MCP 最小使用不需要 Skill。先验收前述功能，再按需启用。

1. 提供独立 Skill 源，布局 `skills/<id>/SKILL.md`；CLI 条目可用 Skill ID 映射。
2. 在设置填写 skillsRepo、Skill 前缀（建议 team-），开启 Skill 导出。
3. 后台将源正文与本机路径 / 版本合并，写默认 `~/.agents/skills/team-<id>/SKILL.md`。
4. 核对正文、frontmatter name、实测路径和版本。

仅处理托管标记文件，内容不变不重写；未安装 / 禁用会移除共享点的托管副本。
P4 工作区 / 项目注册不会因此自动生成 CLI Skill。目录损坏时不运行清理。

跨 Agent 分发走 magpie library：

```sh
magpie library skill hand-over team-<id>
magpie library skill agents team-<id> claude,codex,pi
magpie library skill router on       # 可选聚合入口
magpie library sync
```

hand-over 后插件改维护 library 的托管副本，变化时触发 sync；不会因禁用自动删除
library 副本，删除应使用 magpie 的管理命令。各 Agent Skill 目录支持情况以其实际配置为准。

**仍需工作机验收**：hand-over、sync 重推及多 Agent 分发不能只凭单测认定已部署完成。
关闭、禁用和路径更新都应在临时 skillRoot / 测试条目上先验证。

## 十、备份、迁移、关闭与卸载

### 10.1 文件位置

默认用户配置根为 `~/.config`，尊重 `XDG_CONFIG_HOME`。

| 文件 | 作用 | 是否人工维护 |
| --- | --- | --- |
| magpie/plugins.json | 插件 options / 覆盖 | 推荐经 GUI 或 magpie CLI 修改 |
| magpie/team-catalog/local-registry.yaml | 个人 CLI、项目、团队本机绑定 | GUI 或手工 YAML/JSON |
| magpie/team-catalog/catalog-state.json | 本机探测快照 | 自动生成，不手工改 |
| magpie/team-catalog/registry-cache/ | 远端 registry 缓存 | 自动管理 |

设置 statePath 时默认个人文件随 state 同目录；显式 localRegistry 按指定位置保存。
GUI 将个人文件保存为规范 JSON（YAML 子集），仍支持手工 YAML；页面保存不保留 YAML 注释。

### 10.2 备份与迁移

- 备份个人注册文件；覆盖 / 设置随 magpie 配置按团队方案备份。
- 新机器安装插件、恢复个人文件、核对路径 / Client / 可执行位置后重跑检查。
- 不把旧机器快照当作新机器已安装事实。
- 不把个人路径、P4 用户 / Client、私有地址或凭据放入共享 registry PR。
- 不与 GUI 同时手工编辑文件；过期 revision 会要求重新加载，避免互相覆盖。

### 10.3 关闭与移除

```sh
magpie plugin off magpie-team-catalog
magpie plugin on magpie-team-catalog
magpie plugin rm magpie-team-catalog
```

目录插件名通常取目录名；改名后请以 `magpie plugin list` 显示的名称为准。
关闭不删除个人文件；移除插件不卸载已注册 CLI，也不删除项目或 P4 Client。
状态 / 缓存 / 个人文件与托管 Skill 需要时手动清理，清理前先备份。

## 十一、问题排查与日常检查

| 问题 | 处理 |
| --- | --- |
| UI 仍是旧长表格 / 加载中 | 重新打开团队目录；旧文档仍被保留时重启 magpie，新页脚本会内联提供 |
| 页面会话已过期 | 无草稿时自动恢复；有草稿先复制重要输入，再确认重新加载。不反复点击保存 |
| 配置已被其它窗口修改 | 当前输入不会提交；重新加载读取最新配置后重做修改，不覆盖新版本 |
| 已应用覆盖但重开后消失 | 应用只是暂存，必须再点保存条的“保存本机覆盖” |
| 设置提示先处理覆盖 | 返回工具页保存 / 放弃覆盖草稿，再保存设置 |
| 找不到 CLI | 核对安装渠道、包名与 bin；GUI 本机覆盖指定真实路径，重跑检查 |
| npm 工具没有版本 | 清单是否可读 / 包名是否正确；支持的版本参数是否只读，必要时 [] 避免无效调用 |
| 已注册候选不可选择 | 返回已有个人条目编辑；团队冲突用覆盖而不是重复 ID |
| P4 查询失败 | 核对服务器 / 用户 / Client / 本机权限，按团队流程登录；插件不会自动登录或 trust |
| P4 本机目录已发现但不能操作 | present 只证明目录存在；核对连接、Root / View 和权限，不依赖目录状态提交 |
| Git 扫描结果为空 / 不全 | 核对根目录和深度，缩小扫描范围；bare / 符号链接 / 已发现仓库内部不默认扫描 |
| Git 分支显示 detached | 当前为 detached HEAD / worktree 状态，不自动 checkout |
| Agent 看不到工具 | 检查“交给智能体”、MCP 路由和实际工具名；先用 magpie tool 验证 |
| MCP 返回少于目录数量 | 按 nextOffset 续页，或按 Client / path / type 筛选；UI 筛选也可能隐藏条目 |
| MCP 缓存源不匹配 | 先跑后台刷新；新 Git 源可能需独立 cacheDir，不能用旧源缓存替代 |
| 重跑超过一分钟 | 可能仍在后台；稍后刷新视图，检查慢命令预算，不因超时重复运行真实用例 |
| 端口占用 / 服务暂不可达 | 宿主重载退役窗口可能占用端口，后台重试；默认3969不是所有实例固定端口 |
| 个人文件坏了 | 先备份，修复 YAML/JSON 后重载；插件不会覆盖坏文件或清理其 Skill |
| 写锁残留 | 确认没有保存进程后处理 .write-lock；不在正在保存时删除 |

日志通过宿主支持的 `magpie log` 查看；detached worker 默认 stdio=ignore，不能假定每轮输出均可捕获。

日常建议：使用前查工具路径 / 项目 Client；更新 CLI 后重跑检查；修改配置后确认保存成功；
涉及同步、revert、提交或真实 API 用例时另行确认目标与授权。

## 专题文档

- [UI 与配置操作说明](ui-guide.md)
- [个人 CLI 注册](personal-registry.md)
- [Git/P4 项目与工作区](local-projects.md)
- [MCP contract](mcp-design.md)
- [registry 字段规范](registry-schema.md)
- [团队 registry 变更流程](registry-workflow.md)
- [架构设计](design.md)
- [核心阶段验收](milestone-projects-mcp.md)
