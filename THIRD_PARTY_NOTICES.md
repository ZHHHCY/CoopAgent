# 第三方内容声明

## 便携包运行组件

Windows 便携包随附 [Node.js](https://nodejs.org/)（许可证见 `.tools/node/LICENSE`）、[OpenCode](https://github.com/anomalyco/opencode)（MIT，见 `.tools/opencode/bin/LICENSE.txt`）、[Python 嵌入包](https://www.python.org/downloads/windows/)（许可证见 `.tools/python/LICENSE.txt`）和 [CascLib](https://github.com/ladislav-zezula/CascLib)（MIT，见 `.tools/CascLib/build-coopagent/Release/LICENSE`）。JavaScript 依赖的许可证随各依赖包保留在 `node_modules/` 中。

## 本机 StarCraft II 数据

CoopAgent 从用户本机的 StarCraft II 安装中读取数据并构建合作模式数据库。仓库和发行包包含解析器、数据库结构及索引代码，不包含提取后的 CASC 文件或预构建的合作模式数据库。

本地提取结果和数据库保存在 `%LOCALAPPDATA%\CoopAgent\` 下，CoopAgent 不会上传这些文件。

## 随附任务地图

仓库在以下位置包含一份供地图运行层使用的修改版任务地图：

```text
game-a/projects/GameA-OblivionExpress.SC2Map/
```

该任务地图包含源自 Blizzard Entertainment 的《StarCraft II》及合作任务“湮灭快车”的地图数据、地形、任务脚本、触发器、本地化文本和游戏资源。StarCraft、StarCraft II、Blizzard Entertainment 以及相关名称和资源归其各自权利人所有。

该任务地图供拥有合法 StarCraft II 安装的用户进行非商业的本地模组制作与测试。它不是独立游戏，也不隶属于 Blizzard Entertainment，未得到其认可或赞助。

CoopAgent 的仓库许可证只适用于仓库作者有权许可的原创内容，不授予 Blizzard 游戏内容、自定义游戏或另行标明的第三方材料相关权利。使用与分发仍须遵守适用的 [Blizzard 最终用户许可协议](https://www.blizzard.com/legal/fba4d00f-c7e4-4883-b8b9-1b4500a402ea/blizzard-end-user-license-agreement)和[自定义游戏可接受使用政策](https://www.blizzard.com/legal/2749df07-2b53-4990-b75e-a7cb3610318b/custom-game-acceptable-use-policy)。
