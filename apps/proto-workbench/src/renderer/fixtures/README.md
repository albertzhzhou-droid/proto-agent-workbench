# Public structural reference for the browser preview

These small, fixed artifacts allow the preview to exercise the actual Mol* renderer. They do not represent a new workspace run or newly approved biological material.

- `1GFL.cif`: the deposited GFP structure, RCSB/wwPDB accession 1GFL, from https://files.rcsb.org/download/1GFL.cif. CC0-1.0; attribution: wwPDB / RCSB PDB and the original depositors. Retrieved September 4, 2026. SHA-256: `5d5a7ce2dd7be9228907902d5cd41ec162c569234bb8bd119eb48874e1dac90b`.
- `1GFL.json`: the original local attachment descriptor with source, byte digest, retrieval time, and review status.
- `gfp-reference.ir.json`: the existing project reference IR for UniProt P42212. The UniProt Consortium's CC-BY-4.0 attribution, source revision, and sequence digest are retained inside it. Source: https://rest.uniprot.org/uniprotkb/P42212.json. This is a preview copy; the browser does not issue eligibility decisions or edit the original record.

The browser labels the workspace as fixture data and verifies the structure bytes before displaying geometry. Download, import, workspace mutation, and structure publication still require the desktop bridge.
