import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { ChatAttachment } from "../../shared/contracts.ts";

export interface AttachmentGrant {
  attachment: ChatAttachment;
  expiresAt: number;
}

export interface ValidatedAttachments {
  attachments: ChatAttachment[];
  consumedGrantPaths: string[];
}

const MAX_ATTACHMENT_BYTES = 1024 ** 3;

export async function validateSelectedAttachments(
  requested: ChatAttachment[],
  grants: ReadonlyMap<string, AttachmentGrant>,
  resolveWorkspaceReadable: (path: string) => Promise<string>,
  mediaTypeForPath: (path: string) => string,
  now = Date.now(),
): Promise<ValidatedAttachments> {
  const attachments: ChatAttachment[] = [];
  const consumedGrantPaths: string[] = [];

  for (const requestedAttachment of requested) {
    const grant = grants.get(requestedAttachment.path);
    const grantedAttachment = grant && grant.expiresAt > now && sameAttachment(grant.attachment, requestedAttachment)
      ? grant.attachment
      : undefined;

    if (grantedAttachment) {
      await assertUnchangedRegularFile(grantedAttachment);
      attachments.push(grantedAttachment);
      consumedGrantPaths.push(grantedAttachment.path);
      continue;
    }

    let canonical: string;
    try {
      canonical = await resolveWorkspaceReadable(requestedAttachment.path);
    } catch {
      throw new Error("Attachment access was not granted by the current file picker session or workspace.");
    }
    const info = await lstat(canonical);
    const resolved = await realpath(canonical);
    if (info.isSymbolicLink() || !info.isFile() || resolved !== canonical || info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("Workspace references must be regular, non-linked files no larger than 1 GiB.");
    }
    attachments.push({
      path: resolved,
      name: basename(resolved),
      mediaType: mediaTypeForPath(resolved),
      sizeBytes: info.size,
    });
  }

  return { attachments, consumedGrantPaths };
}

function sameAttachment(left: ChatAttachment, right: ChatAttachment): boolean {
  return left.path === right.path
    && left.name === right.name
    && left.mediaType === right.mediaType
    && left.sizeBytes === right.sizeBytes;
}

async function assertUnchangedRegularFile(attachment: ChatAttachment): Promise<void> {
  const original = await lstat(attachment.path);
  const canonical = await realpath(attachment.path);
  if (
    original.isSymbolicLink()
    || !original.isFile()
    || original.size !== attachment.sizeBytes
    || canonical !== attachment.path
    || original.size > MAX_ATTACHMENT_BYTES
  ) {
    throw new Error("The selected attachment changed before it was sent.");
  }
}
