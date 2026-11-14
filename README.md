# magpie-team-catalog

一个 magpie 插件：把团队内部的公共资源——自研 / 公共服务提供的 CLI 工具、GitHub / P4 等项目地址——集中注册在一处，然后：

1. **让每个 Agent 天然知道**本机实际可用的工具（经网关中间件注入索引）；
2. **让每个 Agent 能查详情**（经 `/mcp/magpie/tools` 的 `catalog` 工具：用法、版本、安装方式、项目地址）;
3. **让人能看能配**（窗口页面：浏览目录、按本机覆盖路径 / 禁用条目）。

团队声明（应该有什么）与本机实测态（这台机器上真有什么）彻底分离；插件只读、fail-open、可随时关闭无残留。

> 状态：**M1–M3 已实现，M4 完成代码侧**（http/git registry 拉取 + 变更流程文档）；剩余为团队决策项（内部 npm 发布、双机验证）与 GUI 三项实机确认，见 [docs/plan.md](docs/plan.md)。

## registry 数据源

`options.registry` 支持三种形态（详见 [registry-workflow.md](docs/registry-workflow.md)）：

- 本地路径 / `file://`（单机试运行）；
- `http(s)://…/registry.yaml`：每轮下载，失败沿用缓存；
- git 仓库（`git@…` / `git+https://…` / `https://….git`，可带 `#ref`）：
  首次 clone、之后 fetch+reset，凭据走本机 git 配置，刷新失败沿用缓存。

## 结构

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | 插件入口（Bun 宿主内）：加载时与按周期 spawn detached worker；提供 `catalog` 工具 |
| `worker.mjs` | 一轮探测+发布的独立进程：读 registry → 探测 → 写 state → 索引发布到 options |
| `catalog.middleware.js` | 网关中间件（moejs）：把 options.index 注入每个请求的 system prompt |
| `lib/yaml.mjs` | registry.yaml 的最小 YAML 子集解析器（纯函数） |
| `lib/core.mjs` | registry 校验、平台/用户覆盖合并、状态判定、索引构建（纯函数） |
| `lib/probe.mjs` | 本机探测：npm/pipx/brew 清单 + PATH/绝对路径，5s 超时并发≤8 |
| `lib/inject.mjs` | 各协议 system 注入（anthropic/chat/responses/gemini，纯函数） |
| `lib/cycle.mjs` | 一轮刷新的编排：跨进程锁、state 原子写、经 magpie CLI 发布索引 |
| `lib/tool.mjs` | `catalog` 工具：搜索（id/名称/用法）与详情（docs 全文 + 按需 probe） |
| `lib/service.mjs` | 窗口页的本地 service（127.0.0.1，端口读 options.servicePort）+ 页面视图纯函数 |
| `page/` | 窗口页：目录表格、行内覆盖编辑（magpie.options.set 写回）、立即重跑 |
| `test/` | bun test（纯函数全覆盖 + 假 CLI 探测/工具/service 实测，共 57 项） |

测试：`bun test`；沙箱验收步骤见 plan.md M1 的验收标准。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/design.md](docs/design.md) | 详细设计：架构、配置分层、探测状态机、Agent 暴露方式、安全边界 |
| [docs/plan.md](docs/plan.md) | 分阶段实施计划与各阶段验收标准 |
| [docs/registry-schema.md](docs/registry-schema.md) | `registry.yaml` 的字段规范 |
| [docs/registry-workflow.md](docs/registry-workflow.md) | registry 变更流程：PR 模板、check 命令纪律、min 升级流程、数据源形态 |
| [registry/registry.example.yaml](registry/registry.example.yaml) | 示例注册表 |

## 要解决的问题

- 团队除 npm / python 等标准公共命令外，还有自研 CLI，安装途径各异（npm scope、pipx、brew tap、手动二进制）；
- 各成员机器上是否装了、装在哪、版本是否达标，无法断定，只能逐机探测；
- GitHub / P4 项目地址等汇总信息散落在各处，Agent 无从得知。

设计参照 npm / pip 的集中注册机制；CLI 的**分发安装**不归本插件管（继续走 npm scope / brew tap / mise），插件只做**发现与感知**。
