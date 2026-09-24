# Proto Workbench third-party notices

The browser preview includes a small public structural reference: RCSB/wwPDB
1GFL coordinates (CC0-1.0; original depositors and wwPDB/RCSB attribution) and
UniProt P42212 sequence metadata (CC-BY-4.0; UniProt Consortium). Source URLs,
retrieval dates, unchanged byte digests, and attributions are retained in
`src/renderer/fixtures/README.md` and the accompanying JSON descriptors.

This distribution includes open-source software. Selected visualization,
local-model, and verification components are listed below. Dependency versions are
pinned in `pnpm-lock.yaml`.

## Chem Workbench source snapshot

- Package: `chem-workbench` 0.1.0a2
- Source: the user-provided local Chem CLI working tree, including uncommitted changes
- Base commit: `3543c91330ac2017d0ca9543e1e5ea1dd71efad7`
- License: MIT
- Copyright: 2026 Chem Workbench contributors

The complete chemistry UI, compiler, design and interface modules, governed
calculation workflows, refinement implementation, scripts, schemas, examples,
and associated resources are retained in `runtime/chem-workbench`. The source
manifest records the exact included bytes and working-tree provenance; its
manifest hash is
`4fab5293651958bc7763b74f510d341e2f5951538a77546b611735d6d95f655d`.
The original MIT license is included unchanged as
`runtime/chem-workbench/LICENSE`.

Proto adds the application selector, a controlled local process/HTTP bridge,
UI presentation overlays, and deployment binding receipts. Scientific source
files in the snapshot remain unchanged. Existing installed scientific runtimes
and model weights are not redistributed as part of this snapshot. The separate
XDL inspection helper calls the already installed external XDL environment;
this integration does not copy the XDL package into the application.

## 3Dmol.js 2.5.5 in the Chem workspace

- Project: [3Dmol.js](https://3dmol.org/)
- Recorded source archive: [3dmol 2.5.5](https://registry.npmjs.org/3dmol/-/3dmol-2.5.5.tgz)
- License: BSD-3-Clause
- Copyright: 2014 University of Pittsburgh and contributors

Chem's retained molecular and crystal viewer uses the unchanged
`runtime/chem-workbench/src/chem_workbench/web_assets/vendor/3Dmol-2.5.5.min.js`.
The accompanying `3Dmol-LICENSE.txt` and `3Dmol-min.js.LICENSE.txt` are included
unchanged in that same directory. The complete license text also preserves
the upstream GLmol, Three.js, and jQuery notices and their respective license
statements. Chem's original archive provenance is retained in
`runtime/chem-workbench/docs/viewer-dependency.md`.

## Mol* 5.11.0

- Project: https://github.com/molstar/molstar
- License: MIT
- Copyright: 2017 - now, Mol* contributors

Mol* supplies the imported protein structure viewer. The installed package's
unmodified license is distributed as `licenses/Molstar-MIT.txt`. Structure
files and their scientific provenance remain separate from the viewer's
software license.

## LM Studio JavaScript SDK 1.5.0

- Package: `@lmstudio/sdk`
- Project: https://github.com/lmstudio-ai/lmstudio.js
- License: Apache License 2.0

The SDK supplies local LM Studio model-instance and tokenization access.
The installed package's unmodified license is distributed as
`licenses/LM-Studio-SDK-Apache-2.0.txt`. Proto Workbench does not distribute
LM Studio or model weights under this SDK license.

## CGView.js 1.8.2

- Project: https://github.com/sciguy/cgview-js
- License: Apache License 2.0
- Author: Jason Grant

CGView.js supplies the interactive circular product map. An unmodified copy of
its Apache License 2.0 is distributed as `licenses/CGView-LICENSE.txt`.

## SVGCanvas 2.6.0

- Project: https://github.com/zenozeng/svgcanvas
- License: MIT
- Copyright: 2014 Gliffy Inc.; 2021 Zeno Zeng

SVGCanvas supplies vector export for the CGView.js scene. An unmodified copy of
its MIT license is distributed as `licenses/SVGCanvas-LICENSE.txt`.

## Sigstore JavaScript verification packages

- Projects: `@sigstore/bundle` 5.0.0, `@sigstore/protobuf-specs` 0.5.2, and `@sigstore/verify` 4.1.2
- Source: https://github.com/sigstore/sigstore-js
- License: Apache License 2.0

These verification-only packages parse Sigstore v0.3 bundles and validate
signatures against independently supplied trust material. Proto Workbench does
not bundle the high-level signing or online TUF client. An unmodified copy of
the Apache License 2.0 is distributed as `licenses/Sigstore-Apache-2.0.txt`.

## TUF JavaScript models 5.0.0 and canonical JSON 2.0.0

- Projects: `@tufjs/models` 5.0.0 and `@tufjs/canonical-json` 2.0.0
- Source: https://github.com/theupdateframework/tuf-js
- License: MIT
- Copyright: 2022 GitHub and the TUF Contributors

These packages provide canonical signed-metadata parsing and offline threshold,
version, length, hash, and expiry verification for imported trust-root candidate
packs. Proto Workbench does not import the online updater. An unmodified copy of
the MIT license is distributed as `licenses/TUF-JS-MIT.txt`.

## SeqViz 3.10.24

- Project: https://github.com/Lattice-Automation/seqviz
- License: MIT
- Copyright: 2019 Lattice Automation

MIT License

Copyright (c) 2019 Lattice Automation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Biomni computational adaptations

- Project: https://github.com/snap-stanford/Biomni
- Source commit: `400c1f366b96a35ca253e13c9b06c5076af41d65`
- Authors: Biomni Team and contributors
- License: Apache License 2.0

Selected computational ideas and source logic from `biomni/tool/biochemistry.py`,
`glycoengineering.py`, `genomics.py`, `physiology.py`, `molecular_biology.py`,
`synthetic_biology.py`, `bioengineering.py`, `microbiology.py`, `immunology.py`,
`pathology.py`, `pharmacology.py`, `genetics.py`, `cancer_biology.py`, and
`systems_biology.py` are adapted in Proto's local analysis tools. The one hundred nine
scoped capabilities cover supplied RNA structures, glycosylation scans, prealigned
conservation, offline gene-set over-representation, cosinor fitting, sequence and
cloning analysis (ORFs, PCR, restriction, primers, Golden Gate, codon usage), ODE
and stochastic simulations, assay and instrument-data fitting, clinical and
pharmacometric analyses, genomics matrix tools, flow cytometry over bounded FCS
file inputs, PDB structure comparison, chain-file liftover, neighbor-joining
phylogeny, SBML writing, torch-based fine-mapping, Kalman neural decoding,
image analysis, cheminformatics, RNA folding, frame-sequence microscopy tracking, histology and stain quantification, medical image registration and ADC mapping, Hi-C chromatin contact analysis, SBML metabolic perturbation, coalescent demographic simulation, and Cas9/CRISPR edit outcome alignment. Further upstream
wrappers are exposed through an explicitly-enabled remote connector tier. Algorithm bodies are copied
from the pinned upstream commit and adapted only for JSON inputs, structured
results, input validation, and documented corrections of selected numerical or
semantic issues; upstream file, process, network, plotting, and agent execution
paths are removed. Separate native companions (measured-data Michaelis-Menten fit
and the sequence-based sgRNA spacer scan) are informed by upstream ideas. General
statistical companion tools are authored for Proto.

The unmodified upstream license is distributed as
`licenses/Biomni-Apache-2.0.txt`. The source inventory and detailed modification
record are in `docs/biomni-source-audit.md` and
`docs/biomni-upstream-inventory.json` in the source repository. The upstream tree
at this commit contains no separate `NOTICE` file. External Biomni datasets,
models, protocol collections, services, and executable dependencies are not
redistributed under this notice. No Stanford endorsement is implied.

## DeepSeek Harness context adaptation

- Source: https://github.com/deepseek-ai/deepseek-harness
- Commit: `ddefc45fbc7f8e46dd73185e68295696d1297887`
- License: MIT; Copyright (c) 2026 DeepSeek

`src/main/services/chat-context.ts` adapts the retention/projection approach in
`packages/context/session-reference/src/projection.ts`: preserve the newest
request, remove oldest retained context, and report omissions independently of
the complete saved transcript. Proto retains complete user turns and verifies
the resulting input with the selected LM Studio instance tokenizer. The DSH
application, provider configuration and separate tool runtime are not bundled.
The unmodified license is in `licenses/DeepSeek-Harness-MIT.txt`.

## OpenScience research workflow adaptations

- Source: https://github.com/synthetic-sciences/openscience
- Commit: `ef6156f8fe5a1e40bd7889707e7abdba9ea1da80`
- License: Apache License 2.0; Copyright 2026 Synthetic Sciences

Modified adaptations in `research-tools.ts` and `research-chat.ts` draw on
`backend/cli/src/session/search-dedupe.ts` (canonical argument signatures and
successful-search reuse), `session/processor.ts` (repeated tool-call detection),
`tool/todo.ts` (compact plan receipts), and `tool/truncation.ts` (bounded results
with a complete saved artifact). Workflow guidance also draws on the public
literature workflow in `tool/literature.ts` and `command/template/literature.txt`.
Proto normalizes scientific aliases before deduplication, keeps failed requests
retryable, retains call/result pairing, and uses local LM Studio and existing
Proto database/computation backends. OpenScience API credentials, paid search
services, desktop application and third-party execution engines are not bundled.
Capability `workflowFamilies` identify workflow families, not authorship of every backend.
The licenses and upstream notice are distributed as
`licenses/OpenScience-Apache-2.0.txt` and `licenses/OpenScience-NOTICE.txt`.

## Chemistry scientific operator adaptations

The Analysis, Statistics and Chemical Data extension adds independently written
NumPy/SciPy numerical adapters and RDKit/SymPy data operators. Public OpenScience
statistics and chemistry procedures were inspected as workflow references;
their upstream implementation source is not vendored in these new modules.
Method-specific source paths, attribution and licenses are documented in
`../../docs/chem-analysis-methods.md` and `../../docs/chem-data-methods.md`.
NumPy, SciPy, RDKit and SymPy use 3-clause BSD licenses. No new package is bundled
by this extension; the operators use the configured scientific Python runtime.

The new `runtime/chem-integration/chem_science.py` adapts public molecular
descriptor, similarity and 3D preparation procedures inspected in OpenScience
commit `ef6156f8fe5a1e40bd7889707e7abdba9ea1da80`:

- `backend/cli/skills/chemistry/rdkit/scripts/molecular_properties.py`;
  its skill metadata identifies K-Dense Scientific Agent Skills, copyright
  2025 K-Dense Inc., MIT. The skill refers to RDKit's separate BSD-3-Clause
  runtime license.
- `backend/cli/skills/chemistry/smiles-validation/scripts/validate.py` and
  `chemistry/molecule-visualization/scripts/render_3d.py`; their skill metadata
  declares MIT and Synthetic Sciences authorship. The OpenScience application
  itself remains under its separate Apache-2.0 license noted above.

The adapters use structured JSON, declared units, bounded work, explicit map
identities, local geometry, and saved source/result hashes. The numerical
reaction-network and rate-fitting code is a new local wrapper around SciPy;
it is not attributed as an OpenScience kinetics engine. SciPy and RDKit are
existing external Python runtime dependencies under BSD-3-Clause. The original
Chem candidate/interface code remains in its MIT source snapshot and is verified
against its source manifest before use. Source file hashes and interpretation
limits are recorded in `docs/chem-science-operators.md`.

The applicable skill license notices are included in
`licenses/K-Dense-Scientific-Agent-Skills-MIT.txt` and
`licenses/Synthetic-Sciences-Chemistry-Skills-MIT.txt`.

## Direct document parsing

The Chat document reader uses Mozilla PDF.js (`pdfjs-dist` 6.3.289, Apache-2.0),
`yauzl` 3.4.0 (MIT) and `fast-xml-parser` 5.11.1 (MIT). Their unmodified license
texts are distributed in `licenses/PDFjs-Apache-2.0.txt`, `licenses/yauzl-MIT.txt`
and `licenses/fast-xml-parser-MIT.txt`. PDF.js ships its own component notices
with its packaged fonts, CMaps and WebAssembly resources. Proto adds bounded
input validation, source hashing, structured page/paragraph/cell extraction
and a paginated Chat reader. It does not execute embedded Office content.

## Physical chemistry and native biology companions

The new SciPy physical-chemistry wrappers independently implement adsorption,
van't Hoff, polyprotic fraction and ideal RC calculations. pyGAPS and impedance.py
public documentation were consulted as references; their implementation code is
not copied or their complete engines bundled. Native biological wrappers use
Biopython ProtParam and NumPy, with qPCR, normalization and diversity method
references recorded separately from Biomni. See
`../../docs/science-tool-expansion.md` for exact methods, sources and boundaries.
