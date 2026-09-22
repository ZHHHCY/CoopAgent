# Coop MCP

入口：`node runtime/coop-mcp/server.mjs`。

当前围绕第一项产品需求“可靠修改指挥官数值”提供六个工具：`project_status`、`search`、`scalar_solve`、`target_confirm`、`plan_prepare`、`plan_submit`。`target_confirm` 仅在最小查询发现目标/效果歧义时使用，持久保存候选并暂停模型，等待用户确认或纠正后恢复同一任务；明确请求直接跳过。

`scalar_solve` 批量读取精确字段，使用十进制有理数运算处理设值、增减、乘除、百分比，以及承伤倍率/加成比例/人口符号换算。current basis 组合工程 Catalog、所选威望修正和已记录同字段玩家 Set；catalog basis 用于明确的基础值请求。所选威望已有单一 Add/Subtract/Set/Multiply/Divide 修正时反解其操作数，不把修正量当最终值。结果返回 operation、依赖、来源和代入检查，no-op 不生成操作；复杂或未知链路返回 unsupported。读操作共用一个地图运行层快照，不写数据库。plan_prepare 对本次 MCP 会话中匹配的计算重新求值，拒绝过期或被改写的 expect/value；这不是对所有替代实现的通用语义验证，也不是游戏验收。

`search` 的 commander.get 与 entity.get 共用指挥官条目导航：等级/精通/威望返回展示对象、经过存在性检查的效果入口及缺失引用。可直接沿 effectTargets 的 catalog/objectId 查字段；也可用 entity.get(commanderId, objectId)，不填 catalog，恢复条目导航。多个效果不会自动选一项；精确字段查询不会替换目标。此层使用已构建的 commander_profiles，不打包官方数据、不要求重建数据库。

search 提供 commander.resolve/get、entity.resolve/get、requirement.explain、patches.for_target。查询按需提供对象、字段、关系、条件及已有改动；prepare/submit 使用统一执行器完成预演、校验与原子提交。

工具参数与最小查询示例见 [search 速查](../../.opencode/skills/coop-query/search.md)。MCP 的精确 path 与显式 include 优先于 full；查字段不会隐式展开整份档案，完整查询仍可按需使用。MCP 在读取前选择统一 objectCard，不生成再丢弃旧详情和原始字段；UI/内部完整投影保留兼容。默认卡片与 topic=fields 共用分页，支持真实 commandIndex，来源通过 objectCard.sources[sourceIndex] 查阅。数值来源、前置条件、依赖、作用域和警告保持可见，不按字符硬截断结果。

数值是需求范围，不是底层操作白名单。必要的隔离或条件配套由明确的 PatchPlan 表达，并遵守原执行器的 Schema、作用域、前置条件和结果校验。

任务流程见 coop-scalar-change；开发和验收见 [第一项产品需求](../../docs/scalar-only.md)。保留标准模型/工具/token 轨迹、任务恢复和命令行测试，应用不会自动启动游戏。
