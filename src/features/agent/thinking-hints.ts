const THINKING_HINTS = [
  "正在采集晶体矿…",
  "正在采集高能瓦斯…",
  "正在呼叫休伯利安…",
  "正在召唤虫群…",
  "正在集结部队…",
  "激光钻机充能中…",
  "免费的爆虫即将孵化…",
  "正在联络暗影卫队…",
  "正在校准净化光束…",
  "还需要更多生物质…",
  "拉克希尔仪式进行中…",
  "正在引导聚变打击…",
  "感染扩散中…",
  "净化者人格载入中…",
  "正在收集精华…",
  "帝国乐队演奏中…",
  "正在召集亡命之徒…",
  "正在寻找萨尔纳加神器…",
  "正在陪盖瑞玩:)",
  "正在动员帝国劳工…",
] as const;

const HOST_ACTIVITIES = new Set([
  "正在完成最终收尾…",
  "已有可交付结果或探索进入长尾，正在收尾…",
  "本阶段已保存，正在继续下一阶段…",
  "等待用户确认目标与效果",
  "阶段保存失败，正在停止…",
]);

function isHostActivity(label: string): boolean {
  return HOST_ACTIVITIES.has(label)
    || (label.length <= 96 && /^正在调用 (?:[\w.:-]+|project tool)…$/u.test(label));
}

// Only host-authored statuses belong in this compact hint. Ignore arbitrary
// activity text from older backends/snapshots without replacing a stable hint.
export function thinkingHintForActivity(label = "", previousHint?: string): string {
  if (isHostActivity(label)) return label;
  if (label.startsWith("阶段保存失败，正在停止：")) return "阶段保存失败，正在停止…";
  const generic = !label || label === "正在分析项目…" || label === "正在启动 Agent…";
  if (!generic && previousHint && isHostActivity(previousHint)) return previousHint;
  if (THINKING_HINTS.some(hint => hint === previousHint)) return previousHint!;
  return THINKING_HINTS[Math.floor(Math.random() * THINKING_HINTS.length)] ?? THINKING_HINTS[0];
}
