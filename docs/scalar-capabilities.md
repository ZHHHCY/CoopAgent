# Scalar 能力接口：稳定交付，而非固定流程

这是启用 `coop_change` 时的当前说明。Agent 可以使用对象查询、原始 XML/SQL、脚本和可选计算器，自选调查顺序。完整契约描述可表达的操作，不要求每次先读完整文档。未知机制需要继续调查或说明真实缺口，不能为了少用工具、减少 token 或满足某条路线牺牲正确性。

## 要交付的结果

确定真实 ID、字段含义、当前数值、适用的指挥官/威望/升级条件。区分“改基础值”“改效果参数”“改条件下最终值”。覆盖用户全部要求并保留未改项；共享对象、升级/条件配套都可按真实需要处理，不默认整单位克隆。用户已明确基础值或条件时不重新定义请求。实质玩法歧义才询问用户，内部字段和实现问题由 Agent 调查。未知或截断不能当作零、无影响或固定加成。

基础数值和威望效果默认分开修改。若已有证据发现具体冲突，在提交相关修改前用玩家语言说明原效果、仅修改请求项后的结果及验证程度；处理方式未明确时用 target_confirm 询问，不自动联动、不先改后告知。用户已明确选择则直接沿用，无冲突不增加确认，也不为此穷尽所有关联效果。只有明确要求或确认保留某个比例效果时才同步必要操作数；比例须有说明或机制证据，不能由两个旧数值相除猜测。

## 获取证据（按需选择）

当前查询的 `edit` 已包含 operation、expect 和 requiredDependsOn 时，这就是该字段的可复用证据；相同工程/条件下无需再调用精确字段查询确认一遍。精通/升级结果的 effect.nextQuery 用于刷新或深入缺失信息。只有写入、外部变更、条件变化、新冲突或未返回的分页项需要重读。对已确定的升级操作数，全部请求级别/形态已为目标值时直接交付 no-op，无需设计假想写入的隔离方案或遍历无关升级。

`search_batch` 可在顶层指定 commanderId/prestigeUpgrade 作为默认条件，也可逐项指定；跨指挥官项不会继承另一个指挥官的默认威望。返回的每项 input 显示实际条件。`shared` 中的相同上下文适用于每个 result（包括 shared.fieldInfluences 中的字段）；数值、写入前置条件、依赖、目标和截断信息始终逐项保留。`complete:false` 时仅 returned 项已交付，其余沿 nextQuery 继续。

- `entity.resolve` 确定对象 ID；`commander.get` 查指挥官名册/等级/威望/精通。`entity.get` 始终需要 objectId，不能用它代替指挥官目录。
- 单位候选的 `productionIdentity` 关联当前训练/变形路径；`entity.get(topic=identity)` 展开生产单位、茧、实际结果、指挥官来源、按钮限制与 Requirements。目录关联和名字不是实际玩法身份，受限按钮也可能通过科技解锁；这些证据不代表运行时可用性已经验证。
- 对大型 Upgrade 使用 `entity.get(topic=upgradeEffects, reference={catalog,objectId,path?})` 按实际 Reference 定位操作数，不需要手动扫描所有 EffectArray 序号。返回当前 expect、Reference/Operation、研究入口和父级/同级升级，`relatedUpgrades[].nextQuery` 保留 Reference 过滤。模板、实际研究级别、单位形态分别核对；目标已经满足就无需提交。
- 精通和 Upgrade 查询的 `operandScope` 给出仅修改现有 `EffectArray.Value` 的静态作用域证据：读等级的 CountUpgrade 条件不读取该操作数，User 授予按同一实例的真实 Commander 链接判断，外部指挥官、未知引用和继承消费者仍保留。`boundedPrivate:true` 可用于已有定义的直接修改；它不证明游戏运行时独占，也不适用于改 Reference、Operation、升级上限或授予条件。
- 对象卡片和字典提供字段解释、技能/武器/条件引用与 `nextQuery`，不是必须经过的页面。已有确切 ID/路径可以直接查询。可分页、限定相关组，或用原始 XML/SQL 交叉核对。
- `entity.get + path` 提供当前工程的 `editState`。`edit.operation` / `catalogEdit.operation` 是操作候选，`expect` 是该候选的真实前置条件，`requiredDependsOn` 是连续编辑依赖。它们不是对整份需求的自动批准。
- `search.operation` 通常显式填写。只有同时提供明确的 `catalog + objectId + path`，且没有其他查询模式参数时，遗漏 operation 才会补为只读 `entity.get`，返回 `inputNormalization`。保留指挥官与威望条件；不会猜目标、把模糊搜索改成字段读取或影响写入校验。
- `topic` 不与 `path`、`fieldPrefix`、`include` 混用；选择生产命令用返回的 `commandIndex`，精确字段路径已经包含槽位，不再附 commandIndex。不要猜不存在的对象或槽位。
- 条件下读取保留真实 `prestigeUpgrade`（威望目录的 `primaryUpgrade`）；数组参数使用真实下标和属性，如 `EffectArray[n].@Value`，并核对同项 Reference/Operation。基础卡片值与当前玩家覆盖值要区分。
- 精通/研究的每级加成从对应 Upgrade 的 EffectArray 读取，同项 Reference、Operation、Value 一起核对。修改升级参数时复用返回的 catalog.set，不自行改成对 Upgrade 字段再施加玩家 Set；已有玩家覆盖需单独处理连续编辑。User/MasteryUpgrades 的 PointIncrement 是展示元数据，不能据此认定玩法加成，也不因数值需求自动增加修改界面的任务。Instances 的 Id 不等于数组 index；返回 ordinal-index-unverified 时不能把实例名或猜测的下标写入计划。
- 精通导航的 `nextQuery` 使用 `entity.get + topic=mastery`，一次关联当前 Upgrade 参数、实际目标、点数上限、消费者、动态 Tooltip 和面板元数据。各显示来源仍是独立要求；`presentationTruncated` / `consumersTruncated` 表示证据未列全。查询返回 `identity-selector-required` 时，需补充经过验证的选择器支持；改 expect 或试猜序号不能解决。执行器独立执行同一校验。
- 精通 PointIncrement 的已验证布局返回同时包含位置与 Id 的路径，例如 `Instances[n:InstanceId].Fixed[0:PointIncrement].@Fixed`；直接复用查询返回的 operation/expect/dependencies。执行器会核对身份并保留 XML 身份字段，当前仅支持单个 Fixed 第 0 项。Commander 的 ValuePerRank 与 User 的 PointIncrement 都使用 catalog.set，不能改成玩家 Set。`inspect-definition` 表示先核对现有定义的作用域和消费者，再声明真实 isolation；无需机械套用单位克隆路线。
- 已知多个字段可用 `coop_search_batch({queries:[{commanderId,prestigeUpgrade?,catalog,objectId,path},...]})`，每批最多 32 项。同一作用域的各项来自同一读快照，保留当前 expect、依赖和可写性；不同作用域分组读取。跨请求复用快照仍检查核心源、计划、基线、数据库修订和作用域；提交或外部编辑后自动失效。

批量响应也受整包字节预算约束。`complete:false` 时只交付 `results` 中完整字段的证据，使用顶层 `nextQuery` 继续读取剩余项；单项 `response-too-large` 的 `nextQuery` 指向该字段的单独搜索，不能将缺失结果当作已经验证。

可直接阅读数据和源码、查询 SQL 或运行分析脚本；提交游戏改动仍经过事务接口，不用手工改核心源绕过校验。脚本可生成候选内容，并在完整计划中以支持的文件/克隆/重连操作表达。

已有目标身份、字段含义、当前值、相关条件和消费者范围的证据时，就可以形成修改。后续查询应解决一个能说清的缺口或矛盾。`partial` 和 `runtimeVerified:false` 本身不要求审计执行器、扫描全部 SQL 表或阅读完整 Schema；这些手段用于排查具体问题。计算器返回的 `handoff` 提供接续提示及精确核对入口，不代替作用域判断。

设值请求在所要求的条件下已达目标时，说明无需修改，不能提交 expect=value 的操作充当成功修改。历史来源的旧值不能充当当前 expect，也不能为了匹配旧值改选对象。用户未明确要求旧基线时，相对变化基于核实的当前值。

## 修改接口

简短输入：`id`（唯一 kebab-case）、`summary`、`scope`、`isolation`、`operations`，以及必要的 `dependsOn` / `conflictsWith`。后端只补齐格式版本、游戏目标与基线版本，不替 Agent 选择目标、数值、条件或隔离方法。

- 每项 operation 保留独立 `opId`、`kind` 及其契约字段。`commander.stat.set` 需要 commanderId/catalog/object/path/expect/value，条件修改还需 prestigeUpgrade。`catalog.set` 不能靠附 commanderId 自动私有化。不要删掉支持操作来凑某种策略。
- 全部使用玩家 Set 时，`scope={kind:"commander",commanderId:真实ID}`、`isolation={strategy:"player-upgrade"}`。这是此实现的表达方式，不是所有需求的默认答案。
- 修改已有私有定义时，使用 `scope={kind:"commander",commanderId:真实ID}`、`isolation={strategy:"direct-private",owner:{catalog:真实目录,object:真实ID}}`；owner 是实际定义对象，不能只写指挥官 ID 或省略 owner。按字段返回的消费者与作用域证据选择，不从名字推断私有性。
- `owner` 标识主要定义，不要求所有操作只修改这个对象。同一事务可以包含已证明属于该指挥官的 Upgrade 操作数、User 面板和 Commander 展示字段；精通查询同时返回 `operandScope` 与各展示字段的 `definitionScope`，与执行器共用判断。每项写入仍独立核对归属，不能用一个私有 owner 掩盖其他共享字段。
- 也可只传完整 `plan`（及可选 dryRun），使用[完整执行契约](patch-plan.md)中的其他操作、隔离与 postconditions；不是另一套受限操作语言。完整 plan 与简短输入互斥。
- 默认一次调用内预检并提交；`dryRun:true` 只预演、不写核心，之后可只传返回的 preparationId 应用该版本。分开的 prepare/submit 仍可使用，不强制先预演。
- 一个宿主任务选定一份包含本次全部数值与必要配套的最终事务。探索可产生多份草稿，不能把一次请求漏拆成多笔不完整提交。

`scalar_solve` 是可选计算能力，输入真实 target（catalog/objectId/path）、条件、transform。basis=current 使用支持的当前工程/条件值；明确基础值时选择 basis=catalog。也可以用脚本计算；无论来源，都必须有真实前置条件和适用范围。使用过的相关 scalar_solve 结果仍会被重新校验，不能改写结果或伪造输入绕过一致性检查。

## 成功、失败与恢复

- `prepared` 只是预演；`submitted` 表示后台状态尚未确定；`applied` 才证明该事务已写入源码。通信异常时先检查 project_status/receipt，不新建 ID 盲目再改一遍。
- 输入或预检失败时按具体诊断修正。提交阶段异常会保留已知 preparationId 和恢复提示；恢复仍检查取消、过期、作用域与原子性。
- 成功预检中的 warnings 是非阻断诊断，仍需按内容判断。`DIRECT_PRIVATE_NOT_PROVEN` 表示静态审查未证明私有性：已有相关归属/消费者证据可复用，缺失时补查该范围；不要仅为消除警告改换实现或审计整个后端。成功 dryRun 可直接用其 preparationId 提交。
- 预检版本过期时重读相关当前值/依赖，重新表达用户意图；不要自动把 expect 更新成任意新值。已有修改真正应用时如实报告，不把“答复中断”当“什么都没改”。
- 检查每项请求的当前工程数值与条件，核对有风险的未改项。必要时继续沿 XML/引用/生成代码调查，不看到 receipt 就宣布游戏内完全正确。
- 最终区分：数值已应用、条件/未改项检查、还缺什么、是否经过游戏内验证。达到请求时交付；未完成时明确缺口，不用“接下来开始”结束。

没有接口能自动证明完整 SC2 运行时。研究等级、Buff、激活时序和叠加次数未求值时保留不确定性；游戏试玩仅在用户要求时启动。
