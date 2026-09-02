# Proto Workbench Workspace

This workspace contains the local development fixtures required by the packaged
Proto workflow: a toy parts library, deterministic review workflow, connector
registry, seed literature metadata, and an example design.

The application only copies files that are missing. It does not overwrite edits
made in this workspace. Generated artifacts are written under `build/`.

The full biological Materials catalogue is intentionally external at
`%USERPROFILE%\Documents\Proto CLI Materials` by default. The package ships only the
small open seed templates; source sync writes inactive snapshots and never
overwrites this workspace or activates data without an explicit human action.

Protein selections are also materialized into `build/` and compiled with
`proto-agent protein compile`; the Design Explorer renders them in its bounded
amino-acid view. Protein IR remains a software-level artifact and carries the
same `human_review_required` boundary as DNA designs.

The bundled biological parts and example design are software-development fixtures.
They are not wet-lab, ordering, biosafety, regulatory, or clinical instructions.
