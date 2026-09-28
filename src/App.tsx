import { ProjectShell } from "./features/projects/ProjectShell";
import "@fontsource/rajdhani/latin-500.css";
import "@fontsource/rajdhani/latin-600.css";
import "@fontsource/rajdhani/latin-700.css";
import { ModelDialog } from "./components/dialogs/ModelDialog";
import { Sc2SetupDialog } from "./components/dialogs/Sc2SetupDialog";
import { AppSidebar } from "./components/layout/AppSidebar";
import { RightPanel } from "./components/layout/RightPanel";
import { WorkspaceCenter } from "./components/layout/WorkspaceCenter";
import { useAgentController } from "./features/agent/useAgentController";
import { useAppliedChanges } from "./features/changes/useAppliedChanges";
import { useSc2Environment } from "./features/environment/useSc2Environment";
import { useModelCatalog } from "./features/models/useModelCatalog";
import "./App.css";

function Workspace() {
  const environment = useSc2Environment();
  const agent = useAgentController(environment.agentReady);
  const models = useModelCatalog({
    isAgentBusy: agent.isThinking,
    onModelChanged: agent.beginNewAgentSession,
  });
  const appliedChanges = useAppliedChanges({
    agentReady: environment.agentReady,
    databaseBuild: environment.status?.databaseBuild,
    receiptPath: agent.pendingPlan?.receiptPath,
    projectRevision: agent.projectRevision,
    environmentRevision: environment.revision,
    databaseMessage: environment.status?.databaseStatus?.message,
  });

  return (
    <main className="app-shell">
      <AppSidebar agent={agent} environment={environment} models={models} />
      <WorkspaceCenter
        agent={agent}
        environment={environment}
      />
      <RightPanel
        agent={agent}
        changeError={appliedChanges.error}
        changes={appliedChanges.items}
        environment={environment}
      />
      <Sc2SetupDialog agent={agent} environment={environment} />
      <ModelDialog models={models} />
    </main>
  );
}

export default function App() { return <ProjectShell><Workspace /></ProjectShell>; }
