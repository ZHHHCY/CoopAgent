# `impact.analyze` 真实数据样本

本文记录 `semanticImpact` 首版对用户本机合法安装的《星际争霸 II》合作模式数据库
`B97579` 的只读审计。仓库只保留 Catalog ID、分组结论和边界，不分发提取数据。

## 雷诺样本

| 目标 | 识别结果 | 已观察到的语义分组 |
| --- | --- | --- |
| `Abil/EngineeringBayResearch` | `ability`、`panel` | 指挥官入口、面板技能入口、单位挂载；Button 和研究 Upgrade 依赖 |
| `Effect/MedicHealACSwitch` | `effect` | Ability 入口；子 Effect 和 Validator 依赖 |
| `Behavior/Stimpack` | `behavior` | Validator 消费者、Upgrade 修改者；当前显式引用图未找到执行入口 |
| `Weapon/GuassRifle` | `weapon` | 多个单位挂载者和 Upgrade 修改者 |
| `Upgrade/RaynorCommander` | `upgrade`、`panel` | 指挥官成长入口、面板默认 Upgrade；Unit 和 Ability 修改目标 |
| `Unit/Barracks` | `building` | 指挥官建筑名单和创建入口；Ability、Behavior 等依赖 |
| `Unit/CoopCasterRaynor` | `building`、`panel` | 面板施法单位绑定及其 Ability、Behavior、表现依赖 |

`Behavior/Stimpack` 没有静态入口不是“游戏中无法应用”的结论，只表示当前数据库的显式
`object_references` 没有证明入口。`semanticImpact` 保留空入口与消费者证据，不由代码补猜运行时关系。

## 边界

- `owners` 来自目标自身的 `commander_membership` 和 `commander_profiles` 绑定，不把上游消费者的归属误当作目标独占证明。
- `entrypoints` 只收录能够按 Catalog 类型解释的入口；其他入向引用仍保留在 `consumers`。
- `dependencies` 只列目标的显式出向引用，并保留原始字段路径、置信度和是否为可写索引路径。
- `sharedDependencies` 同时检查显式的其他消费者和多指挥官 membership，并优先返回跨范围风险；返回数量和每项消费者明细都有上限。
- Galaxy 动态创建、运行时玩家状态、敌方编成和引擎默认引用仍然未知，不能因结果为
  `bounded-complete` 就推断全局安全。
