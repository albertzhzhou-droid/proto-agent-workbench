# API-first workspace initialization

`proto-agent init` sets up a workspace around a model provider chosen for credential
custody, then writes matching Python, R and Proto configuration. It follows the
[trust boundaries](../SECURITY.md#trust-boundaries): no secret value is ever accepted,
stored, logged or echoed.

## Provider paths

| Provider id | Kind | Credential custody | Rank |
|---|---|---|---|
| `anthropic-api` | API key | `ANTHROPIC_API_KEY` in your environment | 1 |
| `openai-api` | API key | `OPENAI_API_KEY` in your environment | 1 |
| `claude-subscription` | Subscription | The installed `claude` CLI login | 2 |
| `codex-subscription` | Subscription | The installed `codex` CLI login | 2 |
| `local-lm-studio` | Local only | None (loopback LM Studio) | 3, fallback |

The local-only path is kept as the earlier plan but ranks last: data stays on the
machine, but there is no provider-side key revocation or audit trail. When no
`--provider` is given, `init` recommends the best ready path by rank and falls back to
local only if nothing else is available.

## Commands

```text
proto-agent init detect                       # offline: presence booleans only
proto-agent init plan  --provider anthropic-api --python-profile analysis --r-profile rnaseq
proto-agent init apply --provider anthropic-api --python-profile analysis --r-profile rnaseq
proto-agent init status                       # digests, secret-shaped content, key presence
proto-agent init verify --provider anthropic-api --approve-network
```

All commands print structured JSON. `plan` writes nothing. `apply` refuses to replace an
existing configuration without `--force`.

`--key-env NAME` selects a different environment variable for an API provider. It takes a
variable **name**; a pasted key is rejected without being echoed.

## What is written

Files go to `.proto/workspace/` (Git-ignored, machine-local):

| File | Purpose |
|---|---|
| `python.json` | Profile (`core`, `analysis`, `sequence`, `full-science`), pip extras, isolated interpreter flags, no inherited environment |
| `r.json` | Profile (`none`, `core`, `rnaseq`), required packages, sandbox-or-explicit-CLI execution policy, no inherited environment |
| `workspace.proto` | Starter design using toy fixture parts; validate with `proto-agent check` |
| `workspace.json` | Provider choice (variable names only) and SHA-256 digests of the three files above |

`workspace.json` is written last, so it exists only when every file it digests was written.
`status` recomputes the digests and rescans for secret-shaped strings, so edits or an
accidentally pasted key are reported.

## Network and subscriptions

* `detect`, `plan`, `apply` and `status` are offline. CLIs are located on `PATH` only;
  they are never executed and their credential stores are never read.
* `verify` is the only networked command. It needs `--approve-network`, sends one `GET
  /v1/models` to the provider's fixed host over verified TLS, refuses every redirect,
  bounds the response, and reports only the HTTP status and model count.
* Subscription paths record that the provider CLI holds the login. Sign in with that CLI
  yourself; Proto Agent never sees a token.

## Limits

Detecting a key, a CLI or `Rscript` does not establish that the credential is valid, the
CLI is signed in, or R packages are installed. The starter design uses toy fixture parts
and carries no wet-lab or biosafety claim.
