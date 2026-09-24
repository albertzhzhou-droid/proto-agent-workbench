# Claim and source review

The Chat workspace's **Claims & sources** inspector records user-authored claims,
exact quotations and explicit review decisions. It uses the existing conversation
documents and persistence service. It does not infer scientific truth or citation
entailment from an exact text match.

## Research workflow

1. Add a text document or import a PDF, DOCX or XLSX through **Documents**.
2. Open **Claims & sources**, choose **New claim**, and write the claim.
3. Select a source document and a zero-based extracted section index. Read the
   source passage. For a long section, choose its starting UTF-16 character offset.
4. Select text directly in the displayed passage or enter an exact quotation.
   Repeated wording requires an explicit occurrence selection. Choose **Supports**,
   **Contradicts** or **Context**, then add the passage. A claim may cite multiple
   sources with different relations.
5. Save the claim as unreviewed. After assessing its wording and cited passages,
   explicitly choose **Confirm my review**. This records the user's judgment;
   it does not certify the underlying study, the claim or the selected relation.

The inspector shows the saved quotation, document revision, extracted locator,
quote range, source hashes and returned reading range. Locations refer to extracted
text, not PDF page geometry or DOCX byte offsets. Character intervals are half-open
UTF-16 ranges, matching JavaScript and DOM selection offsets. Text is not normalized
or trimmed to repair a mismatch. A returned passage establishes what the interface
provided; it does not establish that the user or model read the entire document.

For parsed documents, the binding checks the preserved input bytes, the original
workspace file when one exists, the extraction JSON and the derived text artifact.
The conversation text snapshot has its own hash; matching that preview alone is
insufficient. Editable text documents instead bind the saved text and revision.
Browser line-ending normalization is mapped back to the original source offsets;
it does not change the stored quotation.

## Saved decisions and changed sources

Saving a claim edit resets its review to unreviewed and preserves the previous
version. Source freshness is a host-derived status separate from the historical
review decision. The first observed source invalidation is retained: restoring
old bytes does not silently renew the original review. To replace invalid evidence,
edit the claim, remove the old passage, read and cite the current source, save, and
explicitly review again. Earlier claim versions retain their quotations and decisions.

The implementation bounds each conversation to 16 claims, each claim to eight
cited passages and ten historical versions. Claim text is limited to 8,000 UTF-16
code units and a quotation to 2,000. Reaching a limit rejects the change rather
than silently trimming citations or history. Source read receipts are temporary;
if a read receipt expires or the host restarts before a draft is saved, read and
add that passage again.

The service enforces conversation membership, current session revision and idle
state for edits/reviews. Review commands are user-interface actions and are not
exposed as model tools. A stale save must be reopened from current persisted state;
the inspector does not merge competing human judgments automatically.

A background snapshot checks at most eight source units and rotates through saved
claims. Unchecked evidence is explicitly pending, not current or invalidated.
Confirming a review checks that claim's sources directly within the same bound.
Source file checks pause while the session is generating. Completion-scheduled
polling uses 850 ms while generating and 5 seconds while idle, without overlapping
refreshes. The conversation list now uses bounded SQLite summary indexing and
paging; listing does not reopen claim source files. Opening a conversation still
loads its complete canonical payload. Full-transcript pagination remains
unfinished; see [conversation storage](research-chat-storage.md).

## Acceptance scope

Independent synthetic DOCX inputs and a requirement matrix are retained under
`build/research-claims-20260922/`. Their support and contradiction statements are
invented software fixtures, not empirical findings. Runtime/UI acceptance records
must be read separately from the fixture parser checks. Literature retrieval,
automatic claim extraction and machine assessment of entailment are outside this
manual review feature.

The completed local increment has the following distinct evidence:

- All 118 research-related Node tests passed with no skips, and TypeScript passed.
  This includes the 22 claim-service and 13 renderer selection/state tests; those
  subsets must not be added to 118. The final backend report is
  `build/research-claims-20260922/backend-verification-2026-09-22T02-43-51-609Z-cc80ed49/summary.json`.
- Nine independent service scenarios passed using the production DOCX parser and
  SQLite service. They include source reads beyond the preview, conflicting
  expected revisions, changed original bytes, sticky invalidation after byte
  restoration/restart, and an explicit replacement citation/review.
  The final record is
  `build/research-claims-20260922/service-acceptance-2026-09-22T02-43-37-940Z-7a5c778d/acceptance.json`.
- The real local browser UI saved supporting and contradicting passages, rejected
  a fabricated quote, retained a draft, and showed changed-source invalidation.
  After a host restart it retained both the review and the invalidated quotation.
  Light, dark and narrow layouts were inspected. Reopened SQLite and eight file
  hashes were checked independently in
  `build/research-claims-20260922/ui-persistence-20260922T025139Z.json`.
- The desktop development bundle and content-identity checker passed with content
  ID `20ec7e0d8d0c3892dcf5ea1a3372a71a21ae42e5cbd2225d308e601c774801dc`.
  This is separate from the browser acceptance and does not establish native
  packaged execution, installation or scientific accuracy.

The consolidated bounded evidence inventory is
`build/research-claims-20260922/increment-acceptance.json`. UI review decisions in
these records were made by the acceptance agent on explicitly synthetic fixtures;
they are not independent human scientific judgments. Interrupted captures remain
on disk but are excluded from the accepted UI evidence set.
