import { syncWorkspaceTemplate, verifyWorkspaceTemplate } from "./workspace-template-sync.mjs";

const mode = process.argv[2] ?? "--check";
if (!["--check", "--write"].includes(mode) || process.argv.length > 3) {
  throw new Error("Usage: node scripts/sync-workspace-template.mjs [--check|--write]");
}

const report = mode === "--write"
  ? await syncWorkspaceTemplate()
  : await verifyWorkspaceTemplate();

process.stdout.write(
  `${mode === "--write" ? "Synchronized" : "Verified"} packaged workspace template: `
  + `${report.fileCount} managed files (${report.skillFileCount} Skill files), exact SHA-256 match.\n`,
);
