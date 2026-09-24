# CoopAgent

想让凯瑞甘多一点生命？直接说“把凯瑞甘的生命值改成 1400”。CoopAgent 会把改动写进当前项目。打开地图打一局，就知道效果怎么样了。

也可以只问不改，比如“雷诺的陆战队员要花多少矿？”对话和改动会随项目保存；想试另一套玩法，就新建一个项目。

目前主要能改单位、技能、升级和精通中的数值。遇到暂时做不到的改动，它会告诉你卡在哪里。

## 安装和运行

需要 Windows 电脑、已安装的《星际争霸 II》和可用的模型 API 配置。其他安装要求见[安装与使用指南](docs/getting-started.md)。

1. 下载仓库，双击 `setup.cmd`，选择游戏安装目录，等它准备完成。
2. 双击 `start.cmd`，在打开的应用里配置模型、创建项目。
3. 输入想问或想改的内容。改好后点击“启动编辑器”，在游戏里查看效果。

第一次安装会下载和编译工具，可能要等一会儿。中途出错可以按[安装与使用指南](docs/getting-started.md)排查。

## 看看代码

`scripts\dev.cmd` 启动开发环境，`scripts\build.cmd` 构建桌面程序。想了解游戏数据、改动和地图是怎么衔接的，可以看[合作模式数据库](docs/co-op-database.md)、[PatchPlan v2](docs/patch-plan.md)和[地图运行契约](game-a/RUNTIME-CONTRACT.md)。

## 许可证

CoopAgent 的原创代码采用 [MIT License](LICENSE)。Blizzard 内容和其他第三方材料见[第三方内容声明](THIRD_PARTY_NOTICES.md)。CoopAgent 与 Blizzard Entertainment 无隶属或官方合作关系。
