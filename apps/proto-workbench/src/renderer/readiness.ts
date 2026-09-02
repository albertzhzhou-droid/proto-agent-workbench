import type {
  AppSettings,
  ModelDescriptor,
  RuntimeStatus,
  WorkspaceEntry,
} from "../shared/contracts.ts";
import type { ModuleIntegrityReport } from "../shared/modules.ts";

export type ReadinessStepId = "modules" | "workspace" | "runtime" | "model";
export type ReadinessState = "ready" | "action" | "blocked";
export type ReadinessAction =
  | "open-settings"
  | "choose-workspace"
  | "choose-runtime"
  | "choose-model-root"
  | "open-models";

export interface ReadinessStep {
  id: ReadinessStepId;
  state: ReadinessState;
  title: string;
  detail: string;
  action: ReadinessAction;
  actionLabel: string;
}

export interface WorkbenchReadiness {
  steps: ReadinessStep[];
  readyCount: number;
  totalCount: number;
  operational: boolean;
  next?: ReadinessStep;
}

export function deriveWorkbenchReadiness(input: {
  settings: AppSettings;
  runtime: RuntimeStatus;
  moduleIntegrity: ModuleIntegrityReport;
  models: ModelDescriptor[];
  workspaceEntries: WorkspaceEntry[];
  threadModelId?: string;
}): WorkbenchReadiness {
  const { settings, runtime, moduleIntegrity, models, workspaceEntries, threadModelId } = input;
  const selectedModel = threadModelId ? models.find((model) => model.id === threadModelId) : undefined;
  const activeModel = selectedModel?.loadState === "active" && selectedModel.workbenchInstance
    ? selectedModel
    : threadModelId
      ? undefined
      : models.find((model) => model.loadState === "active" && model.workbenchInstance);
  const workspaceSelected = Boolean(settings.workspacePath.trim());
  const workspaceReady = workspaceSelected && workspaceEntries.length > 0;

  const steps: ReadinessStep[] = [
    moduleIntegrity.ok
      ? {
          id: "modules",
          state: "ready",
          title: "Core modules",
          detail: moduleIntegrity.enforced
            ? "Packaged module integrity is verified."
            : "Development modules are available; package enforcement runs during release builds.",
          action: "open-settings",
          actionLabel: "View audit",
        }
      : {
          id: "modules",
          state: "blocked",
          title: "Core modules",
          detail: "A required module failed integrity verification. Startup actions remain blocked.",
          action: "open-settings",
          actionLabel: "Inspect audit",
        },
    workspaceReady
      ? {
          id: "workspace",
          state: "ready",
          title: "Workspace",
          detail: `${workspaceEntries.length} reviewable file${workspaceEntries.length === 1 ? "" : "s"} indexed in the active workspace.`,
          action: "choose-workspace",
          actionLabel: "Change workspace",
        }
      : {
          id: "workspace",
          state: "action",
          title: "Workspace",
          detail: workspaceSelected
            ? "The selected workspace has no reviewable source files yet. Choose a prepared workspace to continue."
            : "Choose a local Proto workspace before starting a run.",
          action: "choose-workspace",
          actionLabel: "Choose workspace",
        },
    runtime.available
      ? {
          id: "runtime",
          state: "ready",
          title: "LM Studio API",
          detail: `The fixed local endpoint is reachable with ${runtime.modelCount ?? 0} catalog model(s) and ${runtime.loadedModelCount ?? 0} loaded instance(s).`,
          action: "open-settings",
          actionLabel: "View provider",
        }
      : {
          id: "runtime",
          state: "action",
          title: "LM Studio API",
          detail: runtime.detail || `Start LM Studio's local server at ${settings.inference.baseUrl}.`,
          action: "open-settings",
          actionLabel: "View setup",
        },
    activeModel
      ? {
          id: "model",
          state: "ready",
          title: "Active model",
          detail: `${activeModel.name} is connected to an exact LM Studio instance for local runs.`,
          action: "open-models",
          actionLabel: "Manage models",
        }
      : selectedModel
        ? {
            id: "model",
            state: "action",
            title: "Selected model",
            detail: `${selectedModel.name} is selected but is not connected to an exact loaded instance; connect or load it explicitly.`,
            action: "open-models",
            actionLabel: "Load selected model",
          }
        : threadModelId
          ? {
              id: "model",
              state: "action",
              title: "Selected model",
              detail: "The model selected for this run is no longer in the LM Studio catalog. Choose and explicitly connect another model.",
              action: "open-models",
              actionLabel: "Choose model",
            }
          : models.length > 0
        ? {
            id: "model",
            state: "action",
            title: "Active model",
            detail: `${models.filter((model) => model.modelKind !== "embedding").length} chat model(s) discovered from LM Studio; connect or load one explicitly.`,
            action: "open-models",
            actionLabel: "Manage models",
          }
          : {
              id: "model",
              state: "action",
              title: "LM Studio catalog",
              detail: `No models were discovered from ${settings.inference.baseUrl}.`,
              action: "open-models",
              actionLabel: "Refresh LM Studio",
            },
  ];
  const readyCount = steps.filter((step) => step.state === "ready").length;
  return {
    steps,
    readyCount,
    totalCount: steps.length,
    operational: readyCount === steps.length,
    next: steps.find((step) => step.state !== "ready"),
  };
}
