# Chat execution deployment

The local Workbench uses one capability registry for Chat, Design and Compute.
Python, R and Notebook execution reuse the existing execution broker; installed
WSL bioinformatics programs use a separate set of typed operations. Documents
are parsed by the same Node service in the desktop and source preview.

## Local runtime

On 2026-09-19, Docker Engine 29.8.1 was installed in **rootless user mode** in
Ubuntu-24.04, under `/home/openclaw/.local/share/proto-sandbox/bin`. The daemon
socket is `unix:///run/user/1001/docker.sock`. Ubuntu prerequisites `uidmap`,
`slirp4netns` and `iptables` were installed. No system Docker daemon, external
APT repository, user lingering, or Docker Desktop reset was introduced.

Deployment follows the [official rootless installation guidance](https://docs.docker.com/engine/security/rootless/).
The official installer was downloaded and inspected before running it as the
WSL user. Its source commit was `2b32480025b223ebfddae9a3a8bef09027680f53`.
Installation receipts are in `build/chat-qa/rootless-install.log` and
`build/chat-qa/rootless-prerequisites.log`.

The scientific runtime is the official
`quay.io/jupyter/datascience-notebook@sha256:b9c46d18eb2300f4967d5f794ac576afc2dbcd70993ef0eacf7373b38b2289dd`
image. It supplies the Python numerical/plotting stack, R and both Jupyter
kernels. See the [Jupyter image guide](https://jupyter-docker-stacks.readthedocs.io/en/latest/using/selecting.html).
The exact pulled image receipt is `build/chat-qa/sandbox-datascience-image-pull.log`.

The workspace profile `.proto-agent/sandbox.json` is machine-local and ignored
by Git. It records the provider (`docker-wsl`), distribution, non-root user,
explicit Docker binary, local Unix socket and immutable OCI image digest. Both
the MCP subprocess and direct CLI load the same validated profile; the model
cannot supply an alternate daemon, mount or shell command in a tool request.

The user service can be checked with `systemctl --user status docker` and started
with `systemctl --user start docker` inside that user's WSL session. Workbench
probes the actual daemon, resource controls and pinned image. A saved profile
alone does not establish availability.

## Execution contract

In **Local Models > Design plugins & Skills**, enable **Python analysis**,
**R analysis**, **Notebook analysis** and **Biomni scientific computing**, then
apply the selection. In Chat, turn on **Research tools** and connect an actual
loaded LM Studio instance. Module selection controls tool exposure; runtime
availability still comes from live probes. Preview selections are session-only.

Generated `.py`, `.r` and `.ipynb` files can be saved with Chat's `document_write`,
then passed to `code.python`, `code.r` or `code.notebook` through `science_run`.
Use `science_catalog` first to obtain exact argument schemas.

- Inputs are readable through `PROTO_AGENT_WORKSPACE` (`/workspace`).
- Write results under `PROTO_AGENT_RUN_DIR` (`/run`).
- Containers use a non-root UID, a read-only filesystem/workspace, no network,
  dropped capabilities, no-new-privileges, one CPU, 512 MiB memory and 64 PIDs.
- Calls have bounded deadlines and cancellation; the broker removes its owned
  container after a timeout or cancellation.
- Python/R runs save stdout, stderr, output files and an execution manifest
  identifying the immutable image, command and actual outcome.
- Notebooks use actual `python3` or `ir` kernels, save cell execution counts,
  rich outputs and errors in `executed.ipynb`, and export HTML. A failing cell
  stops subsequent cells and retains the already completed work.

Package installation is a runtime deployment operation; analysis containers
have no Internet access. The profile never enables unsafe host code execution.

## WSL programs and documents

`bioinformatics.catalog` returns exact operation schemas and can probe live
versions with `probe:true`. `bioinformatics.run` accepts a workspace request
file containing `{operation, arguments}`. The fixed operations are documented
in [bioinformatics-environment.md](bioinformatics-environment.md). These calls
share the existing Biomni module selection and workspace write queue.

Chat accepts PDF, DOCX and XLSX through the attachment button or a workspace
path. `document_import` and `document_read` give the model the same source-bound
extractions as the document panel. See [chat-document-parsing.md](chat-document-parsing.md)
for pagination, provenance and format-specific limitations.

## Reproducible verification

- `apps/proto-workbench/scripts/verify-chat-execution.mjs` drives the real MCP
  Python/R/Notebook tools and checks numeric results, plots, failures, runtime
  controls and timeout handling. Reports are under `build/chat-runtime-qa/`.
- `scripts/verify-bioinformatics-adapter.py` exercises every installed engine
  through the actual adapters, plus cancellation. The report is
  `build/bioinformatics-adapter-qa/summary.json`.
- Document fixtures and UI verification artifacts are under `build/chat-qa/`.
- `scripts/verify-packaged-chat-runtime.py` verifies the final frozen MCP
  executable after the sidecar build. It checks scientific tool discovery,
  the actual sandbox and pinned image, real NumPy execution with a saved
  result, and all nine installed WSL operations. The report is
  `build/chat-qa/packaged-runtime-acceptance.json`.

### Local acceptance on 2026-09-19

- Six real execution checks passed: scientific Python, R, Python Notebook
  with a plotted output, R Notebook, failing-cell preservation and timeout
  cleanup. The receipt is
  `build/chat-runtime-qa/2026-09-19T17-53-18-743Z/verification.json`.
- All nine WSL operations and cancellation passed on synthetic inputs.
  Five additional checks passed through the actual Chat tool bridge,
  including nucmer execution, artifact verification, disabled-module
  rejection and cancellation propagation. The bridge receipt is
  `build/bioinformatics-chat-qa/latest.json`.
- The final frozen MCP executable passed all four acceptance checks.
  Its SHA-256 is
  `94745bef56ae94f095e6ae18017892c5247d26d3c8dde8197e0a15f612fabb53`.
- PDF, DOCX and XLSX were imported and read in the running browser preview.
  The live local-model conversation read the documents, discovered tools and
  wrote a script, but was stopped before executing that script or a WSL job.
  This conversation does not establish full model-driven workflow completion;
  the execution receipts above verify the actual runtime and tool bridge.
- The final desktop build completed, and all 16 modules passed full runtime
  integrity verification against the rebuilt sidecars. Hashing uses bounded
  file-handle concurrency, including closure before reusing a worker slot.
  The manifest SHA-256 is
  `740c8cfdda20556cb6833a188046d42ac5f5cce1d6d0cb4aef40f01da16ec74f`.
  The consolidated receipt is `build/chat-qa/deployment-acceptance.json`;
  complete integrity results are in
  `build/chat-qa/deployment-module-integrity.json`.

These are local synthetic software acceptance checks, not scientific validation
of arbitrary data or an installer/hosted CI acceptance claim.
