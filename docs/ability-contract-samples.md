# 合作模式技能契约真实样本审计

本文记录技能契约检查器首版使用的真实数据样本和由此确定的规则边界。样本来自用户本机合法安装的《星际争霸 II》合作模式数据库 `B97579`，只记录 Catalog ID、关系和检查结论，不随仓库分发提取数据。

## 已审计样本

| 样本 | 观察到的真实结构 | 对检查器的意义 |
| --- | --- | --- |
| 雷诺陆战队 `Marine` | `Stimpack,Execute` 是主动命令，Requirement 位于 Ability 的 `CmdButtonArray[Execute]`；`CombatShield` 是带独立 Requirement 的被动项。 | 主动与被动需要不同契约；Requirement 可能不写在 Unit 命令卡项上。 |
| 雷诺医疗兵 `Medic` | `heal` 与 `HealPlusMech` 占用同一可见格，由互斥 Requirement 切换；二者都开启 AutoCast 与 AutoCastOn。 | 同一格出现多项不是冲突；必须结合 Ability、Button 和 Requirement 匹配。 |
| 凯瑞甘 `K5Kerrigan` | 主动 `PrimalSlash` 与多个被动项可共享坐标；继承结果同时包含 `[#n]` 未索引项和显式 `[n]` 项。 | 坐标不能作为唯一身份；`[#n]` 不能与 `[n]` 合并或当成可写下标。 |
| 阿拉纳克 `AlarakCoop` | 部分主动 Ability 没有直接 `Effect[0]`，实际机制通过其他字段或链路表达。 | 不能制定“所有主动技能必须有 Effect[0]”的全局规则。 |
| 泰凯斯响尾蛇 `TychusWarhound` | 单位包含通用英雄命令占位符，也包含真正挂载的专属炮台命令；占位命令不一定直接对应 Unit 的 Ability。 | 不能反向扫描并要求每个历史 `AbilCmd` 都直接挂入 Unit。只验证本计划承诺的命令。 |
| 雷诺面板施法者 `CoopCasterRaynor` | 休伯利安面板技能在 Catalog 中仍是 Unit + Ability + Button + CardLayouts 关系。 | 基础可见命令契约可复用；面板注册、资源与运行时解锁仍需额外契约。 |

## 确定的规则

1. 契约由 PatchPlan 显式声明，检查器不把某个样本复制成全局模板。
2. 技能身份至少由 holder Unit、Ability command 和 Button 共同确定；坐标只是可选断言。
3. Requirement 同时检查 Unit 命令卡项与 Ability 的 `CmdButtonArray[command]`。
4. 自动施法额外检查 `Flags[AutoCast]`；只有计划声明时才检查 `Flags[AutoCastOn]`。
5. 被动项检查 `Type=Passive`、Button，以及可选位置和 Requirement，不要求 Ability。
6. 隐藏技能只检查 Unit 的 Ability attachment，不凭空要求可见按钮。
7. 数据库路径中的 `[#n]` 表示未显式索引项的读取序号，必须与显式 `[n]` 分开保留。

## 当前覆盖与未覆盖

首版 `patch_plan_check` 支持 `unit.ability`、`unit.command`、`unit.autocast` 和 `unit.passive`。它从数据库有效字段、当前 Game A 核心和计划操作投影最终状态，并在声明关系不成立时阻止应用。

第二批增加 `ability.effect-chain` 和 `localization.present`：前者验证计划声明的 Ability 根字段、Effect 可达节点和缺失引用，后者验证指定语言键非空并可选比对精确文本。现有可见命令和被动契约还会保守折叠 Requirement 常量树，只拒绝能够静态证明恒为 false 的阶段；动态玩家状态继续保留为未知。

它仍不证明：Effect 实际造成的玩法结果、本地化文案的语言质量、Requirement 在具体对局中的动态真假、Actor 动画与特效、面板注册和资源逻辑。后续扩展应继续增加可组合契约类型，而不是扩大某个固定模板。
