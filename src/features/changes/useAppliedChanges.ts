import { useProjectBridge } from "../projects/projectBridge";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type {
  AppliedChangeSummary,
  AppliedChangeSummaryListResult,
} from "../../components/commander/types";

type Options = {
  agentReady: boolean;
  databaseBuild?: string;
  receiptPath?: string;
  projectRevision?: number;
  environmentRevision?: number;
  databaseMessage?: string;
};

export function useAppliedChanges({ agentReady, databaseBuild, receiptPath, projectRevision, environmentRevision, databaseMessage }: Options) {
  const { invoke } = useProjectBridge();
  const [items, setItems] = useState<AppliedChangeSummary[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!agentReady || !isTauri()) {
      setItems([]);
      setError(isTauri() ? databaseMessage ?? "等待合作模式数据库就绪后读取改动记录。" : "");
      return;
    }

    let cancelled = false;
    setError("");
    invoke<AppliedChangeSummaryListResult>("change_summary_list")
        .then((result) => {
          if (cancelled) return;
          setItems(result.items);
          setError("");
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setItems([]);
          setError(String(cause));
        });

    return () => {
      cancelled = true;
    };
  }, [agentReady, databaseBuild, receiptPath, projectRevision, environmentRevision, databaseMessage, invoke]);

  return { error, items };
}
