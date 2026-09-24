# Development build content identity

`build-desktop.ps1 -Task Desktop` and `-Task Renderer` now capture an input content identity before synchronization/bundling, then seal it after the final output is written. Desktop sealing runs **after** the existing `generate-module-manifest.mjs`; that module manifest remains unchanged and is itself included in the output identity. The receipt lives outside `out`/`dist`, under `apps/proto-workbench/build/content-identity/<run GUID>/`, so neither manifest hashes itself.

The implementation reuses the existing release source allowlist and `captureBuildInputs` path/link and stable-file checks. It omits the installed `node_modules` tree. Managed generated workspace-template copies retain the release snapshotter's exclusions. It reads the allowlisted working-tree file bytes, including uncommitted edits and untracked source files, without relying on a commit SHA or requiring a clean Git tree. `uv.lock` and the application `pnpm-lock.yaml` have both individual hashes and a separate combined lock digest. Unrelated build/cache files are excluded.

The input receipt contains exact source paths, file sizes and SHA256 hashes. Sealing checks those inputs again before and after hashing the outputs. The renderer profile binds the complete `dist` tree and requires `dist/index.html`. The desktop profile binds the complete `out` tree and requires main/preload/renderer entrypoints plus `out/module-manifest.json`. Output capture disables input-cache/name exclusions, so even a file named `.ignored_executable.js` is bound. Added, removed or modified source/output files change the identity or fail its checker. Record order uses an explicit ordinal comparator so identity does not depend on locale. Existing cooperative build locking still applies; this receipt is not a replacement for immutable staging.

The final `contentId` binds profile, source inventory, dependency-lock digest, output inventory and the declared scope. Its meaning is **content association at the build boundaries**. It does not prove that the installed dependencies match the lockfiles, that a toolchain is hermetic, that the build is reproducible on another machine, that an installer is signed, or that native/scientific execution passed. A person able to replace both the receipt and the artifacts can forge a new local association; this is not a signed attestation. Existing private release snapshots, module verification, packaged-payload checks and native/clean-machine gates remain separate.

## Recheck a build

The maintained build wrapper prints `BUILD_CONTENT_IDENTITY <absolute receipt path>`. With that path, run from the application directory:

```powershell
node scripts/build-content-identity.mjs verify --repo ../.. --manifest <printed-path>
```

Direct lower-level builds are outside the wrapper. To instrument another maintained build stage, call `capture --profile renderer|desktop --repo <root> --manifest <inputs-path>` before the first source-consuming command, then `seal --repo <root> --capture <inputs-path> --manifest <identity-path>` after all output generation (including module manifest generation). Both evidence paths must be below `apps/proto-workbench/build/content-identity/`; writes are exclusive and never replace prior evidence. Verify immediately before relying on or transferring those outputs. Installer outputs require the existing packaging checks; `dist`/`out` identity does not cover release EXEs.

## Validation scope

```powershell
node --test tests/build-content-identity.test.mjs
```

Tests use small filesystem fixtures and no compiler, model, GPU or packaging process. They cover dirty source identity without Git, deterministic resealing, lock changes, source edits during the capture/seal interval, later artifact mutations, additions/deletions, required module-manifest bytes, link rejection, manifest tampering, fixed profile boundaries and the CLI's capture/seal/verify failure exits. Fixture success establishes the checker contract; it is not evidence of a completed production build or native acceptance.

## Recorded development build

The Desktop wrapper completed on 2026-09-22 with content ID
`d5a64070830f9cde23803e6a7d3de2d46f1eb5aa90d9308b4575aacc17bd0a90`.
Its identity receipt is
`apps/proto-workbench/build/content-identity/52cdbded127b469599a5f39b6b13f626/identity.json`.
The checker passed using the printed absolute receipt path. The build log and
successful verification are retained in
`build/research-upgrade-20260922/desktop-content-identity-build.log` and
`desktop-content-identity-verify-absolute.log`. The initial checker invocation
used an application-relative receipt path where a repository-relative or absolute
path was required; its rejection is retained separately in
`desktop-content-identity-verify.log`.

This records an actual local development bundle and its content association.
Native execution, installer delivery, clean-machine acceptance and reproducible
build comparison remain untested by this receipt.

The later claim-review increment completed another Desktop build on 2026-09-22:
content ID `20ec7e0d8d0c3892dcf5ea1a3372a71a21ae42e5cbd2225d308e601c774801dc`,
receipt `apps/proto-workbench/build/content-identity/3bbd09e3f01a41c0a31aca229429ee65/identity.json`.
Its actual build and successful absolute-path check are retained in
`build/research-claims-20260922/desktop-build.log` and `build-identity-verify.log`.
The earlier receipt remains historical evidence; the same scope limits apply.

The conversation-paging increment completed a Desktop build on 2026-09-22:
content ID `5b7fd45c36c2047cace52a22f60ac4d7758998a4e6f6169eebddd7f83de7a80b`,
receipt `apps/proto-workbench/build/content-identity/8d63b911ce35498382ae6f3cbb16a2aa/identity.json`.
Its successful terminal build and absolute-path check are retained in
`build/research-paging-20260922/desktop-build.log` and `build-identity-verify.log`.
This is a local development bundle with the same scope limits above; earlier
build receipts are historical and do not certify the current source tree.

The research-project increment completed a Desktop build on 2026-09-22:
content ID `7cc6ffe47cf272f39e7a3bf5dd08277d1fe6e7801c3f24e6a760f9da77bd9841`,
receipt `apps/proto-workbench/build/content-identity/0fa75dad2e434e3f83d7419cfc0bfee7/identity.json`.
The initial sandboxed attempt failed because esbuild could not read the project
ancestor; that failure remains in `build/research-studies-20260922/desktop-build-20260922T2142.log`.
The approved retry completed with the same captured input identity. Its log and
successful absolute-path check are `desktop-build-retry-20260922T2143.log` and
`build-identity-verify-20260922T2143.log` in the same evidence directory. Scope is
still a local development bundle, not native execution or installer acceptance.

The figure-and-methods increment completed a Desktop build on 2026-09-22:
content ID `49d21e931c046db59975028bb660f6aea18083ab7f10245b87171ce675eb4edf`,
receipt `apps/proto-workbench/build/content-identity/65ced82d796c41f69e00dbfe8e6d79d0/identity.json`.
Its completed build and successful absolute-path check are retained in
`build/research-figures-20260922/desktop-build.log` and `build-identity-verify.log`.
This binds the local development bundle only. Native execution, browser download,
clean-machine installation and scientific acceptance are not certified by it.

The RNA-seq increment completed a Desktop build on 2026-09-22:
content ID `1ca53da2f610dc62ed39e53a500903ed7e9281c2896b52590a6593da8ca408bd`,
receipt `apps/proto-workbench/build/content-identity/365ba4e356704e9d8dbb0875baed99f1/identity.json`.
The standard build and absolute-path identity verification both exited zero;
their logs and hashes are in
`build/rnaseq-studies-20260922/desktop-build-2026-09-22T23-10-26-578Z/`.
No native executable was launched and no installer or clean-machine deployment
was accepted. Actual local DESeq2 execution and browser acceptance have separate
records in the RNA-seq increment receipt.
