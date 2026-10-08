import type { z } from "zod";
import {
  PRESENCE_SENTINEL,
  PROVIDER_CREDENTIAL_ENVIRONMENT,
  ProviderSetupOverviewSchema,
  ProviderSetupRequestSchema,
  ProviderSetupResultSchema,
  ProviderVerifyRequestSchema,
  ProviderVerifyResultSchema,
  type CredentialProviderId,
  type ProviderSetupApi,
  type ProviderSetupOverview,
  type ProviderSetupRequest,
  type ProviderSetupResult,
  type ProviderVerifyRequest,
  type ProviderVerifyResult,
} from "../../shared/provider-setup.ts";

/**
 * Main-process side of API-first provider setup.
 *
 * Every action is one call to the Python `workspace_init` sidecar. The sidecar never inherits the
 * ambient environment. What it does receive is decided here:
 *
 *  - presence-only commands (overview, apply) see a sentinel for each default key variable that is
 *    set, so the interface can say "found" without any secret leaving this process;
 *  - `verify` receives the one real variable belonging to the provider the user is verifying, and
 *    nothing else, so a tampered workspace file cannot select a different secret to send.
 */

export interface SidecarResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type SidecarRunner = (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<SidecarResult>;

export class ProviderSetupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderSetupError";
    this.code = code;
  }
}

export const PROVIDER_SETUP_TIMEOUTS_MS = Object.freeze({ local: 20_000, verify: 30_000 });
export const PROVIDER_SETUP_OUTPUT_LIMIT = 1024 * 1024;

const ALL_CREDENTIAL_VARIABLES: readonly string[] = Object.values(PROVIDER_CREDENTIAL_ENVIRONMENT);

/** Sentinel values for the default key variables that are set, for presence-only commands. */
export function presenceEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ALL_CREDENTIAL_VARIABLES) {
    if ((source[name] ?? "").trim()) env[name] = PRESENCE_SENTINEL;
  }
  return env;
}

/** The single real credential for a provider, or nothing when it is unset. */
export function verifyEnvironment(provider: CredentialProviderId, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const name = PROVIDER_CREDENTIAL_ENVIRONMENT[provider];
  const value = source[name];
  return value && value.trim() ? { [name]: value } : {};
}

function isCredentialProvider(provider: string): provider is CredentialProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CREDENTIAL_ENVIRONMENT, provider);
}

/** `--name=value` keeps a value that starts with "-" from being read as another flag. */
function option(name: string, value: string | undefined): string[] {
  return value === undefined ? [] : [`--${name}=${value}`];
}

export function setupArguments(request: ProviderSetupRequest): string[] {
  return [
    "start",
    ...option("provider", request.provider),
    ...option("model", request.model),
    ...option("base-url", request.baseUrl),
    ...option("protocol", request.protocol),
    ...option("credential-mode", request.credentialMode),
    ...option("python-profile", request.pythonProfile),
    ...option("r-profile", request.rProfile),
    ...(request.force ? ["--force"] : []),
  ];
}

export function verifyArguments(request: ProviderVerifyRequest): string[] {
  return ["verify", ...option("provider", request.provider), "--approve-network", ...option("approve-host", request.approveHost)];
}

function diagnosticFrom(stderr: string): ProviderSetupError | undefined {
  try {
    const parsed = JSON.parse(stderr) as { diagnostics?: Array<{ code?: unknown; message?: unknown }> };
    const first = parsed.diagnostics?.[0];
    if (first && typeof first.message === "string") {
      return new ProviderSetupError(typeof first.code === "string" ? first.code : "INVALID_INPUT", first.message);
    }
  } catch {
    // fall through to the generic failure
  }
  return undefined;
}

function parseSidecar<S extends z.ZodType>(result: SidecarResult, schema: S): z.output<S> {
  // Exit 1 means "completed, but not ok" (for example a failed verify); the JSON is still the answer.
  if (result.code === 0 || result.code === 1) {
    if (result.stdout.length > PROVIDER_SETUP_OUTPUT_LIMIT) {
      throw new ProviderSetupError("SIDECAR_OUTPUT_TOO_LARGE", "The setup helper returned more output than allowed.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new ProviderSetupError("SIDECAR_INVALID_JSON", "The setup helper returned invalid JSON.");
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderSetupError("SIDECAR_CONTRACT_MISMATCH", "The setup helper returned an unexpected shape; its version may not match this app.");
    }
    return parsed.data;
  }
  throw diagnosticFrom(result.stderr) ?? new ProviderSetupError("SIDECAR_FAILED", `The setup helper exited with code ${result.code ?? "unknown"}.`);
}

export interface ProviderSetupServiceOptions {
  readonly run: SidecarRunner;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly hasWorkspace: () => boolean;
}

export class ProviderSetupService implements ProviderSetupApi {
  private readonly options: ProviderSetupServiceOptions;

  constructor(options: ProviderSetupServiceOptions) {
    this.options = options;
  }

  private requireWorkspace(): void {
    if (!this.options.hasWorkspace()) {
      throw new ProviderSetupError("WORKSPACE_REQUIRED", "Choose a workspace before setting up a model provider.");
    }
  }

  async overview(): Promise<ProviderSetupOverview> {
    this.requireWorkspace();
    const result = await this.options.run(["overview"], presenceEnvironment(this.options.environment()), PROVIDER_SETUP_TIMEOUTS_MS.local);
    return parseSidecar(result, ProviderSetupOverviewSchema);
  }

  async apply(request: ProviderSetupRequest): Promise<ProviderSetupResult> {
    this.requireWorkspace();
    const checked = ProviderSetupRequestSchema.parse(request);
    const result = await this.options.run(setupArguments(checked), presenceEnvironment(this.options.environment()), PROVIDER_SETUP_TIMEOUTS_MS.local);
    return parseSidecar(result, ProviderSetupResultSchema);
  }

  async verify(request: ProviderVerifyRequest): Promise<ProviderVerifyResult> {
    this.requireWorkspace();
    const checked = ProviderVerifyRequestSchema.parse(request);
    if (!isCredentialProvider(checked.provider)) {
      throw new ProviderSetupError("VERIFY_NOT_APPLICABLE", "Only API-key and gateway providers have a live check.");
    }
    const result = await this.options.run(verifyArguments(checked), verifyEnvironment(checked.provider, this.options.environment()), PROVIDER_SETUP_TIMEOUTS_MS.verify);
    return parseSidecar(result, ProviderVerifyResultSchema);
  }
}
