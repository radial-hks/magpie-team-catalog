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
  install: "npm i -g @team/deploy-cli"   # 必填。给人/Agent 看的安装命令（文本，不由插件执行）
  min: 1.4.0                # 可选。最低版本（semver），低于则标记 outdated
  usage: |                  # 可选。一段式用法摘要，进索引与工具返回
    deploy-cli release --app <name> [--canary]
  doc: docs/deploy-cli.md   # 可选。详细文档路径（registry 仓库内相对路径）
  check:                    # 可选。探测规则；不写则仅按 kind 默认方式探测
    bin: deploy-cli         # PATH 中的可执行名（用户可用 overrides.bin 覆盖为绝对路径）
    version: ["--version"]  # 可选。参数数组，输出中解析首个 semver
    probe: ["whoami"]       # 可选。幂等只读命令，退出 0 → configured
  platform:                 # 可选。按平台差异声明，缺省全平台
    darwin: { install: "brew install team/tap/deploy-cli" }
    windows: { bin: "deploy-cli.exe" }
```

字段纪律：

- `check` 中所有命令字段是**固定的参数数组**，schema 层面禁止任意 shell 字符串（防注入）；
- `probe` 必须幂等、只读、≤5s、不弹网络副作用（登录类命令禁止）；这是 registry 作者纪律，PR 审核把关；
- `kind` 决定探测方式优先级：npm → `npm ls -g`；pipx → `pipx list --json`；pip → 包名导入检查；brew → `brew list --versions`；binary → PATH / `where` 查找。任一途径命中即 `present`；
- `install` 永远只是文本，插件不得解析或执行它。

## projects 条目

```yaml
- id: billing                      # 必填。全局唯一（与 tools 共用一个 id 空间）
  name: 计费服务                   # 可选
  vcs: git@github.com:team/billing.git   # 必填其一：vcs 或 url
  url: https://wiki.internal/billing     # 可选。文档/面板地址
  note: 主仓库，P4 镜像见 legacy-sync    # 可选。一行备注
```

`vcs` 支持任意 git URL 与 `perforce://host:port//depot/path` 两种写法；索引注入时按前缀缩写（`github:team/billing`、`p4://depot/legacy-sync`）。

## 用户覆盖（plugins.json 的 options.overrides）

覆盖不修改 registry，只在本机生效：

```jsonc
{
  "deploy-cli": { "bin": "D:\\tools\\deploy.exe" },  // 探测路径覆盖
  "perf-diag":  { "enabled": false },                 // 本机禁用：索引、工具均不出现
  "legacy-cli": { "status": "present" }               // 钉死状态，跳过探测
}
```

解析优先级：覆盖 > registry 声明 > 自动探测。覆盖层的 `bin` / `enabled` / `status` 三个键是保留键，其余键忽略并记 warning 日志。

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
