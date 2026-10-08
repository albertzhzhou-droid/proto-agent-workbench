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
| `custom-gateway` | Gateway | `PROTO_GATEWAY_API_KEY` (or `--key-env`); host pinned by you | 2 (3 if loopback) |
| `claude-subscription` | Subscription | The `claude` CLI login, in a workspace-isolated home by default | 2 |
| `codex-subscription` | Subscription | The `codex` CLI login, in a workspace-isolated home by default | 2 |
| `local-lm-studio` | Local only | None (loopback LM Studio) | 3, fallback |

The local-only path is kept as the earlier plan but ranks last: data stays on the
machine, but there is no provider-side key revocation or audit trail. When no
`--provider` is given, `init` recommends the best ready path by rank and falls back to
local only if nothing else is available. A custom gateway is never auto-recommended.

## Commands

```text
proto-agent init detect
proto-agent init plan   --provider anthropic-api --model claude-sonnet-5-5 --python-profile analysis --r-profile rnaseq
proto-agent init apply  --provider anthropic-api --model claude-sonnet-5-5 --python-profile analysis --r-profile rnaseq
proto-agent init status
proto-agent init verify --approve-network
```

For user interfaces and scripts there are three more:

```text
proto-agent init catalog     # providers, profiles and categories as data, so nothing is hardcoded
proto-agent init overview    # catalog + offline detection + current status in one process
proto-agent init start ...   # apply (+ optional --verify --approve-network) + status in one process
```

`python -m proto_agent.workspace_init <command>` runs the same commands without importing the
rest of the CLI. It starts in roughly 100 ms instead of roughly 400 ms, which is what the
desktop app uses for every setup action.

Custom gateway and subscription examples:

```text
proto-agent init apply --provider custom-gateway --base-url https://gateway.example.com/v1 \
    --model team-model --protocol chat-completions
proto-agent init verify --approve-network --approve-host gateway.example.com

proto-agent init apply --provider claude-subscription          # isolated home (default)
proto-agent init apply --provider codex-subscription --credential-mode shared
```

All commands print structured JSON, and `apply`, `status` and `verify` include `metrics`
(`elapsed_ms`, `files_written`, `network_requests`). `plan` writes nothing.

### Efficiency

* One command takes a workspace from nothing to configured: `detect` picks the best path,
  `apply` writes everything, and the manifest-driven `verify` needs no arguments.
* `apply` is idempotent. Repeating the same configuration reports `changed: false` and
  writes nothing; a *different* configuration is refused with the sections that differ
  until `--force` is given.
* Everything except `verify` is offline (`network_requests: 0`). `verify` makes exactly one
  request.

## Last verification

A `verify` that actually reached the network is recorded in `verification.json` (provider, host,
model, category, HTTP status, time, and a digest of the configuration it checked; never a
credential). `status` reports it as `verified`, `failed`, `stale` (the configuration changed since)
or `unknown`, and a failed category names the repair (`check_credential`, `choose_model`,
`check_base_url`, `check_gateway_protocol`, `retry_verify`). It is history, not a live connection:
requests refused before sending (no approval, missing key) are never recorded.

## What is written

Files go to `.proto/workspace/` (Git-ignored, machine-local):

| File | Purpose |
|---|---|
| `python.json` | Profile (`core`, `analysis`, `sequence`, `full-science`), pip extras, isolated interpreter flags, no inherited environment |
| `r.json` | Profile (`none`, `core`, `rnaseq`), required packages, sandbox-or-explicit-CLI execution policy, no inherited environment |
| `workspace.proto` | Starter design using toy fixture parts; validate with `proto-agent check` |
| `workspace.json` | Provider choice (variable names only) and SHA-256 digests of the three files above |
| `verification.json` | Last recorded `verify` outcome; advisory, not digest-protected |
| `credentials/<provider>/` | Subscription providers, isolated mode only: an empty owner-only (0700) directory with a `*` `.gitignore` for the provider CLI's login |

`workspace.json` is written last, so it exists only when every file it digests was written.

## Readiness and next actions

`init status` separates **integrity** (`ok`: schema version via the shared artifact reader,
digests, no secret-shaped content) from **readiness** (`ready`: the credential variable or
CLI, isolated home, Python and Rscript the configuration names are present). Each check
carries a `reason`, and `next` lists machine-actionable steps, for example
`{"code": "set_environment", "variable": "ANTHROPIC_API_KEY"}` or
`{"code": "verify_provider", "argv": ["init", "verify", "--approve-network"]}`.
Readiness is presence only; it is not a live authorization result.

## Network: `verify`

`verify` is the only networked command. It needs `--approve-network` and sends one `GET`.

* With `--model` (or a model stored at init) it probes that **exact model**
  (`GET /v1/models/<id>`), so one request checks the key, route and model together. Without
  a model it lists models.
* Official providers use hosts pinned in code (`api.anthropic.com`, `api.openai.com`), so
  editing the manifest cannot redirect a key.
* A remote gateway additionally needs `--approve-host <host>` equal to the pinned host.
* Redirects are refused, TLS is verified, and the response is size-bounded.
* The result has a typed `category`: `ok`, `network`, `auth`, `model-not-found`, `bad-url`,
  `timeout`, `incompatible`, `server-error` or `unknown`, plus the HTTP status. Only counts
  are reported, never response bodies. A gateway that lacks the models route is reported as
  `incompatible`, not as a missing model.

## Custom gateway rules

`--base-url` is the API root the `/models/<id>` route hangs off (for OpenAI-style gateways
that usually includes `/v1`).

* Remote hosts must be `https://` DNS names. IP literals are rejected, which also blocks
  cloud-metadata and internal addresses.
* Plain `http://` is accepted only for loopback (`localhost`, `127.0.0.0/8`, `::1`), and a
  loopback gateway may run without a key.
* Credentials, query strings, fragments, `..` and unusual path characters are rejected.

## Subscriptions

* Detection uses `PATH` lookup only; the provider CLI is never executed and its credential
  store is never read.
* **Isolated** (default): the plan creates `credentials/<provider>/`; set
  `CLAUDE_CONFIG_DIR` (Claude) or `CODEX_HOME` (Codex) to its absolute path before signing
  in, so the login is separate from the CLI's default profile.
* **Shared**: the login lives in the CLI's default profile, shared with every project on the
  machine; `init` warns about this.

## Desktop app

Settings has a **Model provider setup** section, and the Launchpad shows a one-line provider
strip. Both follow the workbench's paper and ink theme in light and dark, using only shared
tokens, the shared type hierarchy and the shared motion vocabulary.

* The interface takes a key once, hands it to the main process and clears the field. It never
  shows or keeps a stored key. Keys live only in the operating-system credential vault (see below).
  Provider choices come from `init catalog`, and workspace settings are written through `init start`.
* Verification is a deliberate step: **Verify with provider…** opens a consent panel naming the
  host and the variable, and only **Send request** sends anything. The host is pinned in code for
  Anthropic and OpenAI, and for a gateway it is the saved host.
* The setup helper never inherits the app's environment. Setup and detection see a
  presence-only sentinel for the three default key variables. Only `verify` receives the single real
  variable belonging to the provider being verified, so a tampered workspace file cannot select
  another secret. A custom variable name (a command-line option) is not handed over; the panel says
  to verify it from the command line.
* A desktop app started from the dock or start menu may not see variables exported in a shell. If
  the panel reports the variable as not visible, start Proto from a shell that exports it.
* Chat can use a configured cloud model (see below). Provider setup records and verifies the
  configuration, and never changes the LM Studio readiness steps.
* The browser preview is session-only: it writes nothing, reads no key and cannot verify.

## Credential vault

Keys are stored with Electron `safeStorage` (Keychain, DPAPI or a Linux secret service). The file
holds ciphertext and routing metadata only, and a backend that would write plain text is refused.
Each key is bound when stored to the one host it may reach: pinned in code for Anthropic and OpenAI,
and the address you typed for a gateway. A workspace file cannot change where a stored key is sent.
The interface can learn that a key exists, its host and when it was stored, never the key.
`verify` and cloud Chat read the key in the main process only. For the official Anthropic and OpenAI
hosts an environment variable still works when no key is stored; a stored key takes precedence. A
gateway key is never read from the environment, because there would be no trusted host to bind it to.

## Cloud Chat

A model from a configured provider appears in Chat in its own **Cloud provider** group. The main
process translates the chat loop to the Anthropic Messages API or to OpenAI chat completions (and
compatible gateways), refuses redirects, bounds every stream, and keeps the key out of logs.

* Nothing is sent until you approve the conversation. The approval states what leaves the computer:
  your messages, attached documents and tool results, including the contents of workspace files the
  assistant reads. Switching model or conversation revokes it, and the main process enforces it
  whatever the interface does.
* Cloud context is capped at 128k tokens whatever the provider advertises.
* The OpenAI Responses protocol is not supported for Chat yet.
* Node's `fetch` in the main process does not use system proxy settings.

## Coding in Chat

The **Code** workflow adds `code_propose_patch`. The assistant reads files with `workspace_read`,
then proposes the complete new content of one file per call. The proposal is a pending diff in
Research runs, which is the same review, apply-with-checkpoint and validation path used for Design
changes. Nothing is written until you approve it. The tool refuses a file the conversation has not
read in its current state, and refuses `.proto` designs, `.git`, `node_modules` and `build/`.
Existing code-execution and network switches keep gating anything the assistant runs.

## Design lineage

The staged setup, typed validation categories, isolated subscription logins and gateway URL
rules follow public product-level patterns of other scientific workbenches (notably AIPOCH
Open-Science, Apache-2.0). This implementation is independent and copies none of their code.
Additions here are the code-pinned provider hosts, per-host approval for gateways, the
content-addressed manifest and secret-shape scanning.

## Limits

Detecting a key, a CLI or `Rscript` does not establish that the credential is valid, the
CLI is signed in, or R packages are installed. The starter design uses toy fixture parts
and carries no wet-lab or biosafety claim.
