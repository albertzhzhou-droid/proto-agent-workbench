/**
 * Cloud models in Chat. A cloud model is a configured provider's model, offered next to the LM
 * Studio models. Three rules shape everything here:
 *
 *  - It appears only when a provider is configured and a key is available. Listing a model makes no
 *    network request.
 *  - Choosing one is not consent. Sending a conversation off this computer needs an explicit,
 *    per-conversation approval that names the host.
 *  - Where a key may go comes from the credential vault (or a host pinned in code), never from a
 *    workspace file.
 */

export const CLOUD_MODEL_PREFIX = "cloud:";

export const CLOUD_PROVIDERS = ["anthropic-api", "openai-api", "custom-gateway"] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDERS)[number];

/** Wire protocols the chat runtime can speak. A gateway's "responses" protocol is not supported for chat yet. */
export const CLOUD_CHAT_PROTOCOLS = ["messages", "chat-completions"] as const;
export type CloudChatProtocol = (typeof CLOUD_CHAT_PROTOCOLS)[number];

/**
 * Conservative working context for every cloud model. Providers advertise more, but a smaller window
 * bounds how much of a conversation, and of any file the assistant reads, leaves this computer on
 * each step.
 */
export const CLOUD_CONTEXT_TOKENS = 128_000;

export interface CloudModelInfo {
  readonly provider: CloudProviderId;
  readonly host: string;
  readonly protocol: CloudChatProtocol;
  readonly keySource: "vault" | "environment";
}

export function cloudModelId(provider: CloudProviderId, model: string): string {
  return `${CLOUD_MODEL_PREFIX}${provider}:${model}`;
}

export function isCloudModelId(id: string): boolean {
  return id.startsWith(CLOUD_MODEL_PREFIX);
}

export function parseCloudModelId(id: string): { provider: CloudProviderId; model: string } | undefined {
  if (!isCloudModelId(id)) return undefined;
  const rest = id.slice(CLOUD_MODEL_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 1) return undefined;
  const provider = rest.slice(0, separator);
  const model = rest.slice(separator + 1);
  if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider) || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(model)) return undefined;
  return { provider: provider as CloudProviderId, model };
}

/** The sentence the person approves. It states exactly what leaves the computer and where it goes. */
export function cloudEgressStatement(host: string): string {
  return `This conversation will be sent to ${host}: your messages, any documents you attach, and the results of tools the assistant runs, including the contents of workspace files it reads.`;
}
