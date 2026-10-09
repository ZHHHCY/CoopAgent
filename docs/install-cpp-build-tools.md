# 安装 Windows C++ 构建工具

本页适用于 Windows x64 源码安装。如果已安装 Visual Studio 2022 或 2026 的对应组件，可以直接返回[安装指南](getting-started.md)继续操作。

1. 打开[微软 Build Tools 官方下载页](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，下载并运行安装程序。
2. 选择 Visual Studio 2022 或 2026 Build Tools，勾选“使用 C++ 的桌面开发”（Desktop development with C++）工作负载。
3. 在右侧“安装详细信息”中确认包含以下组件，然后点击“安装”：
   - 适用于 x64/x86 的 MSVC 生成工具和 MSBuild；
   - 适用于 Windows 的 C++ CMake 工具；
   - Windows 10 SDK 或 Windows 11 SDK，任选一个即可。
4. 安装完成后，在 CoopAgent 仓库根目录重新运行 `setup.cmd`。

如果已经安装完整的 Visual Studio，可以打开 Visual Studio Installer，点击“修改”补齐上述组件，无需另装一份 Build Tools。操作界面可参考[微软的 MSVC Build Tools 安装说明](https://learn.microsoft.com/zh-cn/cpp/overview/acquire-msvc?view=msvc-170)。
