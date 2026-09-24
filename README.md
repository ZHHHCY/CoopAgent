# CoopAgent

用自然语言修改《星际争霸 II》合作模式的指挥官数值，并在本地地图中验证结果。

在桌面端说出想改的效果，例如“把凯瑞甘的生命值提高到 1400”。CoopAgent 会查询游戏数据，将修改写入当前项目；你可以查看改动，再通过《星际争霸 II》编辑器运行地图。

## 能做什么

- 查询指挥官、单位、升级、精通和面板技能。
- 修改生命、伤害、攻速、费用、冷却等已有数值，以及当前支持的脚本参数。
- 为不同项目分别保存对话、改动和地图内容；新项目从干净模板开始。
- 构建并运行湮灭快车地图，查看实际游戏效果。

## 开始使用

当前支持 Windows x64，需要已安装《星际争霸 II》并准备可用的模型 API 配置。完整系统要求见[安装与使用指南](docs/getting-started.md)。

1. 克隆或下载仓库，运行 `setup.cmd`，按提示选择游戏安装目录。
2. 运行 `start.cmd`，在桌面端配置模型并创建项目。
3. 输入查询或修改要求；需要验证效果时，使用应用内的“启动编辑器”。

安装中断、启动失败或需要重新准备环境时，按[安装与使用指南](docs/getting-started.md)中的步骤处理。

## 开发

运行 `scripts\dev.cmd` 启动开发环境，运行 `scripts\build.cmd` 构建桌面程序。数据结构、修改格式和地图运行方式分别见[合作模式数据库](docs/co-op-database.md)、[PatchPlan v2](docs/patch-plan.md)和[地图运行契约](game-a/RUNTIME-CONTRACT.md)。

当前数值修改以已有字段和已支持的脚本参数为范围。源码中的改动、预检通过与游戏内效果是不同的验证结果。

## 许可证

CoopAgent 的原创代码采用 [MIT License](LICENSE)。仓库中的 Blizzard 内容及其他第三方材料见[第三方内容声明](THIRD_PARTY_NOTICES.md)；CoopAgent 与 Blizzard Entertainment 无隶属或官方合作关系。
