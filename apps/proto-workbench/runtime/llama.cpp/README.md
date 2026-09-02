# llama.cpp runtime

This directory is reserved for independent upstream `llama.cpp` Windows builds.
Proto Workbench never searches for or invokes LM Studio executables, services,
extensions, configuration, or private runtime files.

Expected layout:

```text
runtime/llama.cpp/
  cuda/llama-server.exe
  cpu/llama-server.exe
```

The exact upstream release and published digests are pinned in
`release-lock.json`. Stage the reviewed archives with
`scripts/stage-llama-runtime.ps1`. CUDA builds pass the separate official CUDART
archive through `-CompanionArchivePath`. The script verifies every SHA256, copies
`llama-server.exe` and its required DLLs, then records the inputs in
`runtime-manifest.json`.

## Local launch security contract

The pinned `b9970` server supports `--api-key-file`. Proto Workbench therefore
does not put the bearer key in process arguments. It writes a random per-launch
key to an exclusively created temporary file, passes only that path to
`--api-key-file`, and removes the file as soon as the post-bind startup marker
proves argument parsing is complete (or during cancellation/failure cleanup).

Proto Workbench also no longer reserves, closes, then reuses a guessed port. It
chooses a cryptographically random candidate in the dynamic-port range and lets
the owned server bind it directly. The parent does not contact that port until
the pinned runtime emits its post-bind, pre-GGUF `load_model` record. A bind
conflict tears down the owned attempt and its credential before choosing a new
port, with four total attempts. After that gate, the parent validates the public
`/health` response with a 4 KiB body limit before publishing the port.

These controls remove the application's former close/rebind port gap and avoid
routine argv credential disclosure. They do not prevent a local process from
winning all four direct-bind races and causing a bounded load failure. They are
also not an isolation boundary against a process running with the same OS
identity and sufficient rights to read the Workbench process or its temporary
files, terminate the child, or tamper with its runtime. Strong containment
against that attacker requires an OS process container/Job Object and a
separately protected credential boundary. A hard parent-process crash can also
orphan the temporary key file until normal OS/user temporary-file cleanup.

The relevant upstream behavior is pinned in
[`common/arg.cpp` (port)](https://github.com/ggml-org/llama.cpp/blob/b9970/common/arg.cpp#L2991-L2997),
[`common/arg.cpp` (key file)](https://github.com/ggml-org/llama.cpp/blob/b9970/common/arg.cpp#L3099-L3114),
[`server-http.cpp`](https://github.com/ggml-org/llama.cpp/blob/b9970/tools/server/server-http.cpp#L410-L443),
[`server.cpp`](https://github.com/ggml-org/llama.cpp/blob/b9970/tools/server/server.cpp#L401-L427),
and [`server-context.cpp`](https://github.com/ggml-org/llama.cpp/blob/b9970/tools/server/server-context.cpp#L1004-L1041).

Do not place model weights here. GGUF files remain read-only in
`%USERPROFILE%\.lmstudio\models` by default.
