# CoopAgent Map Runtime

The Map Runtime combines Agent-authored commander changes with a host co-op mission and produces a runnable StarCraft II map. It consists of a map-independent core, a mission map, and a deterministic builder/launcher.

```text
core/GameA.SC2Mod (source package)
        +
projects/GameA-OblivionExpress.SC2Map (host source)
        ↓ build
build/versions/oblivion-express/GameA-OblivionExpress-Build-<source-hash>.SC2Map
        =
runnable co-op map
```

## Runtime boundary

- `core/GameA.SC2Mod` is the Agent's normal write target. It owns the preparation UI, commander configuration, generated Catalog overrides, Galaxy mechanics, and core localization. It is used as a source package rather than a runtime `file:Mods` dependency.
- `projects/GameA-OblivionExpress.SC2Map` is the current mission map. It owns terrain, placed objects, train paths, objectives, attack waves, victory/defeat logic, and one thin task adapter.
- Both reuse Blizzard's official `Allied Commanders` dependency. Official SC2 installation and CASC data remain read-only.

The preparation page offers all 18 official co-op commanders in a 6-by-3 grid of square official portraits. The portraits themselves are the selection controls; the selected portrait remains bright while the others are dimmed. It also supports P0-P3 prestige selection, Blizzard's native 90-level mastery point allocator, and Casual-through-Brutal mission difficulty. The editor-test configuration assigns player 2 to a computer-controlled level-15 Raynor.

Registered host missions live in `hosts.json`; currently Oblivion Express is the only registered host. Adding another map requires only its source, thin adapter, and one registry entry.

## One-click test

Click **准备并运行** in the CoopAgent desktop app. After the Agent applies further changes, the button becomes **更新并运行**: click it to load those changes before starting another game. Keeping the editor open does not update its map automatically. If the latest map has opened but a dialog prevents the game from starting, handle the dialog and press **Ctrl+F9** in that map. The button shows **游戏运行中** while SC2 is running and becomes available again after the game exits.

The command-line equivalent is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File game-a/scripts/launch-game-a.ps1
```

The launcher:

1. Builds a content-addressed map under `build/versions/oblivion-express/` and updates `build/latest/oblivion-express.json`.
2. Copies core Galaxy modules into `scripts/generated`, merges core Catalog overrides, appends core localization, and generates the reviewed commander-identity compatibility layer from the local B97579 co-op database.
3. Opens the generated map in the StarCraft II Editor, reusing an existing editor process when possible.
4. Attempts the editor's Test Document command. The desktop separately checks whether SC2 has started; opening the map alone is not reported as a running game.

SC2 Test Document does not reliably expose loose Galaxy files from a custom local Mod dependency. Building a disposable composed map keeps the Agent's source boundary clean while ensuring the game compiler sees every generated file. The builder reads `GameA.Core.json`, automatically merges all core Catalog XML and localized text files, copies declared assets, and generates ordered Galaxy includes and initialization calls. A changed source hash produces a new output folder, so an older map may remain open without blocking the build. If the user manually opens `core/GameA.SC2Mod`, that source document must still be closed before PatchPlan can atomically replace the core package.

Local editor tests can assign only Raynor, Kerrigan, and Artanis to SC2's native `PlayerCommander` slot. For the other commanders, the build derives four narrowly transformed official Galaxy files from the user's read-only database: official script identity reads resolve through Map Runtime's committed co-op script identity, while the rejected native write is skipped. The three native-supported commanders still use the native slot. The transformer is hash-locked to the accepted SC2 build and fails closed on source drift. Neither extracted nor transformed Blizzard scripts are stored in the repository or release package; they exist only in ignored, rebuildable map output.

## Validation

Run the read-only structural check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File game-a/scripts/validate-game-a.ps1
```

This validates required files, XML syntax, dependency wiring, script includes, and that core Map Runtime files are no longer embedded in the host map.

After a successful manual playtest, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File game-a/scripts/verify-game-a.ps1
```

It checks the source structure, deterministic build output, SC2 version, blocking compile errors, missing includes, and unclassified trigger errors against `runtime-baseline.json`.

The automatic launch and run-scoped log contract is documented in `docs/runtime-test-protocol.md`.

The frozen runtime boundary and acceptance rules are documented in `RUNTIME-CONTRACT.md`.
