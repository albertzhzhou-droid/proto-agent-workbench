"""Bounded, offline sequence and cloning calculations adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: pure-Python reimplementation without Biopython (embedded standard
codon table and a curated, explicitly written restriction-enzyme cut table),
structured JSON results, strict validation, no files/network/execution, and
corrected upstream defects (missing wrap-around PCR products, print side
effects, codon optimization discarding the optimized sequence). The sgRNA
spacer designer is a Proto-native sequence-based redesign; upstream queries a
precomputed sgRNA library from the data lake.
"""

from __future__ import annotations

import math
import re

_DNA = frozenset("ACGT")
_MAX_SEQUENCE = 20_000  # The computation decoder caps JSON strings at 20000.

# Standard genetic code (DNA codons); "*" marks stop codons.
_CODONS = {
    "TTT": "F", "TTC": "F", "TTA": "L", "TTG": "L", "CTT": "L", "CTC": "L", "CTA": "L", "CTG": "L",
    "ATT": "I", "ATC": "I", "ATA": "I", "ATG": "M", "GTT": "V", "GTC": "V", "GTA": "V", "GTG": "V",
    "TCT": "S", "TCC": "S", "TCA": "S", "TCG": "S", "CCT": "P", "CCC": "P", "CCA": "P", "CCG": "P",
    "ACT": "T", "ACC": "T", "ACA": "T", "ACG": "T", "GCT": "A", "GCC": "A", "GCA": "A", "GCG": "A",
    "TAT": "Y", "TAC": "Y", "TAA": "*", "TAG": "*", "CAT": "H", "CAC": "H", "CAA": "Q", "CAG": "Q",
    "AAT": "N", "AAC": "N", "AAA": "K", "AAG": "K", "GAT": "D", "GAC": "D", "GAA": "E", "GAG": "E",
    "TGT": "C", "TGC": "C", "TGA": "*", "TGG": "W", "CGT": "R", "CGC": "R", "CGA": "R", "CGG": "R",
    "AGT": "S", "AGC": "S", "AGA": "R", "AGG": "R", "GGT": "G", "GGC": "G", "GGA": "G", "GGG": "G",
}
_STOPS = frozenset(codon for codon, amino in _CODONS.items() if amino == "*")

_COMPLEMENT = {"A": "T", "T": "A", "C": "G", "G": "C"}
_IUPAC = {"A": "A", "T": "T", "C": "C", "G": "G", "R": "AG", "Y": "CT", "K": "GT", "M": "AC",
          "S": "CG", "W": "AT", "B": "CGT", "D": "AGT", "H": "ACT", "V": "ACG", "N": "ACGT"}

# Curated restriction-enzyme constants. Type IIS offsets are transcribed from
# Biomni's own TYPE_IIS_PROPERTIES table; Type II entries are textbook
# recognition/cut patterns written out explicitly for auditability. cut5/cut3
# are top-strand cut offsets counted from the recognition-site start (the "G" in
# EcoRI's "G^AATTC" is offset 1); overhang = cut3 - cut5 (positive: 5'
# overhang, zero: blunt, negative: 3' overhang).
_ENZYMES = {
    "EcoRI": ("GAATTC", 1, 5), "HindIII": ("AAGCTT", 1, 5), "BamHI": ("GGATCC", 1, 5),
    "BglII": ("AGATCT", 1, 5), "NcoI": ("CCATGG", 1, 5), "NdeI": ("CATATG", 2, 6),
    "NheI": ("GCTAGC", 1, 5), "XbaI": ("TCTAGA", 1, 5), "SpeI": ("ACTAGT", 1, 5),
    "SalI": ("GTCGAC", 1, 5), "XhoI": ("CTCGAG", 1, 5), "ClaI": ("ATCGAT", 2, 6),
    "MluI": ("ACGCGT", 1, 5), "AgeI": ("ACCGGT", 1, 5), "AscI": ("GGCGCGCC", 2, 6),
    "NotI": ("GCGGCCGC", 2, 6), "PstI": ("CTGCAG", 5, 1), "KpnI": ("GGTACC", 5, 1),
    "SacI": ("GAGCTC", 5, 1), "ApaI": ("GGGCCC", 5, 1), "SmaI": ("CCCGGG", 3, 3),
    "XmaI": ("CCCGGG", 1, 5), "EcoRV": ("GATATC", 3, 3), "PvuII": ("CAGCTG", 3, 3),
    "NruI": ("TCGCGA", 3, 3), "AluI": ("AGCT", 2, 2), "HaeIII": ("GGCC", 2, 2),
    "DraI": ("TTTAAA", 3, 3), "MboI": ("GATC", 0, 4), "Sau3AI": ("GATC", 0, 4),
    "TaqI": ("TCGA", 1, 3), "HpaII": ("CCGG", 1, 3), "MspI": ("CCGG", 1, 3),
    "HinfI": ("GANTC", 1, 5), "AvaII": ("GGWCC", 1, 5), "StyI": ("CCWWGG", 1, 5),
    "BclI": ("TGATCA", 1, 5), "BsiWI": ("CGTACG", 1, 5), "NsiI": ("ATGCAT", 5, 1),
    "AatII": ("GACGTC", 5, 1), "BsaI": ("GGTCTC", 7, 11), "BsmBI": ("CGTCTC", 7, 11),
    "Esp3I": ("CGTCTC", 7, 11), "BbsI": ("GAAGAC", 8, 12), "BtgZI": ("GCGATG", 16, 20),
    "SapI": ("GCTCTTC", 8, 11),
}

# Type IIS enzymes supported by the Golden Gate designers (upstream table).
_TYPE_IIS = {name: _ENZYMES[name] for name in ("BsaI", "BsmBI", "Esp3I", "BbsI", "BtgZI", "SapI")}


def _dna(value, name="sequence"):
    if not isinstance(value, str) or not value.isascii() or not 1 <= len(value) <= _MAX_SEQUENCE:
        raise ValueError(f"{name} must contain 1 to {_MAX_SEQUENCE} bases.")
    sequence = value.upper()
    if not set(sequence) <= _DNA:
        raise ValueError(f"{name} must contain only A, C, G, and T.")
    return sequence


def _boolean(value, name):
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean.")
    return value


def _integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}.")
    return value


def _number(value, name, *, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number.")
    result = float(value)
    if not math.isfinite(result) or abs(result) > 1e100:
        raise ValueError(f"{name} must be finite with magnitude <= 1e100.")
    if minimum is not None and result < minimum or maximum is not None and result > maximum:
        raise ValueError(f"{name} is outside its allowed range.")
    return result


def _reverse_complement(sequence):
    return "".join(_COMPLEMENT.get(base, "N") for base in reversed(sequence))


def _site_starts(sequence, site):
    """All 0-based recognition starts, including self-overlapping matches."""
    pattern = "".join(f"[{_IUPAC[base]}]" for base in site)
    return [match.start() for match in re.compile(f"(?={pattern})").finditer(sequence)]


def _find_sites(sequence, site, is_circular):
    positions = set(_site_starts(sequence, site))
    if is_circular:
        for offset in range(1, min(len(site), len(sequence))):
            boundary = sequence[-offset:] + sequence[: len(site) - offset]
            if _site_starts(boundary, site) and _site_starts(boundary, site)[0] == 0:
                positions.add(len(sequence) - offset)
    return sorted(positions)


def _enzymes(arguments):
    names = arguments.get("enzymes")
    if not isinstance(names, list) or not 1 <= len(names) <= 50:
        raise ValueError("enzymes must contain 1 to 50 enzyme names.")
    for name in names:
        if not isinstance(name, str) or name not in _ENZYMES:
            raise ValueError(f"Unsupported enzyme {name!r}; supported: {', '.join(sorted(_ENZYMES))}.")
    return names


def annotate_open_reading_frames(arguments):
    """Six-frame ATG-to-stop ORF annotation; the standard genetic code is assumed."""
    sequence = _dna(arguments.get("sequence"))
    minimum = _integer(arguments.get("min_length_nt", 30), "min_length_nt", 3, _MAX_SEQUENCE)
    search_reverse = _boolean(arguments.get("search_reverse", False), "search_reverse")
    filter_subsets = _boolean(arguments.get("filter_subsets", False), "filter_subsets")

    def strand_orfs(target, strand):
        found = []
        for frame in range(3):
            starts = []
            for index in range(frame, len(target) - 2, 3):
                codon = target[index:index + 3]
                if codon == "ATG":
                    starts.append(index)
                elif codon in _STOPS:
                    while starts and starts[0] < index:
                        start = starts.pop(0)
                        end = index + 3
                        if end - start >= minimum:
                            coding = target[start:end]
                            protein = "".join(_CODONS[coding[point:point + 3]]
                                              for point in range(0, len(coding), 3)).rstrip("*")
                            if strand == "-":
                                start, end = len(sequence) - end, len(sequence) - start
                            found.append({"sequence": coding, "aa_sequence": protein, "start": start,
                                          "end": end, "strand": strand,
                                          "frame": frame + 1 if strand == "+" else -(frame + 1)})
        return found

    orfs = strand_orfs(sequence, "+")
    if search_reverse:
        orfs.extend(strand_orfs(_reverse_complement(sequence), "-"))
    if filter_subsets:
        orfs.sort(key=lambda orf: (-(orf["end"] - orf["start"]), orf["start"]))
        kept = []
        for candidate in orfs:
            if any(candidate["strand"] == kept_orf["strand"] and candidate["start"] >= kept_orf["start"]
                   and candidate["end"] <= kept_orf["end"] for kept_orf in kept):
                continue
            kept.append(candidate)
        orfs = kept
    orfs.sort(key=lambda orf: (-(orf["end"] - orf["start"]), orf["start"], orf["strand"]))
    return {
        "length": len(sequence), "min_length_nt": minimum, "total_orfs": len(orfs),
        "forward_orfs": sum(orf["strand"] == "+" for orf in orfs),
        "reverse_orfs": sum(orf["strand"] == "-" for orf in orfs),
        "average_length_nt": round(sum(orf["end"] - orf["start"] for orf in orfs) / len(orfs), 1) if orfs else 0,
        "orfs": orfs[:500], "returned_orfs": min(len(orfs), 500), "truncated": len(orfs) > 500,
        "position_basis": "0-based half-open on the supplied strand",
        "limitations": ["ORFs require an in-frame ATG followed by a stop codon; partial terminal ORFs without a stop are not reported.",
                        "A longest-500 cap applies to the list; counts and averages cover every ORF. The standard genetic code is assumed.",
                        "An ORF is a reading-frame annotation, not evidence of translation."],
    }


def _align_windows(target, probe, max_mismatches):
    alignments = []
    for candidate, strand in ((probe, "+"), (_reverse_complement(probe), "-")):
        for index in range(len(target) - len(candidate) + 1):
            mismatches = [(offset, candidate[offset], target[index + offset])
                          for offset in range(len(candidate)) if candidate[offset] != target[index + offset]]
            if len(mismatches) <= max_mismatches:
                alignments.append({"position": index, "strand": strand, "mismatches": mismatches})
    return alignments


def align_sequences(arguments):
    target = _dna(arguments.get("target_sequence"), "target_sequence")
    primers = arguments.get("primer_sequences")
    if not isinstance(primers, list) or not 1 <= len(primers) <= 50:
        raise ValueError("primer_sequences must contain 1 to 50 sequences.")
    max_mismatches = _integer(arguments.get("max_mismatches", 1), "max_mismatches", 0, 3)
    results = []
    for index, primer in enumerate(primers):
        primer = _dna(primer, f"primer_sequences[{index}]")
        if len(primer) > len(target):
            raise ValueError(f"primer_sequences[{index}] is longer than target_sequence.")
        if len(target) * len(primer) > 4_000_000:
            raise ValueError("Combined target and primer lengths exceed the offline scan budget.")
        results.append({"sequence": primer, "alignments": _align_windows(target, primer, max_mismatches)})
    return {
        "target_length": len(target), "max_mismatches": max_mismatches, "sequences": results,
        "position_basis": "0-based start on the forward strand",
        "limitations": ["Exhaustive window scan allowing up to max_mismatches substitutions; insertions, deletions, and ambiguous bases are not modeled.",
                        "Both orientations are scanned; each alignment is an exact window comparison, not a scored alignment."],
    }


def pcr_simple(arguments):
    sequence = _dna(arguments.get("sequence"))
    forward = _dna(arguments.get("forward_primer"), "forward_primer")
    reverse = _dna(arguments.get("reverse_primer"), "reverse_primer")
    for name, primer in (("forward_primer", forward), ("reverse_primer", reverse)):
        if len(sequence) * len(primer) > 4_000_000:
            raise ValueError(f"Combined sequence and {name} lengths exceed the offline scan budget.")
    circular = _boolean(arguments.get("circular", False), "circular")
    max_mismatches = _integer(arguments.get("max_mismatches", 1), "max_mismatches", 0, 3)
    forward_sites = _align_windows(sequence, forward, max_mismatches)
    reverse_sites = _align_windows(sequence, _reverse_complement(reverse), max_mismatches)
    products = []
    for forward_alignment in forward_sites:
        for reverse_alignment in reverse_sites:
            fwd_pos, rev_pos = forward_alignment["position"], reverse_alignment["position"]
            if fwd_pos < rev_pos:
                product = sequence[fwd_pos:rev_pos + len(reverse)]
            elif circular and rev_pos < fwd_pos:
                product = sequence[fwd_pos:] + sequence[:rev_pos + len(reverse)]
            else:
                continue
            products.append({"size": len(product), "forward_position": fwd_pos, "reverse_position": rev_pos,
                             "sequence": product, "forward_mismatches": forward_alignment["mismatches"],
                             "reverse_mismatches": reverse_alignment["mismatches"]})
    return {
        "success": bool(products), "circular": circular,
        "message": None if products else "No valid PCR products: the primers do not flank an amplicon on this template.",
        "products": products, "forward_binding_sites": len(forward_sites), "reverse_binding_sites": len(reverse_sites),
        "position_basis": "0-based forward-strand primer starts; reverse_primer is supplied 5'-3' and searched as its reverse complement",
        "limitations": ["Primer annealing tolerates up to max_mismatches substitutions; no thermodynamics, extension, or primer-dimer modeling.",
                        "Multiple binding sites yield every combinatorial product; amplification efficiency is not predicted."],
    }


def digest_sequence(arguments):
    sequence = _dna(arguments.get("sequence"))
    enzymes = _enzymes(arguments)
    circular = _boolean(arguments.get("circular", True), "circular")
    cuts, per_enzyme = set(), {}
    for name in enzymes:
        site, cut5, _cut3 = _ENZYMES[name]
        positions = _find_sites(sequence, site, circular)
        per_enzyme[name] = positions
        cuts.update(position + cut5 for position in positions)
    ordered = sorted(cuts)
    fragments = []
    if not ordered:
        fragments.append({"fragment": sequence, "length": len(sequence), "start": 0, "end": len(sequence)})
    elif circular:
        for index, start in enumerate(ordered):
            end = ordered[(index + 1) % len(ordered)]
            if end <= start:
                end += len(sequence)
            piece = sequence[start:] + sequence[: end - len(sequence)] if end > len(sequence) else sequence[start:end]
            fragments.append({"fragment": piece, "length": len(piece), "start": start,
                              "end": end - len(sequence) if end > len(sequence) else end,
                              "is_wrapped": end > len(sequence)})
    else:
        if ordered[0] > 0:
            fragments.append({"fragment": sequence[:ordered[0]], "length": ordered[0], "start": 0, "end": ordered[0]})
        for start, end in zip(ordered, ordered[1:]):
            fragments.append({"fragment": sequence[start:end], "length": end - start, "start": start, "end": end})
        if ordered[-1] < len(sequence):
            fragments.append({"fragment": sequence[ordered[-1]:], "length": len(sequence) - ordered[-1],
                              "start": ordered[-1], "end": len(sequence)})
    fragments.sort(key=lambda fragment: (-fragment["length"], fragment["start"]))
    return {
        "sequence_info": {"length": len(sequence), "is_circular": circular},
        "digestion_info": {"enzymes_used": enzymes, "number_of_fragments": len(fragments),
                           "cut_positions": ordered, "sites_by_enzyme": per_enzyme},
        "fragments": fragments,
        "position_basis": "0-based half-open; a cut index counts top-strand bases left of the cut",
        "limitations": ["Only enzymes in the curated table are supported; methylation sensitivity is not modeled.",
                        "Fragment sizes are topological predictions from curated cut offsets, not electrophoretic measurements."],
    }


def find_restriction_sites(arguments):
    sequence = _dna(arguments.get("sequence"))
    enzymes = _enzymes(arguments)
    circular = _boolean(arguments.get("circular", True), "circular")
    sites = {}
    for name in enzymes:
        site, cut5, cut3 = _ENZYMES[name]
        positions = _find_sites(sequence, site, circular)
        sites[name] = {"recognition_sequence": site,
                       "cut_positions": {"5_prime_offset": cut5, "3_prime_offset": cut3,
                                         "overhang": cut3 - cut5,
                                         "overhang_type": "blunt" if cut3 == cut5 else "sticky"},
                       "top_strand_cut_indices": sorted(position + cut5 for position in positions)}
    return {
        "sequence_info": {"length": len(sequence), "is_circular": circular},
        "restriction_sites": sites,
        "position_basis": "0-based recognition-site starts; a cut index = site start + 5_prime_offset",
        "limitations": ["Recognized sites come from a curated enzyme subset; absence here does not prove an enzyme cannot cut the sequence.",
                        "Degenerate recognition letters match any listed base; methylation state is ignored."],
    }


def find_restriction_enzymes(arguments):
    sequence = _dna(arguments.get("sequence"))
    circular = _boolean(arguments.get("circular", False), "circular")
    enzyme_sites = {}
    for name in sorted(_ENZYMES):
        site, cut5, _cut3 = _ENZYMES[name]
        positions = _find_sites(sequence, site, circular)
        if positions:
            enzyme_sites[name] = [position + cut5 for position in positions]
    return {
        "sequence_info": {"length": len(sequence), "is_circular": circular},
        "enzyme_sites": enzyme_sites, "enzymes_scanned": len(_ENZYMES),
        "position_basis": "0-based top-strand cut indices",
        "limitations": [f"Scans the curated {len(_ENZYMES)}-enzyme subset only; reported values are top-strand cut positions, not site starts.",
                        "Methylation-dependent enzymes such as DpnI are outside the curated set."],
    }


def find_sequence_mutations(arguments):
    query = arguments.get("query_sequence")
    reference = arguments.get("reference_sequence")
    for name, value in (("query_sequence", query), ("reference_sequence", reference)):
        if not isinstance(value, str) or not value.isascii() or not 1 <= len(value) <= _MAX_SEQUENCE:
            raise ValueError(f"{name} must contain 1 to {_MAX_SEQUENCE} characters.")
        if not set(value.upper()) <= (_DNA | {"-"}):
            raise ValueError(f"{name} may use A, C, G, T, and '-' gap characters.")
    query, reference = query.upper(), reference.upper()
    start = _integer(arguments.get("query_start", 1), "query_start", 1, 1_000_000_000)
    mutations = []
    for offset, (query_base, reference_base) in enumerate(zip(query, reference)):
        if reference_base not in (query_base, "-") and query_base != "-":
            mutations.append({"label": f"{reference_base}{start + offset}{query_base}",
                              "position": start + offset, "reference": reference_base, "query": query_base})
    return {
        "mutations": mutations, "count": len(mutations), "query_start": start,
        "compared_positions": min(len(query), len(reference)),
        "input_lengths": {"query": len(query), "reference": len(reference)},
        "position_basis": "1-based over the supplied alignment columns",
        "limitations": ["Positions beyond the shorter sequence are ignored; gaps never count as mutations.",
                        "Inputs must already be aligned; no alignment, codon effect, or variant interpretation is performed."],
    }


def _wallace_tm(primer):
    return 2 * (primer.count("A") + primer.count("T")) + 4 * (primer.count("G") + primer.count("C"))


def _primer_limits(arguments):
    limits = (_number(arguments.get("min_gc", 0.4), "min_gc", minimum=0, maximum=1),
              _number(arguments.get("max_gc", 0.6), "max_gc", minimum=0, maximum=1),
              _number(arguments.get("min_tm", 55.0), "min_tm", minimum=0, maximum=200),
              _number(arguments.get("max_tm", 65.0), "max_tm", minimum=0, maximum=200))
    if limits[0] >= limits[1] or limits[2] >= limits[3]:
        raise ValueError("GC and Tm windows must have min strictly below max.")
    return limits


def _candidate_primer(region, region_start, length, limits):
    minimum_gc, maximum_gc, minimum_tm, maximum_tm = limits
    best, best_score = None, float("inf")
    for offset in range(len(region) - length + 1):
        candidate = region[offset:offset + length]
        gc = (candidate.count("G") + candidate.count("C")) / length
        if not minimum_gc <= gc <= maximum_gc:
            continue
        tm = _wallace_tm(candidate)
        if not minimum_tm <= tm <= maximum_tm:
            continue
        score = abs(gc - (minimum_gc + maximum_gc) / 2) * 100 + abs(tm - (minimum_tm + maximum_tm) / 2)
        if score < best_score:
            best, best_score = {"sequence": candidate, "position": region_start + offset,
                                "gc_content": gc, "tm_wallace_c": tm, "score": score}, score
    return best


_PRIMER_LIMITS = ["Tm uses the Wallace rule (2C per A/T, 4C per G/C), not thermodynamic nearest-neighbor calculations.",
                  "3' end stability, dimers, and specificity are not evaluated; verify candidates before ordering."]


def design_primer(arguments):
    sequence = _dna(arguments.get("sequence"))
    start = _integer(arguments.get("start"), "start", 0, len(sequence) - 1)
    length = _integer(arguments.get("primer_length", 20), "primer_length", 12, 40)
    limits = _primer_limits(arguments)
    window = _integer(arguments.get("search_window", 100), "search_window", length, 2000)
    region_start, region_end = start, min(start + window, len(sequence))
    primer = _candidate_primer(sequence[region_start:region_end], region_start, length, limits)
    if primer is None:
        return {"success": False, "primer": None, "search_window": [region_start, region_end],
                "message": "No primer in the search window satisfies the GC and Tm constraints.",
                "limitations": _PRIMER_LIMITS}
    primer.update({"success": True, "search_window": [region_start, region_end], "position_basis": "0-based", "limitations": _PRIMER_LIMITS})
    return primer


def design_verification_primers(arguments):
    plasmid = _dna(arguments.get("plasmid_sequence"))
    region = arguments.get("target_region")
    if (not isinstance(region, list) or len(region) != 2
            or any(isinstance(bound, bool) or not isinstance(bound, int) for bound in region)):
        raise ValueError("target_region must be [start, end] integers.")
    start, end = region
    if not 0 <= start < end <= len(plasmid):
        raise ValueError("target_region must satisfy 0 <= start < end <= plasmid length.")
    existing = arguments.get("existing_primers")
    if existing is None:
        existing = [{"name": "M13F", "sequence": "GTAAAACGACGGCCAG"},
                    {"name": "M13R", "sequence": "CAGGAAACAGCTATGAC"},
                    {"name": "T7", "sequence": "TAATACGACTCACTATAGGG"},
                    {"name": "SP6", "sequence": "GATTTAGGTGACACTATAG"}]
    if not isinstance(existing, list) or not 1 <= len(existing) <= 50:
        raise ValueError("existing_primers must contain 1 to 50 entries.")
    pool = []
    for index, primer in enumerate(existing):
        if not isinstance(primer, dict) or set(primer) - {"name", "sequence"} or "sequence" not in primer:
            raise ValueError("Each existing primer must be an object with a sequence and optional name.")
        pool.append({"name": primer.get("name") or f"Existing_{index + 1}",
                     "sequence": _dna(primer["sequence"], f"existing_primers[{index}].sequence")})
    circular = _boolean(arguments.get("circular", True), "circular")
    coverage_length = _integer(arguments.get("coverage_length", 800), "coverage_length", 20, 2000)
    primer_length = _integer(arguments.get("primer_length", 20), "primer_length", 12, 40)
    limits = _primer_limits(arguments)
    effective = plasmid
    if circular and end >= len(plasmid) - coverage_length // 2:
        effective = plasmid + plasmid[: coverage_length + 2]

    candidates = []
    for primer in pool:
        for alignment in _align_windows(effective, primer["sequence"], 1):
            position, strand = alignment["position"], alignment["strand"]
            span = ([position, position + coverage_length] if strand == "+" else
                    [position + len(primer["sequence"]) - coverage_length, position + len(primer["sequence"])])
            if span[0] <= end and span[1] >= start:
                candidates.append({"name": primer["name"], "sequence": primer["sequence"], "position": position,
                                   "strand": strand, "source": "existing",
                                   "covers": [max(start, span[0]), min(end, span[1])]})
    candidates.sort(key=lambda item: (-(item["covers"][1] - item["covers"][0]), item["name"]))

    def merge(intervals):
        merged = []
        for interval in sorted(intervals):
            if merged and interval[0] <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], interval[1])
            else:
                merged.append(list(interval))
        return merged

    covered, recommended = [], []
    for candidate in candidates:
        fresh = [point for point in range(candidate["covers"][0], candidate["covers"][1] + 1)
                 if not any(region[0] <= point <= region[1] for region in covered)]
        if fresh:
            recommended.append(candidate)
            covered = merge(covered + [candidate["covers"]])
    gaps, cursor = [], start
    for interval in sorted(covered):
        if cursor < interval[0]:
            gaps.append((cursor, interval[0] - 1))
        cursor = max(cursor, interval[1] + 1)
    if cursor <= end:
        gaps.append((cursor, end))
    for gap_start, gap_end in gaps:
        anchor = max(0, gap_start - 100)
        primer = _candidate_primer(effective[anchor:min(len(effective), gap_end + 100)], anchor, primer_length, limits)
        if primer:
            covered_start, covered_end = max(start, primer["position"]), min(end, primer["position"] + coverage_length)
            recommended.append({**primer, "name": f"New_primer_{len(recommended) + 1}", "strand": "+",
                                "source": "newly_designed", "covers": [covered_start, covered_end]})
            covered = merge(covered + [[covered_start, covered_end]])
    fully_covered = any(interval[0] <= start and interval[1] >= end for interval in covered)
    return {
        "target_region": {"start": start, "end": end, "length": end - start + 1},
        "recommended_primers": recommended, "is_fully_covered": fully_covered,
        "coverage_map": [{"primer": item["name"], "start": item["covers"][0], "end": item["covers"][1]} for item in recommended],
        "covered_intervals": covered,
        "position_basis": "0-based on the supplied plasmid sequence",
        "limitations": ["Greedy coverage with a fixed read length per primer; actual Sanger read length varies.",
                        "Existing-primer matching allows one substitution; new primers use the Wallace Tm rule and are unvalidated.",
                        "A warning-free report does not replace designer review of the coverage map."],
    }


def _type_iis(arguments):
    name = arguments.get("enzyme")
    if not isinstance(name, str) or name not in _TYPE_IIS:
        raise ValueError(f"enzyme must be one of: {', '.join(sorted(_TYPE_IIS))}.")
    return name


def _iis_cuts(sequence, enzyme, circular):
    """Backbone cut record list in upstream geometry, derived from the enzyme table."""
    site, cut5, cut3 = _TYPE_IIS[enzyme]
    length, overhang = len(site), cut3 - cut5
    reverse_site = _reverse_complement(site)
    cuts = []
    for index in _find_sites(sequence, site, circular):
        cuts.append({"site_position": index, "strand": "forward",
                     "cut_fwd": (index + cut5) % len(sequence), "cut_rev": (index + cut3) % len(sequence)})
    for index in _find_sites(sequence, reverse_site, circular):
        # Mirror of the forward geometry about the recognition site: cut_rev
        # sits offset_fwd bases before the site start, cut_fwd offset_rev bases.
        cuts.append({"site_position": index, "strand": "reverse",
                     "cut_fwd": (index + length - cut3) % len(sequence),
                     "cut_rev": (index + length - cut5) % len(sequence)})
    for cut in cuts:
        fwd, rev = cut["cut_fwd"], cut["cut_rev"]
        overhang_sequence = sequence[fwd:rev] if fwd < rev else sequence[fwd:] + sequence[:rev]
        cut["overhang"] = overhang_sequence[:overhang]
    return sorted(cuts, key=lambda cut: cut["site_position"])


def design_golden_gate_oligos(arguments):
    backbone = _dna(arguments.get("backbone_sequence"))
    insert = _dna(arguments.get("insert_sequence"))
    enzyme = _type_iis(arguments)
    circular = _boolean(arguments.get("circular", True), "circular")
    cuts = _iis_cuts(backbone, enzyme, circular)
    if len(cuts) < 2:
        return {"success": False, "enzyme": enzyme, "overhangs": None, "oligos": None, "cut_sites": cuts,
                "message": f"Need at least 2 {enzyme} recognition sites in the backbone for Golden Gate assembly.",
                "limitations": ["Reactions need two correctly oriented Type IIS sites; this prediction does not replace assembly validation."]}
    upstream, downstream = cuts[0]["overhang"], cuts[1]["overhang"]
    return {
        "success": True, "enzyme": enzyme,
        "overhangs": {"upstream": upstream, "downstream": downstream},
        "oligos": {"forward": upstream + insert,
                   "reverse": _reverse_complement(downstream) + _reverse_complement(insert),
                   "notes": [f"Forward oligo: add {upstream} to the 5' end of the insert.",
                             f"Reverse oligo: add {_reverse_complement(downstream)} to the 5' end of the reverse-complemented insert."]},
        "cut_sites": cuts, "position_basis": "0-based site starts on the supplied backbone",
        "limitations": ["Uses the first two Type IIS sites exactly as upstream does; which pair flanks the insertion locus must be confirmed by the designer.",
                        "The reverse oligo carries the reverse complement of the downstream overhang so golden_gate_assembly consumes this output directly; upstream's designer emitted the raw overhang, which its own assembler rejects.",
                        "Overhang identity and insert integrity require in-silico or experimental validation before ordering oligos."],
    }


def golden_gate_assembly(arguments):
    backbone = _dna(arguments.get("backbone_sequence"))
    enzyme = _type_iis(arguments)
    fragments = arguments.get("fragments")
    if not isinstance(fragments, list) or not 1 <= len(fragments) <= 20:
        raise ValueError("fragments must contain 1 to 20 entries.")
    for index, fragment in enumerate(fragments):
        if (not isinstance(fragment, dict)
                or not set(fragment) <= {"name", "sequence", "fwd_oligo", "rev_oligo"}
                or not ({"fwd_oligo", "rev_oligo"} <= set(fragment) or "sequence" in fragment)):
            raise ValueError(f"fragments[{index}] must contain a sequence, or both fwd_oligo and rev_oligo, plus an optional name.")
    circular = _boolean(arguments.get("circular", True), "circular")
    site, cut5, cut3 = _TYPE_IIS[enzyme]
    length, overhang_length = len(site), cut3 - cut5
    reverse_site = _reverse_complement(site)

    processed = []
    for index, fragment in enumerate(fragments):
        name = fragment.get("name") or f"fragment_{index + 1}"
        if "sequence" in fragment and not {"fwd_oligo", "rev_oligo"} <= set(fragment):
            sequence = _dna(fragment["sequence"], f"fragments[{index}].sequence")
            forward = [offset for offset in _site_starts(sequence, site)]
            reverse = [offset for offset in _site_starts(sequence, reverse_site)]
            if not forward or not reverse:
                return {"success": False, "assembled_sequence": None,
                        "message": f"Fragment '{name}' must contain one {enzyme} site in each orientation.",
                        "limitations": _GG_LIMITS}
            # Upstream geometry: the excised piece runs from the forward site's
            # outer cut to the reverse site's outer cut, so the insert excludes
            # both overhang regions.
            forward_cut = forward[0] + cut3
            reverse_cut = reverse[-1] - (cut3 - length)
            if forward_cut >= reverse_cut:
                return {"success": False, "assembled_sequence": None,
                        "message": f"Invalid restriction-site orientation in fragment '{name}': sites must excise the insert.",
                        "limitations": _GG_LIMITS}
            insert = sequence[forward_cut:reverse_cut]
            forward_overhang = sequence[forward_cut - overhang_length:forward_cut]
            reverse_overhang = _reverse_complement(sequence[reverse_cut:reverse_cut + overhang_length])
            processed.append({"name": name, "fwd_oligo": forward_overhang + insert,
                              "rev_oligo": reverse_overhang + _reverse_complement(insert)})
        else:
            processed.append({"name": name,
                              "fwd_oligo": _dna(fragment["fwd_oligo"], f"fragments[{index}].fwd_oligo"),
                              "rev_oligo": _dna(fragment["rev_oligo"], f"fragments[{index}].rev_oligo")})

    cuts = _iis_cuts(backbone, enzyme, circular)
    if not cuts:
        return {"success": False, "assembled_sequence": None,
                "message": f"No {enzyme} recognition sites found in the backbone.", "limitations": _GG_LIMITS}
    overhangs = [{"name": fragment["name"], "fwd_overhang": fragment["fwd_oligo"][:overhang_length],
                  "insert": fragment["fwd_oligo"][overhang_length:],
                  "rc_rev_overhang": _reverse_complement(fragment["rev_oligo"][:overhang_length])}
                 for fragment in processed]
    by_forward = {item["fwd_overhang"]: index for index, item in enumerate(overhangs)}
    starts = [(cut_index, by_forward[cut["overhang"]]) for cut_index, cut in enumerate(cuts) if cut["overhang"] in by_forward]
    for start_cut, start_fragment in starts:
        chain, current = [start_fragment], start_fragment
        while True:
            next_overhang = overhangs[current]["rc_rev_overhang"]
            nxt = next((index for index, item in enumerate(overhangs)
                        if index != current and item["fwd_overhang"] == next_overhang), None)
            if nxt is None or len(chain) >= len(overhangs):
                break
            chain.append(nxt)
            current = nxt
        if len(chain) != len(overhangs):
            continue
        last = overhangs[chain[-1]]
        end_cut_index = next((index for index, cut in enumerate(cuts)
                              if cut["overhang"] == last["rc_rev_overhang"] and index != start_cut), None)
        if end_cut_index is None:
            continue
        start_site, end_site = cuts[start_cut], cuts[end_cut_index]
        if circular:
            if end_site["cut_rev"] <= start_site["cut_fwd"]:
                segment = backbone[end_site["cut_rev"]:start_site["cut_fwd"]]
            else:
                segment = backbone[end_site["cut_rev"]:] + backbone[:start_site["cut_fwd"]]
        else:
            segment = (backbone[:min(start_site["cut_fwd"], end_site["cut_rev"])] +
                       backbone[max(start_site["cut_fwd"], end_site["cut_rev"]):])
        insert_segment = "".join(overhangs[index]["fwd_overhang"] + overhangs[index]["insert"] + overhangs[index]["rc_rev_overhang"]
                                 for index in chain)
        return {"success": True, "assembled_sequence": segment + insert_segment,
                "message": f"Assembled {len(overhangs)} fragment(s).",
                "assembly_order": [overhangs[index]["name"] for index in chain],
                "backbone_segment_length": len(segment), "cut_sites": cuts,
                "position_basis": "0-based cut indices on the supplied backbone", "limitations": _GG_LIMITS}
    return {"success": False, "assembled_sequence": None,
            "message": "Could not find a valid assembly path; fragment overhangs may not form a complete circuit.",
            "limitations": _GG_LIMITS}


_GG_LIMITS = ["Overhang chaining uses fixed-length Type IIS overhangs with unique matching; repeated identical overhangs are not resolved.",
              "The first complete circuit found is returned; alternative assemblies are not enumerated. Validate the construct before synthesis."]


def optimize_codons_for_heterologous_expression(arguments):
    sequence = _dna(arguments.get("sequence"))
    supplied = arguments.get("host_codon_usage")
    if not isinstance(supplied, list) or not 1 <= len(supplied) <= 64:
        raise ValueError("host_codon_usage must contain 1 to 64 {codon, frequency} entries.")
    usage = {}
    for index, entry in enumerate(supplied):
        if not isinstance(entry, dict) or set(entry) != {"codon", "frequency"}:
            raise ValueError(f"host_codon_usage[{index}] must contain exactly codon and frequency.")
        codon = entry["codon"]
        if not isinstance(codon, str) or len(codon) != 3 or not set(codon.upper()) <= set("ACGT"):
            raise ValueError(f"host_codon_usage[{index}].codon must be a DNA triplet.")
        codon = codon.upper()
        if codon in usage:
            raise ValueError(f"Duplicate codon {codon} in host_codon_usage.")
        usage[codon] = _number(entry["frequency"], f"host_codon_usage[{index}].frequency", minimum=0)
    best_for_amino = {}
    for codon, amino in _CODONS.items():
        frequency = usage.get(codon, 0.0)
        incumbent = best_for_amino.get(amino)
        if incumbent is None or frequency > incumbent[1] or (frequency == incumbent[1] and codon < incumbent[0]):
            best_for_amino[amino] = (codon, frequency)
    codons = [sequence[index:index + 3] for index in range(0, len(sequence) - len(sequence) % 3, 3)]
    optimized, changes, unrecognized = [], 0, 0
    for codon in codons:
        amino = _CODONS.get(codon)
        if amino is None:
            optimized.append(codon)
            unrecognized += 1
            continue
        replacement, frequency = best_for_amino[amino]
        optimized.append(replacement if frequency > 0 else codon)
        changes += optimized[-1] != codon
    untranslatable_tail = sequence[len(codons) * 3:]
    return {
        "length_nt": len(sequence), "codon_count": len(codons),
        "partial_codon_tail": untranslatable_tail or None, "unrecognized_codons": unrecognized,
        "codons_changed": changes, "percent_changed": round(100 * changes / len(codons), 2) if codons else 0.0,
        "optimized_sequence": "".join(optimized),
        "amino_acid_sequence": "".join(_CODONS[codon] if codon in _CODONS else "X" for codon in codons).rstrip("*"),
        "method": "Highest-host-frequency synonymous codon per amino acid (standard genetic code)",
        "limitations": ["Greedy per-codon maximization of host usage frequency; CAI, GC balance, mRNA structure, and motif avoidance are not optimized.",
                        "Codons absent from host_codon_usage count as zero frequency; the standard genetic code is assumed.",
                        "Codon usage tables are host-specific; validate the source table before relying on the output."],
    }


def design_sgrna_spacers(arguments):
    """Proto-native spacer scan; upstream queries a precomputed knockout library."""
    sequence = _dna(arguments.get("sequence"))
    pam = arguments.get("pam", "NGG")
    if not isinstance(pam, str) or not 3 <= len(pam) <= 6 or not set(pam.upper()) <= set("ACGTN"):
        raise ValueError("pam must be 3 to 6 bases using A, C, G, T, and N.")
    pam = pam.upper()
    spacer_length = _integer(arguments.get("spacer_length", 20), "spacer_length", 17, 25)
    min_gc = _number(arguments.get("min_gc", 0.2), "min_gc", minimum=0, maximum=1)
    max_gc = _number(arguments.get("max_gc", 0.8), "max_gc", minimum=0, maximum=1)
    if min_gc >= max_gc:
        raise ValueError("min_gc must be below max_gc.")
    pam_pattern = re.compile("".join(f"[{_IUPAC[base]}]" for base in pam))
    guides = []

    def scan(target, strand):
        for match in pam_pattern.finditer(target):
            spacer_start = match.start() - spacer_length
            if spacer_start < 0:
                continue
            spacer = target[spacer_start:match.start()]
            gc = (spacer.count("G") + spacer.count("C")) / spacer_length
            if min_gc <= gc <= max_gc:
                guides.append({"spacer": spacer, "strand": strand, "pam": match.group(),
                               "spacer_start": spacer_start if strand == "+" else len(sequence) - match.end(),
                               "gc_content": round(gc, 3)})

    scan(sequence, "+")
    scan(_reverse_complement(sequence), "-")
    guides.sort(key=lambda guide: (guide["spacer_start"], guide["strand"]))
    return {
        "length": len(sequence), "pam": pam, "spacer_length": spacer_length, "count": len(guides),
        "guides": guides[:500], "returned": min(len(guides), 500), "truncated": len(guides) > 500,
        "position_basis": "0-based spacer start on the strand carrying the PAM",
        "method": "Exhaustive PAM scan with GC bounds",
        "limitations": ["Predicts candidate spacers by motif and GC only; on-target activity, off-targets, and chromatin effects are not evaluated.",
                        "Assumes an N20-PAM architecture (SpCas9-like); other nucleases need a different scan."],
    }


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


_SEQUENCE_SCHEMA = {"type": "string", "minLength": 1, "maxLength": 20000}
_ENZYME_LIST_SCHEMA = {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 20}, "minItems": 1, "maxItems": 50}
_PRIMER_ITEM_SCHEMA = _schema({"name": {"type": "string", "minLength": 1, "maxLength": 100}, "sequence": _SEQUENCE_SCHEMA}, ["sequence"])
_CODON_USAGE_SCHEMA = {"type": "array", "minItems": 1, "maxItems": 64,
                       "items": _schema({"codon": {"type": "string", "minLength": 3, "maxLength": 3},
                                         "frequency": {"type": "number", "minimum": 0, "maximum": 1e100}}, ["codon", "frequency"])}
_USAGE_EXAMPLE = [{"codon": "ATG", "frequency": 0.9}, {"codon": "GGC", "frequency": 0.8}, {"codon": "GGA", "frequency": 0.1},
                  {"codon": "TTC", "frequency": 0.7}, {"codon": "TTT", "frequency": 0.3}, {"codon": "AAA", "frequency": 0.75},
                  {"codon": "AAG", "frequency": 0.25}, {"codon": "TAC", "frequency": 0.6}, {"codon": "TAT", "frequency": 0.4}]


def _tool(title, description, schema, example, path, function, *, native=False):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": [], "implementation": "proto-native" if native else "biomni-adapted",
            "upstream_functions": [{"path": path, "name": function}]}


TOOLS = {
    "annotate_open_reading_frames": _tool(
        "Open reading frame annotation", "Find ATG-to-stop ORFs across reading frames with an embedded standard codon table; not evidence of translation.",
        _schema({"sequence": _SEQUENCE_SCHEMA, "min_length_nt": {"type": "integer", "minimum": 3, "maximum": 20000, "default": 30},
                 "search_reverse": {"type": "boolean", "default": False}, "filter_subsets": {"type": "boolean", "default": False}}, ["sequence"]),
        {"sequence": "ATGGCGAAATAA", "min_length_nt": 9}, "biomni/tool/molecular_biology.py", "annotate_open_reading_frames"),
    "align_sequences": _tool(
        "Primer-to-target alignment", "Scan short sequences against a longer target on both strands allowing up to three substitutions per window.",
        _schema({"target_sequence": _SEQUENCE_SCHEMA,
                 "primer_sequences": {"type": "array", "items": _SEQUENCE_SCHEMA, "minItems": 1, "maxItems": 50},
                 "max_mismatches": {"type": "integer", "minimum": 0, "maximum": 3, "default": 1}}, ["target_sequence", "primer_sequences"]),
        {"target_sequence": "ATGGCGAAATAAGCGTTAG", "primer_sequences": ["ATGGCGAAAT", "CTAACGCTTA"]},
        "biomni/tool/molecular_biology.py", "align_sequences"),
    "pcr_simple": _tool(
        "PCR amplification simulation", "Predict amplicons from a template and primer pair, including circular wrap-around products.",
        _schema({"sequence": _SEQUENCE_SCHEMA, "forward_primer": _SEQUENCE_SCHEMA, "reverse_primer": _SEQUENCE_SCHEMA,
                 "circular": {"type": "boolean", "default": False},
                 "max_mismatches": {"type": "integer", "minimum": 0, "maximum": 3, "default": 1}},
                ["sequence", "forward_primer", "reverse_primer"]),
        {"sequence": "TTTATGGCGAAATAAGCGTTAGCCCGGGAAA", "forward_primer": "ATGGCGAAAT", "reverse_primer": "TTTCCCGGG"},
        "biomni/tool/molecular_biology.py", "pcr_simple"),
    "digest_sequence": _tool(
        "Restriction digest simulation", "Compute digestion fragments from a curated enzyme table with explicit cut offsets; linear or circular topology.",
        _schema({"sequence": _SEQUENCE_SCHEMA, "enzymes": _ENZYME_LIST_SCHEMA, "circular": {"type": "boolean", "default": True}},
                ["sequence", "enzymes"]),
        {"sequence": "GAATTCATGGCGAAATAAGAATTCC", "enzymes": ["EcoRI"], "circular": False},
        "biomni/tool/molecular_biology.py", "digest_sequence"),
    "find_restriction_sites": _tool(
        "Restriction site mapping", "Report recognition sequences, cut offsets, overhang type, and top-strand cut indices per requested enzyme.",
        _schema({"sequence": _SEQUENCE_SCHEMA, "enzymes": _ENZYME_LIST_SCHEMA, "circular": {"type": "boolean", "default": True}},
                ["sequence", "enzymes"]),
        {"sequence": "GAATTCGGATCCC", "enzymes": ["EcoRI", "BamHI"], "circular": False},
        "biomni/tool/molecular_biology.py", "find_restriction_sites"),
    "find_restriction_enzymes": _tool(
        "Common-enzyme site scan", "Scan the curated common-enzyme table and list every enzyme with at least one cut site in the sequence.",
        _schema({"sequence": _SEQUENCE_SCHEMA, "circular": {"type": "boolean", "default": False}}, ["sequence"]),
        {"sequence": "GAATTCGGATCCCAGCTT", "circular": False}, "biomni/tool/molecular_biology.py", "find_restriction_enzymes"),
    "find_sequence_mutations": _tool(
        "Aligned-sequence mutation list", "List substitutions between a query and reference as RefPosQuery labels; inputs must be prealigned.",
        _schema({"query_sequence": _SEQUENCE_SCHEMA, "reference_sequence": _SEQUENCE_SCHEMA,
                 "query_start": {"type": "integer", "minimum": 1, "maximum": 1000000000, "default": 1}},
                ["query_sequence", "reference_sequence"]),
        {"query_sequence": "ACGTACGT", "reference_sequence": "ACGGACGT", "query_start": 1},
        "biomni/tool/molecular_biology.py", "find_sequence_mutations"),
    "design_primer": _tool(
        "Single primer designer", "Choose the best-scoring primer in a window by GC content and Wallace-rule Tm.",
        _schema({"sequence": _SEQUENCE_SCHEMA, "start": {"type": "integer", "minimum": 0, "maximum": 19999},
                 "primer_length": {"type": "integer", "minimum": 12, "maximum": 40, "default": 20},
                 "min_gc": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.4},
                 "max_gc": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.6},
                 "min_tm": {"type": "number", "minimum": 0, "maximum": 200, "default": 55},
                 "max_tm": {"type": "number", "minimum": 0, "maximum": 200, "default": 65},
                 "search_window": {"type": "integer", "minimum": 12, "maximum": 2000, "default": 100}}, ["sequence", "start"]),
        {"sequence": "ATGGCGAAATAAGCGTTAGCCCGGGAAATTG", "start": 0}, "biomni/tool/molecular_biology.py", "design_primer"),
    "design_verification_primers": _tool(
        "Sanger verification primer plan", "Cover a target region greedily with existing primers plus newly designed walkers using a fixed read length.",
        _schema({"plasmid_sequence": _SEQUENCE_SCHEMA,
                 "target_region": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 19999}, "minItems": 2, "maxItems": 2},
                 "existing_primers": {"type": "array", "maxItems": 50, "items": _PRIMER_ITEM_SCHEMA},
                 "circular": {"type": "boolean", "default": True},
                 "coverage_length": {"type": "integer", "minimum": 20, "maximum": 2000, "default": 800},
                 "primer_length": {"type": "integer", "minimum": 12, "maximum": 40, "default": 20},
                 "min_gc": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.4},
                 "max_gc": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.6},
                 "min_tm": {"type": "number", "minimum": 0, "maximum": 200, "default": 55},
                 "max_tm": {"type": "number", "minimum": 0, "maximum": 200, "default": 65}},
                ["plasmid_sequence", "target_region"]),
        {"plasmid_sequence": "TTTATGGCGAAATAAGCGTTAGCCCGGGAAATTGGATCCACGTACGTTTATGGCGAAATAAGCGTTAGCCCGGGAAATTGGATCCACGTACG",
         "target_region": [5, 60], "existing_primers": [{"name": "M13F", "sequence": "GTAAAACGACGGCCAG"}], "coverage_length": 30},
        "biomni/tool/molecular_biology.py", "design_verification_primers"),
    "design_golden_gate_oligos": _tool(
        "Golden Gate oligo designer", "Derive insert oligos carrying the backbone's Type IIS overhangs for a supported enzyme.",
        _schema({"backbone_sequence": _SEQUENCE_SCHEMA, "insert_sequence": _SEQUENCE_SCHEMA,
                 "enzyme": {"type": "string", "enum": ["BsaI", "BsmBI", "Esp3I", "BbsI", "BtgZI", "SapI"]},
                 "circular": {"type": "boolean", "default": True}}, ["backbone_sequence", "insert_sequence", "enzyme"]),
        {"backbone_sequence": "GGTCTCAACCGGTGACGGTCTCG", "insert_sequence": "ATGGCGAAATAA", "enzyme": "BsaI", "circular": True},
        "biomni/tool/molecular_biology.py", "design_golden_gate_oligos"),
    "golden_gate_assembly": _tool(
        "Golden Gate assembly prediction", "Chain fragment overhangs through two backbone Type IIS cuts and report the predicted construct sequence.",
        _schema({"backbone_sequence": _SEQUENCE_SCHEMA,
                 "enzyme": {"type": "string", "enum": ["BsaI", "BsmBI", "Esp3I", "BbsI", "BtgZI", "SapI"]},
                 "fragments": {"type": "array", "minItems": 1, "maxItems": 20, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100}, "sequence": _SEQUENCE_SCHEMA,
                      "fwd_oligo": _SEQUENCE_SCHEMA, "rev_oligo": _SEQUENCE_SCHEMA}, [])},
                 "circular": {"type": "boolean", "default": True}}, ["backbone_sequence", "enzyme", "fragments"]),
        {"backbone_sequence": "GGTCTCAACCGGTGACGGTCTCG", "enzyme": "BsaI",
         "fragments": [{"name": "reporter_insert", "fwd_oligo": "AACCATGGCGAAATAA", "rev_oligo": "GGCCATTTACGCCAT"}], "circular": True},
        "biomni/tool/molecular_biology.py", "golden_gate_assembly"),
    "optimize_codons_for_heterologous_expression": _tool(
        "Codon usage optimization", "Replace each codon with the highest-host-frequency synonym under the standard genetic code and return the optimized sequence.",
        _schema({"sequence": _SEQUENCE_SCHEMA, "host_codon_usage": _CODON_USAGE_SCHEMA}, ["sequence", "host_codon_usage"]),
        {"sequence": "ATGGCGAAATAA", "host_codon_usage": _USAGE_EXAMPLE},
        "biomni/tool/synthetic_biology.py", "optimize_codons_for_heterologous_expression"),
    "design_sgrna_spacers": _tool(
        "sgRNA spacer scan", "Find candidate 17-25 nt spacers upstream of a supplied PAM (default NGG) on both strands with GC bounds; no activity prediction.",
        _schema({"sequence": _SEQUENCE_SCHEMA, "pam": {"type": "string", "minLength": 3, "maxLength": 6, "default": "NGG"},
                 "spacer_length": {"type": "integer", "minimum": 17, "maximum": 25, "default": 20},
                 "min_gc": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.2},
                 "max_gc": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.8}}, ["sequence"]),
        {"sequence": "CACCATGGCGAAATAAGCGTTAGGGTG", "pam": "NGG"},
        "biomni/tool/molecular_biology.py", "design_knockout_sgrna", native=True),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
