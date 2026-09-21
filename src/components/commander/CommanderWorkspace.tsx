import { useEffect, useState } from "react";
import {
  type ChangeIndicatorSnapshot,
  getCommanderChangeIndicator,
} from "../../changeIndicators";
import { CommanderPicker } from "./CommanderPicker";
import { CommanderProgression } from "./CommanderProgression";
import { CommanderRosterPanel } from "./CommanderRosterPanel";
import type { CommanderWorkspaceSelection } from "./CommanderSelection";
import type { CommanderInspectionSelection } from "./types";
import { useCommanderCatalog } from "./useCommanderCatalog";

type Props = {
  agentReady: boolean;
  projectRevision: number;
  changeIndicators: ChangeIndicatorSnapshot;
  sc2RootPath?: string;
  onInspectSelection: (selection: CommanderInspectionSelection) => void;
};

export function CommanderWorkspace({
  agentReady,
  projectRevision,
  changeIndicators,
  sc2RootPath,
  onInspectSelection,
}: Props) {
  const catalog = useCommanderCatalog(agentReady, sc2RootPath, projectRevision);
  const [selection, setSelection] = useState<CommanderWorkspaceSelection>(null);

  useEffect(() => {
    setSelection(null);
    onInspectSelection(null);
  }, [agentReady, catalog.selectedCommanderId, onInspectSelection, projectRevision]);

  const selectedChanges = catalog.selectedCommander
    ? getCommanderChangeIndicator(changeIndicators, catalog.selectedCommander.id)
    : undefined;

  function select(
    nextSelection: CommanderWorkspaceSelection,
    inspection: CommanderInspectionSelection,
  ) {
    setSelection(nextSelection);
    onInspectSelection(inspection);
  }

  return (
    <div className="workspace-reserved">
      <CommanderPicker
        agentReady={agentReady}
        changeIndicators={changeIndicators}
        commanders={catalog.commanders}
        error={catalog.listError}
        loading={catalog.listLoading}
        onSelect={catalog.setSelectedCommanderId}
        selectedCommander={catalog.selectedCommander}
        selectedCommanderId={catalog.selectedCommanderId}
      />

      {catalog.selectedCommander ? (
        <CommanderProgression
          changes={selectedChanges}
          commander={catalog.selectedCommander}
          details={catalog.details}
          error={catalog.detailsError}
          loading={catalog.detailsLoading}
          onSelect={select}
          selection={selection}
        />
      ) : null}

      {catalog.selectedCommander && catalog.details && !catalog.detailsLoading ? (
        <CommanderRosterPanel
          changes={selectedChanges}
          commander={catalog.selectedCommander}
          details={catalog.details}
          onSelect={select}
          selection={selection}
        />
      ) : null}
    </div>
  );
}
