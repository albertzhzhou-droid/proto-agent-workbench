# ADR 0001: Normalize transcript message paging

- Status: Accepted
- Date: 2026-09-22

## Context

Research sessions currently keep the complete transcript in one versioned JSON payload. That gives atomic compare-and-swap writes and lossless migration, but opening a conversation also sends and renders the entire transcript. The research upgrade requires bounded message reads, provenance-aware context omission, stable references to saved receipts, and preservation of the original complete transcript.

## Decision

Keep the versioned session payload as the canonical, atomically validated record. In the same SQLite transaction as every session write, maintain an ordered message projection with per-message hashes and a transcript manifest. Use that projection for cursor-paged reads. Existing rows are materialized lazily from the validated canonical payload; an integrity mismatch is retained and reported, never repaired by silently choosing one copy. Message cursors bind to workspace, session, ordering, page size, and the hash of the transcript prefix, so appending or updating a later message does not invalidate older pages.

Return only the newest bounded message page when opening a conversation. Load earlier pages on explicit request. Keep all messages in the host-side session for generation, recovery, state validation, and migration. Record exact omitted message ranges, hashes, and receipt-bearing message references in the context retention manifest; never shorten a source message to fit.

## Options considered

1. Keep the full session payload and paginate only in the renderer. Rejected because IPC still transfers the full transcript and large histories remain expensive to open.
2. Replace the versioned session with independently mutable message rows. Rejected because that would weaken current session-level validation, optimistic concurrency, and lossless upgrade behavior.
3. Maintain a hash-checked normalized read projection beside the canonical payload. Accepted because it bounds reads while preserving the existing transactional authority.

## Consequences

- Session writes still have one authoritative compare-and-swap boundary.
- Message projection updates and session writes commit or roll back together.
- Legacy sessions incur one bounded full-payload read when first paged.
- Transcript page responses are bounded by message count; callers can request older pages explicitly.
- The context manifest identifies omissions and receipt source messages; receipt contents remain in the immutable transcript and saved artifacts.
- A missing or corrupt canonical payload or an inconsistent projection is surfaced as an error with original rows retained.

## Action items

- Add transactional normalized message storage and cursor validation.
- Add renderer paging and preserve loaded page order across refreshes.
- Add context omission manifests and tests for stable hashes, legacy migration, cursor invalidation, and corrupt projection handling.
