import { useProjectBridge } from "../projects/projectBridge";
import { useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { buildChangeIndicatorSnapshot } from "../../changeIndicators";
import type {
  AppliedChangeSummary,
  AppliedChangeSummaryListResult,
} from "../../components/commander/types";

type Options = {
  agentReady: boolean;
  databaseBuild?: string;
  receiptPath?: string;
  projectRevision?: number;
};

export function useAppliedChanges({ agentReady, databaseBuild, receiptPath, projectRevision }: Options) {
  const { invoke } = useProjectBridge();
  const [items, setItems] = useState<AppliedChangeSummary[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!agentReady || !isTauri()) {
      setItems([]);
      setError("");
      return;
    }

    let cancelled = false;
    setError("");
    invoke<AppliedChangeSummaryListResult>("change_summary_list")
      .then((result) => {
        if (!cancelled) setItems(result.items);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setItems([]);
        setError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [agentReady, databaseBuild, receiptPath, projectRevision]);

  const indicators = useMemo(
    () => buildChangeIndicatorSnapshot(items),
    [items],
  );

  return { error, indicators, items };
}
