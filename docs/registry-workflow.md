# registry 变更流程

版本：draft-1（2026-11-15）。本文面向 **registry 维护者**：加/改/删一个工具
或项目条目时，PR 怎么写、`check` 命令有什么纪律、`min` 怎么升级。字段规范
见 [registry-schema.md](registry-schema.md)。

## 一、仓库形态

registry 是一个共享 git 仓库，PR 审核准入：

```
registry.yaml            唯一声明源
docs/<id>.md             各条目的详细用法（按需引用）
```

各机器的插件经 `options.registry` 指向它，三种写法都支持：

| spec | 拉取方式 | 适用 |
| --- | --- | --- |
| `git@host:team/catalog.git[#ref]` | git clone/fetch（凭据走本机 git 配置） | 团队标准 |
| `https://host/team/catalog.git` | 同上（HTTPS） | 无 SSH 时 |
| `https://host/…/raw/main/registry.yaml` | 每轮 HTTP 下载（失败沿用上次缓存） | 只读镜像 / 单文件 |

插件更新与 registry 更新**解耦**：加一个工具只是 merge 一个 YAML PR，各机器
下一轮周期（默认 15 分钟）自动拉到，无需发版。

## 二、PR 模板

```markdown
### 变更
- [ ] 新增工具 / 修改工具 / 删除工具 / 新增项目 / 修改项目（勾选其一）
- 涉及条目 id：`deploy-cli`

### 新增/修改的工具（逐项填写）
- id / kind / install 命令（谁执行、在哪台机器验证过）
- check 规则：bin、version 参数、probe 命令（必须幂等只读，见下）
- min（如设置）：依据（哪个版本起有安全修复 / 破坏性变更）
- docs/<id>.md 已附 / 无需

### 自查
- [ ] `bunx ts` 之外：本机用 `magpie plugin add` 实测该条目探测结果符合预期
- [ ] probe 命令幂等、只读、≤5s、无网络副作用
- [ ] id 全局唯一（tools 与 projects 共用一个 id 空间）
- [ ] install 命令照抄官方安装文档，未夹带私货
```

## 三、check 命令纪律（PR 审核把关）

插件会在本机执行 `check` 里的命令，schema 层面已限制为**固定参数数组**
（禁止任意 shell 字符串），但数组里的内容仍然会被执行，所以靠作者纪律 +
PR 审核把关：

1. **probe 必须幂等只读**：重复执行无副作用（`whoami`、`status` 一类）；
   登录类、写配置类、发起网络请求的命令**禁止**；
2. **≤5s 返回**：超时按失败处理，会误报状态；
3. **version 参数尽量用 `--version`**：输出里可解析出 semver 即可；
4. **不弹交互**：任何需要 stdin 的参数都会卡住探测（有 5s 超时兜底，
   但会拖慢整轮刷新）。

## 四、min 升级流程

`min` 是**团队声明的最低可用版本**，低于它的安装会被索引与 catalog 工具
标注 `outdated`（附 `fix` 升级命令）。升级流程：

1. 确认依据：安全修复公告 / 破坏性变更 / 依赖方要求，写进 PR 描述；
2. `min` 一次性抬到目标版本（不做渐进），同时确认 `install` 命令装的
   就是 ≥ min 的版本；
3. merge 后各机器 15 分钟内自动生效：已装旧版的会在下一次 Agent 请求的
   索引里看到「需更新」，用 `catalog` 工具查到 fix 命令；
4. 提醒通道（IM/周报）同步一次，覆盖没开 Agent 的同事。

`min` 只影响**提示**，不阻塞任何调用——插件只读、不替用户升级。

## 五、回滚

- 条目回滚：revert PR 即可，各机器下一轮自动回到旧声明；
- 索引异常（某台机器注入了错误内容）：`magpie plugin options magpie-team-catalog '{"registry": "<旧spec>"}'` 单机切回，或
  `magpie plugin off magpie-team-catalog` 整体关闭（无残留）。
