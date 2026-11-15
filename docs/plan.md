# 实施计划 · magpie-team-catalog

版本：draft-1（2026-11-15）。按 [design.md](design.md) 逐阶段实施；每阶段有明确验收标准，验收不过不进入下一阶段。

## 阶段总览

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| M0（当前） | 设计落盘 | 本仓库文档（design / plan / schema / 示例 registry） |
| M1 | 最小可跑：Bun 模块 + middleware | `index.mjs`（拉取+探测+状态文件）、`catalog.middleware.js` |
| M2 | tool 钩子 + 覆盖层 | `catalog` 工具、options 覆盖（bin/enabled/status） |
| M3 | 窗口页 | `magpie.page` + 本地 service + 覆盖编辑 |
| M4 | 团队化 | 发布内部 npm registry、registry 独立共享仓库 |

## M1 · 最小可跑（单机、单用户）

范围刻意收窄：**没有 tool、没有 page**，只有"Bun 模块探测 → middleware 注入"这条最短链路，registry 用本地文件。

1. `package.json`：`name: magpie-team-catalog`，`"magpie": {"options": {"registry": "./registry/registry.yaml"}}`；无 main 之外的冗余字段；
2. `index.mjs`（Bun 宿主模块）：
   - 读 options.registry（M1 仅 `file://`/相对路径），解析 `tools` / `projects`；
   - 对每个 tool 条目按 `check` 探测（§5.3：5s 超时、并发 ≤8）；
   - 结果写 `catalog-state.json`（探测时间戳、状态、版本）；
   - 生成压缩索引字符串，写入自身 options（供 middleware 读取）；
3. `catalog.middleware.js`：`onRequest` prepend 索引到 `body.system`；只注入 available 条目；无索引时直通。

**验收标准：**（2026-11-15 全部通过，沙箱实测记录见提交信息）

- [x] `magpie plugin add ~/github/magpie-team-catalog` 成功加载，`magpie plugin` 列出无错误；
- [x] 沙箱（独立 `HOME`/`XDG_CONFIG_HOME`，`MAGPIE_BUN` 指向本机 Bun）里放一个假 CLI，registry 声明它，请求经网关后 system prompt 出现该条目；删掉假 CLI 并 reload 后条目消失；
- [x] middleware 文件语法错误时，请求原样通过（fail-open 实测：网关正常回错、后续中间件照常执行）；
- [x] `magpie plugin off team-catalog` 后请求 system prompt 无注入，网关仍健康；
- [x] `bun test` 覆盖 registry 解析与状态机迁移（纯函数，放 `_internal` 导出；含 inject/probe，共 39 项）。

**实现备注（与设计文档的偏差，均为实测驱动）：**

- 探测/发布不在插件加载里同步做：宿主对插件加载有预算（add 验证 20s），
  且发布会 spawn magpie CLI、对方还会再启宿主嵌套加载本插件；实际结构是
  `index.mjs`（宿主内触发器）spawn detached `worker.mjs` 跑一轮探测+发布，
  整轮跨进程锁（`cycle.lock`）让嵌套副本跳过；
- 空索引首次不发布（避免 add 时空目录触发无意义发布链）；
- 探测命令（npm/brew/pipx/which）带常见绝对路径回退：GUI 启动的宿主进程
  PATH 可能只有系统默认，没有 /opt/homebrew/bin 等；
- reload 触发方式：`magpie plugin add` 重跑（folder 插件按当前内容加载），
  或任何会启动宿主的命令；网关侧中间件对 plugins.json 变更 1s 内热重载。

## M2 · tool 钩子 + 用户覆盖层

1. 增加 `catalog` 工具（`tool` 钩子，zod args：`query?` / `detail?`）：
   - 搜索：id / name / 关键词模糊匹配，返回条目 + 本机状态 + `fix`（安装/升级命令）；
   - 详情：读 `docs/<id>.md` 全文返回；
2. 用户覆盖生效：`overrides.{id}.bin / enabled / status`（钉死）优先于探测；
3. 索引注入按覆盖过滤（disabled 不出现）；
4. 版本检测：`min` 比对，outdated 在索引与工具返回中标注。

**验收标准：**（2026-11-15 沙箱实测通过；MCP 握手用 curl 走完整
initialize→tools/list→tools/call 流程，与 Agent 侧 MCP 客户端同协议）

- [x] `/mcp/magpie/tools` 上 Agent 能调 `magpie-team-catalog_catalog`（名称
  前缀以 magpie 实际生成的短名为准：文件夹插件短名即目录名）；
- [x] 覆盖 `bin` 路径后探测按覆盖路径成功（实测：覆盖后 version 报出
  覆盖路径下假 CLI 的 9.9.9）；`enabled: false` 后索引与工具均不出现；
- [x] 每工具单次执行 55s 上限不被探测逻辑阻塞：周期探测在 worker 里，
  execute 内只有查详情时按需 probe（≤5s）；
- [x] `detail` 返回按需 probe 结果（probe:ok + 输出，present 升 configured，
  outdated 保留并附带 probe 证据）；`min` 比对在索引与工具返回中标注；
- [x] `bun test` 覆盖工具纯函数（匹配/响应组装/覆盖层），共 50 项。

## M3 · 窗口页

1. `magpie.page`：带路页（`index.html` + `boot.js`）——沙箱 iframe 无网络权限，
   唯一能做的联网动作是导航自身；`boot.js` 拿 service 地址、把主题编码进
   查询串后 `location.replace` 过去；
2. Bun 模块起本地 HTTP service（`magpie.page.service`）：主界面 `main.html`
   由 service 的 GET / 直接提供，数据走同源的 `/state` `/options`；
3. 行内编辑覆盖 → POST `/options`（service 代执 magpie plugin options CLI，
   与 worker 发布同一条 sanctioned 通道）写回；
4. 探测“立即重跑”按钮（触发一次全量刷新）。

**验收标准：**（2026-11-15：数据链路已在沙箱实测；GUI 渲染项待桌面窗口实机验证）

- [x] service 数据链路：`magpie serve` 沙箱里 GET /state 返回正确视图，
  POST /refresh 触发 worker 重探（删掉假 CLI 后 status 变 missing），CORS 头
  齐全（沙箱 iframe 的 opaque origin 可访问）；`magpie plugin` 列表显示
  `page Team catalog`；
- [x] 页面在 magpie 窗口正常渲染（实机 2026-11-15：带路页导航 → service 主界面，
  表格列出全部 4 个工具，均 present）；
- [x] 编辑覆盖保存后，下一个请求的索引按新覆盖过滤（实机 2026-11-15 双向验证：
  窗口取消 gitnexus「启用」→ 保存 → `overrides:{"gitnexus":{"enabled":false}}`
  落盘、index 键保留、索引只剩三个工具、state 转 disabled、checkedAt 前移；
  重新勾选保存后 `overrides:{}`、索引恢复四个工具）；
- [ ] 页面抛错显示「此页面已停止工作」，重试可恢复——magpie 内核自带
  错误边界（框架行为），待实机。

**实现备注：**

- service 端口必须从 `options.servicePort` 读：magpie 在不服务页面的进程
  （如 plugin update）会把该 option 改写到空闲端口，避免与常驻实例撞端口；
  桌面模式下带路页回退直连 `127.0.0.1:<servicePort>`，web 模式走 `magpie.service`
  反向代理；绑定失败（宿主重启期间旧进程还占着端口，retire 窗口最长 10 分钟）
  时后台每 5s 重试、最长 15 分钟；
- 【实装踩坑】worker 发布索引时不能以宿主传入的 options 为基准——无页面
  进程里 servicePort 已被改写成内部值，写回会污染用户配置（实测发生过：
  plugins.json 里混入一次性的 51849）。发布基准改为只读 plugins.json 里
  本插件的用户 options（`cycle.mjs readUserOptions`），运行时行为仍用宿主
  传入值。另：`magpie plugin options <name> '{}'` 是空操作，清除要用 `off`；
- 页面表格用纯 DOM API 构建（无 innerHTML）；覆盖编辑改草稿，保存时经
  `magpie.options.set` 整体写回（保留 index/registry 等既有键）。

## M4 · 团队化

1. registry 独立为共享 git 仓库（HTTP raw 或 git 拉取，凭据走本机 git 配置）；
2. 插件发布内部 npm registry（`@team` scope），成员 `magpie plugin add @team/magpie-team-catalog`；
3. registry 变更流程文档：PR 模板、check 命令纪律（只读幂等）、`min` 升级流程；
4. 双机验证（Mac 主力机 + win）：覆盖层各自独立，索引各自正确。

**进展（2026-11-15）：**

- [x] 第 1、3 项已实现：`lib/source.mjs` 统一三种数据源
  （本地 / http / git，含 `#ref` 与刷新失败沿用缓存），cycle/tool/service
  共用；沙箱实测 http 与 `git+file://` 两种源的完整发布链；变更流程文档
  [registry-workflow.md](registry-workflow.md)（PR 模板、check 纪律、min 流程）；
- [ ] 第 2 项（内部 npm 发布）与第 4 项（双机验证）待团队决策：
  registry 仓库位置 / `@team` scope 的 npm 通道 / win 机器验证时机。

**验收标准：**

- [ ] 第二台机器一条命令装上并出现正确索引；
- [ ] registry 加一个工具（PR merge）后 ≤15 分钟两台机器都拉到（无需插件发版）。
  （两项均为发布后实测项；拉取机制本身已在沙箱验证：http/git 源改内容后
  下一轮 worker 即拉到新索引。）

## F1 · 单条目探测超时（基线后第一个 feature）

**问题**：`probeTimeoutMs` 是全局一个值（默认 5s）。实测 `hermes --version`
输出多、偶发超 5s，被掐后版本号静默丢失（state 里只剩 `present` 无 version，
索引里也看不到版本）。

**做法**：registry 条目的 `check` 增加可选 `timeoutMs`（整数毫秒，默认继承
全局），探测该条目时用它。schema 校验在 core（必须是正整数），probe 侧
which / version 命令都用该条目的预算。

**验收标准：**

- [ ] `check.timeoutMs` 合法值解析通过；非数字/非正整数拒绝并报出行号与字段名；
- [ ] 全局超时小于条目超时时，慢命令仍能读出（测试用 sleep 脚本：全局 200ms
  掐死 vs 条目 2000ms 读出）；反之全局放宽不影响未声明 timeoutMs 的条目；
- [ ] `hermes` 条目声明更长超时后，state 与索引里稳定带出版本号；
- [ ] registry-schema.md 记录该字段与作者纪律。

## 基线后任务清单（2026-11-15 基线 51fdb2b 之后）

| 编号 | 任务 | 状态 | 前置条件 |
| --- | --- | --- | --- |
| F1 | 单条目探测超时 `check.timeoutMs` | 已完成（3163fb3 / 6407e7b） | 无 |
| F2 | 覆盖保存端到端实测（页面改一行 → 保存 → 索引变化） | 已完成（2026-11-15 实机双向） | 无 |
| F3 | skill 落盘（取代 system prompt 注入；经 magpie library 分发） | 已完成（2d4a9b6 / abef66b / 1bdf7a5） | 无 |
| F4 | hand-over 后插件维护 library 副本（方案 C，见下节） | 实施中 | 无 |
| M4-2 | 内部 npm 发布（`@team` scope 通道） | 待团队决策 | 通道/权限定下 |
| M4-4 | 双机验证（win 机器） | 待团队决策 | win 机器可用时机 |
| — | registry 切团队共享仓库（现为本机单机形态） | 待内容侧 | 团队仓库址定下 |

## F3 · skill 落盘（取代 system prompt 注入）

**方向变更（2026-11-15）**：不再往每个请求的 system prompt 里塞工具索引——非项目
任务里注册 CLI/项目清单对模型不友好。改为：插件探测完成后，为每个「本机可用」
的工具渲染一份 `SKILL.md`，落到 skill 目录，Agent 侧以 skill 形式显式调用。

**公共管理面（实测）**：magpie 自带 `magpie library`（"what the library gives each
agent: instructions, MCP servers, skills"），提供 `library skill agents / router /
how link|copy / where agents|shared / hand-over / update`。因此插件**不自己往各家
Agent 目录写**，只写跨工具共享投放点 `~/.agents/skills/<name>/SKILL.md`，是否进
library、发给哪些 Agent、链接还是副本，全由 magpie 决定。

**skill 来源 = 独立公共仓库（决策 B）**：与 CLI 一起发版的 skill 仓库，布局
`skills/<tool-id>/SKILL.md`，通过 `options.skillsRepo` 拉取（复用 source.mjs 的
本地/git 三形态；http 不支持目录，报错跳过）；registry 条目可用 `skill: <id>`
映射到不同 skill id（缺省用工具 id）。

**渲染规则**：

- 目标文件 = `<skillRoot>/<skillPrefix><id>/SKILL.md`；frontmatter 的 `name` 强制
  改写为 前缀+id，`description` 优先用源 frontmatter，否则由 registry 的 name/usage 推；
- 正文 = 源 skill 正文 + 自动生成的「本机实测」块（绝对路径、版本、via、探测时间，
  用 `<!-- team-catalog:measured begin/end -->` 定界）+ 「路径失效则用 catalog 工具
  查最新」的固定提示；
- 写入带 `<!-- team-catalog:managed -->` 标记，只有带标记的文件/目录才允许覆盖
  或删除（不碰别人的 skill）；
- 状态 missing/disabled → 不生成；已生则移除（仅限带标记且名字对应已知工具 id）；
- 内容未变不写入（幂等，避免无意义的 mtime 变动）。

**middleware**：代码保留（`catalog.middleware.js` + `lib/inject.mjs` + 现有测试
不动），但改为 `options.injectIndex === true` 才注入——默认关闭，可一键回退。

**验收标准：**

- [ ] 纯函数：frontmatter 解析/改写、measured 块定界、名字前缀、幂等不重写；
- [ ] 写入/更新/删除三路生效，且**不碰**无标记目录（用临时目录造一个异物验证）；
- [ ] missing/disabled 的工具不生成 skill，已生成的被移除；
- [ ] `skillExport` 默认 false：本机（非工作机）零副作用；开启后只在临时 skillRoot 测；
- [ ] middleware 默认不注入；`injectIndex: true` 时行为与之前一致（现有测试仍绿）；
- [ ] registry-schema / registry-workflow 记录 `skill` 字段与两个仓库的关系。

## F4 · skill 分发形态（方案 C，2026-11-15 决策）

**背景**：F3 落盘到 `~/.agents/skills` 只是装卸点。本机实测：读该目录的是 pi /
hermes 这类工具；Claude Code（`~/.claude/skills`）、Codex（`~/.codex/skills`）不会
自动看到，要发给这几家只有 magpie library 一条官方路。而 hand-over 把 skill 搬进
library 后，F3 的持续写入会重建 `~/.agents/skills` 副本形成双写。

**三个备选的裁决**：

- A（不 hand-over，只写共享目录）：Claude/Codex 永远收不到 → 弃；
- B（hand-over 后关 skillExport）：实测块（本机路径/版本）被冻结，CLI 升级换
  路径后 skill 越来越假 → 弃——只要 skill 暴露本机路径，就必须有人持续刷新它，
  而插件是唯一知道真实路径的角色；
- **C（选定）**：一次 hand-over + 插件改写 library 副本。library 帮助文本明确
  「installed or edited by hand 后 `magpie library sync` 重写进 agents」是官方
  预期用法。

**做法**（部署时 + 每轮探测）：

1. 部署：`skillExport: true` → 插件写 `~/.agents/skills/team-<id>/`；
2. 对每个要分发的 skill 执行一次 `magpie library skill hand-over team-<id>`；
3. `magpie library skill agents team-<id> claude,codex,…` 按需勾选（或 router on）；
4. **F4 代码改动**：`syncSkills` 检测 `<library>/<name>` 存在 → 不写
   `~/.agents/skills`，改写 library 副本（同 managed 标记）；
5. 内容有变 → spawn `magpie library sync`（fail-open）→ magpie 重推给各 Agent。

**验收标准：**

- [ ] `syncSkills` 接受 libraryDir；library 有副本时写 library、不碰共享目录；
- [ ] 写入 library 副本仅限带 managed 标记的文件（不碰手工维护的 skill）；
- [ ] 内容变化时触发 `magpie library sync`（不变化不触发）；
- [ ] 缺省（木 hand-over、无 library 目录）时行为与 F3 完全一致；
- [ ] 测试：临时目录模拟 library，覆盖以上四路。

## 工程纪律

- 每阶段开分支实施（`dev/m1-core` → merge main → `dev/m2-tools` …），阶段开始前把本文件的对应勾选项视为该阶段的验收清单；
- 探测/解析逻辑与 IO 分离，纯函数全部经 `bun test`；
- magpie 侧验证一律用独立 `HOME` 沙箱，不碰常驻实例；
- 提交信息语义直白（"add probe loop" / "filter index by overrides"），不用营销式描述。
