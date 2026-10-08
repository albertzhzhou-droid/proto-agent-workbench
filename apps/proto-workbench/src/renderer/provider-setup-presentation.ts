import {
  PROVIDER_CREDENTIAL_ENVIRONMENT,
  type ProviderCatalog,
  type ProviderCatalogEntry,
  type ProviderDetection,
  type ProviderId,
  type ProviderSetupRequest,
  type ProviderSetupStatus,
  type ValidationCategory,
} from "../shared/provider-setup.ts";

/**
 * Pure presentation rules for the provider setup surface: names, honest status wording, form
 * validation and request building. Kept free of React so every rule is unit-testable.
 */

export interface ProviderForm {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  protocol: "messages" | "chat-completions" | "responses" | "";
  credentialMode: "isolated" | "shared";
  pythonProfile: "core" | "analysis" | "sequence" | "full-science";
  rProfile: "none" | "core" | "rnaseq";
}

const NAMES: Record<ProviderId, string> = {
  "anthropic-api": "Anthropic API",
  "openai-api": "OpenAI API",
  "custom-gateway": "Custom gateway",
  "claude-subscription": "Claude subscription",
  "codex-subscription": "Codex subscription",
  "local-lm-studio": "Local LM Studio",
};

export function providerName(id: ProviderId): string {
  return NAMES[id];
}

/** How the credential is held, in a sentence a person can check against their own setup. */
export function custodyLine(entry: ProviderCatalogEntry): string {
  switch (entry.kind) {
    case "api_key_env":
      return `Key read from ${entry.credential_environment} when you verify; sent only to ${entry.pinned_host}.`;
    case "api_gateway":
      return `Key read from ${entry.credential_environment}; sent only to the HTTPS host you pin, after you approve it.`;
    case "subscription_cli":
      return `Sign-in stays with the ${entry.executable} command line tool; Proto never sees a token.`;
    default:
      return "Runs on this computer with no provider account. No key revocation or audit trail.";
  }
}

export function rankLabel(entry: ProviderCatalogEntry): string {
  if (entry.fallback) return "Fallback · local only";
  if (entry.kind === "api_key_env") return "Preferred";
  if (entry.kind === "api_gateway") return "Your host";
  return "Delegated sign-in";
}

/** What the app can honestly say about this machine, before anything is saved. */
export function detectionLabel(entry: ProviderCatalogEntry, detection: ProviderDetection | undefined): string | undefined {
  const found = detection?.providers[entry.id];
  if (!found) return undefined;
  if (entry.kind === "api_key_env" || entry.kind === "api_gateway") {
    return found.credential_present ? `${entry.credential_environment} found` : `${entry.credential_environment} not set`;
  }
  if (entry.kind === "subscription_cli") return found.cli_found ? `${entry.executable} found` : `${entry.executable} not found`;
  return undefined;
}

const CATEGORY_SENTENCES: Record<ValidationCategory, string> = {
  ok: "The provider accepted the key and the model.",
  auth: "The provider did not accept the key, or it is not set. Check the key in your environment.",
  "model-not-found": "The provider does not list this model. Use a model ID the provider offers.",
  "bad-url": "The provider route was not found. Check the address.",
  network: "The provider could not be reached. Check your connection or proxy.",
  timeout: "The provider did not answer in time. Try again.",
  incompatible: "This gateway does not expose a models route, so the model could not be checked.",
  "server-error": "The provider reported a problem or a rate limit. Try again later.",
  unknown: "The provider answered in a way this app does not recognise.",
};

export function categorySentence(category: ValidationCategory): string {
  return CATEGORY_SENTENCES[category];
}

export type VerificationTone = "neutral" | "ok" | "warn" | "fail";

/** Wording and tone for the last recorded check. Never says "connected": a record is history. */
export function verificationSummary(
  verification: ProviderSetupStatus["verification"] | undefined,
  formatTime: (value: string) => string,
): { label: string; tone: VerificationTone } {
  switch (verification?.state) {
    case "verified":
      return { label: verification.verified_at ? `Verified ${formatTime(verification.verified_at)}` : "Verified", tone: "ok" };
    case "failed": {
      const category = verification.category as ValidationCategory | null | undefined;
      return { label: `Check failed${category ? ` · ${category}` : ""}`, tone: "fail" };
    }
    case "stale":
      return { label: "Configuration changed since the last check", tone: "warn" };
    case "unknown":
      return { label: "Last check could not be read", tone: "warn" };
    default:
      return { label: "Not verified", tone: "neutral" };
  }
}

/**
 * The provider a fresh form starts on. A ready, non-fallback path wins; otherwise the preferred
 * API provider, so an empty workspace is never nudged toward the local-only fallback.
 */
export function defaultProvider(catalog: ProviderCatalog, detection: ProviderDetection): ProviderId {
  const recommended = catalog.providers.find((candidate) => candidate.id === detection.recommended_provider);
  if (recommended && !recommended.fallback) return recommended.id;
  const preferred = catalog.providers
    .filter((candidate) => candidate.kind === "api_key_env")
    .sort((left, right) => left.security_rank - right.security_rank)[0];
  return preferred?.id ?? detection.recommended_provider;
}

export function formFromStatus(status: ProviderSetupStatus | undefined, fallbackProvider: ProviderId): ProviderForm {
  const saved = status?.configuration;
  return {
    provider: saved?.provider.id ?? fallbackProvider,
    model: saved?.provider.model ?? "",
    baseUrl: saved?.provider.base_url ?? "",
    protocol: saved?.provider.protocol ?? "",
    credentialMode: saved?.provider.credential_mode ?? "isolated",
    pythonProfile: saved?.python_profile ?? "analysis",
    rProfile: saved?.r_profile ?? "none",
  };
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

/** Returns the first problem a person can fix, or nothing. The sidecar re-validates everything. */
export function validateForm(form: ProviderForm, catalog: ProviderCatalog): string | undefined {
  const entry = catalog.providers.find((candidate) => candidate.id === form.provider);
  if (!entry) return "Choose a provider.";
  if (form.model && !MODEL_ID.test(form.model)) return "The model ID may use letters, digits and . _ : / @ - only.";
  if (entry.requires.includes("model") && !form.model) return "A model ID is required for this provider.";
  if (entry.kind === "api_gateway") {
    if (!form.baseUrl.trim()) return "Enter the gateway address.";
    const addressProblem = gatewayAddressProblem(form.baseUrl);
    if (addressProblem) return addressProblem;
    if (!form.protocol) return "Choose the gateway's API protocol.";
  }
  return undefined;
}

/**
 * Early feedback that mirrors the setup helper's gateway rules (which remain authoritative):
 * remote hosts need https and a DNS name; plain http is accepted only for this computer.
 */
export function gatewayAddressProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a full address such as https://gateway.example.com/v1.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The gateway address must start with https://.";
  if (url.username || url.password || url.search || url.hash) return "The address must not contain credentials, a query or a fragment.";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1";
  if (loopback) return undefined;
  if (url.protocol !== "https:") return "Remote gateways must use https:// (http:// is allowed only for this computer).";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return "Use the gateway's DNS name, not an IP address.";
  return undefined;
}

/** Only the fields that apply to the chosen provider are sent, so a stale field never leaks across. */
export function buildRequest(form: ProviderForm, catalog: ProviderCatalog, replaceExisting: boolean): ProviderSetupRequest {
  const entry = catalog.providers.find((candidate) => candidate.id === form.provider);
  return {
    provider: form.provider,
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(entry?.kind === "api_gateway" ? { baseUrl: form.baseUrl.trim(), protocol: form.protocol || undefined } : {}),
    ...(entry?.kind === "subscription_cli" ? { credentialMode: form.credentialMode } : {}),
    pythonProfile: form.pythonProfile,
    rProfile: form.rProfile,
    ...(replaceExisting ? { force: true } : {}),
  };
}

export interface VerifyTarget {
  readonly provider: ProviderId;
  readonly host: string;
  readonly variable: string;
  readonly approveHost?: string;
  /**
   * False when the workspace names a custom key variable (a command-line option). The app only
   * hands the setup helper the default variable for each provider, so it cannot verify that one.
   */
  readonly viaApp: boolean;
}

/**
 * Where a verify would send the key, from the saved configuration. Official providers use the
 * host pinned in code; a gateway uses the host the user pinned. Nothing here is typed at verify time.
 */
export function verifyTarget(status: ProviderSetupStatus | undefined, catalog: ProviderCatalog): VerifyTarget | undefined {
  const saved = status?.configuration?.provider;
  if (!status?.initialized || !saved) return undefined;
  const entry = catalog.providers.find((candidate) => candidate.id === saved.id);
  if (!entry || (entry.kind !== "api_key_env" && entry.kind !== "api_gateway")) return undefined;
  const variable = saved.credential_environment ?? entry.credential_environment;
  if (!variable) return undefined;
  const credentialProvider = saved.id as keyof typeof PROVIDER_CREDENTIAL_ENVIRONMENT;
  const viaApp = PROVIDER_CREDENTIAL_ENVIRONMENT[credentialProvider] === variable;
  if (entry.kind === "api_key_env") return entry.pinned_host ? { provider: saved.id, host: entry.pinned_host, variable, viaApp } : undefined;
  if (!saved.host) return undefined;
  return saved.loopback
    ? { provider: saved.id, host: saved.host, variable, viaApp }
    : { provider: saved.id, host: saved.host, variable, approveHost: saved.host, viaApp };
}

export function isDirty(form: ProviderForm, status: ProviderSetupStatus | undefined): boolean {
  const saved = formFromStatus(status, form.provider);
  if (!status?.initialized) return true;
  return (Object.keys(saved) as Array<keyof ProviderForm>).some((key) => saved[key] !== form[key]);
}

/** Plain-language form of a machine-readable next action from the setup helper. */
export function nextActionText(action: ProviderSetupStatus["next"][number]): string {
  switch (action.code) {
    case "initialize":
      return "Save a provider to begin.";
    case "set_environment":
      return `Set ${action.variable ?? "the key variable"} in the environment that starts Proto, then restart the app.`;
    case "verify_provider":
      return "Verify the provider to confirm the key and model.";
    case "check_credential":
      return `Check the key in ${action.variable ?? "your environment"}; the provider did not accept it.`;
    case "choose_model":
      return "Choose a model ID the provider offers, save, then verify again.";
    case "check_base_url":
      return "Check the gateway address, save, then verify again.";
    case "check_gateway_protocol":
      return "Check the gateway's API protocol, or verify it from the command line.";
    case "retry_verify":
      return "Try the check again.";
    case "install_cli":
      return `Install the ${action.executable ?? "provider"} command line tool, then sign in.`;
    case "configure_r_runtime":
      return "R is not available here. Set up the sandbox runtime, or choose R: none.";
    case "repair_configuration":
      return "Save the configuration again to repair it.";
    default:
      return "Review the setup status.";
  }
}
