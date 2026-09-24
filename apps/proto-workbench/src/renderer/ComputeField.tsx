import type { ComputeTool } from "../shared/compute.ts";
import { fieldLabel, schemaHint, schemaRows } from "./compute-presentation.ts";

export function ComputeField({tool, name, value, busy, error, onChange}: {
  tool: ComputeTool; name: string; value: string; busy: boolean; error?: string; onChange(value: string): void;
}) {
  const schema = tool.input_schema!.properties![name], file = tool.file_inputs?.[name];
  const required = tool.input_schema?.required?.includes(name);
  const id = `compute-field-${name}`;
  const structured = schema.type === "array" || schema.type === "object";
  const multiline = structured || (!file && /sequence|structure|smiles/.test(name));
  const hint = file ? `${file.list ? "One workspace-relative path per line, in order" : "Path relative to the current workspace"} · ${file.extensions.join(", ")} · up to ${Math.round(file.max_bytes / 1024 / 1024)} MB per file${file.list ? ` · at most ${file.max_files ?? 200} files` : ""}` : schemaHint(schema);
  const shared = {id, disabled: busy, value, "aria-invalid": Boolean(error), "aria-describedby": `${id}-hint${error ? ` ${id}-error` : ""}`, onChange: (event: {target: {value: string}}) => onChange(event.target.value)};
  const nested = schemaRows(schema);
  return <div className={`analysis-field${file ? " analysis-file-field" : ""}`}>
    <label htmlFor={id}>{fieldLabel(name)}<small>{required ? "required" : "optional"}</small></label>
    {schema.enum ? <select {...shared}>
      <option value="">{required ? "Choose a value" : schema.default !== undefined ? `Default · ${String(schema.default)}` : "Default"}</option>
      {schema.enum.map(choice => <option key={String(choice)} value={String(choice)}>{fieldLabel(String(choice))}</option>)}
    </select> : schema.type === "boolean" ? <select {...shared}>
      <option value="">{required ? "Choose a value" : schema.default !== undefined ? `Default · ${schema.default ? "Yes" : "No"}` : "Default"}</option>
      <option value="true">Yes</option><option value="false">No</option>
    </select> : multiline ? <textarea {...shared} spellCheck={false} rows={file ? 4 : structured ? 6 : 4} /> :
      <input {...shared} spellCheck={false} className={file || ["number", "integer"].includes(schema.type) ? "analysis-data-input" : undefined} inputMode={["number", "integer"].includes(schema.type) ? "decimal" : "text"} />}
    <small id={`${id}-hint`}>{[schema.description, hint].filter(Boolean).join(" · ")}</small>
    {error && <small id={`${id}-error`} className="analysis-field-error">{error}</small>}
    {nested.length > 0 && <details className="analysis-field-guide"><summary>Parameter structure</summary><dl>{nested.map(({path, schema: child}) => <div key={path}><dt><code>{path}</code></dt><dd>{child.enum ? child.enum.join(" / ") : schemaHint(child) || child.type}</dd></div>)}</dl></details>}
  </div>;
}
