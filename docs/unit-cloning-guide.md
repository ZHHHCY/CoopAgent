# 合作单位完整复刻指南

本文总结 Game A 中将官方合作模式单位复刻为新 Unit ID 的实践经验。目标是得到一个可由指定指挥官正常生产、显示、操控和升级的独立单位，而不是机械地深拷贝整张 Catalog 引用图。

本指南以阿塔尼斯的 `Tempest` 复刻为 `GameAExampleArtanisTempest` 的实际过程为案例。对应计划：

- [`examples/commander-tools.patch-plan.json`](./examples/commander-tools.patch-plan.json)
- [`examples/commander-tools-vitals-fix.patch-plan.json`](./examples/commander-tools-vitals-fix.patch-plan.json)
- [`examples/commander-tools-visual-fix.patch-plan.json`](./examples/commander-tools-visual-fix.patch-plan.json)

## 1. “完整复刻”的定义

一个单位拥有新 `CUnit` 对象，只能说明 Catalog 中出现了一个新 ID，不代表复刻已经完成。

本文所说的完整复刻至少要求：

1. 指定指挥官能够从所有实际生产、折跃、变形或召唤入口得到新单位。
2. 其他指挥官和敌方仍使用原单位，不受克隆改动影响。
3. 新单位拥有正确的模型、出生动画、攻击表现、死亡表现和声音事件。
4. 名称、图标、线框、肖像和命令卡正常，不出现 `Bogus` 或纯色占位图。
5. 基础生命、护盾、能量以及出生时的当前值一致。
6. 原单位已有的武器、技能、Behavior、科技要求和玩家级升级按预期继续工作。
7. 后续需要单独修改的机制可以逐层克隆，而不会影响共享的官方对象。

“完整复刻”不等于“深拷贝所有引用”。默认共享官方 Weapon、Ability、Effect、Behavior、Validator 和 Model，通常更可靠。只有某一层需要独立修改时，才从该层开始克隆专属引用链。

## 2. 正确的心智模型

一个可玩的单位是多类对象共同组成的结果：

```text
生产、折跃、变形、召唤或 Galaxy
  └─ Unit ID
      ├─ Weapon ─ Effect 链
      ├─ Ability ─ Button ─ Requirement / Effect / Behavior
      ├─ Command Card
      ├─ Actor 的 unitName 绑定
      │   ├─ Model / BuildModel / PlacementModel
      │   ├─ On 事件、动画、声音和特效
      │   └─ Icon / Wireframe / Portrait
      ├─ 名称与本地化文本
      └─ 玩家 Upgrade、等级、威望和精通
```

因此必须分别验证“怎么产生”“产生什么”“如何显示”“如何升级”。只验证血量或只看到一个单位出现在地图上都不够。

## 3. 推荐的复刻顺序

### 3.1 确认源单位和所有产生入口

先从指挥官资料确定源 Unit ID，再沿引用查询真实入口。不能只按按钮名称猜测。

常见入口包括：

- `CAbilTrain.InfoArray[*].Unit`
- `CAbilWarpTrain.InfoArray[*].Unit`
- `CAbilBuild.InfoArray[*].Unit`
- Morph Ability 的目标 Unit
- Create Unit、Persistent、Set 等 Effect 链
- Galaxy 中的 `UnitCreate`
- 英雄首次部署和复活逻辑

同一个按钮可能存在普通与特殊两条路径。阿塔尼斯风暴战舰同时涉及：

```text
StargateTrain.InfoArray[Train10].Unit
StargateWarpTrain.InfoArray[Train10].Unit
```

只重定向普通星港会导致折跃星港继续生产原版单位。

有些替代 Ability 在合并 Catalog 中没有显式 `Unit` 字段，而是依赖引擎的配对或默认语义。此时不能伪造原值，PatchPlan 应使用 `expectAbsent: true` 声明字段原本不存在，再由指挥官专属 Upgrade 写入明确目标。

### 3.2 创建独立 Unit ID

新 Unit 以官方单位为 parent，保留未修改的数据语义：

```xml
<CUnit id="GameAExampleArtanisTempest" parent="Tempest"/>
```

这样可以继续共享原版武器、技能、移动、碰撞、费用、命令卡和 Behavior。不要一开始就展开复制源 `CUnit` 的全部字段，否则容易冻结官方依赖层中的默认值并制造重复数组。

新 ID 必须稳定且属于项目命名空间。后续计划应继续修改同一 ID，不应因为一次需求修订再创建第二个克隆。

### 3.3 用指挥官专属 Upgrade 重定向入口

共享 Ability 不能直接覆盖，否则敌人和其他指挥官可能同时受到影响。`commander.unit.clone` 通过隐藏玩家 Upgrade 将明确列出的生产或召唤字段改成新 Unit ID，并且只给匹配 `commanderId` 的玩家授予该 Upgrade。

重定向前必须验证：

- Catalog、对象和字段路径真实存在，或明确声明原字段不存在。
- 每条普通、折跃、变形和召唤路径都已覆盖。
- 敌方生成机制没有被改写。
- Upgrade 在指挥官选择确定后、单位首次生产前授予。

### 3.4 物化主 Actor，而不是只写 Actor parent

`CActorUnit` 通过 `unitName` 与 Unit ID 绑定。新单位必须拥有绑定到新 ID 的 Actor。

最初尝试使用了：

```xml
<CActorUnit
    id="GameAExampleArtanisTempest"
    parent="Tempest"
    unitName="GameAExampleArtanisTempest"/>
```

结果仍然出现 `Bogus` 球体。根因是原 `Tempest` Actor 没有显式 `Model` 字段，它依赖“Actor ID 与 Model ID 同名”的隐式规则选择 `Model/Tempest`。克隆 Actor 改变了 Actor ID，这条隐式链接也随之丢失。

可靠做法是物化复制源 `CActorUnit` 的完整配置：

1. 保留源 Actor 的真实 parent。
2. 将 Actor ID 改为新 Actor ID。
3. 将 `unitName` 改为新 Unit ID。
4. 复制 `On`、`Macros`、Model、声音、动画、图标、线框和肖像等字段。
5. 如果源 Actor 没有显式 Model，但存在与源 Actor 同名的 `CModel`，写入显式 `<Model value="源ActorID"/>`。

这一步不是复制 `.m3`、纹理或声音资产；新 Actor 仍引用用户合法安装的官方资源。

源 Actor ID 不一定等于源 Unit ID。遇到这种单位时，必须从数据库确认实际 `CActorUnit.unitName` 绑定，并分别指定 `sourceActor` 和 `actorId`，不能继续按同名规则猜测。

B97579 数据库对 166 个指挥官直接 Unit 成员的审计显示：全部都能找到某种 `unitName` Actor 绑定，但 37 个单位拥有多个 Actor 候选，且 `HHReaper`、`SIInfestedCivilian`、`SIInfestedMarine`、`TychusReaper`、`Viking` 没有“同 ID 的 `CActorUnit`”。因此执行器和 Agent 都不能把“Actor ID 等于 Unit ID”当成通用规则；必须从候选中选出实际主 `CActorUnit` 并显式记录。

### 3.5 显式处理名称和本地化

许多官方 `CUnit` 没有 `<Name>` 字段，而是隐式使用：

```text
Unit/Name/<UnitID>
```

新 Unit ID 没有对应文本时，界面会显示 `Unit/Name/Bogus` 或缺失键。若克隆单位暂时保持原名，应显式写入源名称键：

```xml
<Name value="Unit/Name/Tempest"/>
```

如果新单位需要新名称，则应创建项目自己的文本键，并至少验证 Game A 当前支持的语言。不要只改 Actor 名称；单位面板名称来自 Unit 的文本引用。

### 3.6 成对处理最大值和出生值

SC2 的生命、护盾和能量分别保存最大值与出生值：

| 最大值 | 出生值 |
| --- | --- |
| `LifeMax` | `LifeStart` |
| `ShieldsMax` | `ShieldsStart` |
| `EnergyMax` | `EnergyStart` |

只把 `LifeMax` 从 200 改成 450，可能得到当前生命仍为旧值、最大生命为 450 的单位。要让新单位满血出生，必须在设计上明确同时修改 `LifeStart`。

这不是执行器应当偷偷推断的规则。有些单位本来就故意以低于最大值的生命或能量出生，因此两项修改必须在 PatchPlan 中分别表达、分别验证原值。

### 3.7 判断官方升级是否会跟随克隆

不能仅凭 `CUpgrade.AffectedUnitArray` 判断升级是否对克隆有效，应查看实际 Requirement 和 EffectArray。

| 官方机制 | 克隆后的典型结果 | 原因 |
| --- | --- | --- |
| Unit 静态继承的 Ability、Weapon、Behavior | 通常继承 | 新 Unit 的 parent 是源 Unit |
| Requirement 检查玩家是否拥有某 Upgrade | 通常继承 | 检查玩家状态，不检查当前 Unit ID |
| Ability 或按钮由上述 Requirement 解锁 | 通常继承 | 克隆继续持有相同 Ability 和按钮 |
| `EffectArray Reference="Unit,Tempest,..."` | 不自动继承 | Effect 明确写死了原 Unit ID |
| 修改共享 Weapon、Effect 或 Ability 的 Upgrade | 可能继承 | 克隆仍引用相同对象，需检查具体 EffectArray |
| Actor 的同名 Model、隐式文本键 | 不可靠 | 新 ID 改变了隐式解析目标 |

阿塔尼斯的“衰变”是正面案例：克隆风暴战舰继承 `LightningBomb` Ability 和命令卡按钮；按钮要求 `HaveTempestDisintegration`，它检查玩家是否完成 `TempestDisintegration`，不检查单位是否仍叫 `Tempest`。因此克隆单位可以正常解锁衰变。

如果某项官方升级直接写死源 Unit ID，应根据需求选择：

- 给克隆单位追加等价的指挥官专属 Upgrade Effect；或
- 克隆并重定向被修改的 Weapon、Ability、Effect、Behavior 链。

不要因为 `AffectedUnitArray` 中只写了源单位就立即复制升级；该字段可能只是编辑器和界面元数据。

## 4. 哪些对象应该共享，哪些应该克隆

推荐从最小隔离开始：

| 对象层 | 默认策略 | 需要克隆的情况 |
| --- | --- | --- |
| Unit | 克隆 | 新单位需要独立 ID |
| 主 CActorUnit | 物化复制并重绑 | 完整单位克隆的必需项 |
| Model、纹理、声音资产 | 共享 | 需要全新美术资产时 |
| Weapon | 共享 | 需要独立伤害、攻速、目标规则时 |
| Ability | 共享 | 需要独立冷却、费用、施法方式时 |
| Effect / Behavior / Validator | 共享 | 需要改变实际机制且不能由玩家 Upgrade 隔离时 |
| Button | 共享 | 需要独立名称、图标、提示或 Requirement 时 |
| Requirement | 共享 | 解锁条件需要与原单位不同 |
| Galaxy | 不增加 | Catalog 无法表达生成、状态机或生命周期时 |

每克隆一层，都必须同步修改上游引用。比如克隆 Weapon 后，需要让新 Unit 的 `WeaponArray` 指向新 Weapon；克隆 Ability 后，需要处理 `AbilArray`、命令卡 `AbilCmd`、Button、Effect 和 Actor 事件。

## 5. PatchPlan 组织方式

一个基础的单位复刻计划应包含：

```json
{
  "opId": "clone-artanis-tempest",
  "kind": "commander.unit.clone",
  "commanderId": "ProtossArtanis",
  "sourceUnit": "Tempest",
  "unitId": "GameAExampleArtanisTempest",
  "redirects": [
    {
      "catalog": "Abil",
      "object": "StargateTrain",
      "path": "InfoArray[Train10].Unit",
      "expect": "Tempest"
    },
    {
      "catalog": "Abil",
      "object": "StargateWarpTrain",
      "path": "InfoArray[Train10].Unit",
      "expectAbsent": true
    }
  ]
}
```

同一计划还应声明基础完整性契约，让 `patch_plan_check` 验证执行后的结构，而不是只依赖文字检查表：

```json
{
  "postId": "artanis-tempest-clone-complete",
  "kind": "unit.clone",
  "commanderId": "ProtossArtanis",
  "sourceUnitId": "Tempest",
  "unitId": "GameAExampleArtanisTempest",
  "sourceActorId": "Tempest",
  "actorId": "GameAExampleArtanisTempest",
  "entrypoints": [
    {
      "kind": "catalog",
      "catalog": "Abil",
      "object": "StargateTrain",
      "path": "InfoArray[Train10].Unit"
    },
    {
      "kind": "catalog",
      "catalog": "Abil",
      "object": "StargateWarpTrain",
      "path": "InfoArray[Train10].Unit"
    }
  ],
  "vitalPolicy": "full-start",
  "nameKey": "Unit/Name/Tempest"
}
```

检查器会从源 Actor 的直接定义自动推导非空的头像、图标、线框、肖像、建造/放置模型、状态栏和小地图字段，并验证目标仍然存在这些字段；Model/Portrait 等 Catalog 引用还必须指向真实对象。它不会把通用 Actor 父类的默认字段全部强加给特殊单位。`requiredActorFields` 只用于补充“源 Actor 没有直接写出、但本次设计明确要求”的额外字段，不再要求 Agent 手工重抄常见表现清单。主 `Model` 无论是否列出都会检查。纯继承复刻使用 `preserve-source`，要求满生命、满护盾和满能量出生时使用 `full-start`。该契约目前不证明全部 Upgrade、特殊 Actor 事件和动态 Galaxy 生命周期，仍需按第 3.7 节及目标检查表逐项确认。

目标数值通过独立的 `commander.stat.set` 表达。需要满生命出生时，最大值和出生值分别写操作：

```json
{
  "kind": "commander.stat.set",
  "commanderId": "ProtossArtanis",
  "catalog": "Unit",
  "object": "GameAExampleArtanisTempest",
  "path": "LifeMax",
  "expect": 200,
  "value": 450
}
```

```json
{
  "kind": "commander.stat.set",
  "commanderId": "ProtossArtanis",
  "catalog": "Unit",
  "object": "GameAExampleArtanisTempest",
  "path": "LifeStart",
  "expect": 200,
  "value": 450
}
```

已经应用的计划视为历史记录，不应修改原文件后复用相同 ID。修正应创建新计划，并通过 `dependsOn` 声明它建立在哪些已应用计划之上。若修正继续写相同结构化目标，需要把会发生目标重叠的既有计划直接列入依赖。

## 6. 常见故障与定位

| 现象 | 首要检查点 |
| --- | --- |
| 单位没有生成 | 生产、折跃、变形、召唤或 Galaxy 入口是否全部重定向 |
| 普通建筑能生产，替代建筑仍生产原版 | 是否漏掉 `CAbilWarpTrain` 等第二入口 |
| 出现彩色球体或 `Bogus` 模型 | 主 Actor 是否绑定新 `unitName`；是否补齐隐式同名 Model |
| 名称显示 `Unit/Name/Bogus` | 新 Unit 是否显式写入源名称键或新本地化键 |
| 图标、线框或肖像是纯色块 | 是否只创建了空 Actor，而没有物化复制完整 Actor UI 字段 |
| 最大生命正确但出生不满血 | 是否只改了 `LifeMax`，遗漏 `LifeStart` |
| 技能存在但按钮不显示 | `AbilArray`、`CardLayouts`、Button、Requirement 是否完整 |
| 技能按钮显示但不可使用 | 玩家 Upgrade、Requirement、费用、Validator 和目标过滤器是否满足 |
| 官方某项数值升级没有作用 | EffectArray 是否把源 Unit ID 写死 |
| 攻击有效但没有弹道、音效或动画 | Actor 的 `On`、Action Actor、Missile Actor 和 Effect 事件是否完整 |
| 敌人或其他指挥官也被修改 | 是否直接覆盖了共享 Catalog，而没有使用指挥官专属 Upgrade 或克隆 |

## 7. 分层验收清单

### 7.1 数据证据

- [ ] 源 Unit ID 来自合作模式数据库的强证据。
- [ ] 已列出全部普通和替代生产入口。
- [ ] 已确认主 `CActorUnit` 及其真实 `unitName`。
- [ ] 已确认源 Actor 的 Model 是显式字段还是同 ID 隐式链接。
- [ ] 已检查名称键、Ability、Weapon、Behavior、Requirement 和 Upgrade 引用。
- [ ] 已区分玩家级升级与写死源 Unit ID 的 EffectArray。

### 7.2 PatchPlan 与生成物

- [ ] 新 Unit ID 和 Actor ID 稳定且无冲突。
- [ ] 每个 redirect 都有 `expect` 或 `expectAbsent`。
- [ ] Unit 显式拥有正确名称键。
- [ ] Actor 完整绑定新 Unit，并拥有有效 Model、图标、线框和事件。
- [ ] 最大值与出生值根据设计分别表达。
- [ ] 后续修正使用新计划 ID 和明确 `dependsOn`。
- [ ] `--check` 通过，正式应用后再次 `--check` 为零改动。

### 7.3 实机

- [ ] 通过 Game A 启动器构建新地图版本并重新加载；编辑器进程可以保持运行。
- [ ] 指定指挥官从每种入口生产出的都是新 Unit ID。
- [ ] 模型、名称、图标、线框、肖像和选择框正常。
- [ ] 出生时生命、护盾和能量符合设计。
- [ ] 移动、攻击、受伤、死亡和相关特效正常。
- [ ] 原有技能和研究解锁正常，例如风暴战舰“衰变”。
- [ ] 敌方同类单位仍为原版。
- [ ] 其他指挥官不获得该克隆和专属数值。
- [ ] Game A 结构验证、构建检查和运行日志无新增错误。

## 8. 当前结论

完整复刻单位最容易漏掉的不是 Unit 数值，而是 ID 变化带来的隐式语义：生产入口、Actor 到 Model 的同名关系、名称文本键，以及最大值与出生值的分离。

可靠的实现原则是：

1. 用数据库查全入口与引用，不按界面表象猜测。
2. 用新 Unit ID 隔离机制修改。
3. 用指挥官专属 Upgrade 隔离生产重定向和数值。
4. 物化复制主 Actor，并显式恢复所有依赖旧 ID 的隐式链接。
5. 默认共享下游对象，只在需要改变机制时逐层克隆。
6. 用分层实机验收确认“可生产、可显示、可操控、可升级、不会污染原版”。
