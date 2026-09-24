# ADR 0004: Content-Bound Optional Extensions

- Status: accepted for the declarative Skill adapter trust prototype
- Date: 2026-09-23
- Scope: U07 and H08 in `OPEN_SOURCE_RESEARCH_BRAINSTORM_2026-09-22.md`

## Decision

Skill adapter discovery continues to parse bounded declarative manifests and content snapshots. The resolver now reports a separate local trust state for each adapter. A record under `.proto-agent/extension-trust/<skill-id>.json` pins the repository `HEAD`, the exact manifest digest, a digest over every admitted extension file, the resolved capability-scope digest, and the connector-registry digest. `proto-agent skills trust <skill-id>` is the explicit local action that writes this record. A subsequent mismatch is `stale`; an absent record is `untrusted`; a malformed, linked, or otherwise unsafe per-adapter record is `invalid`. `proto-agent skills resolve` succeeds only when the required connector capabilities are available and the trust state matches.

The trust records are ignored by Git because they represent a local approval choice. Atomic bounded writes use the existing workspace path boundary. A bad record is evaluated per adapter and never changes required design validation, compilation, or review gates. Trust status is not used as scientific evidence or connector effect authorization.

## Security boundary

This is a local content pin, not a digital signature, secure publisher identity, or protection against an actor who can rewrite both the local trust record and the workspace. Admitted Skill files remain non-executable declarative content; executable files are rejected by the existing resolver. Any future executable extension type requires a separate execution boundary and a reviewed design. The current grant binds the local Git commit and actual admitted bytes, so declaration, document, reference, capability-scope, connector-registry, or source-commit changes invalidate it.

## Remaining acceptance

U07 is not complete. There is no generated shared event protocol for Electron, preview, and CLI, no common event reducer, and no golden trace replay proving equal snapshots across transports. H02's common effect policy and cancellation contract also remain open. The trust path has not been behaviorally exercised against changed, malformed, or missing records in this turn; it is an implementation prototype, not an accepted security control. Before production use, add bounded negative-path coverage, exercise filesystem-race behavior, review local approval semantics, and prove required gates stay independent of optional extension state.
