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

// Only generic host placeholders use the themed copy. Keep concrete activity
// verbatim and keep the chosen placeholder stable across snapshot polling.
export function thinkingHintForActivity(label = "", previousHint?: string): string {
  if (label && label !== "正在分析项目…" && label !== "正在启动 Agent…") return label;
  if (THINKING_HINTS.some(hint => hint === previousHint)) return previousHint!;
  return THINKING_HINTS[Math.floor(Math.random() * THINKING_HINTS.length)] ?? THINKING_HINTS[0];
}
