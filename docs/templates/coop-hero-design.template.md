# 合作英雄设计清单

> 使用方法：复制本文件，为本次英雄任务填写所有适用项。未知项先从解析后的官方合作模式数据库调查，不要猜测。完成设计后再生成 PatchPlan v2。

## 1. 用户目标

- 指挥官：
- 任务类型：修改已有英雄 / 加入新英雄
- 一句话目标：
- 明确不做的内容：
- 目标宿主地图：任意 Game A 宿主 / 指定宿主

## 2. 英雄身份

- 显示名称（zhCN）：
- 显示名称（enUS）：
- 私有 Unit ID（新增或修改已有英雄都使用稳定的 GameA ID）：
- 主 Actor ID：
- 指挥官识别 ID：
- 英雄定位：近战 / 远程 / 坦克 / 支援 / 施法者
- 阵营视觉：

## 3. 官方参考与复用

| 用途 | 参考 ID | Catalog | XML 类 | parent | 复用方式 | 已核对 build |
| --- | --- | --- | --- | --- | --- | --- |
| 英雄 Unit |  | Unit |  |  | clone / override / reference |  |
| 主 Actor |  | Actor |  |  | create / clone / explicit fields |  |
| 世界模型 |  | Model |  |  | reference |  |
| 肖像 |  | Actor/Model |  |  | reference |  |
| 普通攻击 |  | Weapon/Effect |  |  | reference / override |  |
| 出生表现 |  | Actor/Model |  |  | reference |  |
| 复生参考 |  | Unit/Actor/Galaxy |  |  | behavior reference only |  |

需要显式落地、不能只依赖跨依赖继承的字段：

- [ ] Actor XML 类
- [ ] `unitName`
- [ ] Model / BuildModel
- [ ] PortraitActor / PortraitModel
- [ ] Icon / Wireframe
- [ ] 英雄状态条
- [ ] 小地图优先级
- [ ] Unit Name

## 4. 基础数值

| 字段 | 初始值 | 最大值 | 再生 | 来源/理由 |
| --- | ---: | ---: | ---: | --- |
| Life |  |  |  |  |
| Shields |  |  |  |  |
| Energy |  |  |  |  |

- 移动速度：
- 碰撞半径：
- 视野：
- Heroic：是 / 否
- MapBoss：是 / 否
- PreventDestroy：是 / 否
- 其他关键 Flag/Attribute：

## 5. 普通攻击

- Weapon ID：
- Damage Effect ID：
- 伤害：
- 周期：
- 射程：
- 目标过滤：
- 弹道/近战：
- 攻击 Actor 与音效：

## 6. 主动技能

| 槽位 | 名称 | Button | Ability | Effect 入口 | 冷却 | 费用 | 快捷键 | Row/Column |
| --- | --- | --- | --- | --- | ---: | ---: | --- | --- |
| Q |  |  |  |  |  |  | Q |  |
| W |  |  |  |  |  |  | W |  |
| E |  |  |  |  |  |  | E |  |
| R |  |  |  |  |  |  | R |  |

对每个技能确认：

- [ ] Ability 已加入 Unit。
- [ ] Button 已进入命令卡。
- [ ] Effect 引用链全部存在。
- [ ] Validator/Requirement 不依赖错误阵营或剧情条件。
- [ ] 施法、弹道、命中和持续 Actor 完整。
- [ ] 本地化名称和说明完整。

## 7. 被动、升级和成长

| 名称 | Behavior/Upgrade | 获得条件 | 修改对象 | UI 表现 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 8. 命令卡与 UI

- 命令卡来源：新建 / 继承后清理 / 覆盖已有
- PortraitActor：
- PortraitModel：
- UnitIcon：
- HeroIcon：
- Wireframe：
- GroupIcon：
- CustomUnitStatusFrame：
- BarOffset：
- BarWidth：
- MinimapIcon / Priority：

确认：

- [ ] 没有继承其他英雄技能。
- [ ] 没有按钮位置冲突。
- [ ] 世界状态条是合作英雄状态条。
- [ ] 选择面板、英雄面板和小地图身份一致。

## 9. 初次登场与复活

- 初次登场延迟：
- 阵亡复活延迟：
- 初始出生点策略：
- 信标 Unit ID：
- 信标 Actor ID：
- 信标世界模型：
- 信标肖像/图标：
- 信标是否无敌、不可选定：
- 进度来源：Life regen / 其他
- 进度条 BarOffset / BarWidth：
- Hero panel cooldown key：

状态机：

| Phase | 含义 | 进入条件 | 创建对象 | 离开条件 |
| ---: | --- | --- | --- | --- |
| 0 | 未初始化 | 模块启动 | 无 | 目标指挥官有效 |
| 1 | 初次等待 | 首次初始化 | 信标 | 初次冷却结束 |
| 2 | 英雄存活 | 创建英雄 | 英雄 | 英雄死亡 |
| 3 | 阵亡等待 | 死亡事件 | 信标 | 复活冷却结束 |

## 10. 本地化清单

| Key | zhCN | enUS |
| --- | --- | --- |
| Unit/Name/Hero |  |  |
| Unit/Name/Beacon |  |  |
| Button/Name/... |  |  |
| Button/Tooltip/... |  |  |
| GameA/Hero/Arrival |  |  |
| GameA/Hero/Fallen |  |  |

## 11. PatchPlan 拆分

- 主计划 ID：
- dependsOn：
- conflictsWith：
- 是否需要后续迁移计划：否 / 是，原因：
- Galaxy 路径：`Base.SC2Data/Generated/<Hero>.galaxy`
- init 函数：
- 注册顺序：

## 12. 验收结果

- [ ] PatchPlan `--check` 通过。
- [ ] 正式 apply 和 receipt 生成成功。
- [ ] PatchPlan 执行器测试通过。
- [ ] Game A 结构和重建通过。
- [ ] Editor XMLAlerts 无本次新增错误。
- [ ] Game ScriptError/Alerts 无本次新增错误。
- [ ] 非目标指挥官不会生成英雄。
- [ ] 初次召唤正确。
- [ ] 模型、肖像、状态条、技能、命令卡正确。
- [ ] 死亡不会导致任务失败。
- [ ] 复活至少连续测试两次。
- [ ] 换宿主地图后修改仍存在。
