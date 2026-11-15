# 本机 Git 项目与 P4 工作区

项目目录是开发上下文，不只是远端 URL。本阶段新增本机路径、Git 元数据和 P4 Client
信息，以及个人项目 GUI 管理、团队项目本机绑定。不会自动 clone/fetch/pull、sync、
创建 P4 Client 或提交代码。

## 配置

个人项目写入现有 `local-registry.yaml.projects`：

```yaml
version: 1
projects:
  - id: local-api
    name: API 开发仓库
    kind: git
    localPath: D:/workspace/api
    vcs: git@host:team/api.git
    note: 本机开发目录
  - id: local-game
    name: P4 游戏项目
    kind: p4
    localPath: D:/workspace/game
    p4:
      port: ssl:p4.example:1666
      user: developer
      client: developer-game
      stream: //game/main
      depotPath: //game/main/...
      view: ["//game/main/... //developer-game/..."]
      configFile: D:/workspace/game/.p4config
```

`kind` 为 git/p4/directory，旧 vcs/url 项目继续兼容；纯本机项目允许仅 localPath。
路径必须绝对路径。P4 不注册 password/tickets/trust 等凭据，未知 P4 字段拒绝。
Stream/Depot 需以 `//` 开头。View 仅记录映射，不执行或修改映射。
目录是否存在与服务器是否有权限是不同状态。

## 团队项目绑定

团队 registry 的 ID/地址不改，个人文件单独保存本机绑定：

```yaml
projectBindings:
  team-api:
    localPath: D:/workspace/api
  team-game:
    localPath: D:/workspace/game
    p4: {port: "p4.example:1666", user: developer, client: developer-game}
```

只允许 localPath/p4；不能用绑定覆盖团队名称或地址。绑定只能引用团队 projects ID，
不是 tools ID。团队项目后来移除时显示悬空绑定 warning；不会静默绑定到新项目。
本机信息仍保存于个人文件，不修改团队 registry。来源显示 team + bindingSource=local。

## GUI

- **新增本机项目**：手工填 Git/P4/普通目录；本机项目可编辑/删除。
- **发现 Git 目录**：显式输入扫描根目录。深度默认 2（最大 5）、默认最多 50 个
  （最大 100）、最多访问 1000 个目录、15 秒时间预算。
  不跟随目录符号链接；跳过 node_modules/Binaries/Intermediate/Saved 等目录。
  找到仓库后不递归仓库内容，子模块/嵌套仓库可另指定扫描根。
  支持 `.git` 文件形式的 worktree；不扫描 bare repository。
- **发现 P4 工作区**：明确 port/user，确认后运行固定只读 `p4 -ztag ... clients -u`
  查询。指定 Client 时，必须先在列表中找到它，才读取 `client -o` 的 View/Stream。
  最多 100 个，失败时提示检查连接/登录/权限，不自动登录、信任或创建工作区。
  候选可能属于其它主机，注册前确认根目录确实是本机目标。
- **P4CONFIG**：可提供明确的绝对文件路径，离线只提取 P4PORT/P4USER/P4CLIENT；
  不读取 P4PASSWD/P4TICKETS，不向上猜测配置文件，密码不会返回页面或写入注册。
- **绑定本机目录**：为现有团队项目添加本机路径/P4 Client，支持解除绑定。

发现只给候选，选择后编辑确认才保存；删除项目仅移除注册，不删除 Git/P4 目录或 Client。
页面会话校验、revision CAS 和个人文件原子保存沿用 CLI 注册机制。

## P4 工作区与 UE 项目分别注册

一个工作区可包含多个开发项目。工作区根可作为容器条目，具体项目另注册，
共享 port/user/client，项目 depotPath 使用已确认的项目范围，避免默认扩大到整个 depot。
同项目不同 Client 副本、同目录多个 `.uproject` 应分别保留唯一 ID，不能自动选择主项目。
具体项目文件/EngineAssociation 当前可写在 note，GUID 不等于引擎版本。

本机已按用户配置完成三个 Client 的 Root 校验、33 个 UE 文件映射核对并确认录入；
这些机器数据/批量导入脚本没有写进仓库。现有 GUI 发现接口提供 Git 仓库/P4 Client，
不将该一次性的 UE 文件扫描脚本冒充为已发布的 GUI 自动扫描能力。

## 状态与 Agent

周期刷新给 state 增加 projects；MCP `catalog` 搜索匹配本机路径、P4 port/client/stream/depot，
详情返回注册和本机检查结果。

- `unbound`：没有本机根目录；
- `missing`：本机目录不存在；
- `not-repository`：Git 目录不是可读工作树或 Git 不可用；
- `present`：本机路径存在，Git 时附 branch/head/gitDir/remotes。
- P4 present 附 `serverChecked:false`，不代表服务器已登录或 workspace 与 spec 一致。

Git 元数据只运行固定 rev-parse/symbolic-ref/config 命令，关闭 optional locks，
不运行 git status/fetch/pull；不读取完整 Git 配置/credential helper。URL 的内嵌凭据、
query/fragment 在发现、MCP、索引中脱敏。分支名不能证明工作树干净，未扫描未提交改动。
P4 每轮只检查目录，不进行网络查询，注册的 Client/Stream/View 是用户确认时的信息。
实际开发前需确认当前工作区/分支及操作权限，写操作仍须明确授权。
