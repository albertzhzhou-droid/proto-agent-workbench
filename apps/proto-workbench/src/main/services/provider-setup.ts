import type { z } from "zod";
import {
  PRESENCE_SENTINEL,
  PROVIDER_CREDENTIAL_ENVIRONMENT,
  ProviderRemoveKeyRequestSchema,
  ProviderSetupRequestSchema,
  ProviderSetupResultSchema,
  ProviderStoreKeyRequestSchema,
  ProviderVerifyRequestSchema,
  ProviderVerifyResultSchema,
  SidecarOverviewSchema,
  SidecarStatusSchema,
  parseGatewayEndpoint,
  type CredentialProviderId,
  type ProviderRemoveKeyRequest,
  type ProviderSetupApi,
  type ProviderSetupOverview,
  type ProviderSetupRequest,
  type ProviderSetupResult,
  type ProviderStoreKeyRequest,
  type ProviderVerifyRequest,
  type ProviderVerifyResult,
  type StoredKeySummary,
  type VaultStatus,
} from "../../shared/provider-setup.ts";
import type { CloudSetupView } from "./cloud-chat-runtime.ts";
import { CredentialVaultError, type ReadResult, type StoreRequest, type VaultProvider } from "./credential-vault.ts";

/**
 * Main-process side of API-first provider setup.
 *
 * Every action is one call to the Python `workspace_init` sidecar. The sidecar never inherits the
 * ambient environment. What it does receive is decided here:
 *
 *  - presence-only commands (overview, apply) see a sentinel for each default key variable that is
 *    set in the environment or held in the credential vault, so the interface can say "found"
 *    without any secret leaving this process;
 *  - `verify` receives the one real key belonging to the provider being verified (from the vault,
 *    else the environment) and nothing else, so a tampered workspace file cannot select a different
 *    secret to send;
 *  - a stored gateway key is bound to the address the user typed when storing it. The helper is told
 *    that origin and refuses to send if the editable workspace file now says otherwise.
 */

export interface SidecarResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type SidecarRunner = (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<SidecarResult>;

/** The slice of the credential vault this service uses, so tests can supply a plain object. */
export interface VaultPort {
  status(): Promise<VaultStatus>;
  list(): Promise<StoredKeySummary[]>;
  store(request: StoreRequest): Promise<StoredKeySummary>;
  read(provider: VaultProvider): Promise<ReadResult | undefined>;
  remove(provider: VaultProvider): Promise<boolean>;
}

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

/** Sentinel values for default key variables that are set or vault-held, for presence-only commands. */
export function presenceEnvironment(source: NodeJS.ProcessEnv, stored: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ALL_CREDENTIAL_VARIABLES) {
    if ((source[name] ?? "").trim()) env[name] = PRESENCE_SENTINEL;
  }
  for (const provider of stored) {
    if (isCredentialProvider(provider)) env[PROVIDER_CREDENTIAL_ENVIRONMENT[provider]] = PRESENCE_SENTINEL;
  }
  return env;
}

/** The single real credential from the environment for a provider, or nothing when it is unset. */
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

export function verifyArguments(request: ProviderVerifyRequest, binding?: { readonly host?: string; readonly origin?: string }): string[] {
  return [
    "verify",
    ...option("provider", request.provider),
    "--approve-network",
    ...option("approve-host", binding?.host ?? request.approveHost),
    ...option("bind-origin", binding?.origin),
  ];
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

function vaultFailure(error: unknown): ProviderSetupError {
  if (error instanceof CredentialVaultError) return new ProviderSetupError(error.code, error.message);
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" && error instanceof Error) {
    return new ProviderSetupError((error as { code: string }).code, error.message);
  }
  return new ProviderSetupError("VAULT_FAILED", "The credential vault could not complete the request.");
}

export interface ProviderSetupServiceOptions {
  readonly run: SidecarRunner;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly hasWorkspace: () => boolean;
  readonly vault: VaultPort;
}

/** How long the saved provider choice is reused. Chat refreshes its model list every few seconds. */
export const CLOUD_SETUP_CACHE_MS = 30_000;

export class ProviderSetupService implements ProviderSetupApi {
  private readonly options: ProviderSetupServiceOptions;
  private cloudCache: { readonly at: number; readonly view: CloudSetupView | undefined } | undefined;

  constructor(options: ProviderSetupServiceOptions) {
    this.options = options;
  }

  private invalidateCloudSetup(): void {
    this.cloudCache = undefined;
  }

  /**
   * The saved cloud provider and model name, for the chat model list. Only the name is taken from the
   * workspace file; where a key may go is decided by the credential vault, not by anything read here.
   */
  async cloudSetup(now: number = Date.now()): Promise<CloudSetupView | undefined> {
    if (!this.options.hasWorkspace()) return undefined;
    if (this.cloudCache && now - this.cloudCache.at < CLOUD_SETUP_CACHE_MS) return this.cloudCache.view;
    let view: CloudSetupView | undefined;
    try {
      const result = await this.options.run(["status"], await this.presence(), PROVIDER_SETUP_TIMEOUTS_MS.local);
      const status = parseSidecar(result, SidecarStatusSchema);
      const saved = status.configuration?.provider;
      if (status.initialized && saved && (saved.kind === "api_key_env" || saved.kind === "api_gateway") && saved.model) {
        view = { provider: saved.id as CloudSetupView["provider"], model: saved.model };
      }
    } catch {
      view = undefined;
    }
    this.cloudCache = { at: now, view };
    return view;
  }

  private requireWorkspace(): void {
    if (!this.options.hasWorkspace()) {
      throw new ProviderSetupError("WORKSPACE_REQUIRED", "Choose a workspace before setting up a model provider.");
    }
  }

  private async vaultStatus(): Promise<VaultStatus> {
    try {
      return await this.options.vault.status();
    } catch (error) {
      // A damaged credential file must not take the whole setup page down.
      return { available: false, reason: vaultFailure(error).message, stored: [] };
    }
  }

  private async storedProviders(): Promise<string[]> {
    try {
      return (await this.options.vault.list()).map((entry) => entry.provider);
    } catch {
      return [];
    }
  }

  private async presence(): Promise<NodeJS.ProcessEnv> {
    return presenceEnvironment(this.options.environment(), await this.storedProviders());
  }

  async overview(): Promise<ProviderSetupOverview> {
    this.requireWorkspace();
    const [result, vault] = await Promise.all([
      this.presence().then((env) => this.options.run(["overview"], env, PROVIDER_SETUP_TIMEOUTS_MS.local)),
      this.vaultStatus(),
    ]);
    return { ...parseSidecar(result, SidecarOverviewSchema), vault };
  }

  async apply(request: ProviderSetupRequest): Promise<ProviderSetupResult> {
    this.requireWorkspace();
    const checked = ProviderSetupRequestSchema.parse(request);
    const result = await this.options.run(setupArguments(checked), await this.presence(), PROVIDER_SETUP_TIMEOUTS_MS.local);
    this.invalidateCloudSetup();
    return parseSidecar(result, ProviderSetupResultSchema);
  }

  async storeKey(request: ProviderStoreKeyRequest): Promise<StoredKeySummary> {
    const checked = ProviderStoreKeyRequestSchema.parse(request);
    this.invalidateCloudSetup();
    try {
      return await this.options.vault.store({
        provider: checked.provider,
        key: checked.key,
        ...(checked.baseUrl ? { baseUrl: checked.baseUrl } : {}),
        ...(checked.protocol ? { protocol: checked.protocol } : {}),
      });
    } catch (error) {
      throw vaultFailure(error);
    }
  }

  async removeKey(request: ProviderRemoveKeyRequest): Promise<{ removed: boolean }> {
    const checked = ProviderRemoveKeyRequestSchema.parse(request);
    this.invalidateCloudSetup();
    try {
      return { removed: await this.options.vault.remove(checked.provider) };
    } catch (error) {
      throw vaultFailure(error);
    }
  }

  async verify(request: ProviderVerifyRequest): Promise<ProviderVerifyResult> {
    this.requireWorkspace();
    const checked = ProviderVerifyRequestSchema.parse(request);
    if (!isCredentialProvider(checked.provider)) {
      throw new ProviderSetupError("VERIFY_NOT_APPLICABLE", "Only API-key and gateway providers have a live check.");
    }
    let stored: ReadResult | undefined;
    try {
      stored = await this.options.vault.read(checked.provider);
    } catch (error) {
      throw vaultFailure(error);
    }
    if (stored && checked.provider === "custom-gateway") {
      // What the user approved must be what the key is bound to; the helper checks the saved file too.
      if (checked.approveHost !== undefined && checked.approveHost !== stored.summary.host) {
        throw new ProviderSetupError("HOST_NOT_APPROVED", `The stored key is bound to ${stored.summary.host}, not ${checked.approveHost}.`);
      }
    }
    const variable = PROVIDER_CREDENTIAL_ENVIRONMENT[checked.provider];
    const env = stored ? { [variable]: stored.key } : verifyEnvironment(checked.provider, this.options.environment());
    let binding: { host?: string; origin?: string } | undefined;
    if (stored && checked.provider === "custom-gateway" && stored.summary.baseUrl) {
      const endpoint = parseGatewayEndpoint(stored.summary.baseUrl);
      binding = { origin: endpoint.origin, ...(endpoint.loopback ? {} : { host: endpoint.host }) };
    }
    const result = await this.options.run(verifyArguments(checked, binding), env, PROVIDER_SETUP_TIMEOUTS_MS.verify);
    return parseSidecar(result, ProviderVerifyResultSchema);
  }
}
