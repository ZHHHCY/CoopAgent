# CoopAgent

CoopAgent 是一个面向《星际争霸 II》合作模式的本地桌面工具。它读取玩家自己的游戏安装并建立合作模式数据库，让 Agent 可以用自然语言查询指挥官数据、修改数值，并生成可在编辑器中试玩的独立项目。

这是一个个人兴趣项目，目前的第一目标很明确：**稳定完成指挥官数值修改**。

## 当前可以做什么

- 查询指挥官、单位、升级、精通和面板技能的数据库信息。
- 修改生命、伤害、攻速、费用、冷却、生产时间、升级加成等已有数值字段。
- 修改已经接入的脚本参数，并区分展示数据、脚本输入和运行时输出。
- 为每个项目保存独立的对话、修改记录和地图运行层内容；新项目从原版合作模式配置开始。
- 构建本地试玩地图，通过《星际争霸 II》编辑器启动湮灭快车并验证效果。

当前版本不会让 Agent 任意编写或改写 Galaxy 函数。找不到可编辑字段或已支持参数时，它会说明具体缺口。

## 使用前准备

第一版以 Windows x64 源码方式提供，需要：

- 已安装《星际争霸 II》。
- Python 3.10 或更新的 **64 位**版本，安装时勾选加入 PATH；以及命令行可用的 Git for Windows。
- Microsoft Visual Studio 2022 或 2026 Build Tools，包含 **Desktop development with C++** 工作负载、MSVC、MSBuild、C++ CMake 工具和 Windows 10/11 SDK。
- 一个可用的模型 API 配置。
- 建议至少预留 20 GiB 磁盘空间，用于本地工具链、合作模式数据库和构建缓存。

## 快速开始

1. 克隆或下载本仓库。
2. 双击 `setup.cmd`。
3. 在文件夹选择窗口中选择《星际争霸 II》安装目录。
4. 等待脚本安装固定版本的 Node.js、pnpm、OpenCode 和 Rust，并从本机游戏数据构建合作模式数据库。
5. 双击 `start.cmd`。首次启动会构建桌面程序；之后直接打开已构建的应用，启动窗口会自动关闭。
6. 在桌面端配置模型，创建项目，然后用自然语言查询或修改数值。新项目默认保存在当前 CoopAgent 目录的 `projects/` 中。

环境准备结果保存在项目的 `.tools/` 和 `%LOCALAPPDATA%\CoopAgent\` 下，不会提交到 Git。选择的游戏目录保存在 `%APPDATA%\CoopAgent\sc2-installation.json`。

`setup.cmd` 在下载前检查上述系统组件；缺少时会列出安装说明。首次启动进入项目首页，选择“新建项目”或“打开已有项目”后开始使用。

日志保存在当前目录的 `.coopagent/logs/`：`setup-*.log` 记录安装输出、错误和退出码，`start-*.log` 记录启动器与桌面编译输出，`app-*.jsonl` 记录应用生命周期、项目管理、数据库检查与后台恢复错误。日志收集器不读取模型凭据文件。

界面错误提示提供操作建议，原始错误折叠在“查看技术详情”中。顶部和错误提示内均可点击“打开日志目录”。当前运行地图为湮灭快车，准备完成后按按钮旁的指引进入游戏。

数据库未就绪或查询失败时，可在环境设置或“全部改动”区域点击“重新检查”。检查会只读打开当前项目绑定的数据库，核对数据版本、基础查询表和合并数据目录。项目列表损坏时会保留 `projects.corrupt-*.json` 备份，并允许重新打开项目。

需要重新测试安装时，先关闭 CoopAgent、开发终端和星际争霸 II 编辑器，再运行 `reset.cmd`。默认只清除当前副本的工具链、依赖和构建缓存，保留项目、会话、修改、日志、共享数据库及模型凭据。

需要额外清理时显式选择范围（仍需输入 RESET 确认）：

```powershell
.\reset.cmd -DeleteProjects       # 同时删除当前 projects 下全部项目及其会话、修改
.\reset.cmd -ClearSharedData      # 同时清除各副本共用的数据库、CASC、WebView 缓存与游戏路径
.\reset.cmd --check               # 仅查看默认清理范围
```

两个清理选项可以组合；仓库外项目和模型凭据会保留。只有清除了共享游戏路径，下次 `setup.cmd` 才会重新显示目录选择窗口。

如果下载、解压或数据库准备中断，重新运行 `setup.cmd` 即可。脚本会续传已下载的归档、清理未完成的临时目录、复用完整的 CASC 提取结果，并只在数据库构建完整后替换正式结果；同一时间只允许一个环境准备进程运行。

命令行也可以显式指定游戏目录：

```powershell
.\setup.cmd -StarCraftRoot "D:\Games\StarCraft II"
```

## 开发

常用入口：

```bat
scripts\bootstrap.cmd
scripts\dev.cmd
scripts\build.cmd
```

日常检查：

```powershell
scripts\pnpm.cmd test:scalar
scripts\pnpm.cmd test:projects
scripts\pnpm.cmd test:setup
scripts\pnpm.cmd build
```

更新源码后，先关闭桌面程序，运行 `scripts\build.cmd` 重新构建，再使用 `start.cmd`。构建产物为仓库内的 `src-tauri/target/release/coopagent.exe`，依赖同一仓库中的脚本、工具和地图资源，请保留在原目录中。`scripts\dev.cmd` 专供开发热更新；日常启动不运行 Vite 开发服务。

本地数据库写入 `%LOCALAPPDATA%\CoopAgent\database\<SC2 build>`，包含 `coop.sqlite`、合并后的 GameData、manifest 和构建报告。数据库来自用户本机安装，不随仓库发布。

主要技术文档：

- [项目工作区](docs/project-workspaces.md)
- [合作模式数据库](docs/co-op-database.md)
- [PatchPlan v2](docs/patch-plan.md)
- [地图运行层运行契约](game-a/RUNTIME-CONTRACT.md)
- [Agent 命令行测试接口](docs/agent-test-interface.md)

## 当前状态

这是可运行的开发首版，还不是安装即用的发行包。数值修改、项目隔离、数据库构建和湮灭快车试玩链路已经建立；不同指挥官的复杂脚本机制仍需要逐步验证。代码测试通过、补丁成功应用和游戏内效果验证会分别记录，不互相代替。

CoopAgent 与 Blizzard Entertainment 无隶属或官方合作关系。仓库内的第三方游戏内容、来源和适用边界见[第三方内容声明](THIRD_PARTY_NOTICES.md)。

## 许可证

CoopAgent 的原创代码以 [MIT License](LICENSE) 发布。该许可证不适用于[第三方内容声明](THIRD_PARTY_NOTICES.md)中列出的 Blizzard 内容及其他第三方材料。
