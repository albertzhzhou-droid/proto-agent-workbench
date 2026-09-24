"""Bounded structural-bioinformatics calculations adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: PDB parsing and Kabsch superposition are reimplemented over
NumPy instead of Bio.PDB; liftover parses UCSC chain text with a pure-Python
mapper instead of pyliftover's downloaded chains; phylogeny consumes prealigned
sequences and builds an identity-distance neighbor-joining tree in NumPy
(upstream shells out to MUSCLE/ClustalW/IQ-TREE, exposed separately through the
executable-connector subsystem); the SBML writer keeps libsbml. Aligned PDB
copies and plot artifacts are not written.
"""

from __future__ import annotations

import math
from array import array


_AMINO_ACIDS = dict(zip(
    "ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL".split(),
    "ARNDCQEGHILKMFPSTWYV",
))
_COMPARISON_METHOD_VERSION = "pdb-ca-sequence-kabsch.v2"
_MAX_ALIGNMENT_CELLS = 2_000_000


def _comparison_chain(raw, requested_model, requested_chain, label):
    """Read CA identities without collapsing chains, insertion codes or models."""
    if requested_model is not None and (isinstance(requested_model, bool)
                                       or not isinstance(requested_model, int) or requested_model < 1):
        raise ValueError(f"model_{label} must be a positive PDB MODEL serial.")
    if requested_chain is not None and (not isinstance(requested_chain, str) or len(requested_chain) > 1):
        raise ValueError(f"chain_{label} must be one PDB chain character, or an empty string for the blank chain.")
    requested_chain = "" if requested_chain == " " else requested_chain
    models = {}
    current_model = None
    explicit_models = False
    implicit_atoms = False
    for line_number, line in enumerate(raw.decode("ascii", "strict").splitlines(), 1):
        record = line[:6].strip()
        if record == "MODEL":
            if current_model is not None or implicit_atoms:
                raise ValueError(f"Structure {label}: nested MODEL or mixed implicit/explicit models at line {line_number}.")
            try:
                serial = int(line[10:14])
            except ValueError:
                raise ValueError(f"Structure {label}: malformed MODEL serial at line {line_number}.") from None
            if serial < 1 or serial in models:
                raise ValueError(f"Structure {label}: invalid or duplicate MODEL serial {serial}.")
            explicit_models = True
            current_model = serial
            models[serial] = {}
            continue
        if record == "ENDMDL":
            if current_model is None:
                raise ValueError(f"Structure {label}: ENDMDL without MODEL at line {line_number}.")
            current_model = None
            continue
        if record == "END":
            break
        # Restrict to polymer ATOM records; HETATM calcium must never be a CA residue.
        if record != "ATOM" or line[12:16].strip() != "CA":
            continue
        if len(line) < 54:
            raise ValueError(f"Structure {label}: truncated CA record at line {line_number}.")
        if explicit_models and current_model is None:
            raise ValueError(f"Structure {label}: CA record outside a MODEL at line {line_number}.")
        model = current_model if explicit_models else 1
        if not explicit_models:
            implicit_atoms = True
        chains = models.setdefault(model, {})
        chain = line[21].strip()
        try:
            number = int(line[22:26])
            coordinates = [float(line[30:38]), float(line[38:46]), float(line[46:54])]
            occupancy = float(line[54:60].strip() or "0")
        except ValueError:
            raise ValueError(f"Structure {label}: malformed CA coordinates or residue identity at line {line_number}.") from None
        if not all(math.isfinite(value) and abs(value) <= 1e6 for value in coordinates):
            raise ValueError(f"Structure {label}: CA coordinates must be finite and bounded at line {line_number}.")
        if not math.isfinite(occupancy) or not 0 <= occupancy <= 1:
            raise ValueError(f"Structure {label}: CA occupancy must be in [0, 1] at line {line_number}.")
        insertion_code, alternate_location = line[26].strip(), line[16].strip()
        name = line[17:20].strip()
        residues = chains.setdefault(chain, {})
        key = (number, insertion_code)
        candidates = residues.setdefault(key, {})
        if alternate_location in candidates:
            raise ValueError(f"Structure {label}: duplicate CA identity model {model}, chain {chain!r}, residue {number}{insertion_code}, altloc {alternate_location!r}.")
        if candidates and any(item["residue_name"] != name for item in candidates.values()):
            raise ValueError(f"Structure {label}: alternate residue identities at {chain!r}:{number}{insertion_code} require explicit preprocessing.")
        candidates[alternate_location] = {
            "model": model, "chain": chain, "residue_number": number, "insertion_code": insertion_code,
            "residue_name": name, "one_letter": _AMINO_ACIDS.get(name, "X"),
            "alternate_location": alternate_location, "occupancy": occupancy, "coordinates": coordinates,
        }
    if not models:
        raise ValueError(f"Structure {label}: no polymer CA records were found.")
    model = requested_model if requested_model is not None else next(iter(models))
    if model not in models:
        raise ValueError(f"model_{label}={model} is absent; available MODEL serials: {list(models)}.")
    chains = models[model]
    if not chains:
        raise ValueError(f"Structure {label}: selected model {model} has no polymer CA records.")
    if requested_chain is None and len(chains) != 1:
        raise ValueError(f"Structure {label}: model {model} has multiple chains {list(chains)}; select chain_{label} explicitly (empty string selects the blank chain).")
    chain = requested_chain if requested_chain is not None else next(iter(chains))
    if chain not in chains:
        raise ValueError(f"chain_{label}={chain!r} is absent from model {model}; available chains: {list(chains)}.")
    records = []
    for candidates in chains[chain].values():
        # Largest occupancy, then blank, then A, then lexical altloc. Never average conformers.
        selected = min(candidates.values(), key=lambda item: (
            -item["occupancy"], item["alternate_location"] != "", item["alternate_location"] != "A", item["alternate_location"]))
        records.append(selected)
    if len(records) > 10_000:
        raise ValueError(f"Structure {label}: selected chain exceeds 10,000 CA residues.")
    return records, {"model": model, "chain": chain, "available_models": list(models),
                     "available_chains": list(chains), "observed_ca_residues": len(records),
                     "unknown_residues": sum(item["one_letter"] == "X" for item in records)}


def _sequence_pairs(first, second):
    """Bounded global alignment; refuse tied optimal correspondences."""
    a, b = [item["one_letter"] for item in first], [item["one_letter"] for item in second]
    n, m = len(a), len(b)
    if (n + 1) * (m + 1) > _MAX_ALIGNMENT_CELLS:
        raise ValueError("Sequence correspondence exceeds 2,000,000 alignment cells; use reviewed matching residue IDs or smaller chain inputs.")
    scores = [array("i", [-2 * j for j in range(m + 1)])]
    counts = [bytearray([1] * (m + 1))]
    for i in range(1, n + 1):
        row, ways = array("i", [-2 * i] + [0] * m), bytearray(m + 1)
        ways[0] = 1
        for j in range(1, m + 1):
            # Unknown residues supply neither sequence identity nor positive alignment evidence.
            substitution = 2 if a[i - 1] == b[j - 1] and a[i - 1] != "X" else -1
            diagonal, up, left = scores[i - 1][j - 1] + substitution, scores[i - 1][j] - 2, row[j - 1] - 2
            best = max(diagonal, up, left)
            row[j] = best
            ways[j] = min(2, (counts[i - 1][j - 1] if diagonal == best else 0)
                          + (counts[i - 1][j] if up == best else 0) + (ways[j - 1] if left == best else 0))
        scores.append(row)
        counts.append(ways)
    if counts[n][m] != 1:
        raise ValueError("Sequence correspondence is ambiguous: multiple optimal global alignments. Review shared numbering and explicitly choose correspondence='residue_id', or provide unambiguous chain inputs.")
    pairs, i, j = [], n, m
    while i or j:
        substitution = 2 if i and j and a[i - 1] == b[j - 1] and a[i - 1] != "X" else -1
        if i and j and scores[i][j] == scores[i - 1][j - 1] + substitution:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i and scores[i][j] == scores[i - 1][j] - 2:
            i -= 1
        else:
            j -= 1
    return list(reversed(pairs)), scores[n][m]


def _residue_identity(record):
    return {key: value for key, value in record.items() if key != "coordinates"}


def _number(value, name, *, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number.")
    result = float(value)
    if not math.isfinite(result) or abs(result) > 1e100:
        raise ValueError(f"{name} must be finite with magnitude <= 1e100.")
    if minimum is not None and result < minimum or maximum is not None and result > maximum:
        raise ValueError(f"{name} is outside its allowed range.")
    return result


def _string(value, name, maximum=100):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or value.strip() != value:
        raise ValueError(f"{name} must be a nonempty trimmed string of at most {maximum} characters.")
    return value


def compare_protein_structures(arguments, files):
    for field in ("structure_a_path", "structure_b_path"):
        if files.get(field) is None:
            raise ValueError(f"{field} must reference a PDB file inside the workspace.")
    first, selected_a = _comparison_chain(files["structure_a_path"], arguments.get("model_a"), arguments.get("chain_a"), "a")
    second, selected_b = _comparison_chain(files["structure_b_path"], arguments.get("model_b"), arguments.get("chain_b"), "b")
    correspondence = arguments.get("correspondence", "sequence")
    minimum_identity = _number(arguments.get("minimum_sequence_identity", 0.5), "minimum_sequence_identity", minimum=0, maximum=1)
    alignment_score = None
    if correspondence == "sequence":
        aligned_pairs, alignment_score = _sequence_pairs(first, second)
    elif correspondence == "residue_id":
        lookup = {(item["residue_number"], item["insertion_code"]): index for index, item in enumerate(second)}
        aligned_pairs = [(index, lookup[key]) for index, item in enumerate(first)
                         if (key := (item["residue_number"], item["insertion_code"])) in lookup]
    else:
        raise ValueError("correspondence must be sequence or residue_id.")
    pairs = [(i, j) for i, j in aligned_pairs if first[i]["one_letter"] != "X" and second[j]["one_letter"] != "X"]
    if len(pairs) < 3:
        raise ValueError("Fewer than three mapped CA residues with known amino-acid identities; the structures cannot be superimposed.")
    identity = sum(first[i]["one_letter"] == second[j]["one_letter"] for i, j in pairs) / len(pairs)
    if identity < minimum_identity:
        raise ValueError(f"Mapped sequence identity {identity:.4f} is below minimum_sequence_identity={minimum_identity}; review correspondence before comparing coordinates.")
    import numpy as np
    mobile = np.asarray([second[j]["coordinates"] for i, j in pairs])
    reference = np.asarray([first[i]["coordinates"] for i, j in pairs])
    mobile_centered = mobile - mobile.mean(axis=0)
    reference_centered = reference - reference.mean(axis=0)
    u, _s, vt = np.linalg.svd(mobile_centered.T @ reference_centered)
    d = np.sign(np.linalg.det(u @ vt))
    rotation = u @ np.diag([1.0, 1.0, d]) @ vt
    rotated = mobile_centered @ rotation
    displacement = np.linalg.norm(rotated - reference_centered, axis=1)
    rmsd = math.sqrt(float(np.sum(displacement ** 2) / len(pairs)))
    threshold = _number(arguments.get("significant_threshold_a", 2.0), "significant_threshold_a", minimum=0)
    rows = []
    for index, (i, j) in enumerate(pairs):
        rows.append({"residue_number": first[i]["residue_number"], "residue_name": first[i]["residue_name"],
                     "residue_a": _residue_identity(first[i]), "residue_b": _residue_identity(second[j]),
                     "observed_index_a": i, "observed_index_b": j,
                     "displacement_a": round(float(displacement[index]), 4),
                     "significant": bool(displacement[index] > threshold)})
    regions = []
    current = []
    for row in rows:
        if row["significant"]:
            if current and row["observed_index_a"] == current[-1]["observed_index_a"] + 1 and row["observed_index_b"] == current[-1]["observed_index_b"] + 1:
                current.append(row)
            else:
                if len(current) >= 3:
                    regions.append(current)
                current = [row]
        else:
            if len(current) >= 3:
                regions.append(current)
            current = []
    if len(current) >= 3:
        regions.append(current)
    return {
        "common_residues": len(pairs), "chain_a": selected_a["chain"], "chain_b": selected_b["chain"],
        "model_a": selected_a["model"], "model_b": selected_b["model"],
        "method_version": _COMPARISON_METHOD_VERSION,
        "mapping": {"correspondence": correspondence, "structure_a": selected_a, "structure_b": selected_b,
                    "aligned_residue_pairs": len(aligned_pairs), "fitted_residue_pairs": len(pairs),
                    "excluded_unknown_pairs": len(aligned_pairs) - len(pairs),
                    "coverage_a": len(pairs) / len(first), "coverage_b": len(pairs) / len(second),
                    "sequence_identity": identity, "identity_denominator": "mapped pairs with two canonical amino acids",
                    "minimum_sequence_identity": minimum_identity, "alignment_score": alignment_score,
                    "alignment_algorithm": "unique global Needleman-Wunsch: match +2, mismatch/unknown -1, linear gap -2" if correspondence == "sequence" else "author residue number plus insertion code within selected chains"},
        "ca_rmsd_a": round(rmsd, 4), "significant_threshold_a": threshold,
        "significant_residues": sum(row["significant"] for row in rows),
        "per_residue": rows[:1000], "returned_residues": min(len(rows), 1000), "per_residue_truncated": len(rows) > 1000,
        "conformational_regions": [{"start": region[0]["residue_number"], "end": region[-1]["residue_number"],
                                    "start_residue_a": region[0]["residue_a"], "end_residue_a": region[-1]["residue_a"],
                                    "start_residue_b": region[0]["residue_b"], "end_residue_b": region[-1]["residue_b"],
                                    "length": len(region),
                                    "mean_displacement_a": round(sum(item["displacement_a"] for item in region) / len(region), 4)}
                                   for region in regions],
        "method": "Explicit-chain CA correspondence and Kabsch superposition (NumPy)",
        "limitations": ["Mapping uses observed polymer ATOM CA residues only; missing coordinates, SEQRES residues and modified HETATM residues are not reconstructed.",
                        "Coverage denominators are observed CA residues in the selected chains, not full biological sequence lengths. Unknown amino acids are excluded from the fit.",
                        "Sequence identity and unique alignment do not establish homology or biological equivalence; residue_id mode requires reviewed numbering.",
                        "The default model is the first encountered MODEL serial (implicit model 1 if absent). Alternate CA conformers use highest occupancy, then blank/A/lexical tie order.",
                        "Displacement thresholds are descriptive geometric cutoffs, not statistical significance; regions follow adjacency in both observed sequences and may span unobserved residues.",
                        "Aligned coordinate files and plots that upstream wrote are intentionally not produced."],
    }


def create_biochemical_network_sbml_model(arguments, files=None):
    """Faithful libsbml transcription; output XML returned as text."""
    reactions = arguments.get("reactions")
    if not isinstance(reactions, list) or not 1 <= len(reactions) <= 200:
        raise ValueError("reactions must contain 1 to 200 entries.")
    kinetic = arguments.get("kinetic_parameters", [])
    if not isinstance(kinetic, list):
        raise ValueError("kinetic_parameters must be a list.")
    parameters = {}
    for index, entry in enumerate(kinetic):
        if not isinstance(entry, dict) or set(entry) - {"reaction_id", "law_type", "formula", "parameters"} or "reaction_id" not in entry:
            raise ValueError(f"kinetic_parameters[{index}] must contain reaction_id with optional law_type, formula, parameters.")
        law = entry.get("law_type", "mass_action")
        if law not in ("mass_action", "michaelis_menten", "custom"):
            raise ValueError(f"kinetic_parameters[{index}].law_type must be mass_action, michaelis_menten, or custom.")
        if law == "custom" and not isinstance(entry.get("formula"), str):
            raise ValueError(f"kinetic_parameters[{index}] needs a formula for law_type custom.")
        constants = entry.get("parameters", [])
        if not isinstance(constants, list) or any(not isinstance(item, dict) or set(item) != {"name", "value"}
                                                  or isinstance(item["value"], bool) or not isinstance(item["value"], (int, float))
                                                  for item in constants):
            raise ValueError(f"kinetic_parameters[{index}].parameters must be {{name, value}} number entries.")
        parameters[entry["reaction_id"]] = (law, {item["name"]: item["value"] for item in constants}, entry.get("formula"))
    import libsbml

    document = libsbml.SBMLDocument(libsbml.SBMLNamespaces(3, 2))
    model = document.createModel()
    model.setId("biochemical_network_model")
    compartment = model.createCompartment()
    compartment.setId("default")
    compartment.setConstant(True)
    compartment.setSize(1.0)
    compartment.setSpatialDimensions(3)
    species = set()
    parsed = []
    for index, reaction in enumerate(reactions):
        if not isinstance(reaction, dict) or not {"id", "reactants", "products"} <= set(reaction) <= {"id", "reactants", "products", "name", "reversible"}:
            raise ValueError(f"reactions[{index}] must contain id, reactants, and products.")
        identifier = _string(reaction["id"], f"reactions[{index}].id")
        for side in ("reactants", "products"):
            if not isinstance(reaction[side], list) or any(not isinstance(item, dict) or set(item) != {"species", "stoichiometry"} for item in reaction[side]):
                raise ValueError(f"reactions[{index}].{side} must be {{species, stoichiometry}} entries.")
        parsed.append(reaction)
        for side in ("reactants", "products"):
            for item in reaction[side]:
                species.add(_string(item["species"], "species id"))
    for name in sorted(species):
        entry = model.createSpecies()
        entry.setId(name)
        entry.setCompartment("default")
        entry.setInitialConcentration(0.0)
        entry.setHasOnlySubstanceUnits(False)
        entry.setBoundaryCondition(False)
        entry.setConstant(False)
    for reaction in parsed:
        entry = model.createReaction()
        entry.setId(reaction["id"])
        entry.setName(reaction.get("name", reaction["id"]))
        entry.setReversible(bool(reaction.get("reversible", False)))
        entry.setFast(False)
        for side, add in (("reactants", entry.createReactant), ("products", entry.createProduct)):
            for item in reaction[side]:
                reference = add()
                reference.setSpecies(item["species"])
                reference.setStoichiometry(_number(item["stoichiometry"], "stoichiometry", minimum=0))
                reference.setConstant(True)
        if reaction["id"] in parameters:
            law_type, constants, formula = parameters[reaction["id"]]
            law = entry.createKineticLaw()
            for name, value in constants.items():
                parameter = law.createParameter()
                parameter.setId(name)
                parameter.setValue(_number(value, f"parameter {name}", minimum=0))
            if law_type == "mass_action":
                product = " * ".join(sorted(reaction["reactants"] and [item["species"] for item in reaction["reactants"]]))
                expression = f"k * {product}" if product else "k"
            elif law_type == "michaelis_menten":
                substrate = reaction["reactants"][0]["species"] if reaction["reactants"] else "S"
                expression = f"Vmax * {substrate} / (Km + {substrate})"
            else:
                expression = formula
            law.setMath(libsbml.parseL3Formula(expression))
    writer = libsbml.SBMLWriter()
    text = writer.writeSBMLToString(document)
    document.checkConsistency()
    return {
        "sbml": text, "species_count": len(species), "reaction_count": len(parsed),
        "kinetic_laws": {name: law_type for name, (law_type, _c, _f) in parameters.items()},
        "method": "libsbml Level 3 Version 2 document construction transcribed from upstream",
        "limitations": ["Species start at zero initial concentration exactly as upstream; set real initial conditions in a downstream editor.",
                        "Units-consistency checking is not enforced here; validate the model with libSBML or a simulator before use.",
                        "The model is returned as text rather than written to a file."],
    }


def liftover_coordinates(arguments, files):
    """UCSC chain-file liftOver; the chain file is a workspace input."""
    if files.get("chain_path") is None:
        raise ValueError("chain_path must reference a UCSC .chain/.over.chain file inside the workspace.")
    intervals = arguments.get("intervals")
    if not isinstance(intervals, list) or not 1 <= len(intervals) <= 10000:
        raise ValueError("intervals must contain 1 to 10000 {chromosome, start, end} entries.")
    parsed_intervals = []
    for index, interval in enumerate(intervals):
        if not isinstance(interval, dict) or set(interval) != {"chromosome", "start", "end"}:
            raise ValueError(f"intervals[{index}] must contain chromosome, start, and end.")
        start = int(interval["start"]) if isinstance(interval["start"], int) and not isinstance(interval["start"], bool) else None
        end = int(interval["end"]) if isinstance(interval["end"], int) and not isinstance(interval["end"], bool) else None
        if start is None or end is None or not 0 <= start < end:
            raise ValueError(f"intervals[{index}] must have integer start < end.")
        parsed_intervals.append((_string(interval["chromosome"], "chromosome", 40), start, end))
    chains = {}
    current = None
    for line in files["chain_path"].decode("utf-8", "replace").splitlines():
        line = line.strip()
        if line.startswith("chain"):
            fields = line.split()
            if len(fields) < 12:
                continue
            _score, t_name, _t_size, t_strand, t_start, t_end, _identifier, q_name, _q_size, q_strand, q_start, q_end = fields[1:13]
            key = (t_name, "+")  # Coordinates are always given on the + strand.
            chains.setdefault(key, []).append({"q_name": q_name, "q_strand": q_strand, "q_size": int(_q_size),
                                               "blocks": [], "t_cursor": int(t_start), "q_cursor": int(q_start),
                                               "t_end": int(t_end), "q_end": int(q_end)})
            current = chains[key][-1]
        elif line and not line.startswith("#") and current is not None:
            fields = line.split()
            if len(fields) not in (1, 3):
                current = None
                continue
            size = int(fields[0])
            dt = int(fields[1]) if len(fields) == 3 else 0
            dq = int(fields[2]) if len(fields) == 3 else 0
            current["blocks"].append((current["t_cursor"], current["t_cursor"] + size, current["q_cursor"], current["q_cursor"] + size))
            current["t_cursor"] += size + dt
            current["q_cursor"] += size + dq
    if not chains:
        raise ValueError("No chain records parsed; supply a valid UCSC chain file.")
    results = []
    mapped = 0
    for chromosome, start, end in parsed_intervals:
        entry = None
        for chain in chains.get((chromosome, "+"), []):
            if all(any(t0 <= point < t1 for t0, t1, _q0, _q1 in chain["blocks"]) for point in (start, end - 1)):
                if all(t0 <= start and end <= t1 for t0, t1, _q0, _q1 in chain["blocks"]):
                    entry = chain
                    break
        if entry is None:
            results.append({"chromosome": chromosome, "start": start, "end": end, "mapped": False})
            continue
        offset_start = offset_end = None
        for t0, t1, q0, q1 in entry["blocks"]:
            if t0 <= start < t1:
                offset_start = q0 + (start - t0)
            if t0 < end <= t1:
                offset_end = q0 + (end - t0)
        if offset_start is None or offset_end is None:
            results.append({"chromosome": chromosome, "start": start, "end": end, "mapped": False})
            continue
        reverse = entry["q_strand"] == "-"
        results.append({"chromosome": chromosome, "start": start, "end": end, "mapped": True,
                        "target_chromosome": entry["q_name"], "target_strand": entry["q_strand"],
                        "target_start": offset_start if not reverse else entry["q_size"] - offset_end,
                        "target_end": offset_end if not reverse else entry["q_size"] - offset_start})
        mapped += 1
    return {
        "intervals": len(results), "mapped": mapped, "unmapped": len(results) - mapped,
        "results": results[:5000],
        "method": "UCSC chain block alignment with strand-aware coordinate transformation (pure Python replacing pyliftover)",
        "limitations": ["Intervals spanning chain block boundaries or gaps lift to unmapped, matching liftOver's strict behavior within one chain.",
                        "Only the first matching chain per region is used; overlapping chains are not scored.",
                        "Supply the correct chain file (for example hg19ToHg38.over.chain); no chains are downloaded."],
    }


def analyze_protein_phylogeny(arguments, files=None):
    """Identity-distance neighbor joining on prealigned sequences (NumPy)."""
    sequences = arguments.get("aligned_sequences")
    if not isinstance(sequences, list) or not 3 <= len(sequences) <= 200:
        raise ValueError("aligned_sequences must contain 3 to 200 named entries.")
    labels, rows = [], []
    for index, entry in enumerate(sequences):
        if not isinstance(entry, dict) or set(entry) != {"name", "sequence"}:
            raise ValueError(f"aligned_sequences[{index}] must contain name and sequence.")
        name = _string(entry["name"], f"aligned_sequences[{index}].name")
        if name in labels or any(ord(character) < 32 or ord(character) == 127 for character in name):
            raise ValueError("Sequence names must be unique and contain no control characters.")
        sequence = entry["sequence"]
        if not isinstance(sequence, str) or not sequence.isascii() or not 10 <= len(sequence) <= 2000:
            raise ValueError(f"aligned_sequences[{index}].sequence must contain 10 to 2000 ASCII characters.")
        if set(sequence.upper()) - set("ACDEFGHIKLMNPQRSTVWYBXZJUO-*"):
            raise ValueError(f"aligned_sequences[{index}].sequence must contain amino-acid letters, '-' gaps or '*' stops only.")
        if not any(residue in _AMINO_ACIDS.values() for residue in sequence.upper()):
            raise ValueError(f"aligned_sequences[{index}].sequence has no canonical amino acids.")
        labels.append(name)
        rows.append(sequence.upper())
    length = len(rows[0])
    if any(len(row) != length for row in rows):
        raise ValueError("Sequences must already be aligned to equal lengths; use the MUSCLE connector to align first.")
    import numpy as np

    n = len(rows)
    identities = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            same = sum(1 for a, b in zip(rows[i], rows[j]) if a == b and a in _AMINO_ACIDS.values())
            identities[i, j] = identities[j, i] = same / length
    distances = 1.0 - identities

    # Neighbor joining (Saitou-Nei) with Newick output.
    nodes = {i: labels[i] for i in range(n)}
    active = list(range(n))
    d = np.zeros((2 * n, 2 * n))
    d[:n, :n] = distances
    np.fill_diagonal(d, 0.0)
    edges = []
    negative_limbs = []

    def add_edge(source, target, branch_length):
        raw_length = float(branch_length)
        if raw_length < 0:
            negative_limbs.append({"source_node": source, "target_node": target, "raw_length": raw_length})
        edges.append((source, target, max(raw_length, 0.0)))

    while len(active) > 2:
        count = len(active)
        r = {i: sum(d[i][j] for j in active) for i in active}
        pair = min(((a, b) for position, a in enumerate(active) for b in active[position + 1:]),
                   key=lambda ab: (count - 2) * d[ab[0]][ab[1]] - r[ab[0]] - r[ab[1]])
        i, j = pair
        delta = (r[i] - r[j]) / (count - 2) if count > 2 else 0
        limb_i = 0.5 * d[i][j] + 0.5 * delta
        limb_j = d[i][j] - limb_i
        new_index = max(nodes) + 1
        add_edge(i, new_index, limb_i)
        add_edge(j, new_index, limb_j)
        for k in active:
            if k in (i, j):
                continue
            updated = 0.5 * (d[i][k] + d[j][k] - d[i][j])
            d[new_index, k] = d[k, new_index] = updated
        d[new_index, new_index] = 0.0
        nodes[new_index] = None
        active = [k for k in active if k not in (i, j)] + [new_index]
    add_edge(active[0], active[1], d[active[0]][active[1]])

    adjacency = {index: [] for index in nodes}
    for source, target, branch_length in edges:
        adjacency[source].append((target, branch_length))
        adjacency[target].append((source, branch_length))

    def newick(index, parent):
        branches = [(neighbor, branch_length) for neighbor, branch_length in adjacency[index] if neighbor != parent]
        if branches:
            return "(" + ",".join(f"{newick(neighbor, index)}:{branch_length:.10g}" for neighbor, branch_length in branches) + ")"
        return "'" + nodes[index].replace("'", "''") + "'"

    # Root only for serialization by splitting the final undirected edge. NJ remains unrooted.
    left, right, final_length = edges[-1]
    tree = f"({newick(left, right)}:{final_length / 2:.10g},{newick(right, left)}:{final_length / 2:.10g});"

    pairwise = []
    for i in range(n):
        for j in range(i + 1, n):
            pairwise.append({"a": labels[i], "b": labels[j], "identity": round(float(identities[i, j]), 6),
                             "distance": round(float(distances[i, j]), 6)})
    pairwise.sort(key=lambda row: -row["identity"])
    return {
        "sequences": n, "alignment_length": length, "newick_tree": tree,
        "method_version": "identity-nj.v2", "rooting": "unrooted; serialized at midpoint of final NJ edge",
        "tree_graph": {"nodes": [{"id": index, "name": name} for index, name in nodes.items()],
                       "edges": [{"source": source, "target": target, "length": branch_length}
                                 for source, target, branch_length in edges], "rooting": "arbitrary-display",
                       "display_root_edge": {"source": left, "target": right, "length": final_length}},
        "negative_branch_length_policy": "clamp_to_zero_and_report", "negative_branch_lengths": negative_limbs,
        "most_similar_pairs": pairwise[:10], "least_similar_pairs": pairwise[-5:],
        "method": "Identity distances with Saitou-Nei neighbor joining in NumPy (prealigned input)",
        "limitations": ["Sequences must already be aligned; upstream alignment used external MUSCLE/ClustalW, which this port exposes through the executable-connector subsystem instead.",
                         "Identity distances ignore substitution models (no JTT/LG correction); long branches are underestimated.",
                         "Identity is canonical-amino-acid matches divided by all alignment columns; gaps, stops and unknown or ambiguous residues never count as matches.",
                         "Any negative NJ limb is recorded before clamping to zero; clamping can change fitted tree distances. The serialization root is not an inferred ancestor.",
                        "Branch lengths are NJ estimates without bootstrap support."],
    }


_PDB_FILE = {"structure_a_path": {"extensions": [".pdb", ".ent", ".txt"], "max_bytes": 32 * 1024 * 1024},
             "structure_b_path": {"extensions": [".pdb", ".ent", ".txt"], "max_bytes": 32 * 1024 * 1024}}
_CHAIN_FILE = {"chain_path": {"extensions": [".chain", ".over.chain", ".txt"], "max_bytes": 256 * 1024 * 1024}}


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _tool(title, description, schema, example, path, function, *, dependency=(), file_inputs=None):
    entry = {"title": title, "description": description, "input_schema": schema, "example": example,
             "dependency": list(dependency), "implementation": "biomni-adapted",
             "upstream_functions": [{"path": path, "name": function}]}
    if file_inputs:
        entry["file_inputs"] = file_inputs
    return entry


TOOLS = {
    "compare_protein_structures": _tool(
        "PDB structure comparison", "Select one model and chain per structure, map observed canonical CA residues by unique sequence alignment or reviewed residue IDs, and report Kabsch RMSD with mapping coverage.",
        _schema({"structure_a_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "structure_b_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "chain_a": {"type": "string", "maxLength": 1}, "chain_b": {"type": "string", "maxLength": 1},
                 "model_a": {"type": "integer", "minimum": 1, "description": "PDB MODEL serial; default is first encountered model."},
                 "model_b": {"type": "integer", "minimum": 1, "description": "PDB MODEL serial; default is first encountered model."},
                 "correspondence": {"type": "string", "enum": ["sequence", "residue_id"], "default": "sequence"},
                 "minimum_sequence_identity": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.5},
                 "significant_threshold_a": {"type": "number", "minimum": 0, "default": 2}}, ["structure_a_path", "structure_b_path"]),
        {"structure_a_path": "build/compute-inputs/apo.pdb", "structure_b_path": "build/compute-inputs/bound.pdb"},
        "biomni/tool/systems_biology.py", "compare_protein_structures", dependency=("numpy",), file_inputs=_PDB_FILE),
    "create_biochemical_network_sbml_model": _tool(
        "SBML network writer", "Build an SBML Level 3 Version 2 model with species, reactions, and mass-action or Michaelis-Menten kinetic laws (libsbml).",
        _schema({"reactions": {"type": "array", "minItems": 1, "maxItems": 200, "items": _schema(
                     {"id": {"type": "string", "minLength": 1, "maxLength": 100}, "name": {"type": "string", "maxLength": 100},
                      "reversible": {"type": "boolean"},
                      "reactants": {"type": "array", "minItems": 0, "maxItems": 50, "items": _schema(
                          {"species": {"type": "string", "minLength": 1, "maxLength": 100},
                           "stoichiometry": {"type": "number", "minimum": 0}}, ["species", "stoichiometry"])},
                      "products": {"type": "array", "minItems": 0, "maxItems": 50, "items": _schema(
                          {"species": {"type": "string", "minLength": 1, "maxLength": 100},
                           "stoichiometry": {"type": "number", "minimum": 0}}, ["species", "stoichiometry"])},
                      }, ["id", "reactants", "products"])},
                 "kinetic_parameters": {"type": "array", "maxItems": 200, "items": _schema(
                     {"reaction_id": {"type": "string", "minLength": 1, "maxLength": 100},
                      "law_type": {"type": "string", "enum": ["mass_action", "michaelis_menten", "custom"]},
                      "formula": {"type": "string", "maxLength": 500},
                      "parameters": {"type": "array", "maxItems": 20, "items": _schema({"name": {"type": "string", "minLength": 1, "maxLength": 50}, "value": {"type": "number", "minimum": 0}}, ["name", "value"])}}, ["reaction_id"])}},
                ["reactions"]),
        {"reactions": [{"id": "binding", "name": "A + B binding", "reactants": [{"species": "A", "stoichiometry": 1}, {"species": "B", "stoichiometry": 1}],
                        "products": [{"species": "AB", "stoichiometry": 1}]}],
         "kinetic_parameters": [{"reaction_id": "binding", "law_type": "mass_action", "parameters": [{"name": "k", "value": 0.8}]}]},
        "biomni/tool/synthetic_biology.py", "create_biochemical_network_sbml_model", dependency=("libsbml",)),
    "liftover_coordinates": _tool(
        "Chain-file coordinate liftover", "Map genomic intervals between assemblies with a user-supplied UCSC chain file (strand-aware, strict block boundaries).",
        _schema({"chain_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "intervals": {"type": "array", "minItems": 1, "maxItems": 10000, "items": _schema(
                     {"chromosome": {"type": "string", "minLength": 1, "maxLength": 40},
                      "start": {"type": "integer", "minimum": 0, "maximum": 2147483647},
                      "end": {"type": "integer", "minimum": 0, "maximum": 2147483648}}, ["chromosome", "start", "end"])}},
                ["chain_path", "intervals"]),
        {"chain_path": "build/compute-inputs/hg19ToHg38.over.chain",
         "intervals": [{"chromosome": "chr1", "start": 1000000, "end": 1000500}]},
        "biomni/tool/genetics.py", "liftover_coordinates", file_inputs=_CHAIN_FILE),
    "analyze_protein_phylogeny": _tool(
        "Protein phylogeny (prealigned)", "Build an identity-distance neighbor-joining tree with a Newick string from prealigned protein sequences.",
        _schema({"aligned_sequences": {"type": "array", "minItems": 3, "maxItems": 200, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100},
                      "sequence": {"type": "string", "minLength": 10, "maxLength": 2000}}, ["name", "sequence"])}},
                ["aligned_sequences"]),
        {"aligned_sequences": [
            {"name": "kinase_human", "sequence": "MKTLLILAVL"},
            {"name": "kinase_mouse", "sequence": "MKTLLILAVL"},
            {"name": "kinase_zebrafish", "sequence": "MKTLLILAVL"},
            {"name": "phosphatase", "sequence": "MKSVLILGVL"}]},
        "biomni/tool/genetics.py", "analyze_protein_phylogeny", dependency=("numpy",)),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
