"""Bounded, offline flow-cytometry analyses adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: a self-contained pure-Python FCS 2.0/3.0/3.1 reader replaces
FlowCytometryTools (whose gate() calls become boolean masks), JSON request
arguments replace file-path orchestration over output directories, results are
structured with limitation notes, and upstream's silent mock-data fallback in
the CFSE tool is removed (fail closed instead). Gating thresholds and channel
heuristics are transcribed from upstream.
"""

from __future__ import annotations

import struct


def _parse_fcs(data: bytes) -> dict:
    """Parse FCS 2.0/3.0/3.1 bytes into {channel_name: [values]} arrays."""
    if len(data) < 58 or not data.startswith(b"FCS"):
        raise ValueError("Not an FCS file: the header signature is missing.")
    version = data[3:8].decode("ascii", "replace").strip(". \x00")
    try:
        text_start, text_end = int(data[10:18]), int(data[18:26])
    except ValueError:
        raise ValueError("Corrupt FCS header: TEXT segment offsets are not numeric.") from None
    if not 0 < text_start <= text_end < len(data):
        raise ValueError("Corrupt FCS header: TEXT segment offsets fall outside the file.")
    text_segment = data[text_start:text_end + 1]
    delimiter = text_segment[:1]
    if delimiter.isalnum():
        raise ValueError("Unsupported FCS TEXT delimiter.")
    pairs = [part for part in text_segment.split(delimiter) if part]
    keywords = {}
    for index in range(0, len(pairs) - 1, 2):
        key = pairs[index].decode("latin-1").strip().strip("$").lower()
        keywords[key] = pairs[index + 1].decode("latin-1").strip()
    datatype = keywords.get("datatype", "").lower()
    if datatype not in ("f", "d", "i"):
        raise ValueError(f"Unsupported FCS $DATATYPE {datatype!r}; only binary F/D/I segments parse.")
    begin = int(keywords.get("begindata", 0) or 0)
    end = int(keywords.get("enddata", 0) or 0)
    if not begin:
        begin = int(data[34:42])
    if not end:
        end = int(data[42:50])
    if not 0 <= begin <= end < len(data):
        raise ValueError("Corrupt FCS DATA segment offsets.")
    byteord = keywords.get("byteord", "4,3,2,1")
    prefix = ">" if byteord.replace(" ", "").startswith("1,") else "<"
    channels, widths, offset = [], [], 0
    index = 1
    while True:
        name = keywords.get(f"p{index}n")
        if name is None:
            break
        bits = int(keywords.get(f"p{index}b", "32") or "32")
        if bits % 8 or bits // 8 not in (2, 4, 8):
            raise ValueError(f"Unsupported channel width {bits} bits for {name}.")
        channels.append(name)
        widths.append(bits // 8)
        offset += bits // 8
        index += 1
    if not channels:
        raise ValueError("The FCS file declares no parameter channels.")
    segment = data[begin:end + 1]
    record_bytes = sum(widths)
    if record_bytes == 0 or len(segment) % record_bytes:
        raise ValueError("FCS DATA segment length is not a whole number of events.")
    events = len(segment) // record_bytes
    if events > 2_000_000:
        raise ValueError("FCS file exceeds the two-million-event offline limit.")
    format_character = {"f": "f", "d": "d", "i": "i"}[datatype]
    result = {}
    for column, (name, width) in enumerate(zip(channels, widths)):
        if format_character == "i":
            code = {2: "h", 4: "i", 8: "q"}[width]
        elif format_character == "f":
            code = {4: "f", 8: "d"}[width]
        else:
            code = "d"
        values = []
        for event in range(events):
            base = event * record_bytes + sum(widths[:column])
            values.append(struct.unpack_from(prefix + code, segment, base)[0])
        result[name] = values
    return {"version": version, "events": events, "channels": result}


def _fcs(arguments, files, field="fcs_path"):
    supplied = files.get(field)
    if supplied is None:
        raise ValueError(f"{field} must reference an FCS file inside the workspace.")
    parsed = _parse_fcs(supplied)
    if not parsed["events"]:
        raise ValueError("The FCS file contains zero events.")
    return parsed


def _channel(sample, name, purpose):
    channels = sample["channels"]
    if name in channels:
        return name
    matches = [candidate for candidate in channels if name.lower() in candidate.lower()]
    if len(matches) == 1:
        return matches[0]
    raise ValueError(f"Could not resolve the {purpose} channel {name!r}; available: {', '.join(channels)}.")


def _gate(channels, mask, expression):
    """Apply one {marker, operator, threshold} gate to a boolean mask."""
    marker, operator = expression["marker"], expression["operator"]
    if marker not in channels:
        raise ValueError(f"Unknown gate marker {marker!r}; available: {', '.join(channels)}.")
    column = channels[marker]
    if operator == ">":
        return [keep and value > expression["threshold"] for keep, value in zip(mask, column)]
    if operator == "<":
        return [keep and value < expression["threshold"] for keep, value in zip(mask, column)]
    if operator == "between":
        low, high = expression["bounds"]
        return [keep and low <= value <= high for keep, value in zip(mask, column)]
    raise ValueError(f"Unsupported gate operator {operator!r}; use '>', '<', or 'between'.")


def analyze_flow_cytometry_immunophenotyping(arguments, files):
    sample = _fcs(arguments, files)
    strategy = arguments.get("populations")
    if not isinstance(strategy, list) or not 1 <= len(strategy) <= 50:
        raise ValueError("populations must contain 1 to 50 named gating strategies.")
    total = sample["events"]
    results = []
    for index, population in enumerate(strategy):
        if not isinstance(population, dict) or set(population) != {"name", "gates"} or not isinstance(population["gates"], list):
            raise ValueError(f"populations[{index}] must contain name and gates.")
        name = population["name"]
        if not isinstance(name, str) or not 1 <= len(name) <= 100:
            raise ValueError(f"populations[{index}].name must be a nonempty string.")
        mask = [True] * total
        trace = []
        for gate_index, gate in enumerate(population["gates"]):
            if not isinstance(gate, dict) or "marker" not in gate or gate.get("operator") not in (">", "<", "between"):
                raise ValueError(f"populations[{index}].gates[{gate_index}] must contain marker and a supported operator.")
            if gate["operator"] == "between" and (not isinstance(gate.get("bounds"), list) or len(gate["bounds"]) != 2):
                raise ValueError(f"populations[{index}].gates[{gate_index}] needs numeric bounds for 'between'.")
            before = sum(mask)
            mask = _gate(sample["channels"], mask, gate)
            trace.append({"marker": gate["marker"], "operator": gate["operator"], "threshold": gate.get("threshold"),
                          "bounds": gate.get("bounds"), "events_before": before, "events_after": sum(mask)})
        count = sum(mask)
        results.append({"name": name, "events": count, "percent_of_total": round(count / total * 100, 6),
                        "gate_trace": trace})
    return {
        "total_events": total, "channels": list(sample["channels"]), "populations": results,
        "method": "Sequential single-marker threshold gating transcribed from upstream (masks replace FCMeasurement.gate)",
        "limitations": ["Thresholds are caller-supplied; no compensation, transformation, or FMO controls are applied.",
                        "Gates apply strictly in the listed order; overlapping populations are counted independently."],
    }


def analyze_cfse_cell_proliferation(arguments, files):
    """Upstream's histogram-peak generation quantification; mock fallback removed."""
    import math

    sample = _fcs(arguments, files)
    cfse_channel = _channel(sample, arguments.get("cfse_channel", "FITC-A"), "CFSE intensity")
    lymphocyte_gate = arguments.get("lymphocyte_gate")
    channels = sample["channels"]
    if lymphocyte_gate is not None:
        if (not isinstance(lymphocyte_gate, list) or len(lymphocyte_gate) != 4):
            raise ValueError("lymphocyte_gate must be [min_fsc, max_fsc, min_ssc, max_ssc].")
        mask = _gate(channels, [True] * sample["events"], {"marker": _channel(sample, "FSC-A", "forward scatter"), "operator": "between", "bounds": [lymphocyte_gate[0], lymphocyte_gate[1]]})
        mask = _gate(channels, mask, {"marker": _channel(sample, "SSC-A", "side scatter"), "operator": "between", "bounds": [lymphocyte_gate[2], lymphocyte_gate[3]]})
    else:
        fsc = channels[_channel(sample, "FSC-A", "forward scatter")]
        ssc = channels[_channel(sample, "SSC-A", "side scatter")]
        fsc_median = sorted(fsc)[len(fsc) // 2]
        ssc_median = sorted(ssc)[len(ssc) // 2]
        mask = _gate(channels, [True] * sample["events"], {"marker": _channel(sample, "FSC-A", "forward scatter"), "operator": "between", "bounds": [fsc_median * 0.5, fsc_median * 1.8]})
        mask = _gate(channels, mask, {"marker": _channel(sample, "SSC-A", "side scatter"), "operator": "between", "bounds": [ssc_median * 0.5, ssc_median * 1.8]})
    cfse = [value for value, keep in zip(channels[cfse_channel], mask) if keep]
    gated = len(cfse)
    if gated < 50:
        raise ValueError("Fewer than 50 events survive gating; CFSE peaks cannot be identified.")
    log_cfse = [math.log10(value + 1) for value in cfse]
    low, high = min(log_cfse), max(log_cfse)
    if high - low < 0.1:
        raise ValueError("CFSE intensity variation is too small for peak detection.")
    bins = 100
    counts = [0] * bins
    for value in log_cfse:
        index = min(bins - 1, int((value - low) / (high - low) * bins))
        counts[index] += 1
    # Three-bin moving average before local-maximum detection: upstream's raw
    # neighbor comparison fires on single-bin noise inside each mode.
    smoothed = [counts[0] + counts[1]] + [counts[i - 1] + counts[i] + counts[i + 1] for i in range(1, bins - 1)] + [counts[-2] + counts[-1]]
    floor = max(5, gated // 200)
    candidates = [index for index in range(1, bins - 1)
                  if smoothed[index] > smoothed[index - 1] and smoothed[index] > smoothed[index + 1] and counts[index] >= floor]
    # Keep the strongest peak per cluster: CFSE generations are ~log10(2)=0.30
    # apart, so peaks closer than 0.15 log units are noise on one mode.
    width = (high - low) / bins
    accepted = []
    for index in sorted(candidates, key=lambda i: -counts[i]):
        if all(abs(index - other) * width >= 0.15 for other in accepted):
            accepted.append(index)
    peaks = sorted(accepted)
    peak_positions = sorted((low + (index + 0.5) * (high - low) / bins for index in peaks), reverse=True)
    if not peak_positions:
        return {"gated_events": gated, "generations": None, "division_index": 0.0, "percent_proliferating": 0.0,
                "message": "No distinct peaks found in the CFSE intensity distribution.",
                "limitations": _CFSE_LIMITS}
    undivided = peak_positions[0]
    if len(peak_positions) == 1:
        threshold = 10 ** (undivided - 0.3)
        proliferating = sum(value < threshold for value in cfse)
        return {"gated_events": gated, "peaks_log10": [round(position, 6) for position in peak_positions],
                "generations": None, "division_index": round(proliferating / gated, 6),
                "percent_proliferating": round(proliferating / gated * 100, 6),
                "message": "Single peak detected; upstream's 0.3-log threshold estimation applied.",
                "limitations": _CFSE_LIMITS}
    boundaries = [(peak_positions[i] + peak_positions[i + 1]) / 2 for i in range(len(peak_positions) - 1)]
    boundaries.append(peak_positions[-1] - (peak_positions[-2] - peak_positions[-1]))
    generation_counts = [sum(value >= 10 ** peak_positions[0] for value in cfse)]
    for index in range(len(boundaries) - 1):
        generation_counts.append(sum(10 ** boundaries[index + 1] <= value < 10 ** boundaries[index] for value in cfse))
    generation_counts.append(sum(value < 10 ** boundaries[-1] for value in cfse))
    total = sum(generation_counts)
    division_index = sum(index * count for index, count in enumerate(generation_counts)) / total
    return {"gated_events": gated, "peaks_log10": [round(position, 6) for position in peak_positions],
            "generation_counts": generation_counts, "generation_boundaries": [round(10 ** boundary, 4) for boundary in boundaries],
            "division_index": round(division_index, 6),
            "percent_proliferating": round(sum(generation_counts[1:]) / total * 100, 6),
            "limitations": _CFSE_LIMITS}


_CFSE_LIMITS = ["Generation boundaries come from upstream's midpoint-between-log-peaks heuristic, not a deconvolution fit; events falling in the gaps between boundary bands are dropped exactly as upstream drops them.",
                "Peak detection smooths the log-intensity histogram over three bins and keeps one peak per 0.15-log cluster; upstream's raw neighbor test fires on single-bin noise.",
                "The automatic FSC/SSC gate uses upstream's median-ratio rectangle; validate against your cytometer's lymphocyte gate.",
                "Upstream silently substituted simulated data when FlowCytometryTools failed; this port fails closed instead.",
                "Division index weights generations by the fixed halving-intensity spacing; overlapping peaks bias counts."]


def analyze_cytokine_production_in_cd4_tcells(arguments, files):
    sample = _fcs(arguments, files)
    cd4_threshold = _number(arguments.get("cd4_threshold", 1000), "cd4_threshold")
    cytokine_threshold = _number(arguments.get("cytokine_threshold", 500), "cytokine_threshold")
    channels = sample["channels"]
    cd4_channel = _channel(sample, arguments.get("cd4_channel", "CD4"), "CD4")
    cytokine_channels = [name for name in channels if "IFN" in name.upper() or "IL-17" in name.upper() or "IL17" in name.upper()]
    if not cytokine_channels:
        raise ValueError("No IFN-gamma or IL-17 channels found; name cytokine channels accordingly (for example 'IFN-G APC').")
    mask = _gate(channels, [True] * sample["events"], {"marker": cd4_channel, "operator": ">", "threshold": cd4_threshold})
    cd4_positive = sum(mask)
    if cd4_positive == 0:
        raise ValueError("No events pass the CD4 gate; adjust cd4_threshold.")
    frequencies = {}
    for channel in cytokine_channels:
        label = "IFN-gamma" if "IFN" in channel.upper() else "IL-17"
        positive = sum(value > cytokine_threshold for value, keep in zip(channels[channel], mask) if keep)
        frequencies.setdefault(label, round(positive / cd4_positive * 100, 6))
    return {
        "total_events": sample["events"], "cd4_channel": cd4_channel, "cd4_positive_events": cd4_positive,
        "cd4_threshold": cd4_threshold, "cytokine_channels": cytokine_channels,
        "cytokine_threshold": cytokine_threshold,
        "frequencies_percent_of_cd4_positive": frequencies,
        "method": "Upstream CD4+ threshold gating with per-cytokine single-threshold positivity, from the supplied FCS file",
        "limitations": ["Thresholds are caller-supplied constants (upstream defaults 1000/500); no compensation or logicle transform is applied.",
                        "Multiple matching channels collapse onto one cytokine label; rename channels to disambiguate.",
                        "Frequencies are percentages of CD4+ events, not of all live singlets."],
    }


def analyze_cell_senescence_and_apoptosis(arguments, files):
    """Upstream percentile-threshold senescence/apoptosis quantification."""
    sample = _fcs(arguments, files)
    channels = sample["channels"]
    fsc_channel = _channel(sample, "FSC-A", "forward scatter")
    ssc_channel = _channel(sample, "SSC-A", "side scatter")
    debris_fsc = _number(arguments.get("debris_fsc_threshold", 10000), "debris_fsc_threshold")
    debris_ssc = _number(arguments.get("debris_ssc_threshold", 5000), "debris_ssc_threshold")
    mask = _gate(channels, [True] * sample["events"], {"marker": fsc_channel, "operator": ">", "threshold": debris_fsc})
    mask = _gate(channels, mask, {"marker": ssc_channel, "operator": ">", "threshold": debris_ssc})
    analyzed = sum(mask)
    if analyzed < 50:
        raise ValueError("Fewer than 50 events survive debris gating; adjust the debris thresholds.")

    def pick(substring_keywords, purpose, fallback_index):
        for name in channels:
            if any(keyword in name.upper() for keyword in substring_keywords):
                return name
        fluorescent = [name for name in channels if any(token in name.upper() for token in ("FL", "BL", "FITC", "PE", "APC", "PERCP"))]
        if len(fluorescent) > fallback_index:
            return fluorescent[fallback_index]
        raise ValueError(f"Could not identify a {purpose} channel; rename channels descriptively.")

    def percentile(channel, fraction):
        values = sorted(value for value, keep in zip(channels[channel], mask) if keep)
        return values[min(len(values) - 1, int(fraction * len(values)))]

    sa_channel = pick(("GAL", "FITC"), "SA-beta-Gal", 0)
    sa_threshold = percentile(sa_channel, 0.8)
    senescent = sum(value > sa_threshold for value, keep in zip(channels[sa_channel], mask) if keep)
    annexin_channel = pick(("ANNEXIN", "PE"), "Annexin V", 1)
    aad_channel = pick(("7AAD", "AAD", "PERCP"), "7-AAD", 2)
    annexin_threshold = percentile(annexin_channel, 0.9)
    aad_threshold = percentile(aad_channel, 0.9)
    early = late = 0
    for annexin, aad, keep in zip(channels[annexin_channel], channels[aad_channel], mask):
        if not keep:
            continue
        if annexin > annexin_threshold and aad < aad_threshold:
            early += 1
        elif annexin > annexin_threshold and aad > aad_threshold:
            late += 1
    return {
        "total_events": sample["events"], "analyzed_events": analyzed,
        "channels_used": {"sa_beta_gal": sa_channel, "annexin_v": annexin_channel, "seven_aad": aad_channel},
        "thresholds": {"sa_beta_gal_80th_percentile": round(sa_threshold, 4),
                       "annexin_90th_percentile": round(annexin_threshold, 4),
                       "seven_aad_90th_percentile": round(aad_threshold, 4)},
        "senescent_percent": round(senescent / analyzed * 100, 6),
        "early_apoptotic_percent": round(early / analyzed * 100, 6),
        "late_apoptotic_percent": round(late / analyzed * 100, 6),
        "total_apoptotic_percent": round((early + late) / analyzed * 100, 6),
        "method": "Upstream debris rectangle gate with 80th/90th-percentile positivity thresholds for SA-beta-Gal and Annexin V/7-AAD",
        "limitations": ["Percentile thresholds label a fixed fraction positive by construction (20%/10%); replace with FMO-derived thresholds for real quantification.",
                        "Channel identification is name-heuristic exactly as upstream; verify the resolved channel mapping before trusting outputs.",
                        "No compensation, viability dye, or doublet discrimination is applied."],
    }


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number.")
    return float(value)


_FCS_FILE = {"fcs_path": {"extensions": [".fcs"], "max_bytes": 64 * 1024 * 1024}}


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _tool(title, description, schema, example, path, function):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": [], "implementation": "biomni-adapted", "file_inputs": _FCS_FILE,
            "upstream_functions": [{"path": path, "name": function}]}


TOOLS = {
    "analyze_flow_cytometry_immunophenotyping": _tool(
        "Flow-cytometry immunophenotyping", "Apply sequential single-marker threshold gates from a workspace FCS file and report population counts and percentages.",
        _schema({"fcs_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "populations": {"type": "array", "minItems": 1, "maxItems": 50, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100},
                      "gates": {"type": "array", "minItems": 1, "maxItems": 20, "items": _schema(
                          {"marker": {"type": "string", "minLength": 1, "maxLength": 100},
                           "operator": {"type": "string", "enum": [">", "<", "between"]},
                           "threshold": {"type": "number"},
                           "bounds": {"type": "array", "minItems": 2, "maxItems": 2, "items": {"type": "number"}}},
                          ["marker", "operator"])}}, ["name", "gates"])}}, ["fcs_path", "populations"]),
        {"fcs_path": "build/compute-inputs/sample.fcs",
         "populations": [{"name": "cd3_positive", "gates": [{"marker": "FSC-A", "operator": ">", "threshold": 50000}, {"marker": "CD3", "operator": ">", "threshold": 2000}]}]},
        "biomni/tool/cell_biology.py", "analyze_flow_cytometry_immunophenotyping"),
    "analyze_cfse_cell_proliferation": _tool(
        "CFSE proliferation quantification", "Gate lymphocytes, find CFSE log-intensity peaks, and report generation counts, division index, and proliferating fraction.",
        _schema({"fcs_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "cfse_channel": {"type": "string", "maxLength": 100},
                 "lymphocyte_gate": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "number"}}},
                ["fcs_path"]),
        {"fcs_path": "build/compute-inputs/cfse.fcs", "cfse_channel": "FITC-A"},
        "biomni/tool/immunology.py", "analyze_cfse_cell_proliferation"),
    "analyze_cytokine_production_in_cd4_tcells": _tool(
        "CD4+ cytokine frequencies", "Threshold-gate CD4+ events and quantify IFN-gamma/IL-17 positive fractions from a workspace FCS file.",
        _schema({"fcs_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "cd4_channel": {"type": "string", "maxLength": 100},
                 "cd4_threshold": {"type": "number", "default": 1000},
                 "cytokine_threshold": {"type": "number", "default": 500}}, ["fcs_path"]),
        {"fcs_path": "build/compute-inputs/cytokines.fcs", "cd4_threshold": 1000, "cytokine_threshold": 500},
        "biomni/tool/immunology.py", "analyze_cytokine_production_in_cd4_tcells"),
    "analyze_cell_senescence_and_apoptosis": _tool(
        "Senescence and apoptosis flow analysis", "Debris-gate events and quantify SA-beta-Gal+ senescent and Annexin V/7-AAD apoptotic fractions with upstream percentile thresholds.",
        _schema({"fcs_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "debris_fsc_threshold": {"type": "number", "default": 10000},
                 "debris_ssc_threshold": {"type": "number", "default": 5000}}, ["fcs_path"]),
        {"fcs_path": "build/compute-inputs/senescence.fcs"},
        "biomni/tool/cancer_biology.py", "analyze_cell_senescence_and_apoptosis"),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
