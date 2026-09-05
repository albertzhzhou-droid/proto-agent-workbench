/** Sentence boundaries preserve filenames, dotted identifiers and URLs. */
export function positiveMissionClauses(goal: string): string[] {
  return goal.split(/(?:[!?。；;\n]+|\.(?=\s|$))/u).map(clause => clause.trim()).filter(clause => Boolean(clause) && !/^(?:do not|don't|never|不要|不得|无需)/i.test(clause));
}
