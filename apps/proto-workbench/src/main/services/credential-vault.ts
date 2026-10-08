import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  API_KEY_SHAPE,
  GATEWAY_PROTOCOLS,
  PROVIDER_PINNED_HOST,
  parseGatewayEndpoint,
  type StoredKeySummary,
  type VaultStatus,
} from "../../shared/provider-setup.ts";

/**
 * Provider API keys, encrypted by the operating system's credential facility (Electron safeStorage:
 * Keychain, DPAPI, or a Linux secret service). This is the only place a key is persisted.
 *
 *  - The file holds ciphertext and routing metadata. It never holds a key in the clear, and a
 *    backend that would store text unencrypted (Linux "basic_text") is refused outright.
 *  - Each key is bound, at store time and from the address the user typed, to the one host it may
 *    reach. Official providers use hosts pinned in code. A workspace file can never change where a
 *    stored key is sent, because nothing here reads one.
 *  - Reading a key is a main-process-only operation. The interface can learn that a key exists, where
 *    it is bound and when it was stored, never the key or any part of it.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export type VaultProvider = "anthropic-api" | "openai-api" | "custom-gateway";

export class CredentialVaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

const MAX_FILE_BYTES = 256 * 1024;
const UNSAFE_BACKENDS = new Set(["basic_text", "unknown"]);

const EntrySchema = z.object({
  ciphertext: z.string().min(1).max(8192),
  host: z.string().min(1).max(253),
  baseUrl: z.string().max(256).optional(),
  protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
  storedAt: z.string().max(64),
}).strict();
const FileSchema = z.object({
  format: z.literal(1),
  entries: z.object({
    "anthropic-api": EntrySchema.optional(),
    "openai-api": EntrySchema.optional(),
    "custom-gateway": EntrySchema.optional(),
  }).strict(),
}).strict();
type VaultFile = z.infer<typeof FileSchema>;

export interface StoreRequest {
  readonly provider: VaultProvider;
  readonly key: string;
  readonly baseUrl?: string;
  readonly protocol?: (typeof GATEWAY_PROTOCOLS)[number];
}

export interface ReadResult {
  readonly key: string;
  readonly summary: StoredKeySummary;
}

export class CredentialVault {
  private readonly filePath: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { filePath: string; safeStorage: SafeStorageLike; now?: () => Date }) {
    this.filePath = options.filePath;
    this.safeStorage = options.safeStorage;
    this.now = options.now ?? (() => new Date());
  }

  /** Whether keys can be stored encrypted on this machine, and why not when they cannot. */
  availability(): { available: boolean; reason?: string } {
    let encryption = false;
    try {
      encryption = this.safeStorage.isEncryptionAvailable();
    } catch {
      encryption = false;
    }
    if (!encryption) {
      return { available: false, reason: "The operating system credential store is not available. Unlock or enable it, or use an environment variable." };
    }
    const backend = this.safeStorage.getSelectedStorageBackend?.();
    if (backend && UNSAFE_BACKENDS.has(backend)) {
      return { available: false, reason: "No system keyring was found, so keys would be stored without encryption. Install or unlock a keyring (for example GNOME Keyring or KWallet), or use an environment variable." };
    }
    return { available: true };
  }

  async status(): Promise<VaultStatus> {
    const availability = this.availability();
    return { ...availability, stored: await this.list() };
  }

  /** Metadata only. Nothing here decrypts, so listing never prompts the keyring. */
  async list(): Promise<StoredKeySummary[]> {
    const file = await this.load();
    return (Object.entries(file.entries) as Array<[VaultProvider, VaultFile["entries"]["anthropic-api"]]>)
      .filter((pair): pair is [VaultProvider, NonNullable<(typeof pair)[1]>] => pair[1] !== undefined)
      .map(([provider, entry]) => summarize(provider, entry));
  }

  store(request: StoreRequest): Promise<StoredKeySummary> {
    return this.serialize(async () => {
      const availability = this.availability();
      if (!availability.available) throw new CredentialVaultError("VAULT_UNAVAILABLE", availability.reason ?? "The credential vault is unavailable.");
      if (!API_KEY_SHAPE.test(request.key)) {
        // The message deliberately says nothing about the value.
        throw new CredentialVaultError("INVALID_KEY", "The key must be 16 to 512 printable characters with no spaces.");
      }
      const binding = bindingFor(request);
      const entry = {
        ciphertext: this.safeStorage.encryptString(request.key).toString("base64"),
        host: binding.host,
        ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
        ...(binding.protocol ? { protocol: binding.protocol } : {}),
        storedAt: this.now().toISOString(),
      };
      const file = await this.load();
      file.entries[request.provider] = entry;
      await this.save(file);
      return summarize(request.provider, entry);
    });
  }

  /** For the main process only. Throws UNREADABLE rather than returning a wrong or partial key. */
  async read(provider: VaultProvider): Promise<ReadResult | undefined> {
    const file = await this.load();
    const entry = file.entries[provider];
    if (!entry) return undefined;
    const availability = this.availability();
    if (!availability.available) throw new CredentialVaultError("VAULT_UNAVAILABLE", availability.reason ?? "The credential vault is unavailable.");
    let key: string;
    try {
      key = this.safeStorage.decryptString(Buffer.from(entry.ciphertext, "base64"));
    } catch {
      throw new CredentialVaultError("UNREADABLE", "The stored key can no longer be read by this account. Store it again.");
    }
    if (!API_KEY_SHAPE.test(key)) throw new CredentialVaultError("UNREADABLE", "The stored key is damaged. Store it again.");
    return { key, summary: summarize(provider, entry) };
  }

  remove(provider: VaultProvider): Promise<boolean> {
    return this.serialize(async () => {
      const file = await this.load();
      if (!file.entries[provider]) return false;
      delete file.entries[provider];
      await this.save(file);
      return true;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<VaultFile> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: 1, entries: {} };
      throw new CredentialVaultError("VAULT_READ_FAILED", "The credential file could not be read.");
    }
    if (text.length > MAX_FILE_BYTES) throw new CredentialVaultError("VAULT_DAMAGED", "The credential file is larger than expected and was not read.");
    try {
      return FileSchema.parse(JSON.parse(text));
    } catch {
      throw new CredentialVaultError("VAULT_DAMAGED", "The credential file is damaged. Remove it and store the key again.");
    }
  }

  private async save(file: VaultFile): Promise<void> {
    const text = `${JSON.stringify(file, null, 2)}\n`;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, text, { flag: "wx", mode: 0o600, encoding: "utf8" });
      await rename(temporary, this.filePath);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new CredentialVaultError("VAULT_WRITE_FAILED", "The credential file could not be written.");
    }
  }
}

function summarize(provider: VaultProvider, entry: NonNullable<VaultFile["entries"]["anthropic-api"]>): StoredKeySummary {
  return {
    provider,
    host: entry.host,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.protocol ? { protocol: entry.protocol } : {}),
    storedAt: entry.storedAt,
  };
}

/** Where a key may go. Official providers: pinned in code. A gateway: the address the user typed now. */
function bindingFor(request: StoreRequest): { host: string; baseUrl?: string; protocol?: (typeof GATEWAY_PROTOCOLS)[number] } {
  if (request.provider === "custom-gateway") {
    if (!request.baseUrl) throw new CredentialVaultError("GATEWAY_BASE_URL_REQUIRED", "A gateway key needs the gateway address it is bound to.");
    if (!request.protocol) throw new CredentialVaultError("GATEWAY_PROTOCOL_REQUIRED", "A gateway key needs the gateway's API protocol.");
    try {
      const endpoint = parseGatewayEndpoint(request.baseUrl);
      return { host: endpoint.host, baseUrl: endpoint.baseUrl, protocol: request.protocol };
    } catch (error) {
      throw new CredentialVaultError((error as { code?: string }).code ?? "INVALID_BASE_URL", error instanceof Error ? error.message : "Invalid gateway address.");
    }
  }
  if (request.baseUrl || request.protocol) {
    throw new CredentialVaultError("GATEWAY_OPTION_NOT_APPLICABLE", "An address and protocol apply only to a custom gateway.");
  }
  return { host: PROVIDER_PINNED_HOST[request.provider] };
}
