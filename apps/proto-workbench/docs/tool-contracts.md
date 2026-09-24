# Shared tool and IPC contracts

`src/shared/tool-contracts.ts` owns backend names, canonical capability aliases,
effect, access risk, feature module, deadline, output budget, maturity reference,
preconditions, produced receipt classes, idempotence, cost class and per-run caps.
Unknown names are rejected before dispatch. The module descriptors and model
discovery derive their tool membership from this table. Chemistry belongs to the
optional `analysis.chemistry` module, so a core-only configuration excludes it.

Harness checks schema validity, remaining run budget and any required material
binding before dispatch. Canonical names share a persisted allowance across
aliases and resumes: 64 cheap reads, 24 local writes or 12 external calls.
Reservations are saved before effect intent; restoring the same operation does
not spend a second call. Terminal host controls remain available. Receipt-class
metadata also drives verification remedies after filtering the actual inventory
against policy, scope, prerequisites and remaining allowance. Unknown diagnostic
codes retain bounded repair behavior. Idempotence never permits replaying an
unknown write; journal reconciliation still requires existing effect evidence.

See [the Harness implementation record](../../../docs/HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md)
for typed diagnostics, recovery details and measured evaluation limits.

The Python sidecar loads a generated package resource instead of maintaining a
second tool table. After changing an MCP contract, run from this directory:

```powershell
node --experimental-strip-types scripts/export-tool-contracts.mjs
node --experimental-strip-types scripts/export-tool-contracts.mjs --check
node --experimental-strip-types --test tests/tool-contracts.test.mjs
```

The parity test invokes Python `tools/list`, compares shared metadata and checks
the live chemistry operator catalog. The generated JSON is included by Python's
package-data configuration and the sidecar's existing `--collect-data` rule.

`permissions.ts` evaluates the same `PolicyDecision` for Chat and Harness. A
decision embeds the selected host-issued grant and binds it to the tool,
operation, surface and scope. Historical grants explain past decisions; loading a
saved grant does not authorize a new send. Only contracts that support offline
execution can exempt an explicitly offline query from a network grant.

`src/shared/ipc-channel-contracts.ts` is the single request-schema table. It
derives handler, preload and browser mock argument types and requires every
request channel to have an API method binding. Push channels are excluded.
Module and skill choices come from their manifests. Preload and main validate
the same argument schema; binary exports retain their separate byte limit.

Response types derive from existing domain interfaces. The new journal responses
have runtime field schemas. Existing response domains are explicitly marked
`domain-types-only`; this stage does not claim full runtime response validation.
Chat and chemistry keep their existing dynamic domain request validators rather
than claiming the broad IPC envelope validates every action field. The browser
preview exposes journal methods as unavailable and cannot reconcile native runs.
