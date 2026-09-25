import { create } from 'zustand';

export interface StudySelection { studyId: string; name: string; question: string; entityId?: string; datasetId?: string }
/** View selection only. The host's Study and immutable versions remain authoritative. */
export const useManagedStudySelection = create<{
  byWorkspace: Record<string, StudySelection | undefined>;
  select(workspace: string, selection?: StudySelection): void;
}>((set) => ({
  byWorkspace: {},
  select: (workspace, selection) => set(state => ({byWorkspace: {...state.byWorkspace, [workspace]: selection}})),
}));
