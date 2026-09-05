export interface ReportDocuments {documents: string[]; errors: string[]}

/** Extract actual JSON report blocks while keeping surrounding Markdown as a
 * separate document. This does not let prose donate fields to a JSON record. */
export function expandJsonReportBlocks(documents: string[]): ReportDocuments {
  const result: ReportDocuments = {documents: [], errors: []};
  let blocks = 0;
  for (const document of documents) {
    try {
      const parsed: unknown = JSON.parse(document);
      if (parsed && typeof parsed === "object") {result.documents.push(document); continue;}
    } catch { /* A Markdown report may contain one or more JSON blocks. */ }
    const lines = document.split(/\r?\n/), outside: string[] = [];
    const flushOutside = () => {
      if (outside.some(line => line.trim())) result.documents.push(outside.join("\n"));
      outside.length = 0;
    };
    for (let index = 0; index < lines.length; index += 1) {
      const opener = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/.exec(lines[index]);
      if (!opener) {outside.push(lines[index]); continue;}
      const marker = opener[1][0], minimumLength = opener[1].length;
      let end = index + 1;
      while (end < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[end]);
        if (closing && closing[1][0] === marker && closing[1].length >= minimumLength) break;
        end += 1;
      }
      const body = lines.slice(index + 1, end).join("\n");
      const json = opener[2].toLowerCase() === "json" || !opener[2] && /^[\s]*[\[{]/.test(body);
      if (!json) {outside.push(...lines.slice(index, Math.min(end + 1, lines.length))); index = end; continue;}
      flushOutside();
      if (++blocks > 128) {result.errors.push("JSON report block count exceeds 128; use a smaller report."); break;}
      if (end === lines.length) result.errors.push("A JSON report code block is unclosed; preserve its complete JSON and closing fence before completion.");
      else {
        try {
          const parsed: unknown = JSON.parse(body);
          if (!parsed || typeof parsed !== "object") throw new Error("Expected an object or array.");
          result.documents.push(body);
        } catch {result.errors.push("A JSON report code block is incomplete or invalid; use a complete JSON object or array before completion.");}
      }
      index = end;
    }
    flushOutside();
  }
  return result;
}
