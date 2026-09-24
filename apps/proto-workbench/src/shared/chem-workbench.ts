export interface ChemWorkbenchStatus {
  available: boolean;
  url?: string;
  error?: string;
  sourceManifestHash?: string;
  workspacePath: string;
  migrated?: {designs: number; projects: number};
}
