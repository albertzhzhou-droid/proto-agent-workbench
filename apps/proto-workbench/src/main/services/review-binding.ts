import type { ReviewPacketView } from "../../shared/contracts.ts";
import { sha256Canonical } from "./validation-journal.ts";

export function bindReviewToValidation(
  review: ReviewPacketView,
  operationId: string,
  validationPlanSha256: string,
  validationJournalRevision: number,
): ReviewPacketView {
  const bound: ReviewPacketView = {
    ...structuredClone(review),
    operationId,
    validationPlanSha256,
    validationJournalRevision,
  };
  return {
    ...bound,
    packetSha256: reviewPacketSha256(bound),
  };
}

export function reviewBindingMatches(
  review: ReviewPacketView | undefined,
  operationId: string,
  validationPlanSha256: string,
  validationJournalRevision: number,
): boolean {
  return Boolean(
    review
    && review.operationId === operationId
    && review.validationPlanSha256 === validationPlanSha256
    && review.validationJournalRevision === validationJournalRevision
    && typeof review.packetSha256 === "string"
    && review.packetSha256 === reviewPacketSha256(review),
  );
}

export function reviewPacketSha256(review: ReviewPacketView): string {
  return sha256Canonical({
    runId: review.runId,
    operationId: review.operationId,
    validationPlanSha256: review.validationPlanSha256,
    validationJournalRevision: review.validationJournalRevision,
    packetPath: review.packetPath,
    summary: review.summary,
    claims: review.claims,
    checklist: review.checklist.map((item) => ({ id: item.id, label: item.label })),
    unresolvedQuestions: review.unresolvedQuestions,
    safetyBoundary: review.safetyBoundary,
  });
}
