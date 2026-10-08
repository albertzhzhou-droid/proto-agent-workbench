import {
  PROVIDER_CREDENTIAL_ENVIRONMENT,
  type ProviderCatalogEntry,
  type ProviderId,
  type ProviderSetupApi,
  type ProviderSetupOverview,
  type ProviderSetupRequest,
  type ProviderSetupResult,
  type ProviderSetupStatus,
} from "../shared/provider-setup.ts";

/**
 * Browser-preview provider setup. It mirrors the desktop catalog so the interface can be reviewed
 * in both themes, but it is explicitly session-only: nothing is written, no key is read, and a
 * live check is never simulated as a success.
 */

const METRICS = { elapsed_ms: 0, files_written: 0, network_requests: 0 } as const;

const PREVIEW_PROVIDERS: ProviderCatalogEntry[] = [
  { id: "anthropic-api", label: "Anthropic API (key from environment)", kind: "api_key_env", security_rank: 1, fallback: false, requires: [], pinned_host: "api.anthropic.com", credential_environment: PROVIDER_CREDENTIAL_ENVIRONMENT["anthropic-api"] },
  { id: "openai-api", label: "OpenAI API (key from environment)", kind: "api_key_env", security_rank: 1, fallback: false, requires: [], pinned_host: "api.openai.com", credential_environment: PROVIDER_CREDENTIAL_ENVIRONMENT["openai-api"] },
  { id: "custom-gateway", label: "Custom gateway (user-pinned host; HTTPS and a key unless loopback)", kind: "api_gateway", security_rank: 2, fallback: false, requires: ["base_url", "model", "protocol"], credential_environment: PROVIDER_CREDENTIAL_ENVIRONMENT["custom-gateway"] },
  { id: "claude-subscription", label: "Claude subscription (delegated to the installed claude CLI login)", kind: "subscription_cli", security_rank: 2, fallback: false, requires: [], executable: "claude", home_environment: "CLAUDE_CONFIG_DIR" },
  { id: "codex-subscription", label: "Codex / ChatGPT subscription (delegated to the installed codex CLI login)", kind: "subscription_cli", security_rank: 2, fallback: false, requires: [], executable: "codex", home_environment: "CODEX_HOME" },
  { id: "local-lm-studio", label: "Local LM Studio on loopback (legacy local-only path)", kind: "local_only", security_rank: 3, fallback: true, requires: [] },
];

const UNINITIALIZED: ProviderSetupStatus = {
  ok: false,
  ready: false,
  initialized: false,
  issues: [],
  next: [{ code: "initialize", argv: ["init", "apply"] }],
  metrics: METRICS,
};

export function createProviderSetupPreview(): ProviderSetupApi {
  let status: ProviderSetupStatus = UNINITIALIZED;

  const overview = (): ProviderSetupOverview => ({
    ok: true,
    catalog: {
      providers: PREVIEW_PROVIDERS,
      python_profiles: [
        { id: "core", summary: "Compiler, checker, review and MCP only.", extras: [] },
        { id: "analysis", summary: "Adds bounded statistics and figure export.", extras: ["compute", "research-figures"] },
        { id: "sequence", summary: "Adds sequence and Biopython-backed computation.", extras: ["compute", "compute-research"] },
        { id: "full-science", summary: "Adds chemistry-capable computation to the analysis stack.", extras: ["compute", "compute-research", "compute-chem", "research-figures"] },
      ],
      r_profiles: [
        { id: "none", summary: "R is not used by this workspace.", enabled: false, packages: [] },
        { id: "core", summary: "Base R for fixed analysis scripts.", enabled: true, packages: ["jsonlite"] },
        { id: "rnaseq", summary: "Adds the DESeq2 adapter dependency.", enabled: true, packages: ["jsonlite", "DESeq2"] },
      ],
      gateway_protocols: ["messages", "chat-completions", "responses"],
      credential_modes: ["isolated", "shared"],
      validation_categories: ["ok", "network", "auth", "model-not-found", "bad-url", "timeout", "incompatible", "server-error", "unknown"],
      default_out_dir: ".proto/workspace",
    },
    detection: {
      python: { version: "preview", executable: "python", supported: true },
      rscript_found: false,
      providers: {},
      recommended_provider: "local-lm-studio",
    },
    status,
  });

  return {
    async overview() {
      return overview();
    },
    async apply(request: ProviderSetupRequest): Promise<ProviderSetupResult> {
      const entry = PREVIEW_PROVIDERS.find((provider) => provider.id === request.provider)!;
      const gateway = entry.kind === "api_gateway" && request.baseUrl ? new URL(request.baseUrl) : undefined;
      const loopback = gateway ? ["localhost", "127.0.0.1", "[::1]"].includes(gateway.hostname) : undefined;
      status = {
        ok: true,
        ready: false,
        initialized: true,
        directory: ".proto/workspace",
        provider: request.provider as ProviderId,
        verification: { state: "never" },
        configuration: {
          provider: {
            id: entry.id,
            kind: entry.kind,
            ...(request.model ? { model: request.model } : {}),
            ...(gateway ? { base_url: `${gateway.origin}${gateway.pathname.replace(/\/$/, "")}`, host: gateway.hostname, loopback, ...(request.protocol ? { protocol: request.protocol } : {}) } : {}),
            ...(entry.kind === "subscription_cli" ? { credential_mode: request.credentialMode ?? "isolated" } : {}),
            ...(entry.credential_environment ? { credential_environment: entry.credential_environment } : {}),
          },
          python_profile: request.pythonProfile ?? "analysis",
          r_profile: request.rProfile ?? "none",
        },
        checks: { provider: { status: "unverified", reason: "preview_only" } },
        next: [],
        issues: [],
        metrics: METRICS,
      };
      return {
        ok: true,
        apply: {
          ok: true,
          changed: true,
          provider: request.provider,
          written: [],
          unchanged: [],
          warnings: ["Preview mode: nothing was written and no key was read. Use the desktop app to configure a provider."],
          next_steps: [],
          metrics: METRICS,
        },
        verify: null,
        status,
        metrics: METRICS,
      };
    },
    async verify() {
      throw new Error("Live provider checks are unavailable in preview mode; use the desktop app.");
    },
  };
}
