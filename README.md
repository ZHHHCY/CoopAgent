# CoopAgent

CoopAgent 是一个面向《星际争霸 II》合作模式的本地桌面工具。它读取玩家自己的游戏安装并建立合作模式数据库，让 Agent 可以用自然语言查询指挥官数据、修改数值，并生成可在编辑器中试玩的独立项目。

这是一个个人兴趣项目，目前的第一目标很明确：**稳定完成指挥官数值修改**。

## 当前可以做什么

- 查询指挥官、单位、升级、精通和面板技能的数据库信息。
- 修改生命、伤害、攻速、费用、冷却、生产时间、升级加成等已有数值字段。
- 修改已经接入的脚本参数，并区分展示数据、脚本输入和运行时输出。
- 为每个项目保存独立的对话、修改记录和 Game A 内容；新项目从原版合作模式配置开始。
- 构建本地试玩地图，通过《星际争霸 II》编辑器启动湮灭快车并验证效果。

当前版本不会让 Agent 任意编写或改写 Galaxy 函数。找不到可编辑字段或已支持参数时，它会说明具体缺口。详细范围见 [Scalar 产品范围与维护基线](docs/scalar-only.md)。

## 使用前准备

第一版以 Windows x64 源码方式提供，需要：

- 已安装《星际争霸 II》。
- Microsoft Visual Studio 2022 或 2026 Build Tools，包含 **Desktop development with C++** 工作负载和 Windows 10/11 SDK。
- 一个可用的模型 API 配置。
- 建议至少预留 20 GiB 磁盘空间，用于本地工具链、合作模式数据库和构建缓存。

## 快速开始

1. 克隆或下载本仓库。
2. 双击 `准备CoopAgent环境.cmd`。
3. 在文件夹选择窗口中选择《星际争霸 II》安装目录。
4. 等待脚本安装固定版本的 Node.js、pnpm、OpenCode 和 Rust，并从本机游戏数据构建合作模式数据库。
5. 双击 `启动CoopAgent.cmd`。
6. 在桌面端配置模型，创建项目，然后用自然语言查询或修改数值。

环境准备结果保存在项目的 `.tools/` 和 `%LOCALAPPDATA%\CoopAgent\` 下，不会提交到 Git。选择的游戏目录保存在 `%APPDATA%\CoopAgent\sc2-installation.json`。

命令行也可以显式指定游戏目录：

```powershell
.\准备CoopAgent环境.cmd -StarCraftRoot "D:\Games\StarCraft II"
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
scripts\pnpm.cmd build
```

本地数据库写入 `%LOCALAPPDATA%\CoopAgent\database\<SC2 build>`，包含 `coop.sqlite`、合并后的 GameData、manifest 和构建报告。数据库来自用户本机安装，不随仓库发布。

主要技术文档：

- [Scalar 能力范围](docs/scalar-only.md)
- [项目工作区](docs/project-workspaces.md)
- [合作模式数据库](docs/co-op-database.md)
- [PatchPlan v2](docs/patch-plan.md)
- [Game A 运行契约](game-a/RUNTIME-CONTRACT.md)
- [Agent 命令行测试接口](docs/agent-test-interface.md)

## 当前状态

这是可运行的开发首版，还不是安装即用的发行包。数值修改、项目隔离、数据库构建和湮灭快车试玩链路已经建立；不同指挥官的复杂脚本机制仍需要逐步验证。代码测试通过、补丁成功应用和游戏内效果验证会分别记录，不互相代替。

CoopAgent 与 Blizzard Entertainment 无隶属或官方合作关系。仓库内的第三方游戏内容、来源和适用边界见 [Third-party content notices](THIRD_PARTY_NOTICES.md)。
