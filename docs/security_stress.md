# Offline security stress harness

`proto_agent.stress.run_stress()` is a small, deterministic harness for exercising path, JSON, schema-envelope, and Proto parser boundaries with hostile-looking data. Importing the module does not run the harness. The implementation uses only in-process Python APIs: it does not invoke a shell or child process, open a socket, make an HTTP request, or contact any unrelated local application.

## Safe use

Run a focused batch from the CLI:

```powershell
proto-agent security stress `
  --max-cases 16 `
  --max-total-seconds 2 `
  --max-case-seconds 0.2 `
  --max-input-bytes 4096 `
  --report security-stress\report.json
```

The corpus must be a regular workspace directory. A source checkout defaults to
`tests/security_corpus`; wheels and packaged workspaces do not bundle the corpus
and must pass `--corpus-dir` for an explicitly reviewed copy. `--report` is
optional and is interpreted relative to the canonical workspace `build/`
directory. CLI budgets have hard upper bounds in addition to the per-run values.

The same focused harness is available from Python:

```python
from pathlib import Path

from proto_agent.stress import run_stress

result = run_stress(
    workspace_root=Path.cwd(),
    corpus_dir=Path("tests/security_corpus"),
    seed=0x50524F54,
    max_cases=16,
    max_total_seconds=2.0,
    max_case_seconds=0.2,
    max_input_bytes=4096,
    report_path="security-stress/report.json",
)
```

`report_path` is optional. With no report path the harness writes only temporary case files, which are removed before return. When a report is requested, `workspace_root` is resolved explicitly and the only accepted build directory is that workspace's canonical `build/`. The relative report path is interpreted below `build/`; traversal, absolute escape, a different directory named `build`, symbolic links, and Windows reparse points/junctions are rejected. Report serialization is size-limited and written through a same-directory temporary file followed by atomic replacement.

The returned value and optional file use `proto-agent.security-stress.v1` JSON. They include case status, elapsed time, traced Python allocation metrics, input and temporary-file byte counts, corpus commit/checksum verification, environment-isolation status, and leak-sentinel status. They do not include corpus payloads, temporary absolute paths, environment names, or environment values.

The focused unit test is:

```text
python -m unittest discover -s tests -p "test_security_stress.py" -v
```

The CLI route calls the same `run_stress()` implementation and preserves its workspace/build containment. It does not expose executable, network, model, GUI, or emulator stress cases.

## Budgets and isolation

Each executed case receives a fresh child `TemporaryDirectory` within a fresh run-level `TemporaryDirectory`. Case selection is deterministic for the same corpus, seed, and case budget. Timings and memory measurements are observational and therefore are not byte-for-byte deterministic.

The harness enforces:

- a maximum selected-case count;
- checksum-entry, aggregate-corpus-byte, BLNS-record, and available-case limits;
- a total deadline that starts before corpus verification and case construction;
- a measured per-case time budget;
- a pre-execution input-size limit; and
- a maximum serialized report size.

The corpus is snapshotted into bounded memory after digest verification, so
cases cannot reread changed files. Selection covers every available case
category before deterministically filling the remaining budget. Per-case time
enforcement is deliberately cooperative. A case that returns late is marked
`time_budget_exceeded`; it is not asynchronously killed. All included
operations are bounded by the input-size limit, but this is not hard preemption.
`tracemalloc` starts before preprocessing and measures traced Python
allocations, not total resident memory, GPU memory, native-library allocations,
or operating-system resource use.

Before each case, the harness snapshots `os.environ`. It detects added, removed, or changed entries using counts only, restores the exact snapshot in `finally`, and marks a mutating case failed. A run-level `finally` repeats restoration and restores the caller's prior `tracemalloc` on/off state. Because `os.environ` and `tracemalloc` are process-global, do not run this harness concurrently with code that intentionally changes them.

A deterministic sentinel is kept in the run temporary directory but is never passed to a case. Before returning or writing a report, the harness verifies that neither the sentinel value nor the temporary root path appears in serialized output. It also verifies that observed temporary outputs resolve beneath the run directory and that the run directory was removed.

## What this does not prove

This is an in-process regression and test-isolation harness, not an operating-system sandbox. It does not prove containment against arbitrary native code, compromised dependencies, threads that ignore cooperative limits, kernel/filesystem races, or code that deliberately bypasses Python APIs. It cannot guarantee process-tree termination because it never starts a process. It also does not inspect, signal, attach to, or make claims about Call of Duty Mobile, an emulator/SIM process, or any unrelated host process.

The `offline`, `external_processes_started: 0`, and `network_requests_made: 0` fields describe the harness implementation and its included cases. They are not a machine-wide network/process monitor. Run higher-risk executable stress tests only in a separately configured OS sandbox with explicit process, network, filesystem, and resource controls.

## Third-party corpus and provenance

The vendored subset is intentionally small. Local integrity metadata is in `tests/security_corpus/PROVENANCE.json` and `tests/security_corpus/SHA256SUMS`.

- Big List of Naughty Strings (BLNS) is used under the MIT License at commit `db33ec7b1d5d9616a88c76394b7d0897bd0b97eb`. The selection source was `blns.json` (27,708 bytes, SHA-256 `c08b3856095b8d0cc6e9c581a49f66550b35dbb247f7c758ff8db6c581f84e5f`). Sixteen exact decoded entries were selected by recorded upstream index and stored in deterministic ASCII-escaped JSON. See `tests/security_corpus/LICENSE-BLNS.txt`.
- JSONTestSuite is used under the MIT License at commit `1ef36fa01286573e846ac449e8683f8833c5b26a`. The fixed-commit archive SHA-256 was `5b205e1f9533123411e794f1f052cf50df8e723a855f629a07f777f472af53d8`. Nine parser fixtures, each no larger than 137 bytes, were copied byte-for-byte. See `tests/security_corpus/LICENSE-JSONTestSuite.txt`.

The selection rules and original URLs are recorded in `PROVENANCE.json`; every local corpus, provenance, and license file is covered by `SHA256SUMS`. These hashes detect accidental or local modification, but they are not a signature and do not independently establish upstream authenticity.
