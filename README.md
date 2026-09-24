# CoopAgent

CoopAgent 是一个用于修改《星际争霸 II》合作模式的桌面应用。你可以用自然语言查询游戏数据、调整指挥官数值，并通过编辑器运行地图，检查改动后的效果。

## 当前功能

- 查询指挥官、单位、技能、升级和精通的数据。
- 修改生命、伤害、费用、冷却等已有数值，以及已支持的脚本参数。
- 为不同项目分别保存会话和改动，并在本地地图中验证结果。

目前不支持任意改写脚本公式。找不到可编辑的数值时，应用会说明原因。

## 安装与使用

需要 Windows x64、已安装的《星际争霸 II》和可用的模型 API 配置。其他安装要求见[安装与使用指南](docs/getting-started.md)。

1. 克隆或下载仓库，运行 `setup.cmd`，选择游戏安装目录并等待环境准备完成。
2. 运行 `start.cmd`，配置模型并创建项目。
3. 输入查询或修改要求。修改完成后，点击“启动编辑器”进入地图。

首次安装需要下载和编译工具。安装中断或启动失败时，参阅[安装与使用指南](docs/getting-started.md)。

## 开发

运行 `scripts\dev.cmd` 启动开发环境，运行 `scripts\build.cmd` 构建桌面程序。技术资料见[合作模式数据库](docs/co-op-database.md)、[PatchPlan v2](docs/patch-plan.md)和[地图运行契约](game-a/RUNTIME-CONTRACT.md)。

## 许可证

CoopAgent 的原创代码采用 [MIT License](LICENSE)。Blizzard 内容和其他第三方材料见[第三方内容声明](THIRD_PARTY_NOTICES.md)。CoopAgent 与 Blizzard Entertainment 无隶属或官方合作关系。
