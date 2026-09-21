# 合作英雄制作指南

本文供 CoopAgent 在“修改现有英雄”或“加入新英雄”时读取。目标不是教 Agent 在编辑器 UI 中点数据，而是规定如何从官方合作模式数据库出发，生成可审计、可重复执行的 PatchPlan v2，并让结果稳定运行在 Game A 中。

配套模板：

- 需求与设计清单：[`templates/coop-hero-design.template.md`](./templates/coop-hero-design.template.md)
- PatchPlan 骨架：[`templates/coop-hero.patch-plan.template.jsonc`](./templates/coop-hero.patch-plan.template.jsonc)
- 已落地参考：[`examples/artanis-hero.patch-plan.json`](./examples/artanis-hero.patch-plan.json) 及其后续修正计划

## 1. 不可违反的边界

1. 官方 CASC 数据和解析后的合作模式数据库只作为只读输入。
2. 所有可发布的修改落在 `game-a/core/GameA.SC2Mod`，并由 PatchPlan v2 描述。
3. 不直接修改 `game-a/build`。测试地图必须从核心源和宿主任务源重新构建。
4. Catalog 修改优先使用结构化操作；只有无法结构化表达的文本差异才使用 `file.patch`。
5. 复杂运行机制写 Galaxy，不要在 PatchPlan JSON 中发明另一种脚本语言。
6. 每次修改必须能说明引用来源、预期原值、目标值、依赖计划和验证结果。
7. 新计划必须声明指挥官 `scope` 与实际 `isolation`；不得以“该对象看起来只属于此英雄”为理由直接修改共享官方对象。

## 2. 正确的心智模型

SC2 中的合作英雄不是一个 `Unit`，而是一张数据与运行逻辑组成的图：

```text
Commander
  └─ Hero Unit
      ├─ Weapon ── Effect chain
      ├─ Ability ─ Button ─ Effect / Behavior / Validator
      ├─ Command Card
      ├─ Actor
      │   ├─ Model / animation
      │   ├─ portrait / icon / wireframe
      │   ├─ status bar / minimap
      │   └─ sound / visual events
      └─ Galaxy lifecycle
          ├─ initial deployment
          ├─ death detection
          ├─ cooldown
          ├─ revival beacon
          └─ hero panel integration
```

因此：

- Catalog 中存在英雄，不代表它会出生。
- Unit 拥有 Ability，不代表命令卡会显示按钮。
- Unit 数值正确，不代表 Actor 有模型、肖像或英雄状态条。
- Actor 外观正确，不代表英雄死亡后能复活。
- 信标能计时，不代表进度条、名称和命令卡正确。

## 3. 先判断任务类型

### 3.1 修改已有英雄

已有英雄的官方引用图可以作为只读模板复用，但不等于可以覆盖共享官方对象。纯数值修改使用玩家 Upgrade；技能、命令卡、Actor 或生命周期等结构修改，只克隆实际变化的 owner 与下游分支，并显式重连到该指挥官。不要无差别复制整套数据。

常见映射：

| 用户意图 | 首要修改点 |
| --- | --- |
| 改生命、护盾、移动速度 | `Unit` |
| 改普通攻击伤害或攻速 | `Weapon`、伤害 `Effect` |
| 改技能冷却、费用、施法距离 | `Abil` |
| 改技能实际效果 | `Effect`、`Behavior`、`Validator` |
| 增删技能按钮 | `Unit.CardLayouts`、`Button` |
| 改模型、肖像、图标、状态条 | `Actor` |
| 改出生、死亡、复活方式 | Galaxy 生命周期 |

如果官方出生与复活机制保持不变，就不要为了改数值而改 Galaxy；如果结构修改要求替换英雄 Unit，则必须同时重连官方出生、复活或选择入口。

### 3.2 加入新英雄

新英雄至少需要：

1. 唯一的 Unit ID。
2. 能绑定该 Unit 的主 Actor。
3. 攻击、技能、Behavior 和命令卡引用。
4. 名称、按钮和说明文本。
5. 初次登场、死亡和复活生命周期。
6. 复生信标或其他等待阶段表现。
7. 合作英雄面板接入。

新英雄可以继承官方英雄作为模板，但必须审计继承后带来的技能、命令卡、Behavior、Actor 类型和表现字段。

## 4. 制作前的数据调查

Agent 必须先从解析后的官方合作模式数据库调查参考对象，不能靠记忆猜 ID。

至少记录：

- 参考英雄的 Unit ID、XML 类和 parent。
- 主 Actor 的 ID、XML 类、`unitName`、Model、Portrait 和状态条字段。
- Weapon、Ability、Effect、Behavior、Button 的入口 ID。
- 命令卡按钮与 Ability 的对应关系。
- 官方出生和复活时使用的 Galaxy/UserData 入口。
- 所有准备复用的 Model、Sound、Validator、Requirement 是否存在于当前 SC2 build。
- `impact.analyze.ownerEntrypoints` 中的创建/复活入口，以及需要保留或重映射的 Requirement、Upgrade、表现和配置消费者。

调查结果填写到英雄设计模板的“官方参考与复用”部分。

克隆英雄 Unit 时，Requirement、Upgrade、Actor 或 UserData 引用了新对象都不代表它会出生。计划必须至少重连一个数据库证明的创建/复活入口，或由同一计划生成的 Galaxy 生命周期显式创建新 Unit ID。`[#n]` 路径只能作为定位证据，不能直接写进 redirect。

## 5. 推荐制作顺序

### 第一步：冻结身份和 ID

为新增对象使用稳定前缀，当前约定使用 `GameA`：

```text
GameA<Hero>Name
GameA<Hero>ReviveBeacon
GameA<Hero><Ability>
GameA<Hero><Effect>
GameA<Hero><Behavior>
```

同一语义对象的 Unit 和主 Actor 应使用相同 ID，Actor 用 `unitName` 绑定 Unit。

### 第二步：建立最小英雄 Unit

优先复用最接近的官方英雄 Unit，并显式覆盖会改变运行语义的字段。

重点检查：

- `Attributes`：Heroic、Structure、MapBoss 等。
- `FlagArray`：PreventDestroy、Invulnerable、Untargetable 等。
- 生命、护盾、能量与再生。
- Movement、Plane、Collide、Radius。
- Weapon、AbilArray、BehaviorArray。
- `CardLayouts`、`SelectAlias`、`SubgroupPriority`。

不要让用于复生的临时单位意外继承另一个英雄的 Ability 和命令卡。

### 第三步：建立主 Actor

英雄 Unit 的主 Actor 必须能作为单位 Actor 工作。至少配置：

- 正确的 `CActorUnit` 类。
- `unitName` 指向英雄 Unit。
- 世界 `Model` 和出生 `BuildModel`。
- `PortraitActor`、`PortraitModel`。
- `UnitIcon`、`HeroIcon`、`Wireframe`、`GroupIcon`。
- 合作英雄 `CustomUnitStatusFrame`。
- `StatusBarOn[Custom] = 1`。
- `UnitFlags[SuppressDefaultStatusBar] = 1`。
- `BarOffset`、`BarWidth`。
- `MinimapRenderPriority = Hero`。

不要因为官方对象能运行，就假设它的 XML 类适合克隆成新的主 Actor。先检查类，再决定 `catalog.clone` 或 `catalog.create`。

### 第四步：接入攻击与技能

每个主动技能按以下方向检查完整性：

```text
Button
  → Ability command
      → Effect entry
          → Search / Set / Damage / ApplyBehavior / CreateUnit / Persistent
              → Validator / Requirement / Behavior
```

每个技能至少验证：

- Ability 已加入英雄 `AbilArray`。
- Button 使用正确的 Ability command。
- Button 已进入 `CardLayouts`，Row/Column 不冲突。
- Effect 链所有引用存在。
- Validator 不会因为继承了敌方、剧情或 Mutator 条件而永远失败。
- 能量、冷却、目标过滤和自动施法符合设计。
- Actor 有对应的施法、弹道、命中和持续表现。

### 第五步：实现生命周期

推荐状态机：

```text
0 未初始化
  → 1 初次等待
  → 2 英雄存活
  → 3 阵亡等待
  → 2 重新生成
```

Galaxy 模块至少负责：

- 判断当前玩家是否选择目标指挥官。
- 初次等待时创建信标和冷却。
- 冷却结束时在信标位置创建英雄。
- 清除不应继承的剧情/敌方 Behavior。
- 将英雄注册到合作英雄面板。
- 监听死亡并清空旧 Unit 引用。
- 创建新的复生信标并开始复活冷却。
- 移除信标并更新 UI。

如果死亡单位会被引擎销毁，不要保存它并在稍后调用 `UnitRevive`。更稳妥的方式是死亡后清空引用，冷却结束时创建一个新的英雄单位。

Galaxy 数组语法是：

```galaxy
unit[16] heroByPlayer;
int[16] phaseByPlayer;
```

不是 C 风格的 `unit heroByPlayer[16]`。

### 第六步：制作复生信标和进度

复生信标应是独立、无战斗命令的临时 Unit，不要继承另一个英雄的完整复生 Unit。

最低要求：

- 独立 Unit parent 或已清理的通用 parent。
- 无攻击技能和无其他英雄命令卡。
- Invulnerable、Untargetable、NoScore。
- 独立 Actor、模型、肖像和名称。
- 与目标英雄一致的阵营视觉。
- 初次召唤和阵亡复活都走同一信标 API。

推荐直接用信标生命值表示进度：

```text
Life = 0.1
LifeRegen = LifeMax / duration
```

Actor 打开 Life 状态条并配置 `BarOffset`、`BarWidth`。这样进度来自实际状态，不会和另一个 UI 计时器漂移。

### 第七步：本地化

至少提供 `zhCN` 和 `enUS`：

- 英雄名称。
- 复生信标名称。
- 新 Ability/Button 名称与说明。
- 出生、阵亡和复活提示。

Unit 的 `Name` 字段必须显式指向自己的本地化键，否则可能继续显示 parent 的名称。

## 6. PatchPlan 组织方式

一个计划应表达一个可以独立解释的用户意图。初次实现可以是一份完整计划；后续修正使用依赖前一计划的新 PatchPlan，不篡改已应用计划和 receipt。

推荐操作顺序：

1. `catalog.create` / `catalog.clone` 建立对象。
2. `catalog.set` 冻结关键字段和属性。
3. `catalog.insert` 添加稳定索引的数组项。
4. `catalog.clear` 清理可枚举的继承数组。
5. `locale.set` 写文本。
6. `galaxy.source` 写完整、可独立验证的生命周期模块。
7. 只有无法结构化表达时才用 `file.patch`。

规则：

- 能写 `expect` 就必须写；新字段使用 `expect: null`。
- `catalog.clone` 只建立“新对象继承官方对象”的覆盖，不代表复制并冻结全部有效字段。
- 跨依赖继承的重要 Model、Portrait、状态条和 UI 字段应显式落地，避免运行环境差异。
- 新计划必须在 `dependsOn` 中列出它修改过的前置计划。
- Galaxy 源文件要有稳定路径、明确 init 函数和确定的注册顺序。

## 7. 本次阿塔尼斯实现得到的硬规则

### 7.1 主 Actor 的 XML 类必须正确

官方 `MutatorAmonArtanis` Actor 的类并不是可以无条件作为新英雄主 Actor 复用的安全模板。盲目 clone 曾产生错误 Actor 类和黑屏。新英雄主 Actor 应明确使用可工作的 `CActorUnit`，并显式配置核心表现字段。

### 7.2 Unit parent 会带来隐藏的数据

复生信标最初继承 `AlarakReviveBeacon`，即使 Galaxy 禁用了 Ability，阿拉纳克命令卡仍然显示。最终做法是切换到通用星灵信标 parent，并显式补齐生命、Flag 和属性。

不要用“运行时禁用技能”替代“数据层没有这些技能”。

### 7.3 Model 正确不等于身份正确

显式写入 `Alarak_COOP_RespawnBase` 解决了 fallback 球体，却仍然让信标看起来像阿拉纳克。最终需要独立的星灵模型、阿塔尼斯投影、图标、肖像和名称。

### 7.4 复活应创建新单位

死亡后的 Unit 可能已无效。保存旧引用再 `UnitRevive` 会导致复活流程失效。当前稳定方案是在死亡事件中清空引用，冷却结束后 `UnitCreate` 新英雄。

### 7.5 英雄状态条与普通状态条不同

只设置 Model 和 Portrait 会得到普通单位血条。合作英雄需要自定义状态框、Custom 状态条和 `SuppressDefaultStatusBar`。

### 7.6 信标进度可以复用生命系统

信标已有生命再生计时，因此只需显示 Life bar，不需要额外每帧更新 Dialog。初次四分钟和复活一分钟自然共用同一套进度逻辑。

### 7.7 Actor 消息参数必须使用引擎格式

`SetOpacity` 使用 `0.0` 到 `1.0`，不是百分数。`SetOpacity 55` 会产生 XML Actor 警告，正确示例是 `SetOpacity 0.550000`。

### 7.8 测试必须重新载入生成地图

核心源变化后，仅对已经打开的生成地图再次按测试快捷键，可能继续使用旧 Catalog。测试流程必须重建并让编辑器重新载入生成地图。

## 8. 验证清单

### 8.1 静态与构建验证

```powershell
node scripts/patch-plan.mjs path/to/hero.patch-plan.json --check --json
node scripts/patch-plan.mjs path/to/hero.patch-plan.json --json
node --test scripts/__tests__/patch-plan-executor.test.mjs
```

同时确认：

- PatchPlan 和 receipt 已写入 `game-a/patches`。
- 没有操作指向 `game-a/build`。
- Game A 结构验证和测试地图构建通过。
- EditorLogs 的 `XMLAlerts.txt` 没有新的错误。
- GameLogs 的 `ScriptError.txt`、`Alerts.txt` 没有新的未知错误。

### 8.2 必测运行场景

1. 选择其他指挥官：不应生成目标英雄或信标。
2. 选择目标指挥官：只生成一个初次信标。
3. 信标模型、名称、肖像、命令卡正确。
4. 进度条持续增长并在正确时间结束。
5. 英雄只生成一次，位置正确。
6. 英雄模型、状态条、技能、按钮、快捷键正确。
7. 杀死英雄：任务不应失败，旧引用应失效。
8. 只生成一个复生信标，复活时间正确。
9. 复活后英雄技能、状态、面板仍正确。
10. 重复死亡和复活至少两次。
11. 在不同宿主地图重建，英雄修改仍存在。

## 9. 完成标准

只有同时满足以下条件，才能向用户报告“英雄已完成”：

- 数据层没有借用其他英雄后泄漏的技能、名称或命令卡。
- 表现层没有 fallback 模型、普通状态条或错误肖像。
- 生命周期覆盖初次登场、死亡和至少一次复活。
- 进度与实际计时一致。
- PatchPlan 可重复检查，执行器测试通过。
- 编辑器和游戏没有由本次修改产生的新警告或脚本错误。
- 修改在可重建 Game A 核心中，而不是只存在于当前测试地图。

## 10. 参考实现顺序

阿塔尼斯当前实现按以下 PatchPlan 演进，可用于排查类似问题：

1. `artanis-hero-unit`
2. `artanis-hero-galaxy-array-fix`
3. `artanis-hero-revival-beacon`
4. `artanis-hero-runtime-spawn-fix`
5. `artanis-hero-visual-fix`
6. `artanis-hero-beacon-identity-fix`
7. `artanis-hero-summon-progress`
8. `artanis-hero-hologram-opacity-fix`

它们不是以后必须照抄的拆分方式，而是一条问题发现史。新英雄应尽量在第一份计划里就满足本文的完整检查清单。
