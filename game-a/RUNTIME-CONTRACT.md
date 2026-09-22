# Map Runtime Contract

Status: **frozen baseline v2**, accepted against StarCraft II `5.0.15.97579` / data build `B97579` on 2026-08-02 after the registry-driven generalized build passed a full Oblivion Express playtest.

Implementation amendment 2026-09-12: the local commander-identity compatibility layer passed automated Karax, Raynor, and Karax-P2-scalar engine probes. This does not replace the existing full manual mission acceptance date or change the frozen interfaces.

Implementation amendment 2026-09-20: optional modules that must refresh state after the official mission startup declare `postMissionStart` in `GameA.Core.json`. The builder emits an always-present `GameA_GeneratedPostMissionStart()` dispatcher, so a host never acquires a direct dependency on an absent feature module. Test-mode economy and production refresh use this lifecycle.

Bundled host amendment 2026-09-21: the repository carries the fixed playable Oblivion Express host at `projects/GameA-OblivionExpress.SC2Map`. Setup does not discover, extract, or rewrite map-cache packages. Builds copy this source into disposable output, while user project changes remain in the Map Runtime core and generated content.

Difficulty amendment 2026-09-20: the official co-op runtime uses players 3/4 as difficulty carriers and as host enemy slots. Preparation options synchronize the selected difficulty to players 1–4 before common mission initialization, then restore the same value through `beforeMissionStart` before the host map calculates difficulty-dependent state. This keeps commander display, common initialization, enemy AI, host mission values, official damage ratio, and game speed on one difficulty.

Preparation UI amendment 2026-09-20: because Map Runtime bypasses Blizzard's commander-selection page, the same before-mission-start preparation hook invokes the official prestige-summary initializer after the selected prestige has been applied. Gameplay prestige state remains authoritative; this call synchronizes the lower-right HUD with it.

Local voice-reward compatibility: offline editor test maps skip only the default commander voice-pack `PlayerAddReward` grant, which the engine rejects locally. Existing voice selection is retained; this does not guarantee the commander's default voice is applied locally. Online and non-test behavior remains unchanged. The guarded official function is generated from hash-checked local sources, not bundled source data.

The 2026-09-12 voice-reward regression passed Mengsk gameplay observations (13/13) and Stetmann startup observations (6/6), both with zero script errors. These bounded probes do not constitute full commander or mission acceptance.

## Fixed architecture

```text
core/GameA.SC2Mod
        +
projects/GameA-OblivionExpress.SC2Map
        ↓ deterministic build
build/versions/oblivion-express/GameA-OblivionExpress-Build-<source-hash>.SC2Map
        ↓ fixed Maps/Test staging + SC2Switcher
SC2 game process
```

- CoopAgent writes the core source package.
- The host source owns terrain and mission logic; ordinary commander changes do not modify it.
- The fixed Oblivion Express host is bundled with the repository and is shared by project templates.
- The host adapter is the only mission-specific Map Runtime bridge.
- Single-player defeat-alliance compatibility remains host-owned because official mission initialization may restore the host's team-defeat policy. The host applies one named policy function on both sides of that initialization.
- The build directory is disposable and must never become a source of truth.
- Automated tests stage and launch only the generated build map. The editor remains an optional manual inspection fallback and never opens Map Runtime core as the runtime source.
- Build maps are content-addressed. `build/latest/<host-id>.json` points to the current output, allowing the editor process to stay alive while a new map version is built and opened.
- Runtime Galaxy is embedded into the generated map; custom local Mod Galaxy dependencies are not used.
- The builder derives the commander-identity compatibility overlay from the user's local co-op database. Extracted official scripts are never source inputs in the repository and exist only in disposable build output.
- `GameA.Core.json` declares deterministic Galaxy order and feature initialization; the builder discovers Catalog, localization, and declared asset inputs dynamically.
- `hosts.json` is the single registry for selectable host maps. Host selection occurs before editor launch.

## Frozen interfaces

- Core preparation entry: `GameA_Init(trigger missionStartTrigger)`.
- Host entry: `GameA_OblivionExpressInit()`.
- Host start callback: `GameA_OblivionExpressStart(bool testConds, bool runActions)`.
- Shared mission loader: `GameAI_LoadCoopMission(string mapId, trigger missionStartTrigger)`.
- Generated scripts live at `scripts/generated/` inside the build map.
- Generated bootstrap: `scripts/generated/GameABootstrap.galaxy`.
- Generated feature initializer: `GameA_GeneratedInit()`.
- Generated before-mission-start dispatcher: `GameA_GeneratedBeforeMissionStart()`.
- Generated post-mission-start dispatcher: `GameA_GeneratedPostMissionStart()`.

Changes to these interfaces require a runtime-contract version bump and a complete manual acceptance run.

## Acceptance baseline

The accepted run demonstrated:

1. The preparation page appeared.
2. Commander selection worked.
3. Start entered the official Oblivion Express mission.
4. Terrain, mission UI, bases, trains, waves, victory, and defeat logic were available.
5. Generated Raynor/Hyperion changes remained active.
6. No Galaxy compile or missing-include errors occurred.

Official `StatEvent*` calls can emit local-test permission warnings. They are non-blocking only when the stack points to Blizzard's `libCOOC_gf_CC_StatEvent*` functions. Other trigger errors are not automatically accepted.

### Local commander identity boundary

SC2 `5.0.15.97579` accepts native `PlayerCommander` writes for Raynor, Kerrigan, and Artanis in a local test, but rejects later commanders. Map Runtime therefore keeps Blizzard's co-op script identity authoritative for unsupported local commanders and routes the official `LibCOOC`, `LibCOMI`, and `LibCOUI` identity reads through a build-generated wrapper. Supported commanders continue to populate and read the native slot. Engine-native identity remains empty for unsupported commanders; new code must use the co-op/Map Runtime identity rather than assuming that native slot was populated. The reviewed transformer verifies the baseline build, exact source hashes, and replacement counts before producing output.

## Stability rule

Do not change this architecture while implementing PatchPlan. New Agent capabilities must produce core Catalog, Galaxy, or localization inputs consumed by the existing builder. Fix implementation defects inside the current boundary before considering an architectural change.
