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

1. `magpie.page`：目录表格（工具/项目两组），列：名称、状态、版本、min、探测时间；
2. Bun 模块起本地 HTTP service（`magpie.page.service`），页面经 `magpie.service` 读 `catalog-state.json` 内容；
3. 行内编辑覆盖 → `magpie.options.set` 写回；
4. 探测"立即重跑"按钮（触发一次全量刷新）。

**验收标准：**（2026-11-15：数据链路已在沙箱实测；GUI 渲染项待桌面窗口实机验证）

- [x] service 数据链路：`magpie serve` 沙箱里 GET /state 返回正确视图，
  POST /refresh 触发 worker 重探（删掉假 CLI 后 status 变 missing），CORS 头
  齐全（沙箱 iframe 的 opaque origin 可访问）；`magpie plugin` 列表显示
  `page Team catalog`；
- [ ] 页面在 magpie 窗口正常渲染（沙盒 iframe、无外部请求）——待实机；
- [ ] 编辑覆盖保存后，下一个请求的索引按新覆盖过滤——机制已验证
  （options.set 写 plugins.json → 宿主重载 → worker 重探测），页面端到端
  待实机；
- [ ] 页面抛错显示「此页面已停止工作」，重试可恢复——magpie 内核自带
  错误边界（框架行为），待实机。

**实现备注：**

- service 端口必须从 `options.servicePort` 读：magpie 在不服务页面的进程
  （如 plugin update）会把该 option 改写到空闲端口，避免与常驻实例撞端口；
  桌面模式下页面回退直连 `127.0.0.1:<servicePort>`，web 模式走 `magpie.service`
  反向代理；
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

## 工程纪律

- 每阶段开分支实施（`dev/m1-core` → merge main → `dev/m2-tools` …），阶段开始前把本文件的对应勾选项视为该阶段的验收清单；
- 探测/解析逻辑与 IO 分离，纯函数全部经 `bun test`；
- magpie 侧验证一律用独立 `HOME` 沙箱，不碰常驻实例；
- 提交信息语义直白（"add probe loop" / "filter index by overrides"），不用营销式描述。
