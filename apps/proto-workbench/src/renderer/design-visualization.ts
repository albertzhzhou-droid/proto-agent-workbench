export type DesignDirection = -1 | 0 | 1;
export type DesignTopology = "linear" | "circular" | "unknown";
export type DesignDomain = "dna" | "protein";

export type DesignDiagnosticSeverity = "error" | "warning" | "info";

export interface DesignDiagnostic {
  severity: DesignDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
}

export type ConstraintValue = string | number | boolean | null;

export interface DesignConstraint {
  [key: string]: ConstraintValue;
}

export interface PartViewModel {
  id: string;
  name: string | null;
  type: string;
  sequence: string;
  start: number;
  end: number;
  designStart: number;
  designEnd: number;
  localStart: number;
  localEnd: number;
  length: number;
  gcFraction: number;
  gcPercent: number;
  direction: DesignDirection;
  color: string;
}

export interface FeatureSegmentViewModel {
  start: number;
  end: number;
  designStart: number;
  designEnd: number;
  length: number;
}

export interface FeatureViewModel {
  id: string;
  name: string | null;
  type: string;
  sequence: string;
  length: number;
  gcFraction: number;
  gcPercent: number;
  direction: DesignDirection;
  color: string;
  source: "part" | "annotation" | "software";
  segments: FeatureSegmentViewModel[];
  /** Original IR/source coordinates retained when a circular view is rotated. */
  sourceSegments?: FeatureSegmentViewModel[];
  wrapsOrigin: boolean;
  partIndex?: number;
}

export interface ConstructViewModel {
  name: string;
  topology: DesignTopology;
  sequence: string;
  /** Unrotated source sequence retained for view-only circular-origin changes. */
  sourceSequence?: string;
  /** Zero-based source base displayed as +1; absent/zero means source origin. */
  viewOrigin?: number;
  start: number;
  end: number;
  length: number;
  gcFraction: number;
  gcPercent: number;
  parts: PartViewModel[];
  features: FeatureViewModel[];
}

export interface ProteinMetricsViewModel {
  lengthAa?: number;
  molecularWeightDaApprox?: number;
  composition?: Record<string, number>;
  hydrophobicFraction?: number;
  chargedFraction?: number;
  ambiguousOrSpecialFraction?: number;
}

export interface ProteinViewModel {
  id: string;
  resourceId: string;
  name: string | null;
  sequence: string;
  sequenceSha256: string;
  description: string | null;
  descriptionZh: string | null;
  source: Record<string, string>;
  license: Record<string, string>;
  start: number;
  end: number;
  length: number;
  metrics: ProteinMetricsViewModel;
}

export type DesignPart = PartViewModel;
export type DesignFeature = FeatureViewModel;
export type DesignConstruct = ConstructViewModel;

export interface DesignViewModel {
  schemaVersion: "proto-agent.ir.v1";
  domain: DesignDomain;
  designId: string;
  chassis: string;
  source: string;
  sequence: string;
  start: 0;
  end: number;
  length: number;
  gcFraction: number;
  gcPercent: number;
  constructs: ConstructViewModel[];
  proteins: ProteinViewModel[];
  constraints: DesignConstraint[];
}

export interface DesignParseResult {
  ok: boolean;
  design?: DesignViewModel;
  diagnostics: DesignDiagnostic[];
}

export type DesignSearchField = "design" | "construct" | "part" | "annotation" | "type" | "sequence";

export interface DesignSearchHit {
  field: DesignSearchField;
  value: string;
  start: number;
  end: number;
  designStart: number;
  designEnd: number;
  constructIndex?: number;
  partIndex?: number;
  featureIndex?: number;
}

export const DESIGN_VISUALIZATION_LIMITS = Object.freeze({
  maxJsonCharacters: 2 * 1024 * 1024,
  maxDesignIdCharacters: 256,
  maxChassisCharacters: 256,
  maxSourceCharacters: 4_096,
  maxConstructNameCharacters: 512,
  maxPartTextCharacters: 512,
  maxConstraintTextCharacters: 4_096,
  maxConstraintKeys: 64,
  maxConstraints: 512,
  maxConstructs: 256,
  maxPartsPerConstruct: 4_096,
  maxTotalParts: 20_000,
  maxAnnotationsPerConstruct: 4_096,
  maxSegmentsPerAnnotation: 64,
  maxTotalFeatures: 20_000,
  maxPartSequenceCharacters: 1_000_000,
  maxTotalSequenceCharacters: 2_000_000,
  maxDiagnostics: 100,
  maxSearchQueryCharacters: 512,
  maxSearchHits: 256,
  maxDiscoveredOrfs: 500,
  maxProteins: 256,
  maxProteinSequenceCharacters: 1_000_000,
  maxTotalProteinSequenceCharacters: 2_000_000,
});

export interface OrfDiscoveryOptions {
  topology: DesignTopology;
  constructStart?: number;
  minimumAminoAcids?: number;
  maximumFeatures?: number;
}

export interface OrfDiscoveryResult {
  features: FeatureViewModel[];
  truncated: boolean;
}

const PART_COLORS: Readonly<Record<string, string>> = Object.freeze({
  promoter: "#2563EB",
  rbs: "#7C3AED",
  cds: "#16A34A",
  terminator: "#DC2626",
  origin: "#D97706",
  orf: "#65A30D",
  primer: "#0891B2",
  misc_feature: "#64748B",
});
const UNKNOWN_PART_COLOR = "#64748B";
const SOFTWARE_ORF_COLOR = "#4D7C0F";
const SAFE_SEQUENCE = /^[ACGTRYSWKMBDHVN]+$/i;
const SAFE_PROTEIN_SEQUENCE = /^[ACDEFGHIKLMNPQRSTVWYBXZJUO*-]+$/i;
const SAFE_SHA256 = /^[a-f0-9]{64}$/i;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STOP_CODONS = new Set(["TAA", "TAG", "TGA"]);

export function parseDesignIr(input: unknown, sourcePath?: string): DesignParseResult {
  const diagnostics: DesignDiagnostic[] = [];
  const report = (
    code: string,
    path: string,
    message: string,
    severity: DesignDiagnosticSeverity = "error",
  ) => {
    if (diagnostics.length >= DESIGN_VISUALIZATION_LIMITS.maxDiagnostics) return;
    diagnostics.push({ severity, code, path, message });
  };

  try {
    const parsedInput = parseUnknownJson(input, report);
    if (parsedInput === undefined || !isJsonObject(parsedInput)) {
      if (parsedInput !== undefined) report("IR_ROOT_INVALID", "$", "Design IR must be a JSON object.");
      return { ok: false, diagnostics };
    }

    if (parsedInput.schema_version !== "proto-agent.ir.v1") {
      report("IR_SCHEMA_UNSUPPORTED", "$.schema_version", "Expected schema_version to be proto-agent.ir.v1.");
    }
    const designId = requiredText(
      parsedInput.design_id,
      "$.design_id",
      DESIGN_VISUALIZATION_LIMITS.maxDesignIdCharacters,
      "DESIGN_ID_INVALID",
      report,
    );
    const chassis = requiredText(
      parsedInput.chassis,
      "$.chassis",
      DESIGN_VISUALIZATION_LIMITS.maxChassisCharacters,
      "CHASSIS_INVALID",
      report,
    );
    const provenance = parsedInput.provenance;
    if (!isJsonObject(provenance)) {
      report("PROVENANCE_INVALID", "$.provenance", "Design IR provenance must be a JSON object.");
    }
    const provenanceSource = isJsonObject(provenance)
      ? requiredText(
        provenance.source,
        "$.provenance.source",
        DESIGN_VISUALIZATION_LIMITS.maxSourceCharacters,
        "PROVENANCE_SOURCE_INVALID",
        report,
      )
      : undefined;
    const explicitSource = sourcePath === undefined
      ? undefined
      : requiredText(
        sourcePath,
        "$sourcePath",
        DESIGN_VISUALIZATION_LIMITS.maxSourceCharacters,
        "SOURCE_PATH_INVALID",
        report,
      );

    const rawConstraints = parsedInput.constraints;
    const constraints: DesignConstraint[] = [];
    if (!Array.isArray(rawConstraints) || rawConstraints.length > DESIGN_VISUALIZATION_LIMITS.maxConstraints) {
      report(
        "CONSTRAINTS_INVALID",
        "$.constraints",
        `Constraints must be an array with at most ${DESIGN_VISUALIZATION_LIMITS.maxConstraints} entries.`,
      );
    } else {
      rawConstraints.forEach((constraint, index) => {
        const normalized = normalizeConstraint(constraint, index, report);
        if (normalized) constraints.push(normalized);
      });
    }

    if (parsedInput.domain !== undefined && parsedInput.domain !== "dna" && parsedInput.domain !== "protein") {
      report("DESIGN_DOMAIN_INVALID", "$.domain", "Design domain must be dna or protein.");
    }
    if (parsedInput.domain === "protein") {
      return parseProteinIr(
        parsedInput,
        designId,
        chassis,
        provenanceSource,
        explicitSource,
        constraints,
        diagnostics,
        report,
      );
    }

    const rawConstructs = parsedInput.constructs;
    const constructs: ConstructViewModel[] = [];
    const designSequencePieces: string[] = [];
    let designOffset = 0;
    let totalParts = 0;
    let totalFeatures = 0;
    if (
      !Array.isArray(rawConstructs)
      || rawConstructs.length === 0
      || rawConstructs.length > DESIGN_VISUALIZATION_LIMITS.maxConstructs
    ) {
      report(
        "DESIGN_CONSTRUCTS_INVALID",
        "$.constructs",
        `Constructs must be a non-empty array with at most ${DESIGN_VISUALIZATION_LIMITS.maxConstructs} entries.`,
      );
    } else {
      rawConstructs.forEach((rawConstruct, constructIndex) => {
        const constructPath = `$.constructs[${constructIndex}]`;
        if (!isJsonObject(rawConstruct)) {
          report("CONSTRUCT_INVALID", constructPath, "Construct must be a JSON object.");
          return;
        }
        const name = requiredText(
          rawConstruct.name,
          `${constructPath}.name`,
          DESIGN_VISUALIZATION_LIMITS.maxConstructNameCharacters,
          "CONSTRUCT_NAME_INVALID",
          report,
        );
        const topology = normalizeTopology(rawConstruct.topology, `${constructPath}.topology`, report);
        const rawParts = rawConstruct.parts;
        if (
          !Array.isArray(rawParts)
          || rawParts.length === 0
          || rawParts.length > DESIGN_VISUALIZATION_LIMITS.maxPartsPerConstruct
        ) {
          report(
            "CONSTRUCT_PARTS_INVALID",
            `${constructPath}.parts`,
            `Construct parts must be a non-empty array with at most ${DESIGN_VISUALIZATION_LIMITS.maxPartsPerConstruct} entries.`,
          );
          return;
        }
        totalParts += rawParts.length;
        if (totalParts > DESIGN_VISUALIZATION_LIMITS.maxTotalParts) {
          report(
            "DESIGN_PART_LIMIT_EXCEEDED",
            `${constructPath}.parts`,
            `Design contains more than ${DESIGN_VISUALIZATION_LIMITS.maxTotalParts} parts.`,
          );
          return;
        }

        const constructStart = designOffset;
        let localOffset = 0;
        const parts: PartViewModel[] = [];
        const constructSequencePieces: string[] = [];
        rawParts.forEach((rawPart, partIndex) => {
          const partPath = `${constructPath}.parts[${partIndex}]`;
          if (!isJsonObject(rawPart)) {
            report("PART_INVALID", partPath, "Part must be a JSON object.");
            return;
          }
          const id = requiredText(
            rawPart.id,
            `${partPath}.id`,
            DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
            "PART_ID_INVALID",
            report,
          );
          const type = requiredText(
            rawPart.type,
            `${partPath}.type`,
            DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
            "PART_TYPE_INVALID",
            report,
          );
          const nameValue = rawPart.name;
          const partName = nameValue === undefined || nameValue === null || nameValue === ""
            ? null
            : requiredText(
              nameValue,
              `${partPath}.name`,
              DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
              "PART_NAME_INVALID",
              report,
            ) ?? null;
          const rawSequence = requiredText(
            rawPart.sequence,
            `${partPath}.sequence`,
            DESIGN_VISUALIZATION_LIMITS.maxPartSequenceCharacters,
            "PART_SEQUENCE_INVALID",
            report,
          );
          if (rawSequence !== undefined && !SAFE_SEQUENCE.test(rawSequence)) {
            report(
              "PART_SEQUENCE_ALPHABET_INVALID",
              `${partPath}.sequence`,
              "Part sequence must contain only IUPAC DNA symbols.",
            );
          }
          if (id === undefined || type === undefined || rawSequence === undefined || !SAFE_SEQUENCE.test(rawSequence)) return;

          const sequence = rawSequence.toUpperCase();
          if (designOffset + sequence.length > DESIGN_VISUALIZATION_LIMITS.maxTotalSequenceCharacters) {
            report(
              "DESIGN_SEQUENCE_LIMIT_EXCEEDED",
              `${partPath}.sequence`,
              `Assembled sequence exceeds ${DESIGN_VISUALIZATION_LIMITS.maxTotalSequenceCharacters} characters.`,
            );
            return;
          }
          const localStart = localOffset;
          const localEnd = localStart + sequence.length;
          const designStart = designOffset;
          const designEnd = designStart + sequence.length;
          const gcFraction = calculateGcFraction(sequence);
          parts.push({
            id,
            name: partName,
            type,
            sequence,
            start: localStart,
            end: localEnd,
            designStart,
            designEnd,
            localStart,
            localEnd,
            length: sequence.length,
            gcFraction,
            gcPercent: gcFraction * 100,
            direction: normalizeDirection(rawPart.direction),
            color: colorForPartType(type),
          });
          constructSequencePieces.push(sequence);
          designSequencePieces.push(sequence);
          designOffset = designEnd;
          localOffset = localEnd;
        });

        if (parts.length !== rawParts.length || name === undefined || topology === undefined) return;
        const sequence = constructSequencePieces.join("");
        const partFeatures = parts.map((part, partIndex): FeatureViewModel => ({
          id: part.id,
          name: part.name,
          type: part.type,
          sequence: part.sequence,
          length: part.length,
          gcFraction: part.gcFraction,
          gcPercent: part.gcPercent,
          direction: part.direction,
          color: part.color,
          source: "part",
          segments: [{
            start: part.start,
            end: part.end,
            designStart: part.designStart,
            designEnd: part.designEnd,
            length: part.length,
          }],
          wrapsOrigin: false,
          partIndex,
        }));
        const annotationFeatures = normalizeAnnotations(
          rawConstruct.annotations,
          constructPath,
          topology,
          constructStart,
          sequence,
          report,
        );
        if (annotationFeatures === undefined) return;
        const features = [...partFeatures, ...annotationFeatures];
        totalFeatures += features.length;
        if (totalFeatures > DESIGN_VISUALIZATION_LIMITS.maxTotalFeatures) {
          report(
            "DESIGN_FEATURE_LIMIT_EXCEEDED",
            `${constructPath}.annotations`,
            `Design contains more than ${DESIGN_VISUALIZATION_LIMITS.maxTotalFeatures} logical features.`,
          );
          return;
        }
        const gcFraction = calculateGcFraction(sequence);
        constructs.push({
          name,
          topology,
          sequence,
          start: constructStart,
          end: designOffset,
          length: sequence.length,
          gcFraction,
          gcPercent: gcFraction * 100,
          parts,
          features,
        });
      });
    }

    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { ok: false, diagnostics };
    }
    if (
      designId === undefined
      || chassis === undefined
      || provenanceSource === undefined
      || constructs.length === 0
      || !Array.isArray(rawConstructs)
      || constructs.length !== rawConstructs.length
    ) {
      report("IR_NORMALIZATION_INCOMPLETE", "$", "Design IR could not be normalized completely.");
      return { ok: false, diagnostics };
    }

    const sequence = designSequencePieces.join("");
    const gcFraction = calculateGcFraction(sequence);
    return {
      ok: true,
      design: {
        schemaVersion: "proto-agent.ir.v1",
        domain: "dna",
        designId,
        chassis,
        source: explicitSource ?? provenanceSource,
        sequence,
        start: 0,
        end: sequence.length,
        length: sequence.length,
        gcFraction,
        gcPercent: gcFraction * 100,
        constructs,
        proteins: [],
        constraints,
      },
      diagnostics,
    };
  } catch {
    report("IR_PARSE_FAILED_CLOSED", "$", "Design IR could not be parsed safely.");
    return { ok: false, diagnostics };
  }
}

function parseProteinIr(
  input: Record<string, unknown>,
  designId: string | undefined,
  chassis: string | undefined,
  provenanceSource: string | undefined,
  explicitSource: string | undefined,
  constraints: DesignConstraint[],
  diagnostics: DesignDiagnostic[],
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): DesignParseResult {
  const rawProteins = input.proteins;
  if (
    !Array.isArray(rawProteins)
    || rawProteins.length === 0
    || rawProteins.length > DESIGN_VISUALIZATION_LIMITS.maxProteins
  ) {
    report(
      "DESIGN_PROTEINS_INVALID",
      "$.proteins",
      `Protein IR must contain 1-${DESIGN_VISUALIZATION_LIMITS.maxProteins} records.`,
    );
    return { ok: false, diagnostics };
  }

  const proteins: ProteinViewModel[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  rawProteins.forEach((rawProtein, proteinIndex) => {
    const proteinPath = `$.proteins[${proteinIndex}]`;
    if (!isJsonObject(rawProtein)) {
      report("PROTEIN_INVALID", proteinPath, "Protein record must be a JSON object.");
      return;
    }
    const id = requiredText(
      rawProtein.id,
      `${proteinPath}.id`,
      DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
      "PROTEIN_ID_INVALID",
      report,
    );
    if (id && seenIds.has(id.toLocaleLowerCase())) {
      report("PROTEIN_ID_DUPLICATE", `${proteinPath}.id`, `Duplicate protein ID: ${id}.`);
    }
    if (id) seenIds.add(id.toLocaleLowerCase());
    const type = requiredText(
      rawProtein.type,
      `${proteinPath}.type`,
      DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
      "PROTEIN_TYPE_INVALID",
      report,
    );
    if (type !== undefined && type !== "protein_sequence") {
      report("PROTEIN_TYPE_INVALID", `${proteinPath}.type`, "Protein record type must be protein_sequence.");
    }
    const rawSequence = requiredText(
      rawProtein.sequence,
      `${proteinPath}.sequence`,
      DESIGN_VISUALIZATION_LIMITS.maxProteinSequenceCharacters,
      "PROTEIN_SEQUENCE_INVALID",
      report,
    );
    if (rawSequence !== undefined && !SAFE_PROTEIN_SEQUENCE.test(rawSequence)) {
      report(
        "PROTEIN_SEQUENCE_ALPHABET_INVALID",
        `${proteinPath}.sequence`,
        "Protein sequence must contain only canonical or explicitly ambiguous amino-acid symbols.",
      );
    }
    const sequenceSha256 = requiredText(
      rawProtein.sequence_sha256,
      `${proteinPath}.sequence_sha256`,
      64,
      "PROTEIN_SEQUENCE_HASH_INVALID",
      report,
    );
    if (sequenceSha256 !== undefined && !SAFE_SHA256.test(sequenceSha256)) {
      report("PROTEIN_SEQUENCE_HASH_INVALID", `${proteinPath}.sequence_sha256`, "Protein sequence_sha256 must be a 64-character hexadecimal digest.");
    }
    if (id === undefined || rawSequence === undefined || sequenceSha256 === undefined || !SAFE_PROTEIN_SEQUENCE.test(rawSequence)) return;

    const sequence = rawSequence.toUpperCase();
    if (offset + sequence.length > DESIGN_VISUALIZATION_LIMITS.maxTotalProteinSequenceCharacters) {
      report(
        "PROTEIN_SEQUENCE_LIMIT_EXCEEDED",
        `${proteinPath}.sequence`,
        `Protein IR exceeds ${DESIGN_VISUALIZATION_LIMITS.maxTotalProteinSequenceCharacters} total residues.`,
      );
      return;
    }
    const nameValue = rawProtein.name;
    const name = nameValue === undefined || nameValue === null || nameValue === ""
      ? null
      : requiredText(nameValue, `${proteinPath}.name`, DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters, "PROTEIN_NAME_INVALID", report) ?? null;
    const descriptionValue = rawProtein.description ?? rawProtein.description_en;
    const description = descriptionValue === undefined || descriptionValue === null || descriptionValue === ""
      ? null
      : requiredText(descriptionValue, `${proteinPath}.description`, DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters, "PROTEIN_DESCRIPTION_INVALID", report) ?? null;
    const descriptionZhValue = rawProtein.description_zh;
    const descriptionZh = descriptionZhValue === undefined || descriptionZhValue === null || descriptionZhValue === ""
      ? null
      : requiredText(descriptionZhValue, `${proteinPath}.description_zh`, DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters, "PROTEIN_DESCRIPTION_ZH_INVALID", report) ?? null;
    const resourceId = rawProtein.resource_id === undefined
      ? id
      : requiredText(rawProtein.resource_id, `${proteinPath}.resource_id`, DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters, "PROTEIN_RESOURCE_ID_INVALID", report) ?? id;
    const source = normalizeProteinMap(rawProtein.source, `${proteinPath}.source`, report);
    const license = normalizeProteinMap(rawProtein.license, `${proteinPath}.license`, report);
    const metrics = normalizeProteinMetrics(rawProtein.metrics, `${proteinPath}.metrics`, report);
    const start = offset;
    const end = start + sequence.length;
    proteins.push({
      id,
      resourceId,
      name,
      sequence,
      sequenceSha256: sequenceSha256.toLowerCase(),
      description,
      descriptionZh,
      source,
      license,
      start,
      end,
      length: sequence.length,
      metrics,
    });
    offset = end;
  });

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { ok: false, diagnostics };
  if (designId === undefined || chassis === undefined || provenanceSource === undefined || proteins.length !== rawProteins.length) {
    report("IR_NORMALIZATION_INCOMPLETE", "$", "Protein IR could not be normalized completely.");
    return { ok: false, diagnostics };
  }
  const sequence = proteins.map((protein) => protein.sequence).join("");
  return {
    ok: true,
    design: {
      schemaVersion: "proto-agent.ir.v1",
      domain: "protein",
      designId,
      chassis,
      source: explicitSource ?? provenanceSource,
      sequence,
      start: 0,
      end: sequence.length,
      length: sequence.length,
      gcFraction: 0,
      gcPercent: 0,
      constructs: [],
      proteins,
      constraints,
    },
    diagnostics,
  };
}

function normalizeProteinMap(
  input: unknown,
  path: string,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): Record<string, string> {
  if (input === undefined) return {};
  if (!isJsonObject(input)) {
    report("PROTEIN_METADATA_INVALID", path, "Protein source and license metadata must be JSON objects.");
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      report("PROTEIN_METADATA_KEY_INVALID", `${path}.${key}`, "Unsafe metadata keys are not allowed.");
      continue;
    }
    if (typeof value !== "string") continue;
    if (value.length > DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters) {
      report("PROTEIN_METADATA_VALUE_INVALID", `${path}.${key}`, "Protein metadata values exceed the visualization limit.");
      continue;
    }
    result[key] = value;
  }
  return result;
}

function normalizeProteinMetrics(
  input: unknown,
  path: string,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): ProteinMetricsViewModel {
  if (input === undefined) return {};
  if (!isJsonObject(input)) {
    report("PROTEIN_METRICS_INVALID", path, "Protein metrics must be a JSON object.");
    return {};
  }
  const result: ProteinMetricsViewModel = {};
  const numberField = (key: string, target: keyof ProteinMetricsViewModel) => {
    const value = input[key];
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      report("PROTEIN_METRIC_INVALID", `${path}.${key}`, "Protein metric must be a finite non-negative number.");
      return;
    }
    if (target === "lengthAa") result.lengthAa = value;
    else if (target === "molecularWeightDaApprox") result.molecularWeightDaApprox = value;
    else if (target === "hydrophobicFraction") result.hydrophobicFraction = value;
    else if (target === "chargedFraction") result.chargedFraction = value;
    else if (target === "ambiguousOrSpecialFraction") result.ambiguousOrSpecialFraction = value;
  };
  numberField("length_aa", "lengthAa");
  numberField("molecular_weight_da_approx", "molecularWeightDaApprox");
  numberField("hydrophobic_fraction", "hydrophobicFraction");
  numberField("charged_fraction", "chargedFraction");
  numberField("ambiguous_or_special_fraction", "ambiguousOrSpecialFraction");
  const composition = input.composition;
  if (composition !== undefined) {
    if (!isJsonObject(composition)) {
      report("PROTEIN_METRIC_INVALID", `${path}.composition`, "Protein composition must be an object.");
    } else {
      const normalized: Record<string, number> = {};
      for (const [key, value] of Object.entries(composition)) {
        if (!/^[A-Z*\-]$/.test(key) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          report("PROTEIN_METRIC_INVALID", `${path}.composition`, "Protein composition keys and counts are invalid.");
          break;
        }
        normalized[key] = value;
      }
      if (Object.keys(normalized).length) result.composition = normalized;
    }
  }
  return result;
}

export function searchDesign(design: DesignViewModel, query: string): DesignSearchHit[] {
  if (typeof query !== "string") return [];
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > DESIGN_VISUALIZATION_LIMITS.maxSearchQueryCharacters) return [];
  const needle = trimmed.toLocaleLowerCase();
  const hits: DesignSearchHit[] = [];
  const hitKeys = new Set<string>();
  const add = (hit: DesignSearchHit) => {
    const key = hit.field === "sequence"
      ? `sequence:${hit.constructIndex ?? "design"}:${hit.start}:${hit.end}`
      : hit.field === "design"
        ? "design"
        : hit.field === "construct"
          ? `construct:${hit.constructIndex}`
          : `feature:${hit.constructIndex}:${hit.featureIndex ?? hit.partIndex}`;
    if (hitKeys.has(key) || hits.length >= DESIGN_VISUALIZATION_LIMITS.maxSearchHits) return;
    hitKeys.add(key);
    hits.push(hit);
  };
  const contains = (value: string | null | undefined) => value?.toLocaleLowerCase().includes(needle) ?? false;

  if (contains(design.designId)) add({ field: "design", value: design.designId, start: design.start, end: design.end, designStart: design.start, designEnd: design.end });
  if (contains(design.chassis)) add({ field: "design", value: design.chassis, start: design.start, end: design.end, designStart: design.start, designEnd: design.end });
  if (contains(design.source)) add({ field: "design", value: design.source, start: design.start, end: design.end, designStart: design.start, designEnd: design.end });

  for (let constructIndex = 0; constructIndex < design.constructs.length; constructIndex += 1) {
    const construct = design.constructs[constructIndex];
    if (contains(construct.name)) {
      add({ field: "construct", value: construct.name, start: 0, end: construct.length, designStart: construct.start, designEnd: construct.end, constructIndex });
    }
    if (hits.length >= DESIGN_VISUALIZATION_LIMITS.maxSearchHits) return hits;
    for (let featureIndex = 0; featureIndex < construct.features.length; featureIndex += 1) {
      const feature = construct.features[featureIndex];
      const firstSegment = feature.segments[0];
      if (!firstSegment) continue;
      const common = {
        start: firstSegment.start,
        end: firstSegment.end,
        designStart: firstSegment.designStart,
        designEnd: firstSegment.designEnd,
        constructIndex,
        partIndex: feature.partIndex,
        featureIndex,
      };
      if (contains(feature.id)) add({ field: feature.source === "part" ? "part" : "annotation", value: feature.id, ...common });
      if (contains(feature.type)) add({ field: "type", value: feature.type, ...common });
      if (contains(feature.name)) add({ field: feature.source === "part" ? "part" : "annotation", value: feature.name as string, ...common });
      if (hits.length >= DESIGN_VISUALIZATION_LIMITS.maxSearchHits) return hits;
    }
    for (const localStart of allSequenceMatches(construct.sequence.toLocaleLowerCase(), needle)) {
      const localEnd = localStart + trimmed.length;
      const featureIndex = construct.features.findIndex((feature) => feature.segments.some(
        (segment) => segment.start <= localStart && segment.end >= localEnd,
      ));
      const feature = featureIndex >= 0 ? construct.features[featureIndex] : undefined;
      add({
        field: "sequence",
        value: construct.sequence.slice(localStart, localEnd),
        start: localStart,
        end: localEnd,
        designStart: construct.start + localStart,
        designEnd: construct.start + localEnd,
        constructIndex,
        partIndex: feature?.partIndex,
        featureIndex: featureIndex >= 0 ? featureIndex : undefined,
      });
      if (hits.length >= DESIGN_VISUALIZATION_LIMITS.maxSearchHits) return hits;
    }
  }
  return hits;
}

/**
 * Rotate only the presentation of a declared circular construct. The source
 * sequence, feature sequences, design offsets, and IR object remain unchanged.
 * Invalid origins and non-circular constructs fail closed to the source view.
 */
export function rotateCircularConstructView(construct: ConstructViewModel, sourceOrigin: number): ConstructViewModel {
  const length = construct.length;
  if (
    construct.topology !== "circular"
    || !Number.isSafeInteger(sourceOrigin)
    || sourceOrigin < 0
    || sourceOrigin >= length
    || length < 1
  ) return construct;

  const sourceSequence = construct.sourceSequence ?? construct.sequence;
  if (sourceSequence.length !== length || sourceOrigin === 0) {
    if (sourceOrigin !== 0) return construct;
    if (construct.viewOrigin === undefined && construct.sourceSequence === undefined) return construct;
    return {
      ...construct,
      sequence: sourceSequence,
      sourceSequence: undefined,
      viewOrigin: undefined,
      features: construct.features.map((feature) => feature.sourceSegments
        ? { ...feature, segments: feature.sourceSegments.map(copySegment), sourceSegments: undefined, wrapsOrigin: segmentsWrapOrigin(feature.sourceSegments) }
        : feature),
    };
  }

  return {
    ...construct,
    sequence: sourceSequence.slice(sourceOrigin) + sourceSequence.slice(0, sourceOrigin),
    sourceSequence,
    viewOrigin: sourceOrigin,
    features: construct.features.map((feature) => {
      const sourceSegments = (feature.sourceSegments ?? feature.segments).map(copySegment);
      const segments = sourceSegments.flatMap((segment) => rotateSourceSegment(segment, sourceOrigin, length, construct.start));
      return {
        ...feature,
        segments,
        sourceSegments,
        wrapsOrigin: segmentsWrapOrigin(segments),
      };
    }),
  };
}

export function sourceBaseToViewBase(sourceBase: number, sourceOrigin: number, length: number): number | undefined {
  if (!validBaseCoordinate(sourceBase, length) || !validBaseCoordinate(sourceOrigin, length)) return undefined;
  return (sourceBase - sourceOrigin + length) % length;
}

export function viewBaseToSourceBase(viewBase: number, sourceOrigin: number, length: number): number | undefined {
  if (!validBaseCoordinate(viewBase, length) || !validBaseCoordinate(sourceOrigin, length)) return undefined;
  return (viewBase + sourceOrigin) % length;
}

export function viewIntervalToSourceSegments(
  start: number,
  end: number,
  sourceOrigin: number,
  length: number,
): Array<{ start: number; end: number }> {
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end <= start
    || end > length
    || !validBaseCoordinate(sourceOrigin, length)
  ) return [];
  const intervalLength = end - start;
  const sourceStart = (start + sourceOrigin) % length;
  const sourceEnd = sourceStart + intervalLength;
  return sourceEnd <= length
    ? [{ start: sourceStart, end: sourceEnd }]
    : [{ start: sourceStart, end: length }, { start: 0, end: sourceEnd - length }];
}

function rotateSourceSegment(
  segment: FeatureSegmentViewModel,
  sourceOrigin: number,
  length: number,
  constructStart: number,
): FeatureSegmentViewModel[] {
  if (segment.start < sourceOrigin && segment.end > sourceOrigin) {
    return [{
      start: length - sourceOrigin + segment.start,
      end: length,
      designStart: constructStart + segment.start,
      designEnd: constructStart + sourceOrigin,
      length: sourceOrigin - segment.start,
    }, {
      start: 0,
      end: segment.end - sourceOrigin,
      designStart: constructStart + sourceOrigin,
      designEnd: constructStart + segment.end,
      length: segment.end - sourceOrigin,
    }];
  }
  const start = (segment.start - sourceOrigin + length) % length;
  const segmentLength = segment.end - segment.start;
  return [{
    start,
    end: start + segmentLength,
    designStart: segment.designStart,
    designEnd: segment.designEnd,
    length: segmentLength,
  }];
}

function segmentsWrapOrigin(segments: ReadonlyArray<FeatureSegmentViewModel>): boolean {
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].start < segments[index - 1].start) return true;
  }
  return false;
}

function copySegment(segment: FeatureSegmentViewModel): FeatureSegmentViewModel {
  return { ...segment };
}

function validBaseCoordinate(value: number, length: number): boolean {
  return Number.isSafeInteger(length)
    && length > 0
    && Number.isSafeInteger(value)
    && value >= 0
    && value < length;
}

/**
 * Find bounded, standard-code ATG-to-stop open reading frames on both strands.
 * Results are software-derived view features only; they do not mutate the IR or
 * imply that an ORF is expressed, functional, or experimentally validated.
 */
export function discoverOpenReadingFrames(sequenceInput: string, options: OrfDiscoveryOptions): OrfDiscoveryResult {
  if (typeof sequenceInput !== "string" || !SAFE_SEQUENCE.test(sequenceInput)) return { features: [], truncated: false };
  const sequence = sequenceInput.toUpperCase();
  if (sequence.length < 6) return { features: [], truncated: false };
  const minimumAminoAcids = options.minimumAminoAcids ?? 30;
  const maximumFeatures = Math.min(
    options.maximumFeatures ?? DESIGN_VISUALIZATION_LIMITS.maxDiscoveredOrfs,
    DESIGN_VISUALIZATION_LIMITS.maxDiscoveredOrfs,
  );
  if (!Number.isSafeInteger(minimumAminoAcids) || minimumAminoAcids < 1 || minimumAminoAcids > 100_000) {
    return { features: [], truncated: false };
  }
  if (!Number.isSafeInteger(maximumFeatures) || maximumFeatures < 1) return { features: [], truncated: false };
  const constructStart = Number.isSafeInteger(options.constructStart) && (options.constructStart as number) >= 0
    ? options.constructStart as number
    : 0;
  const circular = options.topology === "circular";
  const features: FeatureViewModel[] = [];
  let truncated = false;

  const addFeature = (scanStart: number, scanEnd: number, frame: number, direction: -1 | 1) => {
    if (features.length >= maximumFeatures) {
      truncated = true;
      return;
    }
    const segments = orfSegments(sequence.length, scanStart, scanEnd, direction);
    if (!segments.length) return;
    const viewSegments = segments.map(({ start, end }) => ({
      start,
      end,
      designStart: constructStart + start,
      designEnd: constructStart + end,
      length: end - start,
    }));
    const referenceSequence = viewSegments.map((segment) => sequence.slice(segment.start, segment.end)).join("");
    const gcFraction = calculateGcFraction(referenceSequence);
    const aminoAcids = Math.max(0, Math.floor((scanEnd - scanStart) / 3) - 1);
    const displayFrame = direction === 1 ? frame + 1 : -(frame + 1);
    const coordinateId = viewSegments.map((segment) => `${segment.start + 1}-${segment.end}`).join("_");
    features.push({
      id: `software_orf_${displayFrame > 0 ? "plus" : "minus"}${Math.abs(displayFrame)}_${coordinateId}`,
      name: `Software-inferred ORF · frame ${displayFrame > 0 ? "+" : ""}${displayFrame} · ${aminoAcids} aa`,
      type: "orf",
      sequence: referenceSequence,
      length: scanEnd - scanStart,
      gcFraction,
      gcPercent: gcFraction * 100,
      direction,
      color: SOFTWARE_ORF_COLOR,
      source: "software",
      segments: viewSegments,
      wrapsOrigin: viewSegments.length > 1,
    });
  };

  const scanStrand = (strandSequence: string, direction: -1 | 1) => {
    const scanSequence = circular ? strandSequence + strandSequence : strandSequence;
    for (let frame = 0; frame < 3 && !truncated; frame += 1) {
      const starts: number[] = [];
      for (let position = frame; position + 3 <= scanSequence.length; position += 3) {
        const codon = scanSequence.slice(position, position + 3);
        if (codon === "ATG" && position < sequence.length) starts.push(position);
        if (!STOP_CODONS.has(codon)) continue;
        for (const start of starts) {
          const end = position + 3;
          if (end <= start || end - start > sequence.length) continue;
          const aminoAcids = Math.floor((end - start) / 3) - 1;
          if (aminoAcids < minimumAminoAcids) continue;
          addFeature(start, end, frame, direction);
          if (truncated) break;
        }
        starts.length = 0;
        if (!circular && position >= sequence.length) break;
      }
    }
  };

  scanStrand(sequence, 1);
  if (!truncated) scanStrand(reverseComplement(sequence), -1);
  features.sort((left, right) => {
    const leftStart = Math.min(...left.segments.map((segment) => segment.start));
    const rightStart = Math.min(...right.segments.map((segment) => segment.start));
    return leftStart - rightStart || right.length - left.length || right.direction - left.direction || left.id.localeCompare(right.id);
  });
  return { features, truncated };
}

function orfSegments(length: number, scanStart: number, scanEnd: number, direction: -1 | 1): Array<{ start: number; end: number }> {
  if (scanStart < 0 || scanEnd <= scanStart || scanEnd - scanStart > length) return [];
  if (direction === 1) {
    if (scanEnd <= length) return [{ start: scanStart, end: scanEnd }];
    return [{ start: scanStart, end: length }, { start: 0, end: scanEnd - length }];
  }
  if (scanEnd <= length) return [{ start: length - scanEnd, end: length - scanStart }];
  return [{ start: 0, end: length - scanStart }, { start: (2 * length) - scanEnd, end: length }];
}

function reverseComplement(sequence: string): string {
  const complements: Readonly<Record<string, string>> = {
    A: "T", C: "G", G: "C", T: "A",
    R: "Y", Y: "R", S: "S", W: "W", K: "M", M: "K",
    B: "V", D: "H", H: "D", V: "B", N: "N",
  };
  let result = "";
  for (let index = sequence.length - 1; index >= 0; index -= 1) result += complements[sequence[index]] ?? "N";
  return result;
}

function normalizeAnnotations(
  input: unknown,
  constructPath: string,
  topology: DesignTopology,
  constructStart: number,
  constructSequence: string,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): FeatureViewModel[] | undefined {
  if (input === undefined) return [];
  const annotationsPath = `${constructPath}.annotations`;
  if (!Array.isArray(input) || input.length > DESIGN_VISUALIZATION_LIMITS.maxAnnotationsPerConstruct) {
    report(
      "CONSTRUCT_ANNOTATIONS_INVALID",
      annotationsPath,
      `Annotations must be an array with at most ${DESIGN_VISUALIZATION_LIMITS.maxAnnotationsPerConstruct} entries.`,
    );
    return undefined;
  }
  const features: FeatureViewModel[] = [];
  input.forEach((rawAnnotation, annotationIndex) => {
    const annotationPath = `${annotationsPath}[${annotationIndex}]`;
    if (!isJsonObject(rawAnnotation)) {
      report("ANNOTATION_INVALID", annotationPath, "Annotation must be a JSON object.");
      return;
    }
    const id = requiredText(
      rawAnnotation.id,
      `${annotationPath}.id`,
      DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
      "ANNOTATION_ID_INVALID",
      report,
    );
    const type = requiredText(
      rawAnnotation.type,
      `${annotationPath}.type`,
      DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
      "ANNOTATION_TYPE_INVALID",
      report,
    );
    const rawName = rawAnnotation.name;
    const name = rawName === undefined || rawName === null || rawName === ""
      ? null
      : requiredText(
        rawName,
        `${annotationPath}.name`,
        DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
        "ANNOTATION_NAME_INVALID",
        report,
      ) ?? null;
    const rawSegments = rawAnnotation.segments;
    if (
      !Array.isArray(rawSegments)
      || rawSegments.length === 0
      || rawSegments.length > DESIGN_VISUALIZATION_LIMITS.maxSegmentsPerAnnotation
    ) {
      report(
        "ANNOTATION_SEGMENTS_INVALID",
        `${annotationPath}.segments`,
        `Annotation segments must be a non-empty array with at most ${DESIGN_VISUALIZATION_LIMITS.maxSegmentsPerAnnotation} entries.`,
      );
      return;
    }
    const segments: FeatureSegmentViewModel[] = [];
    let orderWraps = 0;
    let previousStart = -1;
    rawSegments.forEach((rawSegment, segmentIndex) => {
      const segmentPath = `${annotationPath}.segments[${segmentIndex}]`;
      if (!isJsonObject(rawSegment)) {
        report("ANNOTATION_SEGMENT_INVALID", segmentPath, "Annotation segment must be a JSON object.");
        return;
      }
      const start = rawSegment.start;
      const end = rawSegment.end;
      if (
        !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || (start as number) < 0
        || (end as number) <= (start as number)
        || (end as number) > constructSequence.length
      ) {
        report(
          "ANNOTATION_SEGMENT_RANGE_INVALID",
          segmentPath,
          `Segment coordinates must be safe integers using 0-based, end-exclusive bounds within 0–${constructSequence.length}.`,
        );
        return;
      }
      if (previousStart >= 0 && (start as number) < previousStart) orderWraps += 1;
      previousStart = start as number;
      segments.push({
        start: start as number,
        end: end as number,
        designStart: constructStart + (start as number),
        designEnd: constructStart + (end as number),
        length: (end as number) - (start as number),
      });
    });
    if (segments.length !== rawSegments.length || id === undefined || type === undefined) return;
    if (orderWraps > 1 || (orderWraps === 1 && topology !== "circular")) {
      report(
        "ANNOTATION_SEGMENT_ORDER_INVALID",
        `${annotationPath}.segments`,
        "Segments must be declared in coordinate order; exactly one origin wrap is allowed only for a circular construct.",
      );
      return;
    }
    const coordinateOrder = [...segments].sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < coordinateOrder.length; index += 1) {
      if (coordinateOrder[index].start < coordinateOrder[index - 1].end) {
        report(
          "ANNOTATION_SEGMENTS_OVERLAP",
          `${annotationPath}.segments`,
          "Segments within one logical annotation must not overlap.",
        );
        return;
      }
    }
    const sequence = segments.map((segment) => constructSequence.slice(segment.start, segment.end)).join("");
    const gcFraction = calculateGcFraction(sequence);
    features.push({
      id,
      name,
      type,
      sequence,
      length: segments.reduce((sum, segment) => sum + segment.length, 0),
      gcFraction,
      gcPercent: gcFraction * 100,
      direction: normalizeDirection(rawAnnotation.direction),
      color: colorForPartType(type),
      source: "annotation",
      segments,
      wrapsOrigin: orderWraps === 1,
    });
  });
  return features.length === input.length ? features : undefined;
}

function parseUnknownJson(
  input: unknown,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): unknown | undefined {
  if (typeof input !== "string") return input;
  if (input.length > DESIGN_VISUALIZATION_LIMITS.maxJsonCharacters) {
    report(
      "IR_JSON_LIMIT_EXCEEDED",
      "$",
      `Serialized design IR exceeds ${DESIGN_VISUALIZATION_LIMITS.maxJsonCharacters} characters.`,
    );
    return undefined;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    report("IR_JSON_INVALID", "$", "Design IR is not valid JSON.");
    return undefined;
  }
}

function normalizeConstraint(
  input: unknown,
  index: number,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): DesignConstraint | undefined {
  const path = `$.constraints[${index}]`;
  if (!isJsonObject(input)) {
    report("CONSTRAINT_INVALID", path, "Constraint must be a flat JSON object.");
    return undefined;
  }
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > DESIGN_VISUALIZATION_LIMITS.maxConstraintKeys) {
    report(
      "CONSTRAINT_KEY_LIMIT_EXCEEDED",
      path,
      `Constraint must have between 1 and ${DESIGN_VISUALIZATION_LIMITS.maxConstraintKeys} keys.`,
    );
    return undefined;
  }
  const result: DesignConstraint = {};
  for (const [key, value] of entries) {
    if (!key || key.length > 128 || UNSAFE_OBJECT_KEYS.has(key)) {
      report("CONSTRAINT_KEY_INVALID", path, "Constraint contains an invalid key.");
      return undefined;
    }
    if (
      value !== null
      && typeof value !== "string"
      && typeof value !== "number"
      && typeof value !== "boolean"
    ) {
      report("CONSTRAINT_VALUE_INVALID", `${path}.${key}`, "Constraint values must be JSON scalar values.");
      return undefined;
    }
    if (typeof value === "string" && value.length > DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters) {
      report("CONSTRAINT_VALUE_LIMIT_EXCEEDED", `${path}.${key}`, "Constraint text value is too large.");
      return undefined;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      report("CONSTRAINT_VALUE_INVALID", `${path}.${key}`, "Constraint number must be finite.");
      return undefined;
    }
    result[key] = value;
  }
  if (typeof result.type !== "string" || !result.type.trim()) {
    report("CONSTRAINT_TYPE_INVALID", `${path}.type`, "Constraint type must be a non-empty string.");
    return undefined;
  }
  return result;
}

function requiredText(
  value: unknown,
  path: string,
  maximum: number,
  code: string,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): string | undefined {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || value.includes("\0")
  ) {
    report(code, path, `Expected a non-empty text value no longer than ${maximum} characters.`);
    return undefined;
  }
  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeDirection(value: unknown): DesignDirection {
  if (value === 1 || value === "forward") return 1;
  if (value === -1 || value === "reverse") return -1;
  return 0;
}

function normalizeTopology(
  value: unknown,
  path: string,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): DesignTopology | undefined {
  if (value === undefined || value === null || value === "") return "unknown";
  if (value === "linear" || value === "circular" || value === "unknown") return value;
  report("CONSTRUCT_TOPOLOGY_INVALID", path, "Construct topology must be linear, circular, unknown, or omitted.");
  return undefined;
}

function colorForPartType(type: string): string {
  return PART_COLORS[type.toLocaleLowerCase()] ?? UNKNOWN_PART_COLOR;
}

function calculateGcFraction(sequence: string): number {
  if (!sequence.length) return 0;
  let gcCount = 0;
  for (const symbol of sequence) {
    if (symbol === "G" || symbol === "C") gcCount += 1;
  }
  return gcCount / sequence.length;
}

function allSequenceMatches(sequence: string, query: string): number[] {
  const matches: number[] = [];
  let start = 0;
  while (start <= sequence.length - query.length && matches.length < DESIGN_VISUALIZATION_LIMITS.maxSearchHits) {
    const match = sequence.indexOf(query, start);
    if (match < 0) break;
    matches.push(match);
    start = match + 1;
  }
  return matches;
}
