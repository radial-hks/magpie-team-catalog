# 插件 MCP contract（2026-11-15 改进）

复用 magpie `/mcp/magpie/tools`，不自建 MCP server。工具最终名称由宿主前缀拼接，
本机通常为 `magpie-team-catalog_catalog` / `magpie-team-catalog_catalog_status`。
是否分发给 Agent 由 magpie 插件“交给智能体”/MCP 路由控制；安装成功不等于每个 Agent 已可见。

## 发现 → 详情 → 显式检查

1. `catalog_status({})`：轻量概览，工具/项目数量、状态分布、快照新鲜度、能力边界。
2. `catalog({...筛选, limit, offset})`：默认合计 20 条、按 ID 稳定排序，工具和项目
   分组返回，pagination.total/returned/nextOffset 指导续页。
3. `catalog({detail:"精确ID"})`：全文条目、命令路径、项目根/P4 Client/Depot、分段文档。
4. `catalog({detail:"CLI-ID",check:true})`：显式执行声明的 probe；最多 5 秒，
   跳过禁用/钉死/未安装/旧快照/无 probe。不写回周期快照。

```js
catalog_status({})
catalog({type:"tool",query:"构建",limit:10})
catalog({type:"project",kind:"p4",client:"明确的Client",port:"server:1666",limit:20})
catalog({type:"project",path:"D:/workspace/project"})
catalog({type:"project",source:"local",offset:20,limit:20})
catalog({detail:"project-id"})
catalog({detail:"tool-id",docOffset:8000,docLimit:8000})
```

输入 schema 与 runtime validation 来自 `lib/mcp-contract.mjs`；未知参数、类型/范围错误、
详情混用筛选/分页报 INVALID_ARGUMENT。limit 1..100，docLimit 1..20000。
详情和查询互斥，check/docOffset/docLimit 只能用于 detail。旧 query/detail 参数保留，
但 **旧隐式 probe 改为 check=true**，全量列表改为分页，文档全文改为字符分段。
调用方应按 pagination.nextOffset / documentation.nextOffset 续读。

## 列表与输出

- 列表默认 summary=true：工具 usage/install/fix 各最多 240 字符，项目 note 最多 240；
  不返回 P4 View/Git remotes/文档全文。summary=false 可展开，仍受条目数量上限约束。
- entryType 明确 tool/project，kind 与 source 明确安装/版本管理渠道和团队/个人来源。
- CLI 状态仍 unknown/missing/present/outdated/configured/disabled。
  默认搜索隐藏禁用项，status=disabled 可用于排障，精确 detail 始终可查询。
- 用户钉死状态标明 pinned/stateOrigin=user-pinned，不带旧路径/版本伪装为实测。
- 项目 local.status 区分 unbound/missing/not-repository/present/unknown。
  详情 safety 明确 serverVerified=false、worktreeCleanVerified=false、writesAuthorized=false。
  目录存在不证明 P4 登录或有权限，Git branch/HEAD 不证明工作树干净。
- 错误保留 error 文本，并附 code：INVALID_ARGUMENT / REGISTRY_UNAVAILABLE / NOT_FOUND。
  业务错误是返回 JSON；MCP transport error / isError 的包装由 magpie 宿主负责。

## 快照与 IO 边界

MCP 默认只读缓存：本地声明直接读取；HTTP/Git registry 只读现有缓存，不 download/fetch/reset。
远端缓存记录来源 spec 哈希（不额外落盘 URL 内凭据）；切换数据源时检查来源与 clone origin/ref，
不能把旧源缓存误作为新源。缺缓存提示并触发后台 worker，宿主内重复触发限流。
远端文档不会隐式下载，registry 可内联 documentation；本地 doc 必须位于来源目录内，
限制 1MB，拒绝绝对路径/父目录/符号链接越界。

meta.checkedAt/ageMs/stale/reason 描述周期快照。超过 interval、无快照或当前注册身份变化
提示 stale，并仅触发后台刷新，不等待探测。Worker 为工具/项目记录 fingerprint：
package/check/path/P4 元数据变化后旧实测失效，描述/name/doc 更新不影响安装状态。
旧版无 fingerprint 快照作为 legacy 使用，下一轮自动升级；详情显示 stateOrigin。

明确 check=true 只允许已声明 CLI probe；不提供任意 shell、Git/P4 写操作、安装、注册、
删除、Client 创建/登录或 P4 服务器查询。GUI 仍是用户确认注册与服务器发现的入口。
建议 Agent 先查目录再使用专门 CLI，具体写操作需任务授权，不因 catalog 返回 present 获得授权。

## 验收

- `test/mcp.test.mjs` 覆盖参数校验、分页无重复、筛选、文档分段、默认零 probe、
  显式检查、快照过期/身份变更、用户钉死、远端缓存只读与源切换。
- 本机 CLI + 38 项目目录验证概览/分页/精确 Client 与项目详情，不触发 P4 网络查询。
- 全套测试覆盖原有 CLI、个人注册、Git/P4 项目和 GUI，真实调用通过 magpie tool 验收。

## 后续边界

- 远程文档内容缓存/全文搜索、cursor 稳定快照分页、MCP annotations/outputSchema
  需按宿主支持能力继续扩展，当前不假定宿主支持资源或自定义协议元数据。
- check=true 依赖 registry 作者保证 probe 幂等只读；它不是执行任意工具的安全沙箱。
- 不持久保存 P4 网络连接验证为“已配置”，项目选择仍需确认 Client/本地根/Depot。
