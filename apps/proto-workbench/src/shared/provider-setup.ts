import { z } from "zod";

/**
 * API-first provider setup, shared by the renderer, preload bridge and main process.
 *
 * The Python `proto_agent.workspace_init` module owns the behaviour; this file owns the
 * boundary. Nothing here carries a secret value: the workbench records environment-variable
 * NAMES only, and a key is read by the sidecar from its own environment at verify time.
 */

export const PROVIDER_IDS = [
  "anthropic-api",
  "openai-api",
  "custom-gateway",
  "claude-subscription",
  "codex-subscription",
  "local-lm-studio",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_KINDS = ["api_key_env", "api_gateway", "subscription_cli", "local_only"] as const;
export const GATEWAY_PROTOCOLS = ["messages", "chat-completions", "responses"] as const;
export const CREDENTIAL_MODES = ["isolated", "shared"] as const;
export const PYTHON_PROFILE_IDS = ["core", "analysis", "sequence", "full-science"] as const;
export const R_PROFILE_IDS = ["none", "core", "rnaseq"] as const;
export const VALIDATION_CATEGORIES = [
  "ok", "network", "auth", "model-not-found", "bad-url", "timeout", "incompatible", "server-error", "unknown",
] as const;
export type ValidationCategory = (typeof VALIDATION_CATEGORIES)[number];
export const VERIFICATION_STATES = ["never", "verified", "failed", "stale", "unknown"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/**
 * The only variables the workbench ever hands to the setup sidecar, and only the one that
 * matches the provider being verified. A custom variable name is a CLI-only option: a name
 * read from a workspace file is untrusted and must never choose which secret leaves the app.
 */
export const PROVIDER_CREDENTIAL_ENVIRONMENT = Object.freeze({
  "anthropic-api": "ANTHROPIC_API_KEY",
  "openai-api": "OPENAI_API_KEY",
  "custom-gateway": "PROTO_GATEWAY_API_KEY",
} as const);
export type CredentialProviderId = keyof typeof PROVIDER_CREDENTIAL_ENVIRONMENT;

/** Stand-in value that proves a variable exists without exposing it to presence-only commands. */
export const PRESENCE_SENTINEL = "presence-only";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const DNS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const ProviderIdSchema = z.enum(PROVIDER_IDS);

/** What the user chose in the setup form. Free text is bounded and re-validated by the sidecar. */
export const ProviderSetupRequestSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().regex(MODEL_ID).optional(),
  baseUrl: z.string().trim().min(1).max(256).optional(),
  protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
  credentialMode: z.enum(CREDENTIAL_MODES).optional(),
  pythonProfile: z.enum(PYTHON_PROFILE_IDS).optional(),
  rProfile: z.enum(R_PROFILE_IDS).optional(),
  force: z.boolean().optional(),
}).strict();
export type ProviderSetupRequest = z.infer<typeof ProviderSetupRequestSchema>;

/**
 * Sending a credential to a host is only ever the result of this explicit request. The literal
 * `true` makes an omitted or falsy approval a validation error rather than a quiet default.
 */
export const ProviderVerifyRequestSchema = z.object({
  provider: ProviderIdSchema,
  approveNetwork: z.literal(true),
  approveHost: z.string().regex(DNS_HOST).max(253).optional(),
}).strict();
export type ProviderVerifyRequest = z.infer<typeof ProviderVerifyRequestSchema>;

const Metrics = z.object({
  elapsed_ms: z.number().nonnegative(),
  files_written: z.number().int().nonnegative(),
  network_requests: z.number().int().nonnegative(),
});

const CatalogProvider = z.object({
  id: ProviderIdSchema,
  label: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  security_rank: z.number().int().min(1).max(3),
  fallback: z.boolean(),
  requires: z.array(z.string()),
  pinned_host: z.string().optional(),
  credential_environment: z.string().optional(),
  executable: z.string().optional(),
  home_environment: z.string().optional(),
});

const ProviderCatalog = z.object({
  providers: z.array(CatalogProvider),
  python_profiles: z.array(z.object({ id: z.enum(PYTHON_PROFILE_IDS), summary: z.string(), extras: z.array(z.string()) })),
  r_profiles: z.array(z.object({ id: z.enum(R_PROFILE_IDS), summary: z.string(), enabled: z.boolean(), packages: z.array(z.string()) })),
  gateway_protocols: z.array(z.enum(GATEWAY_PROTOCOLS)),
  credential_modes: z.array(z.enum(CREDENTIAL_MODES)),
  validation_categories: z.array(z.enum(VALIDATION_CATEGORIES)),
  default_out_dir: z.string(),
});

const Detection = z.object({
  python: z.object({ version: z.string(), executable: z.string(), supported: z.boolean() }),
  rscript_found: z.boolean(),
  providers: z.record(z.string(), z.object({
    kind: z.enum(PROVIDER_KINDS),
    security_rank: z.number().int(),
    credential_environment: z.string().optional(),
    credential_present: z.boolean().optional(),
    executable: z.string().optional(),
    cli_found: z.boolean().optional(),
    note: z.string().optional(),
  })),
  recommended_provider: ProviderIdSchema,
  workspace_writable: z.boolean().optional(),
});

const Check = z.object({ status: z.enum(["ready", "not_ready", "unverified", "disabled"]), reason: z.string() });
const NextAction = z.object({
  code: z.string(),
  argv: z.array(z.string()).optional(),
  variable: z.string().optional(),
  executable: z.string().nullable().optional(),
});
const Verification = z.object({
  state: z.enum(VERIFICATION_STATES),
  verified_at: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  http_status: z.number().int().nullable().optional(),
  host: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  reason: z.string().optional(),
});
const Issue = z.object({ code: z.string(), message: z.string() });

/** The saved, non-secret choices as the sidecar read them back from the workspace manifest. */
const SavedProvider = z.looseObject({
  id: ProviderIdSchema,
  kind: z.enum(PROVIDER_KINDS),
  model: z.string().optional(),
  host: z.string().optional(),
  base_url: z.string().optional(),
  protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
  loopback: z.boolean().optional(),
  credential_environment: z.string().optional(),
  credential_mode: z.enum(CREDENTIAL_MODES).optional(),
  credential_home: z.string().optional(),
});
const Configuration = z.object({
  provider: SavedProvider,
  python_profile: z.enum(PYTHON_PROFILE_IDS).nullable(),
  r_profile: z.enum(R_PROFILE_IDS).nullable(),
});

const Status = z.object({
  ok: z.boolean(),
  ready: z.boolean(),
  initialized: z.boolean(),
  directory: z.string().optional(),
  provider: ProviderIdSchema.nullable().optional(),
  credential_environment: z.string().optional(),
  credential_present: z.boolean().optional(),
  verification: Verification.optional(),
  configuration: Configuration.optional(),
  checks: z.record(z.string(), Check).optional(),
  next: z.array(NextAction),
  issues: z.array(Issue),
  metrics: Metrics,
});

const Verdict = z.object({
  provider: ProviderIdSchema,
  ok: z.boolean(),
  category: z.enum(VALIDATION_CATEGORIES),
  code: z.string().optional(),
  message: z.string().optional(),
  host: z.string().optional(),
  model: z.string().nullable().optional(),
  model_probe: z.boolean().optional(),
  http_status: z.number().int().optional(),
  model_count: z.number().int().nullable().optional(),
  credential_environment: z.string().optional(),
  metrics: Metrics,
});

export const ProviderSetupOverviewSchema = z.object({
  ok: z.literal(true),
  catalog: ProviderCatalog,
  detection: Detection,
  status: Status,
});
export type ProviderSetupOverview = z.infer<typeof ProviderSetupOverviewSchema>;

export const ProviderSetupResultSchema = z.object({
  ok: z.boolean(),
  apply: z.object({
    ok: z.boolean(),
    changed: z.boolean(),
    provider: ProviderIdSchema,
    written: z.array(z.string()),
    unchanged: z.array(z.string()),
    warnings: z.array(z.string()),
    next_steps: z.array(z.string()),
    metrics: Metrics,
  }),
  verify: Verdict.nullable(),
  status: Status,
  metrics: Metrics,
});
export type ProviderSetupResult = z.infer<typeof ProviderSetupResultSchema>;

export const ProviderVerifyResultSchema = Verdict.extend({ status: Status.optional() });
export type ProviderVerifyResult = z.infer<typeof ProviderVerifyResultSchema>;

export type ProviderSetupStatus = z.infer<typeof Status>;
export type ProviderCatalogEntry = z.infer<typeof CatalogProvider>;
export type ProviderCatalog = z.infer<typeof ProviderCatalog>;
export type ProviderDetection = z.infer<typeof Detection>;
export type SavedProviderConfiguration = z.infer<typeof Configuration>;

export interface ProviderSetupApi {
  /** Catalog, offline detection and current status in one sidecar call. */
  overview(): Promise<ProviderSetupOverview>;
  /** Write the configuration (idempotent). Never sends a credential anywhere. */
  apply(request: ProviderSetupRequest): Promise<ProviderSetupResult>;
  /** One approved, credentialed request to the provider's pinned host. */
  verify(request: ProviderVerifyRequest): Promise<ProviderVerifyResult>;
}
