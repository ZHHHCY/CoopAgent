import { useProjectBridge } from "../../features/projects/projectBridge";
import { useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type {
  CommanderDetailsResult,
  CommanderListResult,
  CommanderSummary,
} from "./types";

export function useCommanderCatalog(agentReady: boolean, sc2RootPath?: string, projectRevision = 0) {
  const { invoke, storage } = useProjectBridge();
  const [commanders, setCommanders] = useState<CommanderSummary[]>([]);
  const [selectedCommanderId, setSelectedCommanderId] = useState<string | null>(() => storage.getItem("commanderId"));
  useEffect(() => { if (selectedCommanderId) storage.setItem("commanderId", selectedCommanderId); }, [selectedCommanderId, storage]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [details, setDetails] = useState<CommanderDetailsResult | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");

  const selectedCommander = useMemo(
    () => commanders.find((commander) => commander.id === selectedCommanderId) ?? null,
    [commanders, selectedCommanderId],
  );

  useEffect(() => {
    if (!agentReady || !isTauri()) {
      setCommanders([]);
      setSelectedCommanderId(null);
      return;
    }
    let cancelled = false;
    setListLoading(true);
    setListError("");
    invoke<CommanderListResult>("commander_list")
      .then((result) => {
        if (!cancelled) setCommanders(result.items);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCommanders([]);
        setListError(String(error));
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentReady, sc2RootPath, projectRevision]);

  useEffect(() => {
    if (!agentReady || !isTauri() || !selectedCommanderId) {
      setDetails(null);
      setDetailsLoading(false);
      setDetailsError("");
      return;
    }
    let cancelled = false;
    setDetails(null);
    setDetailsLoading(true);
    setDetailsError("");
    invoke<CommanderDetailsResult>("commander_get", { commanderId: selectedCommanderId })
      .then((result) => {
        if (!cancelled) setDetails(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetails(null);
        setDetailsError(String(error));
      })
      .finally(() => {
        if (!cancelled) setDetailsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentReady, sc2RootPath, selectedCommanderId, projectRevision]);

  return {
    commanders,
    details,
    detailsError,
    detailsLoading,
    listError,
    listLoading,
    selectedCommander,
    selectedCommanderId,
    setSelectedCommanderId,
  };
}
