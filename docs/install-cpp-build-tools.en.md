# Installing Windows C++ Build Tools

[简体中文](install-cpp-build-tools.md) | English

This page covers installation from source on Windows x64. If the required Visual Studio 2022 or 2026 components are already installed, return to the [Installation Guide](getting-started.en.md) and continue.

1. Open Microsoft's [official Build Tools download page](https://visualstudio.microsoft.com/visual-cpp-build-tools/), then download and run the installer.
2. Select Visual Studio 2022 or 2026 Build Tools and check the **使用 C++ 的桌面开发** (Desktop development with C++) workload.
3. Under **安装详细信息** (Installation details) on the right, confirm that the following components are included, then click **安装** (Install):
   - MSVC build tools for x64/x86 and MSBuild;
   - C++ CMake tools for Windows;
   - either the Windows 10 SDK or the Windows 11 SDK.
4. Once installation finishes, run `setup.cmd` again from the CoopAgent repository root.

If you already have the full Visual Studio installed, open Visual Studio Installer and click **修改** (Modify) to add these components. You do not need a separate Build Tools installation. For the installer interface, see Microsoft's [MSVC Build Tools installation instructions](https://learn.microsoft.com/en-us/cpp/overview/acquire-msvc?view=msvc-170).
