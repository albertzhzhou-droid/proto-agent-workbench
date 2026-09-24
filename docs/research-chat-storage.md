# Research conversation storage and recovery

Chat uses SQLite summaries for the conversation sidebar and loads the complete
canonical conversation only when it is opened or an operation needs it. A list
page is not a truncated session: messages, document revisions, research-state
sources and claim history retain their existing complete-session contract.

## Browsing conversations

The sidebar requests 30 summaries at a time. **Load older conversations** extends
the current list up to a 200-conversation window; older groups and a return to the
newest group remain explicit actions. In a compact or narrow layout, **Open
conversations** opens the same list in a dismissible dialog. A changed list
generation invalidates its continuation cursor;
the UI retains the visible conversations and offers a refresh rather than quietly
merging incompatible pages. Selecting a conversation is independent of its list
page, so changing the sidebar window does not discard the selected transcript.

Legacy rows are indexed in bounded batches. While indexing is incomplete, the
interface reports that fact. Rejected records retain their original bytes and
produce recovery notices independently of the visible conversation page. A
summary's review count is stored metadata; it does not assert that source files
were reopened or that a scientific claim is correct. Source integrity is still
checked by the full-session evidence and claim views.

## Interrupted responses

The host records execution ownership separately from the conversation payload.
An observer can view another host's response without rewriting it as interrupted.
Only the owning host can cancel its running response. Recovery is a separate
explicit action with a current expected session revision; it preserves partial
output and records that tool completion was not confirmed. It never replays a
tool or infers whether an external effect finished.

Recovery keeps the original activity output, artifact references and existing
finish time. It writes a separate `interruption` note and marks unfinished
activities `error` and streaming responses `stopped`. An unconfirmed activity is
displayed without a live progress indicator. These states do not claim that a
partially recorded result or external effect completed.

A live owner, or an owner whose death cannot be established, is not taken over
because a timestamp is old. Legacy interrupted rows without ownership information
require explicit confirmation before they can be marked interrupted. This is a
local process-ownership contract, not distributed execution or an exactly-once
effect protocol; the shared Chat/Harness execution work remains a separate item.

## Scope and retained data

Payload saves continue to compare the exact previously persisted raw JSON. Summary
metadata and payload changes belong to the same database transaction. An older
writer changing a payload invalidates its indexed summary. Invalid JSON, future
payload schemas, invalid identities and unsupported large payloads are retained
unopened; they are not truncated and resaved.

The idle-session cache has count and byte limits. Active asynchronous requests
and model runs remain pinned until completion. Cache accounting is a bounded
serialized-size estimate, not a measured V8 heap bound. The full transcript of an
opened session is still decoded and returned; normalized message storage and
transcript pagination are not delivered by sidebar pagination.

The current bounds are 30 pending rows and 8 MiB of payload materialization per
index batch, with an 8 MiB limit per canonical payload checked in SQLite before
loading it. A list page accepts 1 to 50 summaries. Idle cache limits are 12 entries
and a 32 MiB serialized-size estimate; pinned admission limits are 16 entries and
64 MiB, with at most 64 concurrent service requests. Recovery notices report the
total count but return at most 50 details. Notice pagination, normalized message
storage and full-transcript pagination remain unfinished.

## Isolated browser acceptance

The development preview normally uses `build/chat-preview/conversations.sqlite`.
For a separate acceptance database, set `PROTO_CHAT_PREVIEW_DB` to a `.sqlite`
path under the same workspace's `build/` directory before starting Vite. The
override rejects paths outside that directory, non-file targets and linked
parents. It affects the Chat database only. It does not enable a different model,
change external execution policy or create synthetic scientific evidence.

```powershell
$env:PROTO_CHAT_PREVIEW_DB = 'build/research-paging-20260922/ui-conversations-v2.sqlite'
node node_modules/vite/bin/vite.js --configLoader runner --host 127.0.0.1 --port 5196 --strictPort
```

Run this command from `apps/proto-workbench`; the database path is relative to the
repository workspace. Use a separate shell or clear that environment variable
before launching a normal preview.

## Bounded local acceptance

The final research-related suite passed 148/148 tests without skips, and
TypeScript passed with unchanged source hashes. Separate independent service
checks passed 15/15 synthetic software cases, including stable tied-timestamp
pagination, old-writer invalidation, cache pinning, protected live/unknown owners,
failed final saves and exact partial-output/artifact preservation. Subsets in the
backend and renderer handoffs overlap the 148-test suite and are not extra totals.

Actual browser actions exercised first/older pages, a selected conversation
outside the refreshed first page, a legacy research-state quotation, recovery
confirmation, retained partial output and an actual host restart. Light, dark and
narrow layouts were inspected, including the compact conversation dialog. The
browser used a separate, explicitly synthetic SQLite fixture. The original
invalid fixture and the narrow-screen/recovery failures found during development
remain retained as failures, separately from the final accepted evidence.

A read-only comparison found the original preview's 15 canonical conversation
rows (356,761 payload bytes) unchanged from the pre-migration backup. The database
gained derived indexes and ownership metadata, so whole-file equality is not
claimed. In the isolated fixture, both rejected raw rows and the old confirmed
quotation were preserved, and the recovered result retained its original output
after host restart.

A desktop development build and its content checker passed with content ID
`5b7fd45c36c2047cace52a22f60ac4d7758998a4e6f6169eebddd7f83de7a80b`.
The consolidated receipt is
`build/research-paging-20260922/increment-acceptance.json`. These checks do not
establish scientific accuracy, model reliability, native packaged execution,
installation, power-loss durability or exactly-once effects.
