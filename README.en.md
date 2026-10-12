# CoopAgent

[简体中文](README.md) | English

CoopAgent is an agent application for customizing commanders in *StarCraft II* Co-op. It accepts natural-language requests, queries game data, and changes commander values. You can test the results using your local StarCraft II Editor.

## Current features

- Query data for commanders, units, abilities, upgrades, mastery, and more.
- Change existing values such as health, damage, costs, and cooldowns, as well as supported script parameters.
- Use the map's test mode to start with plenty of minerals, gas, and supply, reducing the time needed to test changes.
- The interface supports Simplified Chinese and English. Use the language selector at the top right of the project toolbar to switch.

## Current limitations

- Only existing values and supported script parameters can be changed. The agent cannot yet write or change script formulas, directly create new units, add abilities, or change game mechanics.
- Some values shown in the interface are only for display; game scripts calculate the actual effects. Finding the parameters that affect gameplay can take a long time, many tool calls, and many tokens. If the agent cannot find an editable parameter that controls the actual effect, it cannot complete the change and will explain what remains unfinished.
- Only **Oblivion Express** is currently supported, and it can only be played locally through the editor. Multiplayer is unavailable, and the ally is always Raynor.
- The agent is not guaranteed to complete a request in one turn. You may need to test the map in the editor and give the agent feedback for another round of changes.

## Quick start

### Installation

System requirements:

- Windows x64, with *StarCraft II* and its editor installed.
- Python 3.10 or later, 64-bit, and Git for Windows. Both `python` and `git` must be available from the command line.
- Visual Studio 2022 or 2026 C++ Build Tools, including MSVC, MSBuild, CMake, and the Windows SDK. See [Installing C++ Build Tools](docs/install-cpp-build-tools.en.md).
- A working model API URL, model ID, and API key.
- At least 20 GiB of free disk space is recommended.

1. **Clone the repository:** Run `git clone https://github.com/ZHHHCY/CoopAgent.git`, then open the `CoopAgent` folder.
2. **Run setup:** Double-click `setup.cmd` in the repository root, select your StarCraft II installation folder, and wait for setup to finish.
3. **Run start:** Double-click `start.cmd` to launch CoopAgent. The first launch needs to compile the desktop application; wait for it to finish.

See the [Installation Guide](docs/getting-started.en.md) for the full installation process.

### Usage

1. **Create a project:** Click **新建项目** (New Project) at the top, enter a name, and create it. Each project stores its own sessions and changes.
2. **Configure the API:** Click the model configuration area at the bottom left. Enter the API URL, model ID, and API key, then save and select the model. These settings must match the information provided by your API platform.
3. **Ask and modify:** Enter your request in the CoopAgent chat. For example, first ask, “How much does Mengsk's Aegis Guard cost?” Then ask, “Change Mengsk's Aegis Guard cost to 200 minerals and 200 gas.” Once the agent finishes, you can review the applied changes on the right.
4. **Launch the map:** Click **准备并运行** (Prepare and Run) at the bottom right to open the map with your current changes. If the game does not start automatically, press `Ctrl+F9` in the editor. After further changes, click **更新并运行** (Update and Run) to load them.

See the [User Guide](docs/user-guide.en.md) for screenshots and the full workflow.

## License

CoopAgent's original code is licensed under the [MIT License](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for Blizzard content and other third-party materials.
