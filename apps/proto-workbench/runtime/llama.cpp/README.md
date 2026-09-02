# Retired llama.cpp staging area

> **Legacy developer artifact; not a product, packaging, release, or
> verification entry point.** Proto Workbench uses only the operator-managed
> LM Studio server at `http://127.0.0.1:1234` for model discovery, loading,
> chat, and ownership-safe unloading. This directory is excluded from the
> packaged resources and module-integrity manifest.

This directory is retained only so historical, isolated runtime experiments can
be reproduced by a developer who explicitly invokes the retired staging script.
No product, package, or live-model verification command consumes the staged
binaries. The automated suite only reads the lock and negatively exercises the
staging script as a legacy integrity regression; passing that regression does
not qualify a runtime for product use. Staging files here does not make them
trusted or usable by the product.

Expected layout:

```text
runtime/llama.cpp/
  cuda/llama-server.exe
  cpu/llama-server.exe
```

For historical reproduction, the old upstream release and published digests are pinned in
`release-lock.json`. Stage the reviewed archives with
`scripts/stage-llama-runtime.ps1`. CUDA builds pass the separate official CUDART
archive through `-CompanionArchivePath`. The script verifies every SHA256, copies
`llama-server.exe` and its required DLLs, then records the inputs in
`runtime-manifest.json`.

## Archived local-launch security notes

The remainder documents the retired independent-runtime design. It is not the
current Workbench security contract and must not be cited as product behavior.

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

Do not place model weights here. Current model residency belongs to LM Studio;
Workbench neither reads LM Studio's private model directory nor accepts a model
root path.
