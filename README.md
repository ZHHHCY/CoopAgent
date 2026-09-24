# CoopAgent

CoopAgent 是一个用于自定义《星际争霸 II》合作模式指挥官的agent。agent接受自然语言输入，可以查询游戏数据，调整指挥官数值，并通过编辑器体验。

## 当前功能

- 查询指挥官、单位、技能、升级和精通的数据。
- 修改生命、伤害、费用、冷却等已有数值，以及已支持的脚本参数。

## 当前限制

- 仅支持已有数值和已接入的脚本参数，不能任意编写或改写脚本公式，也不能直接创建新的单位、技能或玩法机制。
- 有些面板数值只用于显示，实际效果由游戏脚本计算。找不到影响实际效果的可编辑参数时，agent 无法完成修改，会说明未完成的部分。
- 目前通过本地的湮灭快车地图体验改动。数值写入项目后，仍需进入游戏确认实际效果。

## 安装与使用

需要 Windows x64、已安装的《星际争霸 II》和可用的模型 API 配置。其他安装要求见[安装与使用指南](docs/getting-started.md)。

1. 克隆或下载仓库，运行 `setup.cmd`，选择游戏安装目录并等待环境准备完成。
2. 运行 `start.cmd`，配置模型并创建项目。
3. 输入查询或修改要求。修改完成后，点击“启动编辑器”进入地图。

首次安装需要下载和编译工具。安装中断或启动失败时，参阅[安装与使用指南](docs/getting-started.md)。

## 开发

运行 `scripts\dev.cmd` 启动开发环境，运行 `scripts\build.cmd` 构建桌面程序。技术资料见[合作模式数据库](docs/co-op-database.md)、[PatchPlan v2](docs/patch-plan.md)和[地图运行契约](game-a/RUNTIME-CONTRACT.md)。

## 许可证

CoopAgent 的原创代码采用 [MIT License](LICENSE)。Blizzard 内容和其他第三方材料见[第三方内容声明](THIRD_PARTY_NOTICES.md)。
