# PatchPlan v2

## 数值字段与威望条件（2026-09-10）

- `CUpgrade.EffectArray` 是记录。数值地址使用 `EffectArray[n].@Value`；记录本身不能用于 numeric catalog.set。查询会将旧数据库展示路径 `EffectArray[#n]` 映射为这一明确的写入地址，无需重新解析 CASC。
- `commander.stat.set` 可指定 `prestigeUpgrade`：该指挥官现有威望的 Upgrade ID（查 commander.get.prestiges）。生成的玩家 Upgrade 只在此威望激活时授予。用于开局固定威望，不承诺动态研究/游戏中切换条件。
- 条件参与生成对象身份，原先不带条件的对象 ID 不变。查询同一条件下的当前编辑值时，传入相同 `prestigeUpgrade`。
- 后端对明确、单一、肯定的 P1/P2/P3 任务描述检查玩家数值操作是否携带相应条件；它不是通用自然语言语义验证器，直接修改原有 Upgrade/Behavior 的适用范围仍需原有作用域检查与独立验收。
- `entity.get` 字段列表返回 offset/nextOffset；按数值顺序排列数组下标。full 不表示取消分页，需读取后续页或缩小字段前缀。


PatchPlan 是 CoopAgent 对地图运行层执行修改时使用的机器可读清单。它描述“改哪里、原值应是什么、改成什么”，而不描述 Agent 的推理过程。

当前推荐格式是 v2，其 JSON Schema 是 [`patch-plan-v2.schema.json`](./schemas/patch-plan-v2.schema.json)。v1 的 [`patch-plan.schema.json`](./schemas/patch-plan.schema.json) 已冻结并继续兼容。Schema 与本文冲突时，以对应版本的 Schema 为准。

本文定义执行格式，不规定调查顺序。当前入口使用 `plan_prepare` / `plan_submit`，由后端预检并原子应用；操作流程见 [Scalar Skill](../.opencode/skills/coop-scalar-change/SKILL.md)。下文旧完整创作工具与示例仅作格式兼容参考。每轮交付选定一份最终计划，包含本轮目标及使其正确生效所需的全部配套；独立遗漏如实记录，可在用户反馈后的下一轮继续处理。

v1 可执行示例见 [`raynor-hyperion-catalog.patch-plan.json`](./examples/raynor-hyperion-catalog.patch-plan.json)，v2 结构化示例见 [`elite-marine.patch-plan.json`](./examples/elite-marine.patch-plan.json)。

## 1. 边界

PatchPlan v1/v2 都只写入 `game-a/core/GameA.SC2Mod`，其 `target` 固定为 `game-a.core`。

- 官方 CASC 和合作模式数据库是只读输入。
- `game-a/projects` 中的宿主任务源不属于 PatchPlan 的普通修改目标。
- `game-a/build` 是可重建产物，任何操作都不得指向它。
- 复杂机制直接使用 Galaxy 源码，不在 JSON 中重新设计一套脚本语言。
- 必须修改宿主任务时，使用未来单独定义的 host plan，不能把宿主路径伪装成 `file.patch`。

这样，同一份指挥官修改可以接入不同宿主地图，不会意外绑定湮灭快车。

## 2. 顶层结构

```json
{
  "$schema": "./schemas/patch-plan-v2.schema.json",
  "formatVersion": 2,
  "id": "raynor-permanent-hyperion",
  "title": "雷诺：常驻休伯利安",
  "userSummary": {
    "text": "将雷诺的休伯利安改为常驻英雄单位。"
  },
  "target": "game-a.core",
  "compatibility": {
    "sc2DataBuild": "B97579",
    "runtimeContract": 2
  },
  "scope": {
    "kind": "commander",
    "commanderId": "TerranRaynor"
  },
  "isolation": {
    "strategy": "player-upgrade"
  },
  "dependsOn": [],
  "conflictsWith": [],
  "operations": []
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `$schema` | 可选，指向本仓库的 PatchPlan Schema。 |
| `formatVersion` | PatchPlan 格式版本；当前推荐 `2`。 |
| `id` | 稳定、唯一的 kebab-case 标识，也是默认生成文件名的一部分。 |
| `title` | 给用户看的简短名称。 |
| `userSummary.text` | 一句话描述整份计划带来的用户可见结果；新计划必填，历史计划通过独立摘要索引兼容。 |
| `target` | 固定为 `game-a.core`。 |
| `compatibility.sc2DataBuild` | 生成计划时所依据的 SC2 数据构建号。 |
| `compatibility.runtimeContract` | 地图运行层运行契约版本。 |
| `scope` | v2 可选；新计划应明确声明修改只属于某个指挥官，还是有意全局生效。旧计划省略时继续兼容。 |
| `isolation` | v2 可选；与 `scope` 配套记录实际隔离策略。声明其中任一字段时必须同时声明另一个。 |
| `dependsOn` | v2 可选；必须已经应用并拥有 receipt 的前置计划。 |
| `conflictsWith` | v2 可选；不能同时存在的计划。 |
| `postconditions` | v2 可选；声明本计划完成后必须成立的机械可验证关系。历史计划无需补写。 |
| `operations` | 按数组顺序执行的操作，至少一项。 |

未知字段一律视为错误，避免拼写错误被静默忽略。

### 2.1 用户改动摘要

每份新 PatchPlan v2 必须包含一个 `userSummary.text`。它是修改历史中的一条用户意图记录，不是执行器操作清单：一份创建英雄的计划应写“为阿塔尼斯新增可部署并可复生的英雄单位”，而不是逐条罗列模型、头像、技能和源码文件。纯数值修改保留准确的“原值 → 新值”。摘要限制为单行 4–160 字符，并随计划一起进入哈希和 receipt 追踪。

已应用的历史计划不能直接补写该字段，否则会改变计划哈希。它们的人工摘要保存在 `game-a/patches/user-summaries.json`，通过 `planId` 关联，且不参与原 receipt 的完整性校验。

### 2.2 作用域与隔离契约

新生成的 v2 计划必须先声明用户要求的真实作用域。根据实际字段、条件和共享消费者选择最小实现：玩家数值 Upgrade、已有私有 Catalog 字段或必要的局部隔离。数值需求不是操作白名单，不默认克隆单位或所有依赖。查询中的可编辑前置条件与执行器校验才是具体证据；执行器继续兼容旧计划，不暗中迁移或补全设计。

全部操作使用 commander.stat.set 时，声明玩家 Upgrade 策略：

```json
{
  "scope": {
    "kind": "commander",
    "commanderId": "ProtossArtanis"
  },
  "isolation": {
    "strategy": "player-upgrade"
  }
}
```

直接 Catalog 写入若有证据证明 owner 已私有，可声明 direct-private；需要隔离共享数据时，才私有化实际变化的 owner 和必要依赖并声明 private-clone：

```json
{
  "scope": {
    "kind": "commander",
    "commanderId": "ProtossArtanis"
  },
  "isolation": {
    "strategy": "private-clone",
    "owner": {
      "catalog": "Unit",
      "object": "Dragoon"
    }
  }
}
```

`private-clone` 计划不得直接写入数据库中的官方 owner 或共享依赖。普通生产、训练和召唤链中的 Unit owner 优先通过 `commander.unit.clone` 私有化；由专属 Galaxy 生命周期或其他新建对象接入的 Unit 可以使用 `catalog.clone`，但必须在同一计划里显式重连。需要变化的下游对象同样用 `catalog.clone` 创建副本，并由明确引用连接到私有上游。`impact.analyze` 会把 Unit owner 的入向引用分为创建、Requirement、升级成长、表现、配置和其他消费者；只有可写的创建入口会生成 redirect 候选。`patch_plan_check` 会拒绝“声明私有克隆、实际却修改官方对象”、克隆后没有接入任何创建/复活入口，以及把 `[#n]` 查询序号直接当成 redirect 路径的计划。

完全由 Galaxy 按玩家保存状态、过滤事件并执行生命周期的机制使用：

```json
{
  "scope": {
    "kind": "commander",
    "commanderId": "ProtossArtanis"
  },
  "isolation": {
    "strategy": "player-runtime"
  }
}
```

`player-runtime` 不允许借 Galaxy 名义直接改写官方共享 Catalog 对象；配套 Catalog 数据必须是计划新建的私有对象，或另行使用可证明的隔离策略。

只有数据库证据支持对象归属当前指挥官、且计划愿意保留无法证明敌方/Galaxy 使用的警告时，才使用：

```json
{
  "isolation": {
    "strategy": "direct-private",
    "owner": {
      "catalog": "Abil",
      "object": "ArtanisOnlyAbility"
    }
  }
}
```

用户明确要求所有消费者都改变时使用全局作用域：

```json
{
  "scope": { "kind": "global" },
  "isolation": { "strategy": "global" }
}
```

旧计划可以省略这两个字段；一旦声明 `scope`，缺少 `isolation` 会被静态审查拒绝。`impact.analyze` 可接收 `scope`、`owner`、`changeType` 和 `includeIsolationPlan: true`，返回有限引用图上的 owner 路径、范围外消费者、克隆候选、重连候选与 `ownerEntrypoints`。结果的 `bounded-no-proven-leak` 只表示当前证据没有发现泄漏，不表示已经排除 Galaxy、敌方编成或引擎默认引用。

### 2.3 语义后置条件

`postconditions` 描述计划承诺的最终关系，不重复列出写文件步骤，也不替 Agent 决定技能设计。当前支持七种可组合条件：

| `kind` | 证明内容 |
| --- | --- |
| `unit.ability` | Unit 与 Ability 存在，且 Ability 已挂入 Unit 的 `AbilArray`。适合刻意隐藏、由 Galaxy 或其他机制调用的技能。 |
| `unit.command` | 在 `unit.ability` 基础上，存在匹配的 `AbilCmd` 命令卡项和 Button。 |
| `unit.autocast` | 在 `unit.command` 基础上，Ability 支持自动施法，并可选验证默认开关状态。 |
| `unit.passive` | Unit 存在匹配的 `Type=Passive` 命令卡项和 Button。 |
| `ability.effect-chain` | Ability 的指定字段连接到声明的根 Effect；所有声明的必经 Effect 可达，且发现的 Effect 引用目标存在。 |
| `localization.present` | 声明的本地化键在数据库、当前核心或本计划投影中非空；可选验证精确文本。 |
| `unit.clone` | 新 Unit 继承指定源 Unit，主 Actor 是绑定到新 Unit 的 `CActorUnit`，模型和名称可解析，并且声明的生产、召唤、复活或 Galaxy 创建入口已连接。检查器会从源 Actor 的直接定义自动推导需保留的表现字段，并可声明额外字段和出生值策略。 |

例如，一个要求初始开启自动施法的治疗技能可以声明：

```json
{
  "postconditions": [
    {
      "postId": "medic-heal-visible-and-autocast",
      "kind": "unit.autocast",
      "unitId": "Medic",
      "abilityId": "heal",
      "command": "Execute",
      "buttonId": "MedicHeal",
      "cardIndex": 0,
      "row": 2,
      "column": 0,
      "requirementId": "NotHaveStabilizerMedPacks",
      "defaultOn": true
    }
  ]
}
```

`cardIndex`、`row`、`column` 都是可选的：只有槽位本身属于设计结果时才声明。`requirementId` 省略表示本计划不对门槛作断言；字符串表示命令卡项或 Ability 命令必须使用该 Requirement；`null` 表示两处都不得设置 Requirement。

新增或替换技能时，可为明确的 Effect 入口和本地化结果补充独立契约：

```json
{
  "postconditions": [
    {
      "postId": "heal-effect-chain",
      "kind": "ability.effect-chain",
      "abilityId": "GameAHeal",
      "effectPath": "Effect[0]",
      "rootEffectId": "GameAHealSet",
      "requiredEffectIds": ["GameAHealModifyUnit"]
    },
    {
      "postId": "heal-localization",
      "kind": "localization.present",
      "entries": [
        { "locale": "zhCN", "key": "Button/Name/GameAHeal", "expected": "战地治疗" },
        { "locale": "zhCN", "key": "Button/Tooltip/GameAHeal" },
        { "locale": "enUS", "key": "Button/Name/GameAHeal" },
        { "locale": "enUS", "key": "Button/Tooltip/GameAHeal" }
      ]
    }
  ]
}
```

`ability.effect-chain` 不假设所有 Ability 都使用 `Effect[0]`；`effectPath` 必须来自该技能的实际结构。`requiredEffectIds` 只列用户结果所必需的节点。检查器沿数据库、当前核心和本计划可见的 Effect→Effect 引用做有界遍历，不替 Agent 猜测完整玩法设计。

完整克隆单位时，必须同时声明一个与 `commander.unit.clone` 根操作精确对应的契约：

```json
{
  "postconditions": [
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
          "path": "InfoArray[Train10].Unit[0]"
        }
      ],
      "vitalPolicy": "full-start",
      "nameKey": "Unit/Name/Tempest"
    }
  ]
}
```

`sourceActorId` 必须来自实际 `CActorUnit.unitName` 绑定，不能默认等于 Unit ID。`entrypoints` 只声明用户确实需要且计划已经重连的入口；Catalog 项必须匹配 `commander.unit.clone.redirects`，Galaxy 项必须匹配同一计划中显式 `UnitCreate` 新 Unit ID 的 `galaxy.source`。检查器会自动读取源 Actor 的直接定义，推导非空的头像、图标、线框、肖像、建造/放置模型、状态栏和小地图字段；继承自通用父类的默认字段不会被强制套用。`requiredActorFields` 仅用于补充那些虽非源 Actor 直接字段、但本次设计明确要求存在的字段。`vitalPolicy: "preserve-source"` 要求最大值与出生值各自保持源单位语义；`"full-start"` 要求每个实际存在的生命、护盾和能量最大值都等于对应出生值。刻意残血或空能量出生时不要声明 `full-start`，而应按设计分别写值。

当 `unit.command`、`unit.autocast` 或 `unit.passive` 声明字符串 `requirementId` 时，检查器还会对 Requirement 布尔树做保守常量折叠。只有某个已声明阶段能被静态证明恒为 false 时才报 `requirement-permanently-locked`；依赖玩家单位、升级或其他运行状态的表达式保持 `unknown`，不会被误判为失败。

执行器在真实临时核心中执行计划后，用共享 Catalog 解释层读取实际产物并验证后置条件；同时审计实际文件/字段差异。`plan_prepare`、诊断 `patch_plan_check` 和直接执行器入口都经过这些强制检查。旧 review 的计划预测模式只供诊断，不作为提交凭据。后置条件失败产生 `POSTCONDITION_NOT_SATISFIED`；需要官方数据的检查在缺少数据库时阻止执行。后置条件是按任务选择的断言，不是全局模板：没有声明的历史对象不会被强制重塑。它不证明玩法结果、动态 Requirement 真值、全部官方 Upgrade 对新 Unit ID 的作用、动画或手感。准备只保存并预演不可变计划，显式提交才创建后台应用任务；成功后由 Receipt 记录实际结果。

## 3. 通用规则

每项操作必须有在当前计划内唯一的 `opId` 和固定的 `kind`。`opId` 只用于诊断、执行记录和错误定位，不决定执行顺序。

`expect` 是可选的前置值：

- 有 `expect` 时，执行器先从“官方数据库 + 当前地图运行层核心覆盖 + 本计划此前操作”解析当前有效值。
- 当前值不同且也不等于目标值时，整份计划失败。
- 当前值已经等于目标值时，该操作视为已完成，因此重复执行同一计划不会重复追加内容。
- `expect: null` 表示该字段或本地化键原本不存在。
- 没有 `expect` 时仍执行，但安全性较低，执行记录必须标记为未校验写入。

所有路径使用 `/`，必须相对于地图运行层核心根目录，禁止绝对路径、`..` 和反斜杠。

## 4. 操作

### 4.1 `catalog.set`

设置现有 Catalog 对象的一个标量字段或 XML 属性。

```json
{
  "opId": "hyperion-mineral-cost",
  "kind": "catalog.set",
  "catalog": "Abil",
  "object": "VoidCoopSummonHyperion",
  "path": "Cost[0].Resource[Minerals]",
  "expect": 0,
  "value": 400
}
```

Catalog 路径采用编辑器式字段路径：

- `Field`：普通字段。
- `Field[0]`：以数字 `index` 选择数组项。
- `Field[Minerals]`：以名字 `index` 选择数组项。
- `Field.@Attribute`：选择 XML 属性，例如 `Cost[0].Cooldown.@TimeUse`。
- 点号表示嵌套，例如 `Cost[0].Resource[Vespene]`。

对象的具体 XML 类（例如 `CAbilEffectTarget`）由合作模式数据库解析，不在计划中重复填写。

### 4.2 `catalog.remove`

从有效 Catalog 中移除一个有索引的数组项。它不是删除生成文件中的一行，而是生成 SC2 的 `removed="1"` 覆盖。

```json
{
  "opId": "remove-hyperion-timed-life",
  "kind": "catalog.remove",
  "catalog": "Effect",
  "object": "HyperionVoidCoopSpawnSet",
  "path": "EffectArray[1]"
}
```

`catalog.remove` 的路径必须指向带 `index` 的数组项。

### 4.3 `galaxy.source`

写入一份完整的 UTF-8 Galaxy 模块，并登记到 `GameA.Core.json`。源码路径必须位于 `Base.SC2Data` 下且以 `.galaxy` 结尾。

```json
{
  "opId": "write-hyperion-runtime",
  "kind": "galaxy.source",
  "path": "Base.SC2Data/Generated/RaynorHyperion.galaxy",
  "source": "void GameA_RaynorHyperionInit () {\n    // generated Galaxy logic\n}\n",
  "register": {
    "order": 200,
    "init": "GameA_RaynorHyperionInit"
  }
}
```

`order` 决定 include 与初始化顺序；同一 order 再按路径排序。`init` 可省略，表示模块只提供声明或函数，不需要启动调用。相同路径的不同内容和重复 init 函数会被视为冲突，不静默覆盖其他计划。

### 4.4 `locale.set`

设置一个 GameStrings 键。目标文件由 locale 自动确定为 `<locale>.SC2Data/LocalizedData/GameStrings.txt`。

```json
{
  "opId": "hyperion-tooltip-zh-cn",
  "kind": "locale.set",
  "locale": "zhCN",
  "key": "Button/Tooltip/SummonHyperionVoid",
  "value": "花费400晶体矿和400高能瓦斯部署休伯利安号。"
}
```

同一文件中的其他键和顺序必须保留；同一个键最终只能保留一行。

### 4.5 `file.patch`

对核心目录中已经存在的 UTF-8 文本文件应用 unified diff。这是逃生口，只在结构化操作无法表达修改时使用。

```json
{
  "opId": "patch-special-core-hook",
  "kind": "file.patch",
  "path": "Base.SC2Data/GameACore.galaxy",
  "baseSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "patch": "@@ -10,1 +10,1 @@\n-old line\n+new line\n"
}
```

`baseSha256` 必填。只允许修改既有文本文件，不创建、删除、重命名文件，也不处理二进制内容。补丁不能干预 `game-a/build` 或宿主任务。

### 4.6 `catalog.create`（v2）

创建全新的 Catalog 对象。`class` 是真实 SC2 XML 类，因此该操作不需要靠执行器猜测对象类型。

```json
{
  "opId": "create-elite-stim",
  "kind": "catalog.create",
  "catalog": "Abil",
  "object": "GameAEliteStim",
  "class": "CAbilEffectInstant",
  "parent": "StimPack"
}
```

`parent` 可省略。目标 ID 已存在但 class 或 parent 不同时视为冲突。

### 4.7 `catalog.clone`（v2）

以 SC2 原生继承方式克隆既有对象。它创建同 XML 类的新对象，并将 `parent` 指向 `source`，不会把源对象展开复制一遍。

```json
{
  "opId": "clone-marine",
  "kind": "catalog.clone",
  "catalog": "Unit",
  "source": "Marine",
  "object": "GameAEliteMarine"
}
```

后续 `catalog.set`、`catalog.insert` 可以继续修改新对象。这样生成结果更小，也会保留 SC2 的继承语义。

### 4.8 `catalog.insert`（v2）

向既有对象的索引数组中加入一项。`path` 指向不带 index 的数组字段，index 单独声明。

```json
{
  "opId": "add-elite-stim",
  "kind": "catalog.insert",
  "catalog": "Unit",
  "object": "GameAEliteMarine",
  "path": "AbilArray",
  "index": 6,
  "attributes": {
    "Link": "GameAEliteStim"
  }
}
```

`Unit.AbilArray` 和 `Unit.CardLayouts[].LayoutButtons` 的 `index` 是 SC2 的数字数组槽，不是 Ability 或 Button ID。Ability ID 应写入 `Link` 或 `AbilCmd`。数据库中的 `[#n]` 表示官方数据里未显式编号的顺序项，不能直接作为 PatchPlan 路径；插入前应把同一有效数组中的顺序项计入占用，并选择下一个空闲数字槽。

可以使用 `value`、`attributes` 或两者。目标 index 已存在且内容相同时视为已完成，内容不同时停止执行。

### 4.9 `catalog.clear`（v2）

清空一个有索引的有效数组。执行器先合并继承链中的 index，再为每个有效项生成明确的 `removed="1"` 覆盖。

```json
{
  "opId": "clear-command-card",
  "kind": "catalog.clear",
  "catalog": "Unit",
  "object": "GameAEliteMarine",
  "path": "CardLayouts[0].LayoutButtons"
}
```

这不是删除本地 XML 节点，而是真正清除继承后的数组。无法枚举继承项时执行器会停止，不会假装清空成功。

### 4.10 `commander.stat.set`（v2）

为一个指挥官设置玩家专属的数值，不直接覆盖共享的官方 Catalog 对象。执行器生成稳定命名的隐藏
`CUpgrade`，在地图运行层确认指挥官选择后只授予匹配的指挥官玩家。

携带 `prestigeUpgrade` 时，后端从已经提交的威望选择读取
`PlayerPrestige.PrimaryUpgrade` 并匹配该 ID，不等待官方威望 Upgrade 等级变为 1。
生成回调仍在官方 `CC_ApplyTech` 之前运行，保留后续自动 Add/Multiply 的顺序；
生成 Upgrade 的等级检查只负责防止重复授予。这不是游戏中动态切换威望机制，也不保证
任意字段的最终值等于 Set 参数（后续自动修正仍需依据字段影响证据判断）。

旧版基于官方 Upgrade 等级判断的生成脚本，可由**新依赖计划**在修改同一目标时迁移：
只接受与旧生成模板完全一致的脚本（允许 CRLF），以原字节 SHA-256 校验后在事务内替换，
并沿用原 Upgrade ID。手改脚本不自动覆盖。仅修复激活时使用当前值作为 `expect` 和 `value`，
声明 `dependsOn` 指向之前的计划；新 Receipt 记录脚本变化，旧 Receipt 保持不变。
重复提交旧计划不会偷偷迁移历史产物，会提示创建新依赖计划。旧地图必须重建后才包含修复。

```json
{
  "opId": "set-artanis-tempest-life",
  "kind": "commander.stat.set",
  "commanderId": "ProtossArtanis",
  "catalog": "Unit",
  "object": "Tempest",
  "path": "LifeMax",
  "expect": 300,
  "value": 450
}
```

`expect` 和 `value` 都必须是数值。生成的 Upgrade 使用 `Operation="Set"`；相同指挥官、Catalog
对象和字段路径始终映射到同一个生成 Upgrade，因此后续依赖计划可以修订该值，而不会叠加多份隐藏升级。
该操作适合生命、护盾、伤害、射程、冷却等 SC2 Upgrade 能表达的字段；不能表达的结构变化必须使用克隆。

### 4.11 `commander.unit.clone`（v2）

以官方单位为 parent 创建指挥官专属 Unit，并使用玩家专属隐藏 Upgrade 重定向明确列出的生产或召唤字段。

```json
{
  "opId": "clone-artanis-tempest",
  "kind": "commander.unit.clone",
  "commanderId": "ProtossArtanis",
  "sourceUnit": "Tempest",
  "unitId": "GameAArtanisTempest",
  "redirects": [
    {
      "catalog": "Abil",
      "object": "StargateTrain",
      "path": "InfoArray[Train10].Unit[0]",
      "expect": "Tempest"
    }
  ]
}
```

`redirects` 至少一项，每项都必须通过 `expect` 给出原值，或用 `expectAbsent: true` 声明该字段原本不存在。至少一个 redirect 必须命中数据库证明的训练、建造、变形、召唤、初始单位或复活入口；或者同一计划的 `galaxy.source` 必须显式创建新 Unit ID。Upgrade、Requirement、配置和表现引用不能单独证明新单位可到达。`[#n]` 是只读序号证据，不能作为 redirect 路径。执行器只重定向计划明确列出的引用，不猜测其他链。新 Unit 默认继续继承源单位；需要改变的 Weapon、Ability、Effect 或 Behavior 应由同一计划中的 `catalog.clone`/`catalog.set` 继续创建专属对象链。

默认情况下，执行器还会物化复制与源单位同 ID 的完整 `CActorUnit`，将其 `unitName` 重绑到新单位，并把依赖“Actor ID 与 Model ID 同名”的隐式模型链接改写成显式 `Model` 字段；同时给新 Unit 写入源单位的名称键。这样克隆单位不会回退成 `Bogus` 模型或 `Unit/Name/Bogus`。源 Actor 或目标 Actor 使用不同 ID 时，可分别通过 `sourceActor` 和 `actorId` 指定。

`LifeMax`、`ShieldsMax`、`EnergyMax` 只表示上限；需要单位以新上限出生时，计划还必须显式设置对应的 `LifeStart`、`ShieldsStart`、`EnergyStart`。执行器不会把这类机制选择隐式合并。

## 5. 执行语义

执行器必须按以下流程处理整份计划：

1. 用 JSON Schema 校验结构，并检查 `formatVersion`、SC2 build 和运行契约。
2. 解析全部路径、Catalog 对象、字段与前置值；这一阶段不写文件。
3. 在临时工作树中按 `operations` 顺序执行。
4. 生成或更新 Catalog XML、本地化文件、Galaxy 模块和 `GameA.Core.json`。
5. 运行地图运行层结构验证和构建检查。
6. 全部成功后一次性替换核心源；任一步失败都不得留下部分写入。

一份计划中的后续操作看到前面操作产生的值。多个操作写同一目标时，除非后一个操作的 `expect` 明确匹配前一个结果，否则视为冲突。

v2 在计划之间增加两层保护：

- `dependsOn` 和 `conflictsWith` 表达显式关系。
- 执行器读取已应用计划的 receipt；两个无依赖关系的计划写入同一结构化目标时自动报冲突。
- `commander.unit.clone` 会展开记录指挥官源单位、新 Unit、新 Actor 和全部 redirect 目标；Receipt
  同时保留兼容字段 `target` 与完整数组 `targets`。冲突检查和 `search.patches.for_target` 共用
  同一套目标生成与父子字段冲突规则。
- 同一计划重复写入同一标量目标时，后一项必须用 `expect` 明确承接前一项的结果。

地图运行层构建器还生成 `GameA_GeneratedConfigureCommander()`。它在准备页面确定指挥官之后调用各模块
登记的 configure 回调，使 `commander.stat.set` 和 `commander.unit.clone` 的隐藏 Upgrade 不会授予敌方玩家。

### 命令行入口

只预演，不修改核心：

```bat
scripts\patch-plan.cmd docs\examples\raynor-hyperion-catalog.patch-plan.json --check
```

应用已经确认的计划：

```bat
scripts\patch-plan.cmd path\to\change.patch-plan.json
```

如果计划首次覆盖一个官方对象，执行器需要从 CASC 数据库产物确定对象的 XML 类和继承值：

```bat
scripts\patch-plan.cmd path\to\change.patch-plan.json --catalog-root path\to\merged\GameData
```

也可以用 `COOPAGENT_CATALOG_ROOT` 环境变量设置默认目录。对象已经存在于地图运行层核心覆盖中时不需要重复提供数据库。`--check` 和正式应用都会在临时副本中运行地图运行层结构验证及构建检查；只有正式应用全部通过后才会替换核心源。

## 6. 保存与生成结果

字段可读取不等于可安全生成稀疏覆盖。查询与执行器共享字段编辑契约：由 `Id` 标识的 UserData 实例不能使用 ordinal 数字索引替代身份；此时返回 `identity-selector-required`。未经适配或引擎证据支持的其他序号布局返回 `ordinal-index-unverified`。执行器独立校验基线及现有核心覆盖，修改 expect、提交相等值或已有稀疏覆盖不能绕过检查。只有具体布局支持得到验证后才能开放相应写入。

B97579 精通 PointIncrement 已支持窄范围身份适配，例如 `Instances[18:ArtanisMastery1].Fixed[0:PointIncrement].@Fixed`（位置必须复用当前查询，示例不代表固定位置）。仅适用于 `User/MasteryUpgrades` 的单个 Fixed、PointIncrement 第 0 项。执行前同时核对基线位置、实例 Id、字段 Id 与 expect；生成包含 `index`、`Id`、`Field Id` 的稀疏 XML。旧的裸数字路径仍不可用，多个 Fixed 的记录尚未开放。相同路径的连续编辑仍需 dependsOn；原子提交和独立产物审计不变。

`Commander.MasteryTalentArray[n].ValuePerRank` 的稀疏覆盖已通过六名指挥官的原生引擎检查，查询默认返回 catalog.set。该证明不覆盖其他 Commander 数组或字段，也不等于前端渲染/实战精通激活验收。

通过确认的计划保存到：

```text
game-a/patches/<id>.patch-plan.json
game-a/patches/<id>.receipt.json
```

PatchPlan 是修改记录，receipt 保存计划哈希、每项操作状态、全部结构化目标、修改文件前后 SHA-256 以及整个核心树的前后 SHA-256。`patch_plan_check` 还会从同一份计划机械生成 `review`，用于显示可读修改、前置值、目标值和静态诊断；`review` 不替代 Receipt，也不代表完成了游戏运行时测试。生成后的 XML、Galaxy 和本地化文本是地图运行层可运行源码，这三部分都进入 Git。`game-a/build` 始终不进入 Git。

当前休伯利安 Galaxy 文件是在 PatchPlan 执行器出现前手工生成的验收样例。执行器已经可以确认其 Catalog 与本地化覆盖处于目标状态；完整 Galaxy 等价计划仍应在后续回归中生成，但不因此改变已冻结的运行层接口。
