# 安装与使用指南

本指南适用于 Windows x64。便携版适合直接使用，源码版保留手动编译入口。

## 便携版

下载 Windows x64 便携 ZIP，**完整解压**到可写目录。先运行包内 `setup.cmd` 并选择《星际争霸 II》安装目录，等待本机游戏数据提取与数据库构建完成；之后运行 `start.cmd` 或 `CoopAgent.exe`。模型 API 在应用内配置。可先运行 `setup.cmd --check` 检查包的完整性，不读取游戏文件。

便携版内含 Node.js、OpenCode、Python、CascLib 和 JavaScript 运行依赖。目标机器仍需 Windows 10/11 x64、WebView2 运行时与已安装的《星际争霸 II》；无需 Git、Visual Studio、Windows SDK、Rust 或手动编译。更新便携版时请先关闭程序，再完整解压新包；项目默认保存在包内 `projects/`，请自行保留该目录。共享数据库和游戏目录配置位于用户目录，不随 ZIP 分发。

## 源码版

以下步骤从源码仓库根目录运行；首次准备和编译可能需要一段时间。

## 使用前准备

- 已安装《星际争霸 II》。
- Python 3.10 或更新的 **64 位**版本，安装时勾选加入 PATH；命令行可用的 Git for Windows。
- Microsoft Visual Studio 2022 或 2026 Build Tools，包含 **Desktop development with C++** 工作负载、MSVC、MSBuild、C++ CMake 工具和 Windows 10/11 SDK。
- 一个可用的模型 API 配置。
- 建议预留至少 20 GiB 磁盘空间，用于工具链、游戏数据库和构建缓存。

`setup.cmd` 会在下载前检查所需系统组件；缺少时会显示安装说明。

## 安装并启动

1. 克隆或下载 CoopAgent 仓库。
2. 双击 `setup.cmd`。
3. 在文件夹选择窗口中选择《星际争霸 II》安装目录。
4. 等待环境准备完成。脚本会安装固定版本的工具，并从本机游戏数据构建合作模式数据库。
5. 双击 `start.cmd`。首次启动会构建桌面程序；之后直接打开已构建的应用。
6. 在桌面端配置模型并创建项目。新项目默认保存在当前仓库的 `projects/` 下。

也可以在命令行指定游戏目录：

```powershell
.\setup.cmd -StarCraftRoot "D:\Games\StarCraft II"
```

## 第一次修改

在 CoopAgent 页签输入要查询或修改的内容。例如：

> 把凯瑞甘的生命值提高到 1400。

Agent 完成后可以在右侧查看改动。准备好验证时，点击“启动编辑器”；如果编辑器打开后没有自动进入游戏，按照按钮旁的提示按 `Ctrl+F9`。游戏结束后如有新修改，再点击“更新并运行”准备最新地图。

项目有独立的会话和改动记录。切换项目后，新项目从干净模板开始。

## 安装或启动遇到问题

下载、解压或数据库准备中断时，重新运行 `setup.cmd`。脚本会续传已下载的归档、清理未完成的临时目录、复用完整的 CASC 提取结果，并只在数据库构建完整后替换正式结果。同一时间只允许一个环境准备进程。

数据库未就绪或查询失败时，在环境设置或“全部改动”区域点击“重新检查”。应用中的“打开日志目录”会打开当前仓库的 `.coopagent/logs/`；`setup-*.log`、`start-*.log` 和 `app-*.jsonl` 分别记录安装、启动和应用错误。界面错误提示中的“查看技术详情”保留原始错误。

如果更新过源码，先关闭桌面程序，运行 `scripts\build.cmd` 重新构建，再运行 `start.cmd`。开发热更新使用 `scripts\dev.cmd`。

开发者在具备源码版工具链的机器上运行 `scripts\build-portable.cmd` 可以生成 `artifacts/CoopAgent-<版本>-windows-x64.zip`。该脚本先用现有手动编译入口构建桌面程序，再编译静态 CRT 的 CASCLib、下载并校验 Python 嵌入包、准备生产依赖，最后执行便携包完整性检查。仅复用已有桌面 EXE 时可传 `-SkipBuild`。

## 重新准备环境

先关闭 CoopAgent、开发终端和《星际争霸 II》编辑器，再运行 `reset.cmd`。默认只清除当前仓库的工具链、依赖和构建缓存，保留项目、会话、修改、日志、共享数据库和模型凭据。

```powershell
.\reset.cmd --check               # 只查看默认清理范围
.\reset.cmd -DeleteProjects       # 同时删除当前 projects 下的项目及其会话、修改
.\reset.cmd -ClearSharedData      # 同时清除共享数据库、CASC、WebView 缓存和游戏路径
```

额外清理选项需要输入 `RESET` 确认；两个选项可以组合。仓库外项目和模型凭据会保留。只有清除了共享游戏路径，下次运行 `setup.cmd` 才会重新显示目录选择窗口。

环境工具存放于仓库的 `.tools/` 和 `%LOCALAPPDATA%\CoopAgent\` 下。游戏目录记录在 `%APPDATA%\CoopAgent\sc2-installation.json`；本地数据库位于 `%LOCALAPPDATA%\CoopAgent\database\<SC2 build>`。这些生成内容不随仓库发布。
