# 阶段交付：Git/P4 项目目录与 MCP 核心功能

日期：2026-11-15。接续基础提交 `fce44ab`，本阶段完成项目版本管理上下文和
Agent 查询接口。本机核心目标已完成；本阶段为源码推送，不是 npm 发布。

## 已交付

### 项目目录

- 本机 Git/P4/普通目录项目的 GUI 新增、编辑、删除。
- Git 显式目录发现：深度/数量/时间上限，兼容 `.git` 文件和 worktree；
  读取根目录、分支、HEAD、remote，不 fetch/pull，不判定工作树干净。
- P4 授权只读发现：指定 server/user，查询已有 Client；明确 Client 后读取
  Root/Stream/View。离线 P4CONFIG 仅提取 port/user/client，不读取密码或票据。
- 团队项目的本机绑定：个人文件 projectBindings 保存路径/Client，不修改团队地址或 ID。
- 周期检查 projects 本机状态，P4 不访问服务器；MCP 返回项目路径、工作区和 Depot 信息。
- GUI 沙箱使用 DOM 确认弹窗/复选框，不依赖被禁止的原生 modal 确认。

### MCP

- 保留 catalog 入口，新增 catalog_status 概览。
- 简略分页默认合计 20 条，按 ID 排序；支持类型、来源、kind、状态、Client、port、路径筛选。
- 精确详情与字符分段文档；本地文档限来源目录内、限大小，拒绝路径/符号链接越界。
- 默认不执行 CLI；显式 detail + check=true 才运行声明的 probe，跳过旧快照等不适用情况。
- 快照新鲜度和注册身份 fingerprint；路径/check/package/P4 元数据变化后旧实测失效。
- MCP 只读远端 registry 缓存，不下载/fetch/reset；来源哈希与 clone origin/ref 检查，
  防止旧源缓存冒充新源；旧快照查询的后台刷新触发有限流。
- 结构化业务错误、用户钉死来源与项目安全提示；MCP 不开放注册写入或 P4 网络发现。

## 验收结果

- Bun 1.3.9、1.4.2、1.4.4：各 129 项测试通过；三轮测试未改本机插件选项/个人注册。
  覆盖 CLI、个人目录、Git/P4 项目、
  GUI 会话、MCP 分页/筛选/显式检查/快照与缓存边界。
- 真实浏览器和 opaque-origin iframe：项目新增/编辑/删除、团队绑定/解除绑定、
  P4 网络授权前置校验通过；原生 magpie GUI 的项目管理入口可见。
- 本机明确扫描根发现 11 个 Git 仓库，没有自动注册或访问远端。
- 用户指定的 3 个 P4 Client：服务器 Root 与本机配置一致；有界扫描找到
  33 个 UE 项目文件，分布于 32 个目录，全部通过只读 p4 where 映射验证。
- 经用户确认后，3 个工作区 + 33 个项目分别注册到本机个人文件；同目录多个
  .uproject/不同 Client 副本分别保留。本机 36 条均 present；不意味着已全量同步。
- 真实 MCP：7 个 CLI、38 个项目（含 2 个团队地址）概览、Client 精确筛选、分页和详情通过。
- P4 配置、项目路径、个人目录、导入备份、临时脚本/日志仅在本机，不提交到共享仓库。

## 兼容性与使用变化

- CLI/P4 目录管理保存结构仍为 version:1；旧 vcs/url 项目兼容。
- MCP 列表由全量变为分页，默认详情不再隐式执行 probe；调用方应按 nextOffset
  续读，主动检查需 check=true。详情文档默认最多 8000 字符。
- MCP transport、工具前缀、分发/可见性仍由 magpie 管理；安装插件不等于所有 Agent 自动可见。
- 首次升级旧 GUI 文档可能需要重新打开页面；新页面检测宿主会话变化并保留未保存输入。

## 后续边界（不阻塞本机核心功能）

- 团队 npm 发布、共享 registry/Skill 治理、双机同步、Linux/macOS 实机与 CI 覆盖。
- Skill/library hand-over/sync 的工作机验收；Skill 导出和提示词注入继续默认关闭。
- 项目文件/引擎元数据当前通过项目说明保存，本机批量导入流程未作为 GUI 扫描接口发布。
- Git/P4 发现不自动登录、clone、创建工作区、sync、revert 或 submit；写操作需明确授权。
- MCP cursor 快照分页、远程文档缓存、全文搜索、宿主支持的 annotations/outputSchema。
- 文件写锁异常退出恢复与大型目录性能优化；外部编辑个人文件不应与页面并发保存。

使用说明：[usage.md](usage.md)；项目字段：[local-projects.md](local-projects.md)；
Agent 接口：[mcp-design.md](mcp-design.md)。历史基础验收见 [milestone-local-catalog.md](milestone-local-catalog.md)。
