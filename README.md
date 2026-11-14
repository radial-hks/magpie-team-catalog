# magpie-team-catalog

一个 magpie 插件：把团队内部的公共资源——自研 / 公共服务提供的 CLI 工具、GitHub / P4 等项目地址——集中注册在一处，然后：

1. **让每个 Agent 天然知道**本机实际可用的工具（经网关中间件注入索引）；
2. **让每个 Agent 能查详情**（经 `/mcp/magpie/tools` 的 `catalog` 工具：用法、版本、安装方式、项目地址）;
3. **让人能看能配**（窗口页面：浏览目录、按本机覆盖路径 / 禁用条目）。

团队声明（应该有什么）与本机实测态（这台机器上真有什么）彻底分离；插件只读、fail-open、可随时关闭无残留。

> 状态：**设计阶段**。当前仓库只有设计文档与实施计划，代码尚未开始。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/design.md](docs/design.md) | 详细设计：架构、配置分层、探测状态机、Agent 暴露方式、安全边界 |
| [docs/plan.md](docs/plan.md) | 分阶段实施计划与各阶段验收标准 |
| [docs/registry-schema.md](docs/registry-schema.md) | `registry.yaml` 的字段规范 |
| [registry/registry.example.yaml](registry/registry.example.yaml) | 示例注册表 |

## 要解决的问题

- 团队除 npm / python 等标准公共命令外，还有自研 CLI，安装途径各异（npm scope、pipx、brew tap、手动二进制）；
- 各成员机器上是否装了、装在哪、版本是否达标，无法断定，只能逐机探测；
- GitHub / P4 项目地址等汇总信息散落在各处，Agent 无从得知。

设计参照 npm / pip 的集中注册机制；CLI 的**分发安装**不归本插件管（继续走 npm scope / brew tap / mise），插件只做**发现与感知**。
