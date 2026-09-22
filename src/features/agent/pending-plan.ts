import type { PendingPatchPlan, SubmissionJob } from "./types";

export const PENDING_PLAN_KEY = "coopagent-pending-plan-v1";

export function pendingFromSubmission(job: SubmissionJob): PendingPatchPlan {
  const result = job.result ?? job.prepared;
  const summary = result.review?.userSummary;
  const active = job.state === "submitted" || job.state === "applying";
  return { preparationId: job.preparationId, submissionState: job.state,
    runId: job.runId ?? "backend-job", planId: result.report.id,
    planPath: result.planPath, planSha256: result.planSha256,
    operationCount: result.report.operations?.length ?? 0,
    changedFiles: result.report.changedFiles, summaryItems: summary?.items ?? [],
    verificationLevel: job.state === "applied" ? "applied-to-source" : "static-preflight",
    verificationLabel: job.state === "applied" ? "已写入地图运行层并生成回执；未启动游戏。"
      : active ? "后端已保存提交任务，正在处理；关闭页面不会撤销提交。" : "提交未完成，未报告为已应用。",
    runtimeVerified: false, status: active ? "applying" : job.state === "applied" ? "applied" : "error",
    receiptPath: job.state === "applied" ? result.report.receiptRecord : undefined,
    error: job.error?.message,
  };
}

// Storage is an outcome/retry pointer, not permission to change a plan. The
// backend still checks the run's exact checked file hash and executor state.
export function restorePendingPlan(raw: string | null): PendingPatchPlan | null {
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw) as PendingPatchPlan;
    if (!plan || typeof plan.runId !== "string" || typeof plan.planId !== "string"
      || typeof plan.planPath !== "string" || !/^game-a\/drafts\/[a-z0-9]+(?:-[a-z0-9]+)*\.patch-plan\.json$/.test(plan.planPath)
      || typeof plan.planSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(plan.planSha256)
      || !Array.isArray(plan.changedFiles) || !plan.changedFiles.every((item) => typeof item === "string")
      || !Array.isArray(plan.summaryItems) || !plan.summaryItems.every((item) => typeof item === "string")
      || !["checked", "applying", "applied", "error"].includes(plan.status)) return null;
    return plan.status === "applied" || plan.status === "error" ? plan : {
      ...plan,
      status: "error",
      runtimeVerified: false,
      error: "上次任务尚未确认应用结果。点击重试将核对原计划，并在必要时先恢复中断的事务；不会自动启动游戏。",
    };
  } catch { return null; }
}
