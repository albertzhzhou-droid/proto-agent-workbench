export interface TypographySelection {
  profile: "local" | "public";
  root: string;
  files: Array<{ file: string; sha256: string; bytes: number; path: string }>;
  faces: Array<{ family: string; aliases: string[]; style: string; weight: string | number; file: string; format: string }>;
}
export function selectTypography(appRoot: string, requested?: "auto" | "public" | "local"): TypographySelection;
