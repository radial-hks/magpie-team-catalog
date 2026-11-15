# 个人 CLI 注册与 npm 候选扫描

团队 registry 说明“团队有哪些工具”；个人注册层允许用户补充自己的内部 CLI，
不修改团队仓库，也不依赖插件发版。npm 只负责安装/更新，catalog 只负责发现与说明。

## 三层配置

```text
团队 registry（options.registry，本地/HTTP/Git）
    + 个人 registry（local-registry.yaml）
    → 本机 overrides（路径/禁用/钉死）
    → 探测 → MCP catalog / 页面 / 可选 Skill
```

- 默认个人文件：`~/.config/magpie/team-catalog/local-registry.yaml`（尊重 XDG_CONFIG_HOME）。
- 指定 `statePath` 时，默认个人文件位于 state 同目录，方便沙箱隔离。
- `options.localRegistry` 可设为插件目录之外的本地绝对路径或 file URL；
  `false` 关闭个人注册层。文件不存在时视为空目录，不自动创建。
- 个人与团队 tools/projects 共用 ID 命名空间。新增与团队同 ID 的条目被拒绝；
  团队后来出现冲突时，团队优先、个人冲突条目跳过并显示 warning，不改个人文件。
- 保存使用 revision 校验、跨进程写锁和原子替换，过期窗口必须重新加载。
  外部直接编辑文件时也应避免与页面同时保存。
- 任何一层损坏仍可查询另一层并显示诊断；不完整目录不会发布新索引或清理 Skill。
  损坏文件不会被页面覆盖；需手动修复后重载。

## 页面使用

打开插件页面或本机 `http://127.0.0.1:3969/`：

1. **新增个人 CLI**：填 ID、名称、安装渠道、包名、命令名、版本参数、用法、文档。
2. **扫描 npm CLI**：只读取 `npm ls -g --depth=0 --json`、`npm root -g` 和
   每个包的 `package.json.bin`；只有声明命令的包成为候选，不执行候选 CLI。
3. **选择注册**：候选预填包名/命令名，用户补充安装维护说明，确认后才保存并探测。
4. **编辑注册 / 删除注册**：仅作用于个人条目，删除注册不卸载 npm 包。
5. **本机覆盖**：个人条目同样可覆盖路径、禁用或钉死状态；保存覆盖会重载宿主。

版本参数必须是固定 JSON 字符串数组，例如 `["--version"]` 或 `[]`。
周期探测不得填写构建、登录、写文件或网络副作用命令。安装说明只是文本，不执行。
默认不为候选填写 `probe`；个人文件若手工声明 probe，必须幂等只读且无交互。

界面保存规范 JSON（YAML 子集），也支持手工维护 YAML；已有字段如 platform/check.probe
会保留。详细文档可写在 `documentation` 内，或用 `doc` 相对个人文件目录引用 Markdown。
页面增删改面向 CLI；个人项目地址也可在文件的 projects 中维护。

## ueb 示例

本机 ueb 从源码经 npm global prefix 安装，包名 `ueb`，命令也是 `ueb`：

```yaml
version: 1
tools:
  - id: ueb
    name: Unreal Engine Build CLI
    kind: npm
    package: ueb
    install: "在 ueb 源码仓库运行 npm run install:local 安装或更新全局命令"
    usage: |
      ueb inspect / doctor：查看项目与构建环境
      ueb build / plugin / package：编译、构建插件和打包
      操作前用 -n 预览；自动化使用 --json
    check:
      bin: ueb
      version: ["--version"]
      timeoutMs: 5000
projects: []
```

对于包名与命令名不同的工具，可声明 `package: "@team/ue-build"`、`check.bin: ueb`。
package 精确匹配包清单，旧条目不写 package 则保持旧的 bin/包名匹配方式。
包清单命中后仍解析本机可执行绝对路径，路径写入 state、MCP 返回和 Skill 实测块。
npm 包存在不等于环境配置完成，仍只标记 present；probe 通过才可能 configured。

## Skill

个人 CLI 合并后进入同一套 Skill 同步流程：需开启 skillExport，配置 skillsRepo，
并在源仓库提供 `skills/<id>/SKILL.md`（或用 skill 字段指定 ID）。
仅注册 CLI 不会自动生成 Skill、复制 npm 包内 SKILL.md 或自动分发到所有 Agent。

## GUI 加载排障

主页面将个人编辑器脚本随 HTML 内联提供，避免 WebView/sandbox 外部脚本加载差异。
初始化失败时显示错误原因，不无限停在“加载中”。若更新后 GUI 仍保留旧页面，
关闭 magpie 窗口（后台网关可保持运行），重新打开并点击侧边栏 **团队目录**。
只切换侧边栏或重载插件宿主不一定会重新创建已保留的 iframe。
普通浏览器可用并不等于 GUI 已验收；需要在原生窗口核对按钮与编辑弹窗。

## 本地服务接口

- `GET /state`：合并目录、source（team/local）、状态、版本、路径及 warnings。
- `GET /local-registry`：个人 registry、path、revision。
- `POST /local-registry`：`{registry, revision}`，保存后触发后台探测。
- `GET /npm-candidates`：只读候选列表。

个人读取、npm 扫描及所有 POST 要求本页面的 `x-catalog-token`。
页面每 5 秒检查公开的 service 实例 ID，发现宿主重载或明确的 SESSION_EXPIRED
时，空闲页面自动重新加载；有未保存覆盖或注册表单则保留输入并显示重新加载按钮。
不会获取新令牌或自动重放保存/删除操作。旧版本 GUI 页面首次升级需重新打开页面。
仅监听 loopback，并校验 Host 防 DNS rebinding。MCP catalog 仍只查询，不提供注册写接口。
这是本机页面边界，不是针对同权限本机恶意进程的沙箱。

## 关闭与保留

`localRegistry: false` 仅关闭合并，不删除个人文件；重新开启即可恢复。
卸载插件或删除个人条目不卸载 CLI。备份个人文件即可保留自定义注册。
