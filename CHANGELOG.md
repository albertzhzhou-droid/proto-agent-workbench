# Proto Agent / Proto Workbench Changelog

This record was reconstructed on 2026-09-01 from the source, tests, QA
screenshots, build contents, and SHA-256 values that remained in the project.
The project's `.git` directory was empty and could not provide commit, tag, or
branch history. The entries below therefore are not inferred from a Git log,
and byte-level differences without sufficient evidence are not presented as
known feature changes.

Version boundary: the current Python CLI version is `0.1.0`, and the current
Windows Workbench version is `0.1.2`. `Stage N`, `rN`, `vN`, and
`native-pass-N` are internal iteration identifiers, not new semantic versions.

## 2026-09-01 — Current retained build: Workbench 0.1.2 / Product Stage 16

Local release-attachment record (the `releases/` directory is excluded from
Git): `releases/workbench-0.1.2-stage16-20260901/Proto Workbench-0.1.2-x64-portable.exe`

- Portable: 651,485,539 bytes, SHA-256
  `24ebedc4e6cd2e6b29cf723f8fb0960eaf3e0163c17d7d548d2099ccb9f57d38`.
- Packaged ASAR: 188,139,891 bytes, SHA-256
  `9fefffd9d9f2bd4cd6c3d4ae262fded6de0a53e1fe801feba0e35b10cb1c35e2`.
- The module inventory embedded in the ASAR matches the retained
  `module-manifest.json`: 15 modules, 870,727 bytes, SHA-256
  `a4fa7ca689f805b9bb2b70a1a6a2651490f959c1bbf5ed09ef5b25d9467faf89`.
- Electron fuses: `RunAsNode`, Node options, and CLI inspect are disabled;
  cookie encryption, embedded ASAR integrity, and only-load-from-ASAR are
  enabled.
- Current source gates: TypeScript passed; JavaScript passed 427/427; the
  offline guard passed 427/427; Python passed 123 tests, with 4 Windows symlink
  boundary tests skipped.
- The unpacked build received a 10-second hidden-launch smoke test. Four owned
  processes under the same build path were observed and then all terminated.
  The final repacked Portable was also launched from an isolated short Windows
  temporary path: its launcher and four extracted Electron processes were
  observed, its embedded 6,788-byte trust root matched SHA-256
  `a040678bbcc3e3f708a107e3955308bcb4fd31d58860dde6317ea18416af9d36`,
  all five owned processes were stopped, and both smoke-test directories were
  removed.
- The package is not Authenticode-signed. This work confirms the build,
  content wiring, gates, and startup only; it does not claim a complete GUI
  journey, a real-model workflow, OS-level network isolation, or formal release
  closure.

Compared with the old `release-v7`, whose highest proven product stage was
Stage 12, the current retained build adds:

- Stage 13: a content-addressed, exact-match, immutable, non-authorizing Trust
  Policy.
- Stage 14: five-stage offline Signature Evidence with a pinned local trust
  root and read-only import, without signing or activation capabilities.
- Stage 15: an offline TUF Trust Root lifecycle with sequential dual-threshold
  rotation and seven-file candidate packs, without an online updater or
  activation path.
- Stage 16: a Transparency Log Witness Center bound to Rekor v2, TrustedRoot,
  a pinned checkpoint, and two witnesses. It verifies Merkle inclusion and
  consistency and fails closed on rollback, equal-size forks, missing quorum,
  or policy drift.
- Visualization increment: linked CGView/SeqViz rendering of real IR;
  segmented and origin-spanning annotations; primer and ORF layers; bounded
  software ORF discovery; a reversible view origin; GC content and skew;
  bounded view preferences keyed by artifact SHA-256; and SVG/PNG exports that
  can be independently reopened and verified.

## Product Stages 1–16

| Stage | Main change from the preceding stage |
|---:|---|
| 1 | Introduced the Launchpad, startup blocking, and model-readiness guidance. |
| 2 | Added the Runs overview, patch-ledger selection, and Review page. |
| 3 | Strengthened patch review, recovery, and validation state. |
| 4 | Bound Design Explorer to real artifact bytes, SHA-256/size, provenance, and a fail-closed validation journal. |
| 5 | Synchronized Timeline, Topology, and Artifacts; added accessible selection, lineage/digest state, and task-only forks. |
| 6 | Added main-process-issued mission digests with CAS rechecks before send, a two-step preflight, and a command palette limited to navigation or draft preparation. |
| 7 | Introduced Mission Recipes, Resume Contracts, and explicit recovery review. |
| 8 | Introduced a bounded Operator Cockpit; mission recipes still prepare drafts only. |
| 9 | Introduced bounded, redacted, navigation-only Global Evidence search. |
| 10 | Introduced effect-free Policy Simulation / Decision Lab without launch, approval, or write capabilities. |
| 11 | Introduced content-addressed, unsigned, non-authorizing Decision Bundles with CAS export and redaction preview. |
| 12 | Introduced a read-only Decision Bundle Verification Center that explicitly separates content integrity from publisher identity. |
| 13 | Introduced exact-match Trust Policies; a policy does not itself grant execution authority. |
| 14 | Introduced five-stage offline Signature Evidence and immutable evidence import. |
| 15 | Introduced the offline Trust Root lifecycle and sequential dual-threshold TUF root-rotation checks. |
| 16 | Introduced the Transparency Log Witness Center, witness quorum, inclusion/consistency proofs, and rollback/fork detection. |

The corresponding source-level contracts are included in
`apps/proto-workbench/tests/stage*-*.test.mjs`. Visual QA captures and the
generated `design-qa.md` reports are retained only in ignored local paths and
are not distributed with a source checkout.

## 2026-08-31 — Workbench 0.1.2 build lineage

All builds below have been superseded by the current Stage 16 package. The
hashes are ASAR SHA-256 values read before deletion. "Highest proven stage"
means only the product capabilities that could be demonstrated explicitly from
the package's main, preload, and renderer contents.

| Build | ASAR SHA-256 | Highest proven stage | Difference / conclusion |
|---|---|---:|---|
| `release-alt2` | `cbe007474c457e93e5e865ef3eddd1f6e4c4933fe19cb182b97b24773c8b1bb0` | 8 | Old setup/portable/unpacked build from the Operator Cockpit era. |
| `release-final` | `a4bb1a2618b00a7a7fc396ee9747ac536f82ff31310958e30f5dc8e825e810b0` | 8 | Later byte-level change in the same stage; evidence is insufficient to claim a new feature. |
| `release-v1` | `b9e5b89f06a978687086f1d342c63d579ddb6dc8faa677c66d7565f1be9a775b` | 8 | Old package containing an incomplete NSIS intermediate artifact. |
| `release-v2` | `b9e5b89f06a978687086f1d342c63d579ddb6dc8faa677c66d7565f1be9a775b` | 8 | ASAR and main EXE are identical to v1; this is a duplicate build. |
| `release-v3` | `aba92302e069bed8848f955d19322d75992a8f76a73a19da0022d85e7bb801e2` | 9 | Added Global Evidence. |
| `release-v4` | `01cc0f75112c0d405f3db03c8a77150f5259928593c96767cb783bd55fddafd0` | 9 | Visible capabilities still end at Stage 9; only an internal byte-level change is proven. |
| `release-v5` | `cceaf63def0403e273eae284f70671a75ae968356fee431565fbbef2547e4f5b` | 10 | Added Policy Simulation / Decision Lab. |
| `release-v6` | `ecf0ee48e5b3947f265241b0b88f667d47f7d0b0fa7ccace81fd19771dad554e` | 10 | Visible capabilities still end at Stage 10. |
| `release-v7` | `9ec0b20295f293d7f30ce5382be3f7a9cfd6c6acec5bdccbdb753678625e54d5` | 12 | Added Decision Bundles and the read-only Verification Center; does not contain Stages 13–16. |

### Visualization native-pass lineage

`native-pass-N` identifies a visualization QA pass and must not be confused
with product Stage N.

| Native pass | ASAR SHA-256 | Actual product content |
|---|---|---|
| 12 | `92f76b7358adde18d4acf20dd4a5ec8d65bd00ac07719cad086e1d3c2a5e9fdb` | Product Stage 12. |
| 13 | `4956a95483a5b6d8e36afcc78d24aa7c175634d37b6b985d388754cda385eddc` | Added the Stage 13 Trust Policy. |
| 13 merged | `ee6e95eb377abecf09b039fd8e7ec3ede43faf6ab94c920000ee08a044ac6db4` | Already contains Stage 14 Signature Evidence. |
| 13 fixed | `359ffafb9b91ad7e005e485abaa54fbdff99e8fd8113752bcc4d792ee1d0a52a` | Corrective repack that still contains Stage 14. |
| 14 fixed | `8d25d2920f74b67cd0194e0640656356a238cf7416b0c21b47740deaf1efdc6c` | Still contains Stage 14. |
| 15 fixed | `a8409f09b749ccb2f3b54912c555d925de0777ce02ea9a2d4e7e5faa20fd470b` | Added the Stage 15 Trust Root lifecycle. |
| 16 final | `c87f862a4c7fd035e158899a14b6e57f0946139b6d4dcc6240161b002f28f299` | Still ends at product Stage 15; "16" identifies the visualization pass, which completed the native visualization/export increment. |

The final visualization package's `release-gates.json` explicitly reports
`scope-passed_whole-product-release-not-claimed`. Its large staging tree has
been removed, while the gate, module manifest, final native screenshot, and
comparison image were retained.

## 2026-08-18 — r19–r39 security stress iterations

| Iteration | Result or relative difference |
|---|---|
| r19/r20/r22 | Only provable byte-level changes remain. There is not enough manifest evidence to invent semantic differences. |
| r23–r26 | Progressively exposed an unmeasured model, a missing patch, and an incomplete patch-review flow. |
| r27/r27b/r27c | Progressively exposed app-launch, CDP-connection, and app-spawn failures. |
| r28 | Exact duplicate of r27: both ASARs are `d4c2db6216952104cade7e30369d4101ec2655de57a36fa5ecbcfac6b3d7fca4`, and the main EXE is also identical. |
| r29 | ASAR changed to `ea4c707eb218aa4290132fc12838e4aa29e842343d0c92bb299f42d7b5d371c7`; app spawn still failed. |
| r30–r35 | Advanced through model matching, patching, verification, and review-packet generation to quiz/grounding, but still did not complete successfully. |
| r36 | Exposed NVML's inability to read GPU state: the minimal Windows child environment must retain `ProgramFiles`. |
| r37 | Exposed unknown GGUF layer-count estimation: absent block metadata now uses a conservative 33-layer estimate, while `999` denotes only the all-layers UI sentinel. |
| r38 | Exposed model variance in malformed patch JSON: added a deterministic, evidence-bound, NO-GO host fallback. |
| r39 | First passing control: 14 completed, 0 failed, and 5 screenshots. Real Qwen and the MCP sidecar started; the final software evidence dossier remained human-review-required. |

The final r39 queue and five screenshots are retained locally at
`apps/proto-workbench/build/upgrade-queue/packaged-ui-levodopa-20260819005240-db54ce27.json`
and `apps/proto-workbench/build/stress-evidence-r39/`; these ignored artifacts
are not distributed with a source checkout. The complete `pnpm test` run at
r39 still had a compiler link-policy regression. The current 427/427 offline
gate demonstrates that this old issue is closed in the present source.

## 2026-07-08 — Python CLI 0.1.0 initial baseline

- Established the dependency-light `proto-agent` CLI with `check`, `compile`,
  `export`, `score`, `parts search`, and structured JSON diagnostics.
- Added provenance manifests from `workflow run`, plus evidence cards and a
  human-review checklist from `review run`.
- Added a dependency-light stdio JSON-RPC MCP server and a PubMed metadata
  connector that explicitly distinguishes fixture/cache results from live
  network results.
- All bundled parts remain development fixtures. Software success does not
  imply a scientific GO decision, and the tool does not provide wet-lab
  execution instructions.

## 2026-09-01 build retention and cleanup policy

- Retain locally the current source, tests, lockfiles, current `runtime`,
  `node_modules`, Python `.venv`, the Electron 43.4.0 distribution, current
  `out/dist`, and the sole Stage 16 portable package. Generated dependencies,
  build outputs, and binary packages remain excluded from source control.
- Retain the final r39 queue, screenshots, and workspace dossier, plus the
  final visualization gate, module manifest, SVG/PNG verification receipts,
  and two key screenshots.
- Remove superseded stress/release/native-pass binary trees and browser user
  data. The provable product stages, important differences, and SHA-256 values
  were recorded in this file before deletion.
- The completed cleanup removed 18 obsolete release trees, nine obsolete
  visualization staging or user-data trees, 53 stress/PyInstaller state
  directories, and four obsolete caches. Measured reclaimed space was
  44,454,998,016 bytes (41.402 GiB); an explicit retired-target residual scan
  returned zero. The remaining project tree is 4,524,802,655 logical bytes
  (4.214 GiB, excluding junction traversal).
- All remaining non-vendor Markdown was standardized in English. The final
  scan covered 40 Markdown files outside dependency and virtual-environment
  trees and found zero CJK text files.
- Retain the current dependency tree and local Electron distribution for
  offline rebuilds. Removing old npm/pnpm/llama download caches does not change
  the retained package or current source.
- Cleanup is a permanent local deletion; the project has no usable Git history
  for rollback. A formal release still requires signing, a complete GUI journey
  through the installer and portable package, and an independent release
  dossier.
