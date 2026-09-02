import { calculateProteinMetrics } from "./protein-sequence.ts";
import { sha256Text } from "./sha256.ts";

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
  /** Explicit sequence domain from governed compiler IR; null for legacy/toy IR. */
  sequenceKind: string | null;
  description: string | null;
  descriptionZh: string | null;
  /** Catalog identity declared by governed compiler IR; null for legacy/toy IR. */
  resourceId: string | null;
  /** Renderer-checked digest when declared; null means the legacy IR is unverified. */
  sequenceSha256: string | null;
  source: Record<string, string> | null;
  license: Record<string, string> | null;
  reviewStatus: string | null;
  designEligibility: boolean | null;
  safetyStatus: string | null;
  safetyFlags: string[] | null;
  evidenceRefs: string[] | null;
  /** "verified" means every field in the current governed DNA compiler contract is present and internally consistent. */
  governanceStatus: "verified" | "unverified";
  governanceGaps: string[];
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
  lengthAa: number;
  molecularWeightDaApprox: number;
  composition: Record<string, number>;
  hydrophobicFraction: number;
  chargedFraction: number;
  ambiguousOrSpecialFraction: number;
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
  reviewStatus: "DESIGN_ELIGIBLE";
  designEligibility: true;
  safetyStatus: "NO_FLAG";
  safetyFlags: string[];
  evidenceRefs: string[];
  organism: Record<string, ConstraintValue>;
  roleTerms: string[];
  metadata: Record<string, ConstraintValue>;
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
  /** First canonical source segment; use segments for the complete logical hit. */
  start: number;
  end: number;
  designStart: number;
  designEnd: number;
  /** Canonical source/design spans. Use this for a hit that crosses a circular source origin. */
  segments?: FeatureSegmentViewModel[];
  /** Explicit presentation spans; these are never substituted for source/design coordinates. */
  viewSegments?: Array<{ start: number; end: number; length: number }>;
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
const SAFE_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
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

    if (parsedInput.proteins !== undefined && (!Array.isArray(parsedInput.proteins) || parsedInput.proteins.length !== 0)) {
      report(
        "DNA_PROTEIN_DOMAIN_MIXED",
        "$.proteins",
        "DNA IR must not contain protein records.",
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
          const governance = normalizeDnaPartGovernance(rawPart, id, sequence, partPath, report);
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
            ...governance,
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

type DesignReport = (
  code: string,
  path: string,
  message: string,
  severity?: DesignDiagnosticSeverity,
) => void;

type DnaPartGovernance = Pick<PartViewModel,
  | "sequenceKind"
  | "description"
  | "descriptionZh"
  | "resourceId"
  | "sequenceSha256"
  | "source"
  | "license"
  | "reviewStatus"
  | "designEligibility"
  | "safetyStatus"
  | "safetyFlags"
  | "evidenceRefs"
  | "governanceStatus"
  | "governanceGaps"
>;

/**
 * The DNA compiler deliberately keeps catalog governance fields optional so
 * legacy toy IR remains readable. Absence is therefore an explicit
 * unverified state, while every declaration that is present is checked and a
 * malformed or contradictory claim blocks the complete IR parse.
 */
function normalizeDnaPartGovernance(
  rawPart: Record<string, unknown>,
  id: string,
  sequence: string,
  path: string,
  report: DesignReport,
): DnaPartGovernance {
  const gaps: string[] = [];
  const addGap = (field: string) => {
    if (!gaps.includes(field)) gaps.push(field);
  };
  const sequenceKind = optionalPartText(
    rawPart,
    "sequence_kind",
    `${path}.sequence_kind`,
    DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
    "PART_SEQUENCE_KIND_INVALID",
    report,
  );
  if (sequenceKind === null) addGap("sequence_kind");
  else if (sequenceKind !== "DNA") {
    report(
      "PART_SEQUENCE_KIND_MISMATCH",
      `${path}.sequence_kind`,
      "Declared DNA part sequence_kind must be DNA.",
    );
  }
  const description = optionalPartText(
    rawPart,
    "description",
    `${path}.description`,
    DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters,
    "PART_DESCRIPTION_INVALID",
    report,
  );
  const descriptionZh = optionalPartText(
    rawPart,
    "description_zh",
    `${path}.description_zh`,
    DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters,
    "PART_DESCRIPTION_INVALID",
    report,
  );

  const resourceId = optionalPartText(
    rawPart,
    "resource_id",
    `${path}.resource_id`,
    256,
    "PART_RESOURCE_ID_INVALID",
    report,
  );
  if (resourceId === null) addGap("resource_id");
  else if (!isSafeResourceId(resourceId)) {
    report(
      "PART_RESOURCE_ID_INVALID",
      `${path}.resource_id`,
      "Declared resource_id must be namespaced, bounded, and path-safe.",
    );
  } else if (resourceId !== id) {
    report(
      "PART_RESOURCE_ID_MISMATCH",
      `${path}.resource_id`,
      "Declared resource_id must match the compiler IR part id.",
    );
  }

  const declaredSequenceSha256 = optionalPartText(
    rawPart,
    "sequence_sha256",
    `${path}.sequence_sha256`,
    64,
    "PART_SEQUENCE_HASH_INVALID",
    report,
  );
  const recomputedSequenceSha256 = sha256Text(sequence);
  let sequenceSha256: string | null = null;
  if (declaredSequenceSha256 === null) {
    addGap("sequence_sha256");
  } else if (!SAFE_SHA256.test(declaredSequenceSha256)) {
    report(
      "PART_SEQUENCE_HASH_INVALID",
      `${path}.sequence_sha256`,
      "Part sequence_sha256 must be a 64-character hexadecimal digest.",
    );
  } else {
    sequenceSha256 = declaredSequenceSha256.toLowerCase();
    if (sequenceSha256 !== recomputedSequenceSha256) {
      report(
        "PART_SEQUENCE_HASH_MISMATCH",
        `${path}.sequence_sha256`,
        "Part sequence_sha256 does not match the renderer-recomputed DNA sequence digest.",
      );
    }
  }

  const source = normalizeOptionalPartMap(rawPart, "source", `${path}.source`, "PART_SOURCE_INVALID", report);
  if (source === null) {
    addGap("source");
  } else {
    for (const key of ["provider", "record_id", "url", "retrieved_at", "content_sha256", "sequence_sha256"] as const) {
      if (!hasOwn(source, key)) addGap(`source.${key}`);
      else if (!source[key].trim()) {
        report("PART_SOURCE_FIELD_INVALID", `${path}.source.${key}`, `Declared source.${key} must not be empty.`);
      }
    }
    if (!source.revision?.trim() && !source.release?.trim()) addGap("source.revision_or_release");
    if (source.url && !isSafePublicHttpsUrl(source.url)) {
      report("PART_SOURCE_URL_INVALID", `${path}.source.url`, "Part source URL must be an absolute public HTTPS URL.");
    }
    if (source.retrieved_at && !isIsoTimestamp(source.retrieved_at)) {
      report(
        "PART_SOURCE_RETRIEVED_AT_INVALID",
        `${path}.source.retrieved_at`,
        "Part source.retrieved_at must be an ISO-8601 timestamp.",
      );
    }
    if (source.content_sha256 && !SAFE_SHA256.test(source.content_sha256)) {
      report(
        "PART_SOURCE_CONTENT_HASH_INVALID",
        `${path}.source.content_sha256`,
        "Part source.content_sha256 must be a 64-character hexadecimal digest.",
      );
    }
    if (source.sequence_sha256) {
      if (!SAFE_SHA256.test(source.sequence_sha256)) {
        report(
          "PART_SOURCE_SEQUENCE_HASH_INVALID",
          `${path}.source.sequence_sha256`,
          "Part source.sequence_sha256 must be a 64-character hexadecimal digest.",
        );
      } else if (source.sequence_sha256.toLowerCase() !== recomputedSequenceSha256) {
        report(
          "PART_SOURCE_SEQUENCE_HASH_MISMATCH",
          `${path}.source.sequence_sha256`,
          "Part source.sequence_sha256 does not match the renderer-recomputed DNA sequence digest.",
        );
      }
    }
  }

  const license = normalizeOptionalPartMap(rawPart, "license", `${path}.license`, "PART_LICENSE_INVALID", report);
  if (license === null) {
    addGap("license");
  } else {
    for (const key of ["id", "url", "attribution", "rights_notes", "redistribution_status"] as const) {
      if (!hasOwn(license, key)) addGap(`license.${key}`);
      else if (!license[key].trim()) {
        report("PART_RIGHTS_FIELD_INVALID", `${path}.license.${key}`, `Declared license.${key} must not be empty.`);
      }
    }
    if (license.url && !isSafePublicHttpsUrl(license.url)) {
      report("PART_LICENSE_URL_INVALID", `${path}.license.url`, "Part license URL must be an absolute public HTTPS URL.");
    }
    if (license.redistribution_status && license.redistribution_status !== "REDISTRIBUTABLE") {
      report(
        "PART_RIGHTS_NOT_REDISTRIBUTABLE",
        `${path}.license.redistribution_status`,
        "Declared part rights must explicitly permit redistribution.",
      );
    }
  }

  const reviewStatus = optionalPartText(
    rawPart,
    "review_status",
    `${path}.review_status`,
    DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
    "PART_REVIEW_STATUS_INVALID",
    report,
  );
  const designEligibility = optionalPartBoolean(
    rawPart,
    "design_eligibility",
    `${path}.design_eligibility`,
    "PART_DESIGN_ELIGIBILITY_INVALID",
    report,
  );
  const safetyStatus = optionalPartText(
    rawPart,
    "safety_status",
    `${path}.safety_status`,
    DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
    "PART_SAFETY_STATUS_INVALID",
    report,
  );
  const safetyFlags = optionalPartStringArray(
    rawPart,
    "safety_flags",
    `${path}.safety_flags`,
    "PART_SAFETY_FLAGS_INVALID",
    report,
  );
  if (reviewStatus === null) addGap("review_status");
  if (designEligibility === null) addGap("design_eligibility");
  if (safetyStatus === null) addGap("safety_status");
  if (safetyFlags === null) addGap("safety_flags");
  if (reviewStatus !== null && reviewStatus !== "DESIGN_ELIGIBLE") {
    report(
      "PART_REVIEW_STATUS_NOT_ELIGIBLE",
      `${path}.review_status`,
      "Declared part review_status must be DESIGN_ELIGIBLE.",
    );
  }
  if (designEligibility === false) {
    report(
      "PART_DESIGN_NOT_ELIGIBLE",
      `${path}.design_eligibility`,
      "Declared part design_eligibility must be true.",
    );
  }
  if (safetyStatus !== null && safetyStatus !== "NO_FLAG") {
    report(
      "PART_SAFETY_STATUS_BLOCKED",
      `${path}.safety_status`,
      "Declared part safety_status must be NO_FLAG.",
    );
  }
  if (safetyFlags !== null && safetyFlags.length > 0) {
    report(
      "PART_SAFETY_FLAGS_BLOCKED",
      `${path}.safety_flags`,
      "Declared part safety_flags must be empty for a NO_FLAG design view.",
    );
  }

  const evidenceRefs = optionalPartStringArray(
    rawPart,
    "evidence_refs",
    `${path}.evidence_refs`,
    "PART_EVIDENCE_REFS_INVALID",
    report,
  );
  if (evidenceRefs === null) addGap("evidence_refs");
  else if (evidenceRefs.length === 0) {
    addGap("evidence_refs");
    if (reviewStatus === "DESIGN_ELIGIBLE" || designEligibility === true) {
      report(
        "PART_EVIDENCE_REFS_MISSING",
        `${path}.evidence_refs`,
        "A part declared design-eligible must retain at least one evidence reference.",
      );
    }
  }
  gaps.sort();
  return {
    sequenceKind,
    description,
    descriptionZh,
    resourceId,
    sequenceSha256,
    source,
    license,
    reviewStatus,
    designEligibility,
    safetyStatus,
    safetyFlags,
    evidenceRefs,
    governanceStatus: gaps.length === 0 ? "verified" : "unverified",
    governanceGaps: gaps,
  };
}

function optionalPartText(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  maximum: number,
  code: string,
  report: DesignReport,
): string | null {
  if (!hasOwn(owner, key)) return null;
  return requiredText(owner[key], path, maximum, code, report) ?? null;
}

function optionalPartBoolean(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  code: string,
  report: DesignReport,
): boolean | null {
  if (!hasOwn(owner, key)) return null;
  if (typeof owner[key] !== "boolean") {
    report(code, path, "Declared governance value must be a boolean.");
    return null;
  }
  return owner[key];
}

function optionalPartStringArray(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  code: string,
  report: DesignReport,
): string[] | null {
  if (!hasOwn(owner, key)) return null;
  const input = owner[key];
  if (
    !Array.isArray(input)
    || input.length > DESIGN_VISUALIZATION_LIMITS.maxConstraints
    || !input.every((item) => typeof item === "string"
      && Boolean(item.trim())
      && item.length <= DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters
      && !item.includes("\0"))
  ) {
    report(code, path, "Declared governance list must contain bounded, non-empty strings.");
    return null;
  }
  return [...input];
}

function normalizeOptionalPartMap(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  code: string,
  report: DesignReport,
): Record<string, string> | null {
  if (!hasOwn(owner, key)) return null;
  const input = owner[key];
  if (!isJsonObject(input) || Object.keys(input).length > DESIGN_VISUALIZATION_LIMITS.maxConstraintKeys) {
    report(code, path, "Declared part governance metadata must be a bounded JSON object.");
    return null;
  }
  const normalized: Record<string, string> = {};
  for (const [entryKey, value] of Object.entries(input)) {
    if (!entryKey || entryKey.length > 128 || UNSAFE_OBJECT_KEYS.has(entryKey)) {
      report(code, `${path}.${entryKey}`, "Declared part governance metadata contains an invalid key.");
      continue;
    }
    if (
      typeof value !== "string"
      || value.length > DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters
      || value.includes("\0")
    ) {
      report(code, `${path}.${entryKey}`, "Declared part governance metadata values must be bounded strings.");
      continue;
    }
    normalized[entryKey] = value;
  }
  return normalized;
}

function hasOwn(owner: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(owner, key);
}

function isSafeResourceId(value: string): boolean {
  if (!value.includes(":") || !SAFE_RESOURCE_ID.test(value) || value.includes("//") || value.includes("/.")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
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
  if (chassis !== undefined && chassis !== "protein_sequence") {
    report("PROTEIN_CHASSIS_INVALID", "$.chassis", "Protein IR chassis must be protein_sequence.");
  }
  if (!Array.isArray(input.constructs) || input.constructs.length !== 0) {
    report("PROTEIN_DNA_DOMAIN_MIXED", "$.constructs", "Protein IR must contain an explicit empty constructs array.");
  }
  if (input.review_status !== "human_review_required") {
    report("PROTEIN_REVIEW_BOUNDARY_INVALID", "$.review_status", "Protein IR must preserve review_status=human_review_required.");
  }
  requiredText(
    input.safety_boundary,
    "$.safety_boundary",
    DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters,
    "PROTEIN_SAFETY_BOUNDARY_INVALID",
    report,
  );
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
    const diagnosticStart = diagnostics.length;
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
    if (id !== undefined && !isSafeResourceId(id)) {
      report("PROTEIN_RESOURCE_ID_INVALID", `${proteinPath}.id`, "Protein id must be a namespaced, bounded, path-safe resource ID.");
    }
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
    if (rawProtein.sequence_kind !== "PROTEIN") {
      report("PROTEIN_SEQUENCE_KIND_INVALID", `${proteinPath}.sequence_kind`, "Protein sequence_kind must be PROTEIN.");
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
    const recomputedSequenceSha256 = sha256Text(sequence);
    if (sequenceSha256.toLowerCase() !== recomputedSequenceSha256) {
      report(
        "PROTEIN_SEQUENCE_HASH_MISMATCH",
        `${proteinPath}.sequence_sha256`,
        "Protein sequence_sha256 does not match the renderer-recomputed SHA-256 digest.",
      );
    }
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
    const description = requiredText(
      descriptionValue,
      `${proteinPath}.description`,
      DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters,
      "PROTEIN_DESCRIPTION_INVALID",
      report,
    ) ?? null;
    const descriptionZhValue = rawProtein.description_zh;
    const descriptionZh = descriptionZhValue === undefined || descriptionZhValue === null || descriptionZhValue === ""
      ? null
      : requiredText(descriptionZhValue, `${proteinPath}.description_zh`, DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters, "PROTEIN_DESCRIPTION_ZH_INVALID", report) ?? null;
    const resourceId = requiredText(
      rawProtein.resource_id,
      `${proteinPath}.resource_id`,
      DESIGN_VISUALIZATION_LIMITS.maxPartTextCharacters,
      "PROTEIN_RESOURCE_ID_INVALID",
      report,
    );
    if (resourceId !== undefined && !isSafeResourceId(resourceId)) {
      report("PROTEIN_RESOURCE_ID_INVALID", `${proteinPath}.resource_id`, "Protein resource_id must be namespaced, bounded, and path-safe.");
    } else if (id !== undefined && resourceId !== undefined && resourceId !== id) {
      report("PROTEIN_RESOURCE_ID_MISMATCH", `${proteinPath}.resource_id`, "Protein id and resource_id must match exactly.");
    }
    const source = normalizeProteinMap(rawProtein.source, `${proteinPath}.source`, report);
    const license = normalizeProteinMap(rawProtein.license, `${proteinPath}.license`, report);
    validateProteinSource(source, recomputedSequenceSha256, `${proteinPath}.source`, report);
    validateProteinLicense(license, `${proteinPath}.license`, report);
    if (rawProtein.review_status !== "DESIGN_ELIGIBLE" || rawProtein.design_eligibility !== true) {
      report(
        "PROTEIN_DESIGN_ELIGIBILITY_INVALID",
        proteinPath,
        "Protein must be explicitly DESIGN_ELIGIBLE with design_eligibility=true.",
      );
    }
    if (rawProtein.safety_status !== "NO_FLAG") {
      report("PROTEIN_SAFETY_STATUS_INVALID", `${proteinPath}.safety_status`, "Protein safety_status must be NO_FLAG.");
    }
    const safetyFlags = requiredProteinStringArray(rawProtein.safety_flags, `${proteinPath}.safety_flags`, report, true);
    if (safetyFlags && safetyFlags.length !== 0) {
      report("PROTEIN_SAFETY_FLAGS_INVALID", `${proteinPath}.safety_flags`, "Protein safety_flags must be an explicit empty array.");
    }
    const evidenceRefs = requiredProteinStringArray(rawProtein.evidence_refs, `${proteinPath}.evidence_refs`, report, false);
    const organism = normalizeProteinFlatMetadata(rawProtein.organism, `${proteinPath}.organism`, report);
    if (!organism.name || typeof organism.name !== "string") {
      report("PROTEIN_ORGANISM_INVALID", `${proteinPath}.organism.name`, "Protein organism.name is required.");
    }
    const roleTerms = requiredProteinStringArray(rawProtein.role_terms, `${proteinPath}.role_terms`, report, false);
    const metadata = normalizeProteinFlatMetadata(rawProtein.metadata, `${proteinPath}.metadata`, report);
    const metrics = normalizeProteinMetrics(rawProtein.metrics, sequence, `${proteinPath}.metrics`, report);
    if (
      diagnostics.slice(diagnosticStart).some((diagnostic) => diagnostic.severity === "error")
      || metrics === undefined
      || resourceId === undefined
      || safetyFlags === undefined
      || evidenceRefs === undefined
      || roleTerms === undefined
    ) return;
    const start = offset;
    const end = start + sequence.length;
    proteins.push({
      id,
      resourceId,
      name,
      sequence,
      sequenceSha256: recomputedSequenceSha256,
      description,
      descriptionZh,
      source,
      license,
      reviewStatus: "DESIGN_ELIGIBLE",
      designEligibility: true,
      safetyStatus: "NO_FLAG",
      safetyFlags,
      evidenceRefs,
      organism,
      roleTerms,
      metadata,
      start,
      end,
      length: sequence.length,
      metrics,
    });
    offset = end;
  });

  validateProteinProvenance(input.provenance, proteins, report);

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
  if (!isJsonObject(input)) {
    report("PROTEIN_METADATA_INVALID", path, "Protein source and license metadata are required JSON objects.");
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      report("PROTEIN_METADATA_KEY_INVALID", `${path}.${key}`, "Unsafe metadata keys are not allowed.");
      continue;
    }
    if (typeof value !== "string" || value.includes("\0")) {
      report("PROTEIN_METADATA_VALUE_INVALID", `${path}.${key}`, "Protein metadata values must be strings without NUL characters.");
      continue;
    }
    if (value.length > DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters) {
      report("PROTEIN_METADATA_VALUE_INVALID", `${path}.${key}`, "Protein metadata values exceed the visualization limit.");
      continue;
    }
    result[key] = value;
  }
  return result;
}

function validateProteinSource(
  source: Record<string, string>,
  expectedSequenceDigest: string,
  path: string,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): void {
  for (const key of ["provider", "record_id", "revision", "release", "url", "retrieved_at", "content_sha256", "sequence_sha256"] as const) {
    if (!source[key]?.trim()) {
      report("PROTEIN_SOURCE_REQUIRED_FIELD_MISSING", `${path}.${key}`, `Protein source.${key} is required.`);
    }
  }
  if (source.content_sha256 && !SAFE_SHA256.test(source.content_sha256)) {
    report(
      "PROTEIN_SOURCE_CONTENT_HASH_INVALID",
      `${path}.content_sha256`,
      "Protein source.content_sha256 must be a 64-character hexadecimal digest of the upstream response.",
    );
  }
  if (source.sequence_sha256) {
    if (!SAFE_SHA256.test(source.sequence_sha256)) {
      report(
        "PROTEIN_SOURCE_SEQUENCE_HASH_INVALID",
        `${path}.sequence_sha256`,
        "Protein source.sequence_sha256 must be a 64-character hexadecimal digest.",
      );
    } else if (source.sequence_sha256.toLowerCase() !== expectedSequenceDigest) {
      report(
        "PROTEIN_SOURCE_SEQUENCE_HASH_MISMATCH",
        `${path}.sequence_sha256`,
        "Protein source.sequence_sha256 does not match the renderer-recomputed sequence digest.",
      );
    }
  }
  if (source.url && !isSafePublicHttpsUrl(source.url)) {
    report("PROTEIN_SOURCE_URL_INVALID", `${path}.url`, "Protein source URL must be an absolute public HTTPS URL.");
  }
  if (source.retrieved_at && !isIsoTimestamp(source.retrieved_at)) {
    report("PROTEIN_SOURCE_RETRIEVED_AT_INVALID", `${path}.retrieved_at`, "Protein source.retrieved_at must be an ISO-8601 timestamp.");
  }
}

function validateProteinLicense(
  license: Record<string, string>,
  path: string,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): void {
  for (const key of ["id", "url", "attribution", "rights_notes", "redistribution_status"] as const) {
    if (!license[key]?.trim()) {
      report("PROTEIN_LICENSE_REQUIRED_FIELD_MISSING", `${path}.${key}`, `Protein license.${key} is required.`);
    }
  }
  if (license.redistribution_status !== "REDISTRIBUTABLE") {
    report("PROTEIN_LICENSE_NOT_REDISTRIBUTABLE", `${path}.redistribution_status`, "Protein license must explicitly declare REDISTRIBUTABLE.");
  }
  if (license.url && !isSafePublicHttpsUrl(license.url)) {
    report("PROTEIN_LICENSE_URL_INVALID", `${path}.url`, "Protein license URL must be an absolute public HTTPS URL.");
  }
}

function requiredProteinStringArray(
  input: unknown,
  path: string,
  report: DesignReport,
  allowEmpty: boolean,
): string[] | undefined {
  if (
    !Array.isArray(input)
    || input.length > DESIGN_VISUALIZATION_LIMITS.maxConstraints
    || (!allowEmpty && input.length === 0)
    || !input.every((item) => typeof item === "string"
      && Boolean(item.trim())
      && item.length <= DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters
      && !item.includes("\0"))
  ) {
    report(
      "PROTEIN_GOVERNANCE_LIST_INVALID",
      path,
      `Protein governance list must be ${allowEmpty ? "an explicit bounded string array" : "a non-empty bounded string array"}.`,
    );
    return undefined;
  }
  return [...input];
}

function normalizeProteinFlatMetadata(
  input: unknown,
  path: string,
  report: DesignReport,
): Record<string, ConstraintValue> {
  if (!isJsonObject(input) || Object.keys(input).length > DESIGN_VISUALIZATION_LIMITS.maxConstraintKeys) {
    report("PROTEIN_GOVERNANCE_METADATA_INVALID", path, "Protein governance metadata must be a bounded flat JSON object.");
    return {};
  }
  const result: Record<string, ConstraintValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key || key.length > 128 || UNSAFE_OBJECT_KEYS.has(key)) {
      report("PROTEIN_GOVERNANCE_METADATA_INVALID", `${path}.${key}`, "Protein governance metadata contains an invalid key.");
      continue;
    }
    if (
      value !== null
      && typeof value !== "string"
      && typeof value !== "number"
      && typeof value !== "boolean"
    ) {
      report("PROTEIN_GOVERNANCE_METADATA_INVALID", `${path}.${key}`, "Protein governance metadata values must be scalar JSON values.");
      continue;
    }
    if (
      (typeof value === "string" && (value.length > DESIGN_VISUALIZATION_LIMITS.maxConstraintTextCharacters || value.includes("\0")))
      || (typeof value === "number" && !Number.isFinite(value))
    ) {
      report("PROTEIN_GOVERNANCE_METADATA_INVALID", `${path}.${key}`, "Protein governance metadata contains an unsafe or unbounded value.");
      continue;
    }
    result[key] = value;
  }
  return result;
}

function validateProteinProvenance(
  input: unknown,
  proteins: ReadonlyArray<ProteinViewModel>,
  report: DesignReport,
): void {
  const path = "$.provenance";
  if (!isJsonObject(input)) {
    report("PROTEIN_PROVENANCE_INVALID", path, "Protein provenance must be a governed JSON object.");
    return;
  }
  const snapshotId = requiredText(input.snapshot_id, `${path}.snapshot_id`, 256, "PROTEIN_PROVENANCE_INVALID", report);
  const selectionDigest = requiredText(input.selection_digest, `${path}.selection_digest`, 64, "PROTEIN_PROVENANCE_INVALID", report);
  const normalizedSelectionDigest = selectionDigest?.toLowerCase();
  if (normalizedSelectionDigest !== undefined && !SAFE_SHA256.test(normalizedSelectionDigest)) {
    report("PROTEIN_SELECTION_DIGEST_INVALID", `${path}.selection_digest`, "Protein selection_digest must be a SHA-256 digest.");
  }
  if (input.selection_schema_version !== "proto-agent.protein-selection.v2") {
    report("PROTEIN_SELECTION_SCHEMA_UNSUPPORTED", `${path}.selection_schema_version`, "Protein visualization requires proto-agent.protein-selection.v2 provenance.");
  }
  const resourceIds = input.resource_ids;
  if (
    !Array.isArray(resourceIds)
    || resourceIds.length !== proteins.length
    || resourceIds.some((value, index) => value !== proteins[index]?.resourceId)
  ) {
    report("PROTEIN_PROVENANCE_RESOURCE_BINDING_INVALID", `${path}.resource_ids`, "Protein provenance resource_ids must exactly match the visible record order.");
  }
  const attestation = input.catalog_attestation;
  if (!isJsonObject(attestation)) {
    report("PROTEIN_CATALOG_ATTESTATION_INVALID", `${path}.catalog_attestation`, "Catalog-issued selection attestation is required.");
    return;
  }
  if (
    attestation.schema_version !== "proto-agent.catalog-selection-attestation.v1"
    || attestation.issuer !== "proto-agent-materials-catalog"
    || attestation.attestation_kind !== "catalog-issued-content-binding"
    || attestation.signature_status !== "UNSIGNED"
    || attestation.cryptographic_signature !== false
    || attestation.authenticity !== "NOT_ESTABLISHED"
    || typeof attestation.selection_digest !== "string"
    || attestation.selection_digest.toLowerCase() !== normalizedSelectionDigest
  ) {
    report("PROTEIN_CATALOG_ATTESTATION_INVALID", `${path}.catalog_attestation`, "Protein catalog attestation has an unsupported or misleading trust contract.");
  }
  const bindingSha256 = typeof attestation.binding_sha256 === "string" ? attestation.binding_sha256.toLowerCase() : "";
  if (!SAFE_SHA256.test(bindingSha256) || input.catalog_binding_sha256 !== bindingSha256) {
    report("PROTEIN_CATALOG_BINDING_INVALID", `${path}.catalog_binding_sha256`, "Protein catalog binding digest is missing or inconsistent.");
  }
  if (input.catalog_signature_status !== "UNSIGNED" || !snapshotId) {
    report("PROTEIN_CATALOG_TRUST_STATUS_INVALID", path, "Protein provenance must honestly retain its UNSIGNED catalog trust status and snapshot identity.");
  }
  const snapshot = attestation.snapshot_manifest;
  if (
    !isJsonObject(snapshot)
    || snapshot.schema_version !== "proto-agent.materials.v1"
    || snapshot.snapshot_id !== snapshotId
    || !Number.isSafeInteger(snapshot.record_count)
    || (snapshot.record_count as number) < 1
    || !SAFE_SHA256.test(String(snapshot.manifest_sha256 ?? ""))
    || !SAFE_SHA256.test(String(snapshot.catalog_sha256 ?? ""))
    || !SAFE_SHA256.test(String(snapshot.license_catalog_sha256 ?? ""))
  ) {
    report("PROTEIN_CATALOG_SNAPSHOT_BINDING_INVALID", `${path}.catalog_attestation.snapshot_manifest`, "Protein catalog attestation must bind the selected snapshot and its manifest, catalog, and license digests.");
  }
  const recordBindings = attestation.records;
  if (!Array.isArray(recordBindings) || recordBindings.length !== proteins.length) {
    report("PROTEIN_CATALOG_RECORD_BINDING_INVALID", `${path}.catalog_attestation.records`, "Catalog attestation must cover every visible protein record.");
  } else {
    recordBindings.forEach((binding, index) => {
      const resourceId = proteins[index]?.resourceId;
      const promotion = isJsonObject(binding) ? binding.promotion_attestation : undefined;
      if (
        !isJsonObject(binding)
        || binding.resource_id !== resourceId
        || !SAFE_SHA256.test(String(binding.selection_record_sha256 ?? ""))
        || !SAFE_SHA256.test(String(binding.promotion_attestation_sha256 ?? ""))
        || !SAFE_SHA256.test(String(binding.promotion_audit_sha256 ?? ""))
        || !isJsonObject(promotion)
        || promotion.resource_id !== resourceId
        || promotion.decision !== "PASS"
        || promotion.policy_version !== "proto-agent.materials-promotion-policy.2026-09"
      ) {
        report("PROTEIN_CATALOG_RECORD_BINDING_INVALID", `${path}.catalog_attestation.records[${index}]`, "Catalog record binding is incomplete or does not match the visible protein.");
      }
    });
  }
}

function normalizeProteinMetrics(
  input: unknown,
  sequence: string,
  path: string,
  report: (code: string, path: string, message: string, severity?: DesignDiagnosticSeverity) => void,
): ProteinMetricsViewModel | undefined {
  if (!isJsonObject(input)) {
    report("PROTEIN_METRICS_INVALID", path, "Protein metrics are required and must be a JSON object.");
    return undefined;
  }
  const expected = calculateProteinMetrics(sequence);
  const numberField = (key: string, maximum?: number): number | undefined => {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) {
      report("PROTEIN_METRIC_INVALID", `${path}.${key}`, `Protein metric must be a finite number between 0 and ${maximum ?? "the supported bound"}.`);
      return undefined;
    }
    return value;
  };
  const lengthAa = numberField("length_aa", DESIGN_VISUALIZATION_LIMITS.maxProteinSequenceCharacters);
  const molecularWeightDaApprox = numberField("molecular_weight_da_approx");
  const hydrophobicFraction = numberField("hydrophobic_fraction", 1);
  const chargedFraction = numberField("charged_fraction", 1);
  const ambiguousOrSpecialFraction = numberField("ambiguous_or_special_fraction", 1);
  const composition = input.composition;
  const normalizedComposition: Record<string, number> = {};
  if (!isJsonObject(composition)) {
    report("PROTEIN_METRIC_INVALID", `${path}.composition`, "Protein composition is required and must be an object.");
  } else {
    for (const [key, value] of Object.entries(composition)) {
      if (!/^[A-Z*\-]$/.test(key) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        report("PROTEIN_METRIC_INVALID", `${path}.composition`, "Protein composition keys and counts are invalid.");
        break;
      }
      normalizedComposition[key] = value;
    }
  }
  const numbers = [lengthAa, molecularWeightDaApprox, hydrophobicFraction, chargedFraction, ambiguousOrSpecialFraction];
  if (numbers.some((value) => value === undefined)) return undefined;
  const supplied = {
    lengthAa: lengthAa as number,
    molecularWeightDaApprox: molecularWeightDaApprox as number,
    composition: normalizedComposition,
    hydrophobicFraction: hydrophobicFraction as number,
    chargedFraction: chargedFraction as number,
    ambiguousOrSpecialFraction: ambiguousOrSpecialFraction as number,
  };
  if (
    supplied.lengthAa !== expected.lengthAa
    || Math.abs(supplied.molecularWeightDaApprox - expected.molecularWeightDaApprox) > 0.001
    || Math.abs(supplied.hydrophobicFraction - expected.hydrophobicFraction) > 0.000001
    || Math.abs(supplied.chargedFraction - expected.chargedFraction) > 0.000001
    || Math.abs(supplied.ambiguousOrSpecialFraction - expected.ambiguousOrSpecialFraction) > 0.000001
    || JSON.stringify(Object.entries(supplied.composition).sort()) !== JSON.stringify(Object.entries(expected.composition).sort())
  ) {
    report("PROTEIN_METRICS_MISMATCH", path, "Protein metrics do not match values recomputed from the sequence.");
    return undefined;
  }
  return expected;
}

function isSafePublicHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return false;
    const hostname = parsed.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "::1") return false;
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
    if (ipv4 && ipv4.every((part) => part >= 0 && part <= 255)) {
      const [first, second] = ipv4;
      if (first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return false;
    }
    if (hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8") || hostname.startsWith("fe9") || hostname.startsWith("fea") || hostname.startsWith("feb")) return false;
    return true;
  } catch {
    return false;
  }
}

export function searchDesign(design: DesignViewModel, query: string): DesignSearchHit[] {
  if (typeof query !== "string") return [];
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > DESIGN_VISUALIZATION_LIMITS.maxSearchQueryCharacters) return [];
  const needle = trimmed.toLocaleLowerCase();
  const hits: DesignSearchHit[] = [];
  const hitKeys = new Set<string>();
  const add = (hit: DesignSearchHit) => {
    const segmentKey = hit.segments?.map((segment) => `${segment.start}-${segment.end}`).join(",") ?? `${hit.start}-${hit.end}`;
    const key = hit.field === "sequence"
      ? `sequence:${hit.constructIndex ?? "design"}:${segmentKey}`
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
      const canonicalSegments = (feature.sourceSegments ?? feature.segments).map(copySegment);
      const firstSegment = canonicalSegments[0];
      const viewSegments = feature.segments.map(({ start, end, length }) => ({ start, end, length }));
      if (!firstSegment) continue;
      const common = {
        start: firstSegment.start,
        end: firstSegment.end,
        designStart: firstSegment.designStart,
        designEnd: firstSegment.designEnd,
        segments: canonicalSegments,
        viewSegments,
        constructIndex,
        partIndex: feature.partIndex,
        featureIndex,
      };
      if (contains(feature.id)) add({ field: feature.source === "part" ? "part" : "annotation", value: feature.id, ...common });
      if (contains(feature.type)) add({ field: "type", value: feature.type, ...common });
      if (contains(feature.name)) add({ field: feature.source === "part" ? "part" : "annotation", value: feature.name as string, ...common });
      if (hits.length >= DESIGN_VISUALIZATION_LIMITS.maxSearchHits) return hits;
    }
    for (const localStart of sequenceMatchesForConstruct(construct, needle)) {
      const canonicalSegments = canonicalSearchSegments(construct, localStart, trimmed.length);
      const viewSegments = viewSearchSegments(construct.length, localStart, trimmed.length);
      const firstSegment = canonicalSegments[0];
      if (!firstSegment || viewSegments.length === 0) continue;
      const featureIndex = construct.features.findIndex((feature) => searchSegmentsWithinFeature(
        canonicalSegments,
        feature.sourceSegments ?? feature.segments,
      ));
      const feature = featureIndex >= 0 ? construct.features[featureIndex] : undefined;
      add({
        field: "sequence",
        value: sliceCircularView(construct.sequence, localStart, trimmed.length),
        start: firstSegment.start,
        end: firstSegment.end,
        designStart: firstSegment.designStart,
        designEnd: firstSegment.designEnd,
        segments: canonicalSegments,
        viewSegments,
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

function sequenceMatchesForConstruct(construct: ConstructViewModel, query: string): number[] {
  const sequence = construct.sequence.toLocaleLowerCase();
  if (construct.topology !== "circular" || query.length > sequence.length) {
    return allSequenceMatches(sequence, query);
  }
  const circularSequence = sequence + sequence.slice(0, Math.max(0, query.length - 1));
  return allSequenceMatches(circularSequence, query).filter((start) => start < sequence.length);
}

/** Map a view-local sequence match back to immutable source/design spans. */
function canonicalSearchSegments(
  construct: ConstructViewModel,
  viewStart: number,
  matchLength: number,
): FeatureSegmentViewModel[] {
  if (
    !Number.isSafeInteger(viewStart)
    || !Number.isSafeInteger(matchLength)
    || viewStart < 0
    || viewStart >= construct.length
    || matchLength < 1
    || matchLength > construct.length
  ) return [];
  const sourceOrigin = construct.viewOrigin ?? 0;
  if (!validBaseCoordinate(sourceOrigin, construct.length)) return [];
  const sourceStart = (viewStart + sourceOrigin) % construct.length;
  const sourceEnd = sourceStart + matchLength;
  const spans = sourceEnd <= construct.length
    ? [{ start: sourceStart, end: sourceEnd }]
    : [{ start: sourceStart, end: construct.length }, { start: 0, end: sourceEnd - construct.length }];
  return spans.map(({ start, end }) => ({
    start,
    end,
    designStart: construct.start + start,
    designEnd: construct.start + end,
    length: end - start,
  }));
}

function viewSearchSegments(
  constructLength: number,
  viewStart: number,
  matchLength: number,
): Array<{ start: number; end: number; length: number }> {
  if (
    !Number.isSafeInteger(constructLength)
    || constructLength < 1
    || !Number.isSafeInteger(viewStart)
    || viewStart < 0
    || viewStart >= constructLength
    || !Number.isSafeInteger(matchLength)
    || matchLength < 1
    || matchLength > constructLength
  ) return [];
  const viewEnd = viewStart + matchLength;
  const spans = viewEnd <= constructLength
    ? [{ start: viewStart, end: viewEnd }]
    : [{ start: viewStart, end: constructLength }, { start: 0, end: viewEnd - constructLength }];
  return spans.map(({ start, end }) => ({ start, end, length: end - start }));
}

function searchSegmentsWithinFeature(
  searchSegments: ReadonlyArray<FeatureSegmentViewModel>,
  featureSegments: ReadonlyArray<FeatureSegmentViewModel>,
): boolean {
  return searchSegments.every((searchSegment) => featureSegments.some(
    (featureSegment) => featureSegment.start <= searchSegment.start && featureSegment.end >= searchSegment.end,
  ));
}

function sliceCircularView(sequence: string, start: number, length: number): string {
  const end = start + length;
  return end <= sequence.length
    ? sequence.slice(start, end)
    : sequence.slice(start) + sequence.slice(0, end - sequence.length);
}
