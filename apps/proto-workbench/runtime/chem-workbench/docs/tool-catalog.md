# Research tool catalog for base-model callable adapters

> Curated on 2026-09-05 from public project documentation and publications
> (sources linked per row). This catalog inventories serious, existing
> chemistry algorithms and tools — with an emphasis on interface chemistry —
> as candidates for future reviewed Workbench adapters per the plan's
> Section 9.4 rules. **Listing a tool here installs nothing, registers
> nothing, and licenses nothing**; every entry needs its own compatibility
> spike, license record, and conformance corpus before activation.

## Status legend

- **PINNED (M0)**: installed locally and verified — see the
  [M0 spike](compatibility-spikes/2026-09-05-m0-backend-acceptance.md).
- **CANDIDATE**: researched, not installed; needs a spike under ADR-0002/0006 rules.
- **BLOCKED**: licensing or acquisition makes it unavailable for this
  repository's current boundary.

## Interface-chemistry algorithm families

| Algorithm family | What it answers | Representative tools | Status |
| --- | --- | --- | --- |
| Adsorption energy / site screening | Which site and binding geometry is preferred under a declared method | [pymatgen slab + adsorption-site tooling](https://pymatgen.org/pymatgen.analysis.html); [Xsorb automated adsorption configurations](https://arxiv.org/html/2304.14353v1); [Montoya et al. high-throughput adsorption workflow](https://www.nature.com/articles/s41524-017-0017-z) | pymatgen **PINNED (M0)**; Xsorb/workflow CANDIDATE |
| Surface energy & Wulff morphology | Equilibrium particle shape and facet distribution from facet energies | [WulffPack (ASE-based)](https://ase-workshop.materialsmodeling.org/abstracts/magnus-rahm/); [pymatgen WulffShape](https://pymatgen.org/pymatgen.analysis.html); [SurfFlow](https://arxiv.org/html/2311.03163v1) | CANDIDATE (WulffPack); pymatgen module PINNED as a library |
| Ab initio atomistic thermodynamics (surface phase diagrams) | Which termination/phase is stable at given T, p(reactant) | Framework of [Reuter & Scheffler](https://link.springer.com/chapter/10.1007/978-1-4020-3286-8_10); [surfinpy](https://surfinpy.readthedocs.io/en/latest/tutorial_3.html); [FHI-aims ab initio thermodynamics + REGC tutorial](https://fhi-aims-club.gitlab.io/tutorials/introduction-of-ab-initio-thermodynamics-and-regc/); [ab initio GCMC surface phase prediction (Wexler et al.)](https://pubs.acs.org/doi/10.1021/acs.jpcc.8b11093) | CANDIDATE (needs quantum execution layer first) |
| Microkinetic modeling (mean-field) | Steady-state rates/selectivity from a reaction network | [CatMap (SUNCAT), GPL-3.0](https://github.com/SUNCAT-Center/catmap) | CANDIDATE — GPL-3.0 needs owner licensing review |
| Kinetic Monte Carlo (lattice) | Stochastic surface kinetics with spatial effects | [Zacros](https://zacros.org/) — free to academics via [UCL XIP portal](https://zacros.org/software/obtain-zacros), not open source | **BLOCKED** — proprietary terms; no distribution |
| Electrochemical (Pourbaix) stability | Aqueous/electrochemical stability vs pH and potential | [pymatgen pourbaix_analysis](https://pymatgen.org/pymatgen.analysis.html) + [Materials Project methodology](https://docs.materialsproject.org/methodology/materials-methodology/aqueous-stability-pourbaix); [PourPy](https://www.research-collection.ethz.ch/bitstreams/6815ef2b-ecef-4e63-94ca-94e54d856505/download) | CANDIDATE (pymatgen module; needs thermodynamic data provenance) |
| Bader / QTAIM charge analysis | Charge partitioning from a density grid | [Henkelman group grid-based Bader code](https://theory.cm.utexas.edu/bader/); [BaderKit (JOSS)](https://www.theoj.org/joss-papers/joss.09943/10.21105.joss.09943.pdf) | CANDIDATE |
| Barrier search (NEB/dimer) | Reaction barriers on a surface | ASE NEB/dimer (part of [ASE calculators/optimization stack](https://docs.ase-lib.org/ase/calculators/calculators.html)) | ASE PINNED (M0); NEB profile deferred per plan §9.4 |

## General research/analysis tools for the base model

| Tool | Domain | License (as documented) | Status |
| --- | --- | --- | --- |
| [ASE](https://docs.ase-lib.org/ase/calculators/calculators.html) | structures, calculators, NEB | LGPL-2.1+ (per project docs) | **PINNED (M0)**, `ase.emt.cu.scan.v1` candidate |
| [QCEngine](https://molssi.github.io/QCEngine/dev/) + [Psi4](https://psicode.org/) | quantum execution | LGPL/BSD (per project docs) | **PINNED (M0)**, `qcengine.psi4.hf_sto3g.smoke.v1` candidate |
| [PySCF](https://pyscf.org/) | quantum chemistry framework | [Apache-2.0](https://github.com/pyscf/pyscf) | CANDIDATE — pure-Python-friendly quantum backend |
| [RDKit](https://www.rdkit.org/docs/RDKit_Book.html) | molecular representation, InChI | Apache-2.0/BSD (per project docs) | **PINNED (M0)** as parsing/identity candidate |
| [pymatgen](https://pymatgen.org/) | periodic structures, slabs, analysis | MIT (per project docs) | **PINNED (M0)** |
| [cclib](https://cclib.github.io/) | package-independent output parsing | LGPL-3.0 (per project docs) | CANDIDATE — [cclib 2.0 architecture](https://pubs.acs.org/doi/10.1021/acs.jctc.7b00483-p) |
| [Basis Set Exchange](https://www.basissetexchange.org/) | basis-set data | per-data licenses | **PINNED (M0)** local data |
| [PHREEQC](https://www.usgs.gov/software/phreeqc-version-3) | aqueous speciation | public domain (USGS) | CANDIDATE (plan §2.3 solution profile) |
| [spglib](https://spglib.github.io/spglib/) | symmetry | BSD (per project docs) | **PINNED (M0)** |

## Consequences for the language (RFC-0007)

The catalog confirms the interface-chemistry question space: every serious
workflow above consumes exactly the condition dimensions the domain language
must carry explicitly — phase, temperature, pressure/chemical potentials,
solution environment, reference states, and the compared property — and every
one rejects unstated defaults. [RFC-0007](rfcs/RFC-0007-conditions-and-task-semantics.md)
encodes that contract; adapters from this catalog become callable only after
the M2 gateway layer exists.

Sources: [pymatgen analysis](https://pymatgen.org/pymatgen.analysis.html) ·
[WulffPack](https://ase-workshop.materialsmodeling.org/abstracts/magnus-rahm/) ·
[Xsorb](https://arxiv.org/html/2304.14353v1) ·
[Montoya et al. 2017](https://www.nature.com/articles/s41524-017-0017-z) ·
[Reuter & Scheffler primer](https://link.springer.com/chapter/10.1007/978-1-4020-3286-8_10) ·
[surfinpy](https://surfinpy.readthedocs.io/en/latest/tutorial_3.html) ·
[FHI-aims REGC tutorial](https://fhi-aims-club.gitlab.io/tutorials/introduction-of-ab-initio-thermodynamics-and-regc/) ·
[Wexler et al. 2019](https://pubs.acs.org/doi/10.1021/acs.jpcc.8b11093) ·
[CatMap](https://github.com/SUNCAT-Center/catmap) ·
[Zacros](https://zacros.org/software/obtain-zacros) ·
[MP Pourbaix methodology](https://docs.materialsproject.org/methodology/materials-methodology/aqueous-stability-pourbaix) ·
[PourPy](https://www.research-collection.ethz.ch/bitstreams/6815ef2b-ecef-4e63-94ca-94e54d856505/download) ·
[Henkelman Bader](https://theory.cm.utexas.edu/bader/) ·
[BaderKit](https://www.theoj.org/joss-papers/joss.09943/10.21105.joss.09943.pdf) ·
[PySCF](https://pyscf.org/) ·
[cclib](https://cclib.github.io/) ·
[SurfFlow](https://arxiv.org/html/2311.03163v1)
