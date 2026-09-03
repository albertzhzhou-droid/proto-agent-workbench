import type {
  MaterialSummary,
  MaterialsMaterializeRequest,
  MaterialsSearchResult,
} from "../shared/contracts.ts";

export const MAX_MATERIALS_DESIGN_SELECTION = 50;

export type MaterialsDesignSelectionErrorCode =
  | "DUPLICATE_CONFLICT"
  | "INELIGIBLE_MATERIAL"
  | "INVALID_CHASSIS"
  | "INVALID_MATERIAL"
  | "INVALID_PAGE"
  | "INVALID_SELECTION"
  | "INVALID_SNAPSHOT"
  | "NO_COMMON_CHASSIS"
  | "PAGE_TOTAL_MISMATCH"
  | "SELECTION_LIMIT_EXCEEDED"
  | "SNAPSHOT_MISMATCH";

export class MaterialsDesignSelectionError extends Error {
  readonly code: MaterialsDesignSelectionErrorCode;
  readonly resourceId?: string;

  constructor(code: MaterialsDesignSelectionErrorCode, message: string, resourceId?: string) {
    super(message);
    this.name = "MaterialsDesignSelectionError";
    this.code = code;
    this.resourceId = resourceId;
  }
}

export interface MaterialsDesignSelection {
  readonly snapshotId: string;
  readonly materials: readonly MaterialSummary[];
  readonly resourceIds: readonly string[];
  readonly commonChassis: readonly string[];
}

const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*:[^/\\]+(?:[/\\][^/\\]+)*$/u;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f\u0085\u2028\u2029]/u;
const SUPPORTED_DNA_PART_TYPES = new Set(["promoter", "rbs", "cds", "terminator"]);

function fail(code: MaterialsDesignSelectionErrorCode, message: string, resourceId?: string): never {
  throw new MaterialsDesignSelectionError(code, message, resourceId);
}

function validateSnapshotId(snapshotId: unknown): asserts snapshotId is string {
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID.test(snapshotId)) {
    fail("INVALID_SNAPSHOT", "Materials selection requires a canonical snapshot ID.");
  }
}

function validateChassis(chassis: unknown, resourceId?: string): asserts chassis is string {
  if (
    typeof chassis !== "string"
    || chassis.length < 1
    || chassis.length > 256
    || chassis !== chassis.trim()
    || CONTROL_CHARACTER.test(chassis)
  ) {
    fail("INVALID_CHASSIS", "Materials selection contains an invalid chassis value.", resourceId);
  }
}

function canonicalResourceId(resourceId: string): string {
  return resourceId.toLocaleLowerCase("en-US");
}

function compareResourceIds(left: string, right: string): number {
  const canonicalLeft = canonicalResourceId(left);
  const canonicalRight = canonicalResourceId(right);
  if (canonicalLeft < canonicalRight) return -1;
  if (canonicalLeft > canonicalRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => jsonValuesEqual(leftRecord[key], rightRecord[key]));
}

/**
 * Fail closed unless a search result is explicitly eligible for the DNA design
 * path. This is a UI-side guard; the catalogue and materializer remain the
 * authoritative enforcement points.
 */
export function assertDesignEligibleMaterial(material: unknown): asserts material is MaterialSummary {
  if (material === null || typeof material !== "object" || Array.isArray(material)) {
    fail("INVALID_MATERIAL", "Materials selection requires a structured catalogue record.");
  }
  const candidate = material as Partial<MaterialSummary>;
  const resourceId = typeof candidate.resource_id === "string" ? candidate.resource_id : undefined;
  if (!resourceId || resourceId.length > 256 || !RESOURCE_ID.test(resourceId)) {
    fail("INVALID_MATERIAL", "Materials selection contains an invalid resource ID.", resourceId);
  }
  if (candidate.kind !== "genetic_part") {
    fail("INELIGIBLE_MATERIAL", `${resourceId} is not a genetic part.`, resourceId);
  }
  if (candidate.sequence_kind !== "DNA" || !SUPPORTED_DNA_PART_TYPES.has(String(candidate.part_type))) {
    fail("INELIGIBLE_MATERIAL", `${resourceId} is not a supported DNA part.`, resourceId);
  }
  if (candidate.review_status !== "DESIGN_ELIGIBLE" || candidate.design_eligibility !== true) {
    fail("INELIGIBLE_MATERIAL", `${resourceId} is not explicitly design-eligible.`, resourceId);
  }
  if (candidate.safety_status !== "NO_FLAG" || !Array.isArray(candidate.safety_flags) || candidate.safety_flags.length !== 0) {
    fail("INELIGIBLE_MATERIAL", `${resourceId} does not pass the no-flag safety gate.`, resourceId);
  }
  if (!Array.isArray(candidate.chassis) || candidate.chassis.length === 0) {
    fail("INVALID_MATERIAL", `${resourceId} has no declared chassis.`, resourceId);
  }
  for (const chassis of candidate.chassis) validateChassis(chassis, resourceId);
}

function assertSearchMaterial(material: unknown): asserts material is MaterialSummary {
  if (material === null || typeof material !== "object" || Array.isArray(material)) {
    fail("INVALID_MATERIAL", "Materials search returned an invalid catalogue record.");
  }
  const resourceId = (material as Partial<MaterialSummary>).resource_id;
  if (typeof resourceId !== "string" || resourceId.length > 256 || !RESOURCE_ID.test(resourceId)) {
    fail("INVALID_MATERIAL", "Materials search returned an invalid resource ID.");
  }
}

function deduplicateMaterials(materials: readonly MaterialSummary[]): MaterialSummary[] {
  const unique = new Map<string, MaterialSummary>();
  for (const material of materials) {
    assertDesignEligibleMaterial(material);
    const key = canonicalResourceId(material.resource_id);
    const existing = unique.get(key);
    if (existing === undefined) {
      unique.set(key, material);
      continue;
    }
    if (existing.resource_id !== material.resource_id || !jsonValuesEqual(existing, material)) {
      fail(
        "DUPLICATE_CONFLICT",
        `Conflicting catalogue records share resource ID ${material.resource_id}.`,
        material.resource_id,
      );
    }
  }
  return [...unique.values()];
}

function deduplicateSearchMaterials(materials: readonly MaterialSummary[]): MaterialSummary[] {
  const unique = new Map<string, MaterialSummary>();
  for (const material of materials) {
    assertSearchMaterial(material);
    const key = canonicalResourceId(material.resource_id);
    const existing = unique.get(key);
    if (existing === undefined) {
      unique.set(key, material);
      continue;
    }
    if (existing.resource_id !== material.resource_id || !jsonValuesEqual(existing, material)) {
      fail("DUPLICATE_CONFLICT", `Conflicting catalogue records share resource ID ${material.resource_id}.`, material.resource_id);
    }
  }
  return [...unique.values()];
}

function sharedChassis(materials: readonly MaterialSummary[]): string[] {
  const [first, ...rest] = materials;
  if (first === undefined) return [];
  const common = new Set(first.chassis);
  for (const material of rest) {
    const available = new Set(material.chassis);
    for (const chassis of common) {
      if (!available.has(chassis)) common.delete(chassis);
    }
  }
  return [...common].sort();
}

/** Build a deterministic, snapshot-bound selection of one to fifty DNA parts. */
export function createMaterialsDesignSelection(
  snapshotId: string,
  materials: readonly MaterialSummary[],
): MaterialsDesignSelection {
  validateSnapshotId(snapshotId);
  if (!Array.isArray(materials) || materials.length === 0) {
    fail("INVALID_SELECTION", "Select at least one design-eligible material.");
  }
  const unique = deduplicateMaterials(materials).sort((left, right) => compareResourceIds(left.resource_id, right.resource_id));
  if (unique.length > MAX_MATERIALS_DESIGN_SELECTION) {
    fail(
      "SELECTION_LIMIT_EXCEEDED",
      `Select at most ${MAX_MATERIALS_DESIGN_SELECTION} distinct materials.`,
    );
  }
  const commonChassis = sharedChassis(unique);
  if (commonChassis.length === 0) {
    fail("NO_COMMON_CHASSIS", "Selected materials do not declare a common chassis.");
  }
  return {
    snapshotId,
    materials: [...unique],
    resourceIds: unique.map((material) => material.resource_id),
    commonChassis,
  };
}

function validateSearchPage(page: unknown, index: number): asserts page is MaterialsSearchResult {
  if (page === null || typeof page !== "object" || Array.isArray(page)) {
    fail("INVALID_PAGE", `Materials search page ${index + 1} is not a structured response.`);
  }
  const candidate = page as Partial<MaterialsSearchResult>;
  if (candidate.ok !== true || !Array.isArray(candidate.matches)) {
    fail("INVALID_PAGE", `Materials search page ${index + 1} is not successful or has no matches array.`);
  }
  validateSnapshotId(candidate.snapshot_id);
  if (
    !Number.isSafeInteger(candidate.match_count)
    || candidate.match_count! < 0
    || !Number.isSafeInteger(candidate.returned_count)
    || candidate.returned_count! < 0
    || candidate.returned_count !== candidate.matches.length
    || candidate.returned_count! > candidate.match_count!
    || typeof candidate.truncated !== "boolean"
  ) {
    fail("INVALID_PAGE", `Materials search page ${index + 1} has inconsistent counts or pagination fields.`);
  }
  const nextCursor = (candidate as { next_cursor?: unknown }).next_cursor;
  if (
    (candidate.truncated && (typeof nextCursor !== "string" || nextCursor.length === 0 || candidate.matches.length === 0))
    || (!candidate.truncated && nextCursor !== undefined && nextCursor !== null)
  ) {
    fail("INVALID_PAGE", `Materials search page ${index + 1} has an inconsistent continuation cursor.`);
  }
}

/**
 * Merge consecutive search pages without allowing records from different
 * snapshots to enter the same selectable result set.
 */
export function mergeMaterialsSearchPages(pages: readonly MaterialsSearchResult[]): MaterialsSearchResult {
  if (!Array.isArray(pages) || pages.length === 0) {
    fail("INVALID_PAGE", "At least one materials search page is required.");
  }
  let snapshotId: string | undefined;
  let matchCount: number | undefined;
  const merged: MaterialSummary[] = [];
  for (const [index, page] of pages.entries()) {
    validateSearchPage(page, index);
    snapshotId ??= page.snapshot_id;
    matchCount ??= page.match_count;
    if (page.snapshot_id !== snapshotId) {
      fail("SNAPSHOT_MISMATCH", "Materials search pages come from different snapshots.");
    }
    if (page.match_count !== matchCount) {
      fail("PAGE_TOTAL_MISMATCH", "Materials search pages disagree about the total match count.");
    }
    if (index < pages.length - 1 && page.truncated !== true) {
      fail("INVALID_PAGE", `Materials search page ${index + 1} ended before a later page.`);
    }
    merged.push(...page.matches);
  }

  const unique = deduplicateSearchMaterials(merged);
  if (unique.length > matchCount!) {
    fail("PAGE_TOTAL_MISMATCH", "Merged materials exceed the declared total match count.");
  }
  const lastPage = pages[pages.length - 1];
  if (!lastPage.truncated && unique.length !== matchCount) {
    fail("PAGE_TOTAL_MISMATCH", "Complete materials pages do not cover the declared total match count.");
  }
  const result: MaterialsSearchResult = {
    ok: true,
    snapshot_id: snapshotId!,
    matches: unique,
    match_count: matchCount!,
    returned_count: unique.length,
    truncated: lastPage.truncated,
  };
  if (lastPage.truncated && lastPage.next_cursor) result.next_cursor = lastPage.next_cursor;
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Revalidate a snapshot-bound selection and construct the exact IPC request. */
export function createMaterialsMaterializeRequest(
  selection: MaterialsDesignSelection,
  chassis: string,
): MaterialsMaterializeRequest {
  if (selection === null || typeof selection !== "object") {
    fail("INVALID_SELECTION", "A materials design selection is required.");
  }
  validateChassis(chassis);
  const rebuilt = createMaterialsDesignSelection(selection.snapshotId, selection.materials);
  if (
    !Array.isArray(selection.resourceIds)
    || !Array.isArray(selection.commonChassis)
    || !sameStrings(selection.resourceIds, rebuilt.resourceIds)
    || !sameStrings(selection.commonChassis, rebuilt.commonChassis)
  ) {
    fail("INVALID_SELECTION", "Materials design selection changed after validation.");
  }
  if (!rebuilt.commonChassis.includes(chassis)) {
    fail("INVALID_CHASSIS", `Selected materials do not share chassis ${chassis}.`);
  }
  return {
    resource_ids: [...rebuilt.resourceIds],
    chassis,
    snapshot: rebuilt.snapshotId,
  };
}
