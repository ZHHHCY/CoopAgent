CoopAgent Windows x64 portable release

1. Extract the entire ZIP to a writable folder. Keep all files together.
2. Run setup.cmd once and select your local StarCraft II installation.
   This reads your local game files and builds the database; it may take time.
3. Run start.cmd or CoopAgent.exe to open the desktop app.

The package includes Node.js, OpenCode, Python, CASCLib and JavaScript runtime
dependencies. No Git, Visual Studio, Windows SDK, Rust or manual compilation is
needed on the target computer. Windows 10/11 x64, WebView2 and StarCraft II
are still required. Model API configuration is completed inside the app.

Run setup.cmd --check to check package integrity without reading game files.
Source builds remain available in the repository through scripts\build.cmd.

Logs: .coopagent\logs\
Generated game data: %LOCALAPPDATA%\CoopAgent\
Projects: projects\ inside the extracted folder

See THIRD_PARTY_NOTICES.md for bundled third-party content.
