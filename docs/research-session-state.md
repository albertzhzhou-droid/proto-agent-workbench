# Versioned research session state

`apps/proto-workbench/src/shared/research-session-state.ts` provides a pure payload
codec and source-attributed state projection for the existing Research Chat
session. It creates no database and does not replace the harness SQLite journal.
Research Chat already stores a complete session JSON payload in `research_chats`;
the harness separately records executions, effects and checkpoints.

`ResearchChatService` now uses this codec for its existing SQLite rows, and
`retainChatContext` accepts the complete versioned session as its third argument.
The standalone codec test uses an independent SQLite fixture; the separate
`research-chat-state.test.mjs` suite exercises the actual service lifecycle.

## Payload and source contract

The codec adds three fields without stripping unknown existing JSON fields:

```ts
payloadSchema: "proto-workbench.research-session.v1";
revision: number; // positive safe integer
researchState: {
  question: SourcedResearchText | null;
  confirmedConstraints: ConfirmedResearchConstraint[];
  openQuestions: SourcedResearchText[];
  nextStep: SourcedResearchText | null;
};
```

Every text item has `text`, `sourceMessageId` and `sourceRole`. Constraints also
have a unique `id` and require `sourceRole: "user"`. Every item must quote an exact,
nonempty fragment of the identified durable message's `content`. Document content,
tool outputs and activity IDs are not source messages. An assistant ID labelled
as a user is rejected; attaching a document to a real user message does not make
the document text a user constraint. No Unicode normalization or paraphrase is
silently applied. Editing or removing a cited source invalidates the state.

This is a source-binding check, not a semantic entailment or intent classifier.
The host must accept **confirmation** only through an explicit user action, show
the original message when the user selects a quotation, and never expose this
update as a model-callable tool. A quotation alone cannot establish that a user
endorsed a quoted instruction or that a scientific claim is correct. Assistant
question/next-step entries remain proposals and retain their assistant source
role. No state is inferred or auto-confirmed during legacy migration.

Unknown JSON fields, document snapshots, tool inputs and cached evidence metadata
round-trip unchanged through the codec. Core identity, timestamps, transcript,
document and activity containers plus research-state references are checked.
The codec does not verify receipt files, extraction metadata, scientific evidence,
module configuration, or effect completion. Existing evidence verification remains
responsible for those claims. Optional object fields set to `undefined` serialize
as absent, matching the existing service; nonfinite numbers, functions, symbols,
bigints and cycles are rejected instead of silently rewriting stored values.

## API

- `decodeResearchSession(raw)` returns `{ok:true, raw, session, migrated}` or
  `{ok:false, raw, code, diagnostic}`. `raw` is the original string, including its
  whitespace, on both branches. Decode each row independently. Unsupported schema
  markers and malformed data must not be rewritten or made active by a fallback.
- `encodeResearchSession(session)` validates and returns the versioned JSON
  payload. It accepts an actual legacy `ResearchChatSession`, adding revision 1
  and an empty state. An unversioned payload already containing reserved
  `revision` or `researchState` fields is rejected rather than overwritten.
- `emptyResearchState()` returns a fresh empty state.
- `updateResearchState(session, state, expectedRevision, updatedAt)` validates a
  replacement state, compares the expected revision, returns a detached copy with
  revision incremented, and leaves both inputs unchanged. A stale revision throws
  `REVISION_CONFLICT`. This is an in-memory comparison, **not** a database lock.
- `projectResearchState(session, maxBytes)` returns a source-labelled `message`,
  `bytes`, `revision` and `sourceMessageIds`. It uses the complete durable
  transcript to validate references and projects only known state fields. It
  neither truncates constraints nor includes arbitrary extension fields. Budget
  failure throws `STATE_CONTEXT_BUDGET`. `bytes` counts UTF-8 JSON message bytes
  plus one array separator; the host must additionally budget its system prompt,
  retained turns and runtime tools.

All thrown contract errors have a stable `code` on `ResearchSessionStateError`.
The functions perform no I/O, model calls or automatic execution recovery.

## Service persistence and recovery

The constructor opens the database and derived indexes without loading every
payload. Bounded list indexing and lazy session reads decode rows independently
for the current workspace. See [storage and recovery](research-chat-storage.md).
The row ID must be an addressable UUID and equal the payload session ID. Malformed, future-schema or
identity-mismatched rows are excluded from the active session map while their
original payload remains untouched in `research_chats`. Healthy conversations
still open. The `list` response supplies `recoveryIssues`, with entries containing
`sessionId`, `code`, `message` and a disposition of `retained-unopened` or
`reloaded-latest`. Original payload text is not sent to the renderer.

Opening a valid legacy session migrates its payload once at revision 1. Startup
does not mark another host's response interrupted. An unfinished record exposes a
host-derived execution state; only its owning host can cancel it. Explicit recovery
with the current revision marks streaming messages stopped and running activities
as unconfirmed errors. An unowned legacy record also requires confirmation that
no other process is executing it. Live or unverifiable registered owners cannot
be overridden with that confirmation. A migrated, explicitly recovered legacy
row reaches revision 2. No tool is automatically replayed and no effect is declared
complete by recovery. Existing activity output, artifact references and finish
times remain intact; the recovery explanation is a separate validated
`interruption` field, not a replacement for the recorded tool output.

Each active session keeps its last persisted raw payload. Ordinary transcript,
document, plan, streaming and terminal saves increment the revision. A confirmed
state update increments it exactly once. Existing rows are updated with one
atomic SQLite statement, using the exact prior payload as the last parameter:

```sql
UPDATE research_chats SET updated_at=?, payload=?
WHERE id=? AND workspace=? AND payload=?;
```

Initial creation uses a distinct `INSERT`, not an unconditional UPSERT. When the
comparison fails, the service aborts its own active run, removes the dirty object,
and reloads the latest valid database row without applying interruption recovery
to that other writer's state. Detached generation callbacks and their `finally`
block cannot save again. If reloading finds a rejected or missing row, the dirty
session remains unavailable. The conflict is exposed to the caller and in
`recoveryIssues`; no silent last-writer-wins fallback is performed. The canonical
payload remains in the existing table; derived summary, issue and ownership tables
live in the same database. Payload CAS and summary updates share a transaction.
A losing run marks only its own execution token finished after its actual work
has ended, even when its final payload could not be saved.

## Trusted state request and context

The host accepts this direct UI request only while the session is idle and has no
local active run:

```ts
{ action: "research_state", sessionId: string,
  expectedRevision: number, state: ResearchState }
```

It returns the current session snapshot with its new revision. A stale revision
or source-reference mismatch rejects the request. The model tool registry has no
`research_state` capability. The UI must select quotations from actual saved
messages and present original sources for confirmation. Session version fields
remain optional in the shared display type for legacy preview fixtures; the real
service always produces versioned sessions.

`retainChatContext(history, maxBytes, fullSession)` projects nonempty state from
the complete durable transcript and inserts it immediately after the system
message. This projection is outside the whole-turn eviction loop, and its bytes
are included in every budget comparison. The newest real user request stays last.
An empty research state adds no message or byte overhead. If the state and newest
request cannot both fit, `STATE_CONTEXT_BUDGET` is thrown; confirmed constraints
are never silently dropped. The generation path additionally runs its existing
runtime token-count check with tools and guidance. Assistant-sourced entries stay
source-labelled proposals, not system instructions or confirmed user constraints.

Artifact verification, uncertain effects and resumption authorization remain
separate from this state and persistence contract.

## Research state editor

Open **Chat → Research state** in a saved conversation. Select an existing
message and keep an exact excerpt for the research question, confirmed
constraints, open questions or next step. The constraint selector includes only
user messages; assistant entries elsewhere remain labelled proposals. **View
source message** exposes the complete original message. The UI offers up to 24
constraints and 12 open questions, with 2,000-character excerpts; the host's
larger bounded request limits also accommodate other trusted clients.

**Save state** is an explicit user action and is disabled during generation. A
changed session revision requires **Reload saved state** before an old draft can
be saved. The editor is keyed by session identity; polling uses monotonic
revisions and session-selection tokens, so delayed responses cannot roll back
the visible revision or select an earlier conversation. Migration/recovery
notices are shown separately and never expose the rejected raw payload.

The local preview fixture was saved at revision 2, the owned development server
was stopped and restarted, and the same source-bound quotation reappeared at
revision 2. An invented quotation was rejected without advancing that revision;
switching to another fixture showed its own empty state. Screenshots and DOM
evidence are under `build/research-upgrade-20260922/ui/research-state-*`. These
checks used explicitly labelled fixtures without model inference.

## Validation boundary

From `apps/proto-workbench`:

```text
node --experimental-strip-types --test tests/research-session-state.test.mjs tests/research-chat-state.test.mjs
node node_modules/typescript/bin/tsc --noEmit
```

The focused suite checks 14 cases covering legacy migration, nested extension
preservation, repeated decode/encode, malformed/future raw retention, invalid
shapes, source impersonation, invalidated sources, optimistic revision conflict,
mutation isolation, role-preserving projection and an exact UTF-8 budget boundary.
Its SQLite fixture writes serialized legacy/current/corrupt rows, closes/reopens
the file, migrates only the valid legacy row, reopens again to prove idempotence,
retains the corrupt row byte-for-byte, and demonstrates stale SQL CAS rejection.
The original service cases separately check actual service close/reopen, exact revision
increments, explicit interrupted-response recovery, raw rejected-row
retention, multiple-instance stale writes and an active losing run whose finalizer
cannot overwrite the winner. They also cover forged confirmation sources,
idle-only confirmation, absence from the model tool registry, a fixture runtime request
that retains constraints after evicting their old source turn, empty-state
overhead, insufficient context, and an externally replaced future-schema row.

These automated tests do not establish renderer confirmation UX, crash durability
under power loss, distributed execution leasing, or scientific validation.
