# registry.yaml 字段规范

版本：draft-1。registry 是团队声明的唯一真源，YAML 格式，PR 审核准入。本文件是字段级的规范，供 registry 作者与插件实现共同遵循。

## 顶层结构

```yaml
version: 1            # schema 版本，整数；插件按此解析
tools:                # CLI 工具条目列表
  - …
projects:             # 项目地址条目列表
  - …
```

## tools 条目

```yaml
- id: deploy-cli            # 必填。全局唯一，小写字母数字与 -，≤48 字符（与 magpie 工具名约束兼容）
  name: 部署 CLI            # 可选。显示名，缺省用 id
  kind: npm                 # 必填。npm | pipx | pip | brew | binary
  package: "@team/deploy-cli" # 可选。包清单精确匹配名称，可与 check.bin 不同
  install: "npm i -g @team/deploy-cli"   # 必填。给人/Agent 看的安装命令（文本，不由插件执行）
  min: 1.4.0                # 可选。最低版本（semver），低于则标记 outdated
  usage: |                  # 可选。一段式用法摘要，进索引与工具返回
    deploy-cli release --app <name> [--canary]
  doc: docs/deploy-cli.md   # 可选。详细文档路径（相对该条目来源目录）
  documentation: "用法全文" # 可选。内联详细文档，优先于 doc
  check:                    # 可选。探测规则；不写则仅按 kind 默认方式探测
    bin: deploy-cli         # PATH 中的可执行名（用户可用 overrides.bin 覆盖为绝对路径）
    version: ["--version"]  # 可选。参数数组，输出中解析首个 semver
    timeoutMs: 5000         # 可选。本条目的探测超时（毫秒，正整数），缺省继承全局
    probe: ["whoami"]       # 可选。幂等只读命令，退出 0 → configured
  platform:                 # 可选。按平台差异声明，缺省全平台
    darwin: { install: "brew install team/tap/deploy-cli" }
    windows: { bin: "deploy-cli.exe" }
```

字段纪律：

- `check` 中所有命令字段是**固定的参数数组**，schema 层面禁止任意 shell 字符串（防注入）；
- Windows 按当前 `PATH` / `PATHEXT` 查找 `.exe/.com/.cmd/.bat`，不选择 npm
  同名的 POSIX 无扩展名启动器。`.cmd/.bat` 经 `cmd.exe /d /s /v:off /c`
  执行，支持带空格的路径与参数；为防 shell 注入，批处理路径/参数含
  `" % ! ^ & | < >`、换行或 NUL 时拒绝执行（返回失败，不中断整轮探测）。
  需要这些字面字符时请用原生可执行文件；原生程序仍直接接收参数数组；
- `probe` 必须幂等、只读、≤5s、不弹网络副作用（登录类命令禁止）；这是 registry 作者纪律，PR 审核把关；
- `timeoutMs` 建议每条都显式写明（快条目与全局同值也行），让探测预算在
  registry 里可见；确实慢的条目（冷启动、输出多）再单独放宽，上限建议
  15000——探测是并发跑的，一个条目拖太久会拖慢整轮刷新；
- `package` 指定时精确匹配包清单；省略仍兼容 bin 或 scope/bin 名称匹配。
  清单命中后仍解析可执行路径，供 state / MCP / Skill 使用；
- `kind` 决定探测方式优先级：npm → `npm ls -g`；pipx → `pipx list --json`；pip → 包名导入检查；brew → `brew list --versions`；binary → PATH / `where` 查找。任一途径命中即 `present`；
- Perforce `p4 -V` 输出的 `Rev. P4/<平台>/<年.次版本>/<构建号>` 优先解析为
  `年.次版本.构建号`（例如 `2017.2.1579154`），不会把 OpenSSL 依赖版本当作 p4 版本；
- `install` 永远只是文本，插件不得解析或执行它；
- `skill: <id>`（可选）：skill 仓库里的 skill id（缺省用工具 id）。skill 仓库
  （`options.skillsRepo`）布局 `skills/<id>/SKILL.md`，与 CLI 一起发版；只有
  `skillExport: true` 且源仓库里有对应文件时才落盘（F3，见 registry-workflow.md）。

## projects 条目

```yaml
- id: billing                      # 必填。全局唯一（与 tools 共用一个 id 空间）
  name: 计费服务                   # 可选
  vcs: git@github.com:team/billing.git   # 必填其一：vcs 或 url
  url: https://wiki.internal/billing     # 可选。文档/面板地址
  note: 主仓库，P4 镜像见 legacy-sync    # 可选。一行备注
```

`vcs` 支持任意 git URL 与 `perforce://host:port//depot/path` 两种写法；索引注入时按前缀缩写（`github:team/billing`、`p4://depot/legacy-sync`）。

## 个人注册层

除团队 registry 外，默认合并插件状态目录的 `local-registry.yaml`，也支持
`options.localRegistry` 本地路径或 false 关闭。格式与团队 registry 相同，
页面可扫描 npm 候选、增删改个人 CLI。来源标记 source 为运行时元数据，不应手写。
团队/个人 ID 冲突拒绝静默覆盖；完整流程见 [personal-registry.md](personal-registry.md)。

## 用户覆盖（plugins.json 的 options.overrides）

覆盖不修改 registry，只在本机生效：

```jsonc
{
  "deploy-cli": { "bin": "D:\\tools\\deploy.exe" },  // 探测路径覆盖
  "perf-diag":  { "enabled": false },                 // 本机禁用：索引、工具均不出现
  "legacy-cli": { "status": "present" }               // 钉死状态，跳过探测
}
```

解析顺序：团队 + 个人 registry 合并 → 平台声明 → 本机覆盖 → 自动探测。覆盖层的 `bin` / `enabled` / `status` 三个键是保留键，其余键忽略并记 warning 日志。

## state 文件（插件生成，非人写）

`catalog-state.json`（magpie 配置目录下插件自己的目录）：

```jsonc
{
  "checkedAt": 1763145600000,
  "tools": {
    "deploy-cli": { "status": "outdated", "version": "1.2.0", "via": "npm", "at": 1763145600000 }
  }
}
```

状态枚举：`unknown | missing | present | outdated | configured | disabled`，语义见 [design.md](design.md#51-状态模型)。
