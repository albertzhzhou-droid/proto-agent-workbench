/** Independent acceptance extraction supports the public MCP identifier schema.
 * It does not turn citation identity into evidence for a scientific claim. */
export function returnedPublicationIdentifiers(value) {
  if (typeof value === "string") return /^(?:PMID:|PMCID:|PMC\d|DOI:|10\.\d{4,9}\/)/i.test(value) ? [value.replace(/^(?:PMID|PMCID|DOI):/i, "")] : [];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(returnedPublicationIdentifiers);
  return Object.entries(value).flatMap(([key, item]) => /^(?:pmid|pmcid|doi)$/i.test(key) && ["string", "number"].includes(typeof item)
    ? [String(item).replace(/^(?:PMID|PMCID|DOI):/i, "")]
    : ["source_id", "source_ids", "identifiers"].includes(key) || typeof item === "object" ? returnedPublicationIdentifiers(item) : []);
}
export function checkProviderCitations(receipts, output) {
  return ["proto_pubmed_search", "proto_crossref_search"].every(tool => receipts.filter(result => result.tool === tool && result.ok).some(result => returnedPublicationIdentifiers(result.data).some(id => id.length > 2 && output.toLowerCase().includes(id.toLowerCase()))));
}

export function checkRecordEvidence(records, output, requireSequenceHashes = false) {
  const text=output.toLowerCase(), contains=value=>typeof value==="string"&&value.length>0&&text.includes(value.toLowerCase());
  return records.length>0 && records.every(record=>contains(record.resource_id??record.id)
    && (!requireSequenceHashes || (/^[a-f0-9]{64}$/i.test(record.sequence_sha256??"")&&contains(record.sequence_sha256)))
    && (contains(record.source?.url)||contains(record.source?.record_id)) && contains(record.license?.id));
}

export function classifyAcceptanceOutcome({passed, finalState, hostRecovered, recoveryCounters = {}, failedTool = false, intentionalCheckpointResume = false}) {
  if (!passed) return finalState === "completed" ? "false_completion" : "incomplete";
  const hostRecovery = hostRecovered || recoveryCounters.instanceRebinds > 0 || recoveryCounters.journalReconciliations > 0
    || (recoveryCounters.resumes > 0 && !intentionalCheckpointResume);
  if (hostRecovery) return "host_recovery";
  return intentionalCheckpointResume || failedTool || ["transportRetries", "outputRepairs", "progressRepairs"].some(key => recoveryCounters[key] > 0)
    ? "success_after_retry_or_repair" : "direct_success";
}

/** Freeze these thresholds and classifications before inference. Planned public
 * pause/resume is a model-authored repair scenario, never app-restart evidence. */
export function evaluateMatrixAcceptance(results, scenarios, measuredInputsUnchanged = true) {
  const key = item => `${item.family ?? item.id}:${item.repeat}`;
  const expected = new Set(scenarios.map(key));
  const observed = new Set(results.map(key));
  const counted = results.filter(item => item.status === "passed" && ["direct_success", "success_after_retry_or_repair"].includes(item.outcome) && item.checks?.noHostFallback === true);
  const familyPasses = family => counted.filter(item => item.family === family).length;
  const conditions = {
    completeFrozenMatrix: scenarios.length === 60 && expected.size === 60 && results.length === 60 && observed.size === 60 && [...observed].every(item => expected.has(item)),
    measuredInputsUnchanged,
    modelDirectOrLimitedRepairAtLeast57: counted.length >= 57,
    allFiveGovernedDna: familyPasses("governed_dna") === 5,
    allFiveGovernedProtein: familyPasses("governed_protein") === 5,
    zeroFalseCompletion: results.every(item => item.outcome !== "false_completion"),
    zeroStaticHostFallback: results.every(item => item.checks?.noHostFallback !== false),
  };
  return {schema:"proto-workbench.matrix-gate.v1", passed:Object.values(conditions).every(Boolean), conditions,
    denominator:60, requiredModelSuccesses:57, modelSuccesses:counted.length,
    intentionalCheckpointResume:results.filter(item => item.intentionalCheckpointResume).length,
    allCasesPassed:results.length === 60 && results.every(item => item.status === "passed"),
    classification:"Only independently verified model-authored direct/limited-repair results count. A planned same-service public pause/resume counts as repair only with unchanged budgets, one resume and no journal/instance recovery. Host recovery is excluded; no app restart is claimed."};
}
