export type Message = {
  id: number | string;
  role: "assistant" | "user";
  text: string;
  createdAtMs?: number;
  status?: "thinking";
  thinkingHint?: string;
  errorDetails?: string;
};

export type AgentSessionSummary = {
  id: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type AgentTokenUsage = {
  input: number;
  cached: number;
  output: number;
};

export type AgentSessionUsage = {
  lastTurn: AgentTokenUsage;
  total: AgentTokenUsage;
};

export type AgentSessionDetail = AgentSessionSummary & {
  model?: string;
  messages: Message[];
  historyTruncated: boolean;
  usage: AgentSessionUsage;
};

export type AgentEvent =
  | { type: "scoped"; projectId: string; contextGeneration: number; event: AgentEvent }
  | { type: "started"; runId: string; tracePath: string }
  | { type: "phase"; task: AgentTask }
  | { type: "paused"; runId: string; sessionId?: string; task: AgentTask }
  | { type: "activity"; label: string }
  | { type: "usage"; sessionId?: string; tokens: AgentTokenUsage }
  | { type: "submissionChanged" }
  | {
      type: "planReady";
      runId: string;
      planPath: string;
      planSha256: string;
      planId: string;
      operationCount: number;
      changedFiles: string[];
      summaryItems: string[];
      verificationLevel: string;
      verificationLabel: string;
      runtimeVerified: boolean;
    }
  | { type: "text"; text: string }
  | { type: "complete"; runId: string; sessionId?: string }
  | { type: "error" | "cancelled"; runId: string; message: string; sessionId?: string };

export type AgentRunSnapshot = {
  runId: string;
  tracePath: string;
  prompt: string;
  startedAtMs: number;
  sessionId?: string | null;
  state: "starting" | "running" | "completed" | "failed" | "cancelled" | "paused";
  text: string;
  activity: string;
  error?: string | null;
  sequence: number;
  task?: AgentTask | null;
};

export type AgentTask = {
  id: string; runId: string; prompt: string; phase: number; deadline?: number | null;
  status: "ready" | "running" | "paused" | "blocked" | "cancelled" | "submitted" | "finished" | "ended" | "awaiting_confirmation";
  turnId?: string; currentInput?: string; modelSessionId?: string | null;
  turnStatus?: "ready" | "running" | "closing" | "ended" | "awaiting_input" | "failed" | "cancelled";
  deliveryOutcome?: "complete" | "partial" | "no_change" | "unresolved" | null;
  applicationStatus?: "not_submitted" | "submitted" | "applying" | "applied" | "failed" | "stale" | "cancelled";
  confirmation?: { question: string; target: string; currentEffect: string; proposedEffect: string; reason: string } | null;
  selectedPreparation: string | null; draftPath: string | null;
  checkpoint?: { summary: string; disposition?: "continue" | "blocked" | "deliver" } | null;
  lastCheckpoint: { summary: string; remaining: string[]; nextAction: string; source: "agent" | "host";
    capabilityReview?: { status: "needs_validation" | "executor_unsupported"; coreBehavior: string } } | null;
  requestItems?: Array<{ id: string; sourceTurnId: string; sourceMessage: string }>;
};

export type AgentStatus = { busy: boolean; run: AgentRunSnapshot | null; shutdownError?: string | null };

export type PendingPatchPlan = {
  preparationId?: string;
  submissionState?: string;
  runId: string;
  tracePath?: string;
  planPath: string;
  planSha256: string;
  planId: string;
  operationCount: number;
  changedFiles: string[];
  summaryItems: string[];
  verificationLevel: string;
  verificationLabel: string;
  runtimeVerified: boolean;
  status: "checked" | "applying" | "applied" | "error";
  receiptPath?: string;
  error?: string;
};

export type SubmissionJob = {
  preparationId: string;
  state: "submitted" | "applying" | "applied" | "failed" | "stale" | "cancelled";
  runId: string | null;
  updatedAt: string;
  error?: { message?: string } | null;
  prepared: PatchPlanApplyResult;
  result?: PatchPlanApplyResult | null;
};

export type PatchPlanApplyResult = {
  status: "applied";
  runId: string;
  tracePath: string;
  planPath: string;
  planSha256: string;
  report: {
    id: string;
    operations?: unknown[];
    changedFiles: string[];
    receiptRecord?: string;
  };
  review?: {
    userSummary?: {
      items?: string[];
      verificationLevel?: string;
      verificationLabel?: string;
      runtimeVerified?: boolean;
    };
  };
  runtimeLaunch?: {
    status: "launched" | "failed" | "skipped";
    output?: string;
    error?: string;
    reason?: string;
  };
};
