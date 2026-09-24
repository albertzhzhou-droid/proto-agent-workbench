import type { ComputeDomain, ComputeSchema, ComputeTool } from "../shared/compute.ts";

export const domainTitles: Record<ComputeDomain, string> = {
  statistics: "Statistics & learning", biology: "Biological data", simulation: "Systems & simulations",
  imaging: "Imaging & microscopy", chemistry: "Chemistry",
};
export const fieldLabel = (value: string) => value.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
export const categoryFor = (tool: ComputeTool) => tool.category ?? {id: "other", title: "Other analyses", section: "biology" as const};
export function toolMatches(tool: ComputeTool, query: string) {
  const searchable = [tool.id, tool.title, tool.description, categoryFor(tool).title,
    ...Object.values(tool.file_inputs ?? {}).flatMap(file => file.extensions)].join(" ").toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every(word => searchable.includes(word));
}
export function fieldsFor(tool: ComputeTool, args = tool.example ?? {}): Record<string, string> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key,
    tool.file_inputs?.[key]?.list && Array.isArray(value) ? value.join("\n") :
    typeof value === "string" ? value : JSON.stringify(value, null, 2)]));
}
export class ComputeInputError extends Error {
  field: string;
  constructor(field: string, message: string) { super(message); this.field = field; }
}

export function computeInputsChanged(tool:ComputeTool,fields:Record<string,string>,submitted:Record<string,unknown>):boolean {
  const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'
    ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)])):value;
  try{return JSON.stringify(ordered(requestArguments(tool,fields)))!==JSON.stringify(ordered(submitted));}
  catch{return true;}
}

// Mirrors the registry's small schema vocabulary for immediate field feedback.
// The host validates the request and resolves file containment again before running.
export function validateComputeValue(value: unknown, schema: ComputeSchema, path: string): void {
  const fail = (message: string): never => { throw new Error(`${path} ${message}`); };
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be a JSON object.");
    const record = value as Record<string, unknown>, properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in record)) fail(`is missing ${key}.`);
    for (const [key, item] of Object.entries(record)) {
      if (!Object.hasOwn(properties, key)) fail(`contains unknown field ${key}.`);
      validateComputeValue(item, properties[key], `${path}.${key}`);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) fail("must be a JSON array.");
    const items = value as unknown[];
    if (items.length < (schema.minItems ?? 0) || items.length > (schema.maxItems ?? 5000)) fail(`requires ${schema.minItems ?? 0}–${schema.maxItems ?? 5000} items.`);
    if (schema.items) items.forEach((item, index) => validateComputeValue(item, schema.items!, `${path}[${index}]`));
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e100) fail("must be a finite number within ±1e100.");
    const number = value as number;
    if (type === "integer" && !Number.isInteger(number)) fail("must be a whole number.");
    if (schema.minimum !== undefined && number < schema.minimum) fail(`must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && number > schema.maximum) fail(`must be at most ${schema.maximum}.`);
    if (schema.exclusiveMinimum !== undefined && number <= schema.exclusiveMinimum) fail(`must exceed ${schema.exclusiveMinimum}.`);
    if (schema.exclusiveMaximum !== undefined && number >= schema.exclusiveMaximum) fail(`must be below ${schema.exclusiveMaximum}.`);
  } else if (type === "string") {
    if (typeof value !== "string") fail("must be text.");
    const length = [...value as string].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? 10000)) fail(`requires ${schema.minLength ?? 0}–${schema.maxLength ?? 10000} characters.`);
  } else if (type === "boolean" && typeof value !== "boolean") fail("must be Yes or No.");
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) fail("must be one of the listed choices.");
}

export function requestArguments(tool: ComputeTool, fields: Record<string, string>) {
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.input_schema?.properties ?? {})) {
    const raw = fields[key]?.trim();
    try {
      if (!raw) {
        if (tool.input_schema?.required?.includes(key)) throw new Error(`${fieldLabel(key)} is required.`);
        continue;
      }
      let value: unknown;
      try { value = schema.type === "string" ? raw : tool.file_inputs?.[key]?.list && !raw.startsWith("[") ? raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : JSON.parse(raw); }
      catch { throw new Error(`${fieldLabel(key)} must be valid ${schema.type === "number" || schema.type === "integer" ? "numeric data" : "JSON"}. Check commas, brackets and quotes.`); }
      validateComputeValue(value, schema, fieldLabel(key));
      const declaration = tool.file_inputs?.[key];
      if (declaration) {
        const paths = declaration.list ? value as string[] : [value as string];
        if (paths.length > (declaration.max_files ?? 200)) throw new Error(`Select at most ${declaration.max_files ?? 200} files.`);
        for (const path of paths) {
          if (/^(?:[a-zA-Z]:|[/\\])/.test(path) || path.split(/[/\\]/).includes("..") || path.includes(":")) throw new Error(`${fieldLabel(key)} requires paths relative to the current workspace.`);
          if (!declaration.extensions.some(extension => path.toLowerCase().endsWith(extension))) throw new Error(`${fieldLabel(key)} accepts ${declaration.extensions.join(", ")}.`);
        }
      }
      result[key] = value;
    } catch (error) { throw new ComputeInputError(key, error instanceof Error ? error.message : String(error)); }
  }
  return result;
}

export function schemaHint(schema: ComputeSchema): string {
  const parts = [schema.type === "array" ? `JSON array of ${schema.items ? `${schema.items.type}s` : "values"}${schema.items?.type === "array" ? " · one row per nested array" : ""}` : schema.type === "object" ? "JSON object" : schema.type === "integer" ? "Whole number" : schema.type === "number" ? "Number · scientific notation accepted" : ""];
  if (schema.minItems !== undefined || schema.maxItems !== undefined) parts.push(`${schema.minItems ?? 0}–${schema.maxItems ?? 5000} items`);
  if (schema.minimum !== undefined) parts.push(`min ${schema.minimum}`);
  if (schema.exclusiveMinimum !== undefined) parts.push(`greater than ${schema.exclusiveMinimum}`);
  if (schema.exclusiveMaximum !== undefined) parts.push(`less than ${schema.exclusiveMaximum}`);
  if (schema.maximum !== undefined) parts.push(`max ${schema.maximum}`);
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  return parts.filter(Boolean).join(" · ");
}

export function schemaRows(schema: ComputeSchema, prefix = ""): Array<{ path: string; schema: ComputeSchema }> {
  if (schema.type === "array" && schema.items) return schemaRows(schema.items, `${prefix}[]`);
  return Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [{path, schema: child}, ...schemaRows(child, path)];
  });
}

export type ResultTable = { name: string; columns: string[]; rows: Record<string, unknown>[]; total: number };
const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);
export function resultTables(result: Record<string, unknown>): ResultTable[] {
  return Object.entries(result).flatMap(([name, value]): ResultTable[] => {
    if (Array.isArray(value) && value.length && value.every(row => row && !Array.isArray(row) && typeof row === "object")) {
      const rows = value.slice(0, 50) as Record<string, unknown>[];
      const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].filter(key => rows.every(row => row[key] === undefined || scalar(row[key]))).slice(0, 8);
      return columns.length ? [{name, columns, rows, total: value.length}] : [];
    }
    if (value && !Array.isArray(value) && typeof value === "object") {
      const rows = Object.entries(value).filter(([,item]) => scalar(item)).map(([metric, value]) => ({metric, value}));
      return rows.length ? [{name, columns: ["metric", "value"], rows: rows.slice(0, 50), total: rows.length}] : [];
    }
    return [];
  }).slice(0, 8);
}

export function resultSeries(result: Record<string, unknown>) {
  const numeric = (value: unknown): value is number[] => Array.isArray(value) && value.length > 1 && value.every(v => typeof v === "number" && Number.isFinite(v));
  if (!numeric(result.times)) return undefined;
  const times = result.times;
  const candidates = Object.entries(result).flatMap(([key, value]) => key === "concentration_traces" && value && typeof value === "object" ? Object.entries(value) : [[key, value]]);
  const series = candidates.filter((entry): entry is [string, number[]] => entry[0] !== "times" && numeric(entry[1]) && entry[1].length === times.length).slice(0, 6);
  return series.length ? {times, series} : undefined;
}
