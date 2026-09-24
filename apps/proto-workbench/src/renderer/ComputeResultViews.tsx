import { fieldLabel, resultSeries, resultTables } from "./compute-presentation.ts";

const display = (value: unknown) => value === undefined || value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
const tick = (n: number) => Number(n.toPrecision(4)).toString();

export function ComputeResultViews({result}: {result: Record<string, unknown>}) {
  const plot = resultSeries(result), tables = resultTables(result);
  const interval = result.confidence_interval && typeof result.confidence_interval === "object" && !Array.isArray(result.confidence_interval)
    ? result.confidence_interval as Record<string, unknown> : undefined;
  const intervalAvailable = interval?.status === "available" && [interval.lower, interval.upper, interval.estimate, interval.confidence_level].every(value=>typeof value==="number"&&Number.isFinite(value));
  return <>
    {interval&&<section className="analysis-inference" aria-label="Statistical uncertainty">
      <h3>{typeof interval.confidence_level==="number"?`${tick(interval.confidence_level*100)}% confidence interval`:"Confidence interval"}</h3>
      <p>{fieldLabel(String(interval.estimand??"Unspecified estimand"))}</p>
      {intervalAvailable?<><div className="analysis-inference-values"><span>Estimate <strong>{tick(interval.estimate as number)}</strong></span><span>Lower <strong>{tick(interval.lower as number)}</strong></span><span>Upper <strong>{tick(interval.upper as number)}</strong></span></div><p>Method: {fieldLabel(String(interval.method))}. Rounded display; exact values remain in Complete result.</p></>:<p>Unavailable · {String(interval.reason??"No supported interval was reported for this method.")}</p>}
    </section>}
    {Array.isArray(result.warnings)&&<div className="analysis-limitations"><h3>Interpretation notes</h3><ul>{result.warnings.map((note,index)=><li key={index}>{String(note)}</li>)}</ul></div>}
    {Array.isArray(result.assumptions)&&<details className="analysis-limitations"><summary>Statistical assumptions and effect-size scope</summary><ul>{result.assumptions.map((note,index)=><li key={index}>{String(note)}</li>)}</ul></details>}
    {plot && <section className="analysis-traces" aria-label="Computed time series"><h2>Computed trajectories</h2><p>Time in the supplied model units. Each series uses its own vertical scale.</p><div className="analysis-trace-grid">{plot.series.map(([name, values]) => {
      const low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
      const start = plot.times[0], duration = plot.times.at(-1)! - start || 1;
      const points = values.map((v, i) => `${45 + (plot.times[i] - start) / duration * 300},${112 - (v - low) / span * 82}`).join(" ");
      return <figure key={name}><figcaption>{fieldLabel(name)}</figcaption><svg viewBox="0 0 370 145" role="img" aria-label={`${fieldLabel(name)} over time. Values from ${tick(low)} to ${tick(high)}. Exact data in Complete result.`}>
        <path d="M45 25 V112 H345" className="analysis-chart-axis"/>
        <polyline points={points} className="analysis-chart-line"/>
        <text x="40" y="31" textAnchor="end">{tick(high)}</text><text x="40" y="115" textAnchor="end">{tick(low)}</text>
        <text x="45" y="134">{tick(start)}</text><text x="345" y="134" textAnchor="end">{tick(plot.times.at(-1)!)}</text>
      </svg></figure>;
    })}</div></section>}
    {tables.map(table => <details key={table.name} className="analysis-table-section" open={tables.length <= 2}><summary>{fieldLabel(table.name)}<small>{table.total} rows</small></summary><div className="analysis-table-scroll" tabIndex={0} role="region" aria-label={`${fieldLabel(table.name)} table`}><table><thead><tr>{table.columns.map(column => <th key={column} scope="col">{fieldLabel(column)}</th>)}</tr></thead><tbody>{table.rows.map((row, index) => <tr key={index}>{table.columns.map(column => <td key={column} className={typeof row[column] === "number" ? "is-numeric" : undefined}>{display(row[column])}</td>)}</tr>)}</tbody></table></div><p>Showing {table.rows.length} of {table.total} rows and up to 8 scalar columns. Complete data remains in the result JSON.</p></details>)}
  </>;
}
