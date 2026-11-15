# 仓库地址安装与插件市场分发

适用于 magpie 支持的 OpenCode/Bun 插件安装。无需编译、npm 发布或 install scripts：
根 package.json 指向已提交的 index.mjs，运行代码/页面/默认 registry 均随包分发。

## 1. 用户安装

在 magpie **插件 → 发现 → 添加插件**的地址输入处使用：

```text
github:radial-hks/magpie-team-catalog
```

CLI 等价命令：

```sh
magpie plugin add github:radial-hks/magpie-team-catalog
```

如 UI 没有相同按钮名称，以当前版本的“添加插件 / 仓库地址”入口为准。
完整 URL 使用显式 Git spec，避免被当成 npm 包名：

```sh
magpie plugin add git+https://github.com/radial-hks/magpie-team-catalog.git
# 分支或已存在的 tag / commit，可用 #ref 固定
magpie plugin add 'github:radial-hks/magpie-team-catalog#main'
```

安装完成后打开侧边栏 **团队目录**。在“插件设置”填写团队 registry、个人文件、
检查周期等，参考 [usage.md](usage.md)。默认 Skill 导出与提示词注入关闭。
插件名通常是包名 magpie-team-catalog；工具为 catalog / catalog_status，前缀由宿主生成。

### 仓库可见性与历史私有安装

当前仓库已由所有者改为 public，并设置 `magpie-plugin` topic；公开地址不需要
本仓库的私有读取凭据。下列说明适用于私有镜像或以后再次改为 private 时：

- 用户需要仓库读取权限，并配置 Bun/Git 安装过程实际支持的 GitHub 认证。
- 不把 token 写进插件 spec、README、registry 或命令日志。
- SSH 凭据、git credential helper 与 GitHub archive 下载的认证不是同一机制，
  `gh auth status` 成功也不能保证 Bun 的 GitHub shorthand 下载已授权。
- 无法直接安装时，先用团队的正常 Git 认证 clone，再 `magpie plugin add /local/path`；
  或由维护者提供可信 tgz（见下）。不要把 private 仓库误报为已公开市场可用。

## 2. 更新与固定版本

```sh
magpie plugin update
```

该命令会更新所有已安装插件，调用前确认其它插件也允许更新。
无 #ref 默认跟随仓库默认分支；main 为开发分发，团队可按已存在的 tag/commit 固定。
本次完善包版本为 0.2.0，不自动创建 tag / GitHub Release，不发布 npm。
不要把示例中的不存在 tag 当作可安装版本。

就地 folder 插件不会因远端 push 自动变更，需先 git pull 后重新加载宿主；
Git 安装副本通过 magpie 管理更新。两种安装不要并存，以免多个实例争用同一状态/端口。
用户个人注册文件位于插件目录之外，更新无需覆盖它；更新前仍建议备份。

## 3. “地址安装”与“市场自动发现”区别

根据 magpie 官方插件文档：

- **地址安装**：GitHub spec、Git URL、npm 包或本地目录均可作为安装输入。
- **公开 GitHub 非官方发现**：公开仓库添加 topic `magpie-plugin`，根目录保留
  package.json，运行入口必须提交。随后通常在“发现 → 非官方 GitHub 插件”出现；
  GitHub 查询有缓存/延迟，且不代表官方审核。
- magpie.name / summary 是作者自述，不能标为官方 reviewed / community。
- **社区推荐列表**：需要独立向社区 registry 提 PR/审核，不由仓库提交自动完成。
- npm 搜索安装需要实际发布 npm 包，单有 repository 字段或版本号不代表已发布。

### 维护者收录清单

- [x] 根 package.json：main/exports、repository/homepage/bugs、keywords。
- [x] magpie.name 与中英文 summary（满足单行/字节数要求）。
- [x] LICENSE：标准 MIT 文本。
- [x] 源码入口与页面随仓库和 npm files 分发，无构建/install script 依赖。
- [x] Git/#ref/npm/folder 身份解析保持稳定，更新不丢用户 options。
- [x] CI：Windows/Linux/macOS 测试与打包文件检查；公开分发提交的三个平台任务已成功。
- [x] 所有者已将仓库改为 public，GitHub API 与未认证 raw 文件访问已确认。
- [x] 设置 GitHub topic `magpie-plugin`；市场搜索结果仍需等待 GitHub 索引与 magpie 缓存刷新。
- [ ] 可选发布 tag、GitHub Release、npm 或社区推荐列表；需要单独授权与验收。

## 4. 离线 tgz / 发布前检查

维护者：

```sh
bun test
bun run check:package
npm pack --ignore-scripts
```

npm pack 创建 magpie-team-catalog-0.2.0.tgz，不发布网络服务。
check:package 使用 dry-run 校验入口、相对 imports、UI 脚本、registry、使用文档/许可证，
排除测试、CI、日志、状态、个人注册与备份。包包含 docs 便于离线查阅。

用户可按 magpie 支持的文件 spec 添加 tgz；未验证宿主版本先解压为目录再 folder 安装。
不要使用 `npm install -g` 把本插件当 CLI：它没有 bin，必须由 magpie 加载。
所有本机 P4/CLI 项目注册数据留在个人文件，不随 tgz 或 Git 仓库分发。

## 5. 新机器验收

1. 使用仓库地址安装，不依赖维护者原工作目录。
2. 确认插件加载，无 load errors，两个工具与团队目录 page 可见。
3. 打开 GUI 确认 ui-kit / catalog-app 等脚本均有，保存个人注册成功。
4. 核对插件设置保存/索引发布保留当前用户 options，不写无页面进程的临时端口。
5. 调 catalog_status，再按 type/limit 查询；默认不执行 CLI/P4 命令。
6. 更新安装副本后核对个人文件仍在，CLI 路径/项目 Client 按新机器实际情况重测。

## 6. 本次安装验证（2026-11-15）

- `check:package` 通过：实际 tgz 含 45 个文件、两种入口、全部页面脚本、文档与 LICENSE。
- 解压 tgz 到独立 HOME/XDG 配置环境，由 magpie 0.1.4254 安装加载成功：
  middleware、catalog/catalog_status、page 均识别，不依赖维护者源码目录。
- 从解压安装副本保存 options 与读取 catalog_status 成功，保留用户参数。
- GitHub/#ref/npm 安装身份在独立进程中核对 options 读取与命名通过。
- 未认证的 private GitHub shorthand 与 git+https 安装均返回 archive 404；
  隔离 SSH 未通过，Bun 1.3.9 本地 git+file 测试出现宿主自身崩溃，未认定为成功。
- 以上 404 为改公开之前的私有安装结果，不是当前公开地址结论。
- 公开后，独立 HOME/XDG 环境、移除 GitHub/npm token 环境变量，
  `magpie plugin add github:radial-hks/magpie-team-catalog` 已成功。
  分发提交 `75f5ce3` 推送后，`github:radial-hks/magpie-team-catalog#main` 匿名安装
  **0.2.0** 成功：页面、middleware、catalog/catalog_status 均加载；options 保存保留
  自定义键，带 #main 的身份识别正常。
- [GitHub Actions 43715234739](https://github.com/radial-hks/magpie-team-catalog/actions/runs/43715234739)
  已回读为 success，Windows/Linux/macOS 三个平台的测试及实际包文件检查通过。
- 匿名 GitHub topic 搜索已返回本仓库（1 条）。magpie 自身市场列表仍受刷新周期影响，
  topic 搜索成功不等于 GUI 卡片已即时出现，亦不代表官方审核。

官方参考：[Writing plugins](https://usemagpie.ai/docs/plugins)。
本项目版本和实际安装验收以仓库记录为准；private/公开发现/社区审核三者需分别确认。
