# Game A Host Registry

Host missions are registered in `hosts.json`. The builder selects one host before the SC2 Editor starts; a running SC2 map is never switched in place.

Each host entry provides:

- a stable `id` used by the Agent and CLI;
- the component-folder map source;
- a unique disposable build-output name used as the prefix for content-addressed map versions;
- one thin adapter Galaxy file;
- the adapter entry called by `InitCustomScript`.

The host source must include `scripts/generated/GameABootstrap`, include its own adapter, and call the registered entry from `InitCustomScript`. Its Trigger custom-script record must contain the same bootstrap include and entry so the editor cannot regenerate an obsolete `MapScript.galaxy`.

Build or launch a registered host with:

```powershell
powershell -File game-a/scripts/build-game-a.ps1 -Host oblivion-express
powershell -File game-a/scripts/launch-game-a.ps1 -Host oblivion-express
```

Run `game-a/选择地图运行GameA.cmd` for a registry-driven console selector. The CoopAgent desktop UI can later read the same `hosts.json` and pass the selected host id to the launcher.

Adding a host does not copy or fork Game A commander content. Every registered host consumes the same core build inputs.

The builder records the selected version in `build/latest/<host-id>.json`. Launching a changed build reuses the existing editor process; it closes only an active generated-map document with no unsaved changes, then opens the new version. It never closes a modified document automatically.
