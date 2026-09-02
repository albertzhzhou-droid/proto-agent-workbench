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
  const activeModel = selectedModel?.loadState === "active"
    ? selectedModel
    : threadModelId
      ? undefined
      : models.find((model) => model.loadState === "active");
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
          title: "Inference runtime",
          detail: runtime.backend === "cuda"
            ? "The trusted llama.cpp runtime is available with CUDA."
            : "The trusted llama.cpp runtime is available with CPU fallback.",
          action: "choose-runtime",
          actionLabel: "Change runtime",
        }
      : {
          id: "runtime",
          state: "action",
          title: "Inference runtime",
          detail: runtime.detail || "Choose a trusted upstream llama-server executable.",
          action: "choose-runtime",
          actionLabel: "Choose runtime",
        },
    activeModel
      ? {
          id: "model",
          state: "ready",
          title: "Active model",
          detail: `${activeModel.name} is loaded and selected for local runs.`,
          action: "open-models",
          actionLabel: "Manage models",
        }
      : selectedModel
        ? {
            id: "model",
            state: "action",
            title: "Selected model",
            detail: `${selectedModel.name} is selected for this run but is ${selectedModel.loadState}; review its memory estimate and load it explicitly.`,
            action: "open-models",
            actionLabel: "Load selected model",
          }
        : threadModelId
          ? {
              id: "model",
              state: "action",
              title: "Selected model",
              detail: "The model selected for this run is no longer in the discovered catalog. Choose and load another local model.",
              action: "open-models",
              actionLabel: "Choose model",
            }
          : models.length > 0
        ? {
            id: "model",
            state: "action",
            title: "Active model",
            detail: `${models.length} local model${models.length === 1 ? "" : "s"} discovered; load one explicitly after reviewing its memory estimate.`,
            action: "open-models",
            actionLabel: "Review models",
          }
          : {
              id: "model",
              state: "action",
              title: "Model library",
              detail: "No GGUF models were discovered in the configured read-only library.",
              action: "choose-model-root",
              actionLabel: "Choose model folder",
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
