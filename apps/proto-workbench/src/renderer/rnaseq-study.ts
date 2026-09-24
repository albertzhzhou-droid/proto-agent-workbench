import {z} from "zod";

export const RNASEQ_VIEW_LIMITS={genes:100000,samples:100,tablePage:50} as const;
const finite=z.number().finite().min(-1e100).max(1e100),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text=(max=4000)=>z.string().max(max).refine(value=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const id=text(256).min(1),sha=z.string().regex(/^[a-f0-9]{64}$/);
const path=z.string().min(1).max(1024).transform(value=>value.replaceAll("\\","/")).refine(value=>!/[\x00-\x1f\x7f:]/.test(value)&&!value.startsWith("/")&&value.split("/").every(part=>part!==""&&part!=="."&&part!==".."));
const source=z.object({path,sha256:sha,bytes:count.min(1).max(32*1024*1024),snapshot:path.optional()}).strict();
const probability=finite.min(0).max(1),geneIds=z.array(id).max(RNASEQ_VIEW_LIMITS.genes);
const contrast=z.object({numerator:id,denominator:id}).strict();
const sampleBase={sample:id,condition:id,batch:id.optional(),subject:id.optional()};
const differentialRow=z.object({gene_id:id,baseMean:finite.min(0).nullable(),log2FoldChange:finite.nullable(),lfcSE:finite.min(0).nullable(),stat:finite.nullable(),pvalue:probability.nullable(),padj:probability.nullable(),status:text(200).min(1)}).strict();
const enrichmentSchema=z.object({status:z.enum(["not-requested","completed","empty-selection","no-background","no-contrast","not-run"]),method:z.literal("hypergeometric ORA with Benjamini-Hochberg correction"),background_rule:z.literal("genes with finite adjusted p-value in this contrast"),selection_rule:z.literal("padj < alpha; both directions"),gene_set_source:z.object({namespace:text(1000),source:text(4000)}).strict().optional(),selected_genes:geneIds.optional(),background_genes:geneIds.optional(),tested_gene_sets:count.max(200).optional(),rows:z.array(z.object({name:id,set_size_in_background:count.max(5000),excluded_members_outside_background:count.max(5000),overlap_count:count.max(5000),overlap_genes:z.array(id).max(5000),expected_overlap:finite.min(0),fold_enrichment:finite.min(0).nullable(),p_value:probability,adjusted_p_value:probability}).strict()).max(200).optional(),reason:text().optional()}).strict();
const resultSchema=z.object({
  schema_version:z.literal("proto-agent.rnaseq-study.v1"),
  analysis:z.object({mode:z.enum(["validate","fit"]),status:z.enum(["validated","complete"]),engine_run_id:z.string().regex(/^[a-f0-9]{32}$/).optional(),manifest_path:path.optional(),manifest_sha256:sha.optional(),runtime:z.record(z.string(),z.unknown()).optional(),engine_artifacts:z.array(z.object({path,sha256:sha,bytes:count}).strict()).max(100).optional(),engine_metadata:z.record(id,text(4000)).optional()}).strict(),
  sources:z.object({counts_path:source,samples_path:source,gene_sets_path:source.optional()}).strict(),
  design:z.object({id:z.enum(["condition","batch_condition","subject_condition"]),formula:text(256),columns:z.array(id).min(1).max(200),rank:count.max(200),residual_df:count.max(200),contrast:contrast.extend({factor:z.literal("condition")}).strict(),factor_levels:z.record(id,z.array(id).min(1).max(200))}).strict(),
  qc:z.object({samples:z.array(z.object({...sampleBase,library_size:count,detected_genes:count.max(RNASEQ_VIEW_LIMITS.genes),zero_fraction:probability,size_factor:finite.gt(0).optional()}).strict()).min(1).max(RNASEQ_VIEW_LIMITS.samples),gene_count:count.min(1).max(RNASEQ_VIEW_LIMITS.genes),sample_count:count.min(1).max(RNASEQ_VIEW_LIMITS.samples),all_zero_genes:geneIds,metadata_reordered:z.boolean(),condition_counts:z.record(id,count)}).strict(),
  filter:z.object({min_count:count,min_samples:count.min(1).max(RNASEQ_VIEW_LIMITS.samples),input_genes:count.max(RNASEQ_VIEW_LIMITS.genes),kept_genes:count.max(RNASEQ_VIEW_LIMITS.genes),excluded_genes:geneIds}).strict(),
  pca:z.object({samples:z.array(z.object({...sampleBase,pc1:finite,pc2:finite}).strict()).min(1).max(RNASEQ_VIEW_LIMITS.samples),variance_fraction:z.tuple([probability,probability]),genes:geneIds,transform:z.literal("DESeq2 varianceStabilizingTransformation blind=FALSE"),center:z.literal(true),scale:z.literal(false)}).strict().nullable(),
  differential_expression:z.object({rows:z.array(differentialRow).max(RNASEQ_VIEW_LIMITS.genes),alpha:probability,contrast,summary:z.object({modeled:count,pvalue_available:count,padj_available:count,significant_up:count,significant_down:count,significant_zero:count}).strict()}).strict().nullable(),
  enrichment:enrichmentSchema,
  warnings:z.array(text()).max(200),limitations:z.array(text()).max(200),
}).strict();
const requestSchema=z.object({counts_path:path,samples_path:path,reference_level:id,comparison_level:id,design:z.enum(["condition","batch_condition","subject_condition"]).default("condition"),analysis_mode:z.enum(["validate","fit"]).default("fit"),alpha:finite.min(.001).max(.5).default(.05),min_count:count.max(1000000).default(10),min_samples:count.min(1).max(100).default(2),pca_top_genes:count.min(2).max(5000).default(500),size_factor_type:z.enum(["ratio","poscounts"]).default("ratio"),gene_sets_path:path.optional()}).strict();
const receiptSchema=z.object({ok:z.literal(true),tool:z.literal("analyze_rnaseq_study"),run_id:z.string().regex(/^[a-f0-9]{32}$/),result_sha256:sha,inputs:z.record(z.string(),z.unknown()),preview:z.literal(false).optional()});
const previewSchema=z.object({ok:z.literal(true),tool:z.literal("analyze_rnaseq_study"),preview:z.literal(true),result:z.record(z.string(),z.unknown())}).strict();
export type RnaSeqStudy=z.infer<typeof resultSchema>;
export type RnaSeqDifferentialRow=z.infer<typeof differentialRow>;
export type RnaSeqPlotPoint={id:string;x:number;y:number;group:string};
/** Locale grouping must not apply its default three fractional-digit rounding.
 * Keep unavailable, exact zero and a small recorded nonzero value distinct. */
export function rnaSeqDisplayValue(value:number|null|undefined,locale?:string):string {
  if(value===null||value===undefined)return "Unavailable";
  if(!Number.isFinite(value))throw Error("RNA-seq display requires a finite number or an unavailable value.");
  if(value===0)return "0";
  return Math.abs(value)<.0001?value.toExponential(5):value.toLocaleString(locale,{maximumSignificantDigits:6});
}
const fail=(message:string):never=>{throw Error(`RNA-seq result: ${message}`);};
function unique(values:string[],message:string){if(new Set(values).size!==values.length)fail(message);}
function boundedRuntime(value:unknown){let nodes=0;const visit=(item:unknown,depth:number):void=>{if(++nodes>20000||depth>12)fail("runtime metadata exceeds its display bound.");if(item===null||typeof item==="boolean")return;if(typeof item==="number"){if(!Number.isFinite(item))fail("runtime metadata contains a non-finite number.");return;}if(typeof item==="string"){if(item.length>16000)fail("runtime metadata text exceeds its bound.");return;}if(Array.isArray(item)){item.forEach(next=>visit(next,depth+1));return;}if(item&&typeof item==="object"){for(const [key,next]of Object.entries(item)){if(["__proto__","prototype","constructor"].includes(key))fail("unsupported runtime metadata key.");visit(next,depth+1);}return;}fail("unsupported runtime metadata value.");};visit(value,0);}

/** Validate associations and display shape after the caller verifies the saved bytes.
 * These checks do not establish a correct biological design or scientific validity. */
export function validateRnaSeqStudy(value:unknown,requested:unknown,receipt:unknown):RnaSeqStudy {
  const parsed=resultSchema.safeParse(value),request=requestSchema.safeParse(requested);
  const preview=typeof receipt==="object"&&receipt!==null&&"preview"in receipt&&receipt.preview===true;
  const run=receiptSchema.safeParse(receipt);
  if(!parsed.success||!request.success||(!preview&&!run.success)||(preview&&!previewSchema.safeParse(receipt).success))fail("the study, request or execution receipt has an unsupported or malformed contract.");
  const result=parsed.data!,args=request.data!;
  if(result.analysis.runtime)boundedRuntime(result.analysis.runtime);
  if(result.analysis.engine_metadata&&Object.keys(result.analysis.engine_metadata).length>200)fail("engine metadata exceeds its field bound.");
  for(const field of ["counts_path","samples_path","gene_sets_path"]as const){const file=result.sources[field];if(Boolean(file)!==Boolean(args[field])||file&&file.path!==args[field])fail("source paths do not match the requested files.");if(file&&!preview){const claim=z.object({path,sha256:sha}).safeParse(run.data!.inputs[`file:${field}`]);if(!claim.success||claim.data.path!==file.path||claim.data.sha256!==file.sha256)fail("source identities do not match the execution receipt.");}if(file&&!file.path.toLowerCase().endsWith(field==="gene_sets_path"?".json":".csv"))fail("source type is unsupported.");if(file?.snapshot&&!new RegExp(`^build/rnaseq-inputs/[a-f0-9]{32}/${field}\\.${field==="gene_sets_path"?"json":"csv"}$`).test(file.snapshot))fail("source snapshot identity is unsupported.");}
  if(args.reference_level===args.comparison_level||result.analysis.mode!==args.analysis_mode||result.design.id!==args.design||result.design.contrast.numerator!==args.comparison_level||result.design.contrast.denominator!==args.reference_level)fail("mode, design or contrast does not match the saved request.");
  const expectedFormula={condition:"~condition",batch_condition:"~batch+condition",subject_condition:"~subject+condition"}[args.design];
  if(result.design.formula.replaceAll(/\s/g,"")!==expectedFormula)fail("the recorded formula does not match the selected design.");
  const {qc,filter,design,pca}=result;
  unique(qc.samples.map(row=>row.sample),"duplicate sample IDs.");unique(qc.all_zero_genes,"duplicate all-zero gene IDs.");unique(filter.excluded_genes,"duplicate excluded gene IDs.");unique(design.columns,"duplicate design columns.");
  if(qc.sample_count<4||qc.samples.length!==qc.sample_count||qc.all_zero_genes.length>qc.gene_count||filter.input_genes!==qc.gene_count||filter.kept_genes<2||filter.kept_genes+filter.excluded_genes.length!==filter.input_genes||filter.min_count!==args.min_count||filter.min_samples!==args.min_samples||filter.min_samples>qc.sample_count)fail("QC dimensions or filtering totals contradict the saved request.");
  if(design.rank!==design.columns.length||design.rank>qc.sample_count||design.residual_df<1||design.residual_df!==qc.sample_count-design.rank)fail("design rank and residual degrees of freedom do not correspond.");
  const conditions:Record<string,number>=Object.create(null);
  for(const row of qc.samples){conditions[row.condition]=(conditions[row.condition]??0)+1;if(row.detected_genes>qc.gene_count||Math.abs(row.zero_fraction-(1-row.detected_genes/qc.gene_count))>1e-10)fail("sample QC counts and zero fractions do not correspond.");for(const factor of ["batch","subject"]as const)if(args.design===`${factor}_condition`&&!row[factor])fail(`the selected design lacks a ${factor} identity.`);}
  if(Object.keys(conditions).length!==Object.keys(qc.condition_counts).length||Object.entries(conditions).some(([key,n])=>qc.condition_counts[key]!==n)||(conditions[args.reference_level]??0)<2||(conditions[args.comparison_level]??0)<2)fail("condition counts or requested levels do not match the sample metadata.");
  for(const [factor,levels]of Object.entries(design.factor_levels)){unique(levels,"duplicate factor levels.");if(!["condition","batch","subject"].includes(factor))fail("unsupported design factor.");const observed=new Set(qc.samples.map(row=>row[factor as "condition"|"batch"|"subject"]));if(observed.has(undefined)||observed.size!==levels.length||levels.some(level=>!observed.has(level)))fail("factor levels do not correspond to the sample metadata.");}
  if(!design.factor_levels.condition?.includes(args.reference_level)||!design.factor_levels.condition?.includes(args.comparison_level))fail("contrast levels are absent from the design.");
  if(Boolean(args.gene_sets_path)===(result.enrichment.status==="not-requested"))fail("enrichment availability contradicts the supplied gene-set file.");
  if(args.analysis_mode==="validate"){if(result.analysis.status!=="validated"||pca!==null||result.differential_expression!==null||args.gene_sets_path&&result.enrichment.status!=="not-run")fail("validation-only results cannot claim a fitted analysis.");}
  else {
    const de=result.differential_expression;if(result.analysis.status!=="complete"||!pca||!de)fail("a completed fit is missing its PCA or differential-expression output.");
    if(de!.alpha!==args.alpha||de!.contrast.numerator!==args.comparison_level||de!.contrast.denominator!==args.reference_level)fail("differential-expression contrast or alpha does not match the request.");
    unique(de!.rows.map(row=>row.gene_id),"duplicate differential-expression gene IDs.");
    const excluded=new Set(filter.excluded_genes),genes=new Set(de!.rows.map(row=>row.gene_id));
    if(de!.rows.length!==filter.kept_genes||de!.rows.some(row=>excluded.has(row.gene_id)))fail("modeled genes do not correspond to the recorded filtering totals.");
    const summary={modeled:de!.rows.length,pvalue_available:0,padj_available:0,significant_up:0,significant_down:0,significant_zero:0};
    for(const row of de!.rows){const expectedStatus=row.baseMean===0?"all_zero":row.pvalue===null?"p_value_unavailable":row.padj===null?"adjusted_p_value_unavailable":"available";if(row.status!==expectedStatus||row.padj!==null&&row.pvalue===null)fail("gene availability status contradicts its numeric values.");if(row.pvalue!==null)summary.pvalue_available++;if(row.padj!==null)summary.padj_available++;if(row.padj!==null&&row.padj<de!.alpha&&row.log2FoldChange!==null)summary[row.log2FoldChange>0?"significant_up":row.log2FoldChange<0?"significant_down":"significant_zero"]++;}
    for(const key of Object.keys(summary)as Array<keyof typeof summary>)if(summary[key]!==de!.summary[key])fail("differential-expression summary does not match its retained rows.");
    unique(pca!.genes,"duplicate PCA gene IDs.");unique(pca!.samples.map(row=>row.sample),"duplicate PCA sample IDs.");
    if(pca!.genes.length<2||pca!.genes.length>args.pca_top_genes||pca!.genes.some(gene=>!genes.has(gene))||pca!.samples.length!==qc.samples.length||pca!.variance_fraction.reduce((a,b)=>a+b,0)>1+1e-8)fail("PCA dimensions or variance fractions are inconsistent.");
    for(let i=0;i<qc.samples.length;i++)for(const field of ["sample","condition","batch","subject"]as const)if(pca!.samples[i][field]!==qc.samples[i][field])fail("PCA sample identities do not match the saved QC order.");
    const enrichment=result.enrichment;
    if(args.gene_sets_path){
      if(enrichment.status==="not-run")fail("a completed fit cannot leave requested enrichment unassessed.");
      const background=de!.rows.filter(row=>row.padj!==null).map(row=>row.gene_id),selected=de!.rows.filter(row=>row.padj!==null&&row.padj<de!.alpha).map(row=>row.gene_id);
      for(const [actual,expected]of [[enrichment.background_genes,background],[enrichment.selected_genes,selected]]as const){if(!actual)fail("enrichment gene identities are missing.");unique(actual!,"duplicate enrichment gene IDs.");const ids=new Set(expected);if(actual!.length!==expected.length||actual!.some(gene=>!ids.has(gene)))fail("enrichment genes do not match the stated background and selection rules.");}
      const selectedSet=new Set(selected),backgroundSet=new Set(background);
      const expectedStatus=!background.length?"no-background":!selected.length?"empty-selection":selected.length===background.length?"no-contrast":"completed";
      if(enrichment.status!==expectedStatus)fail("enrichment status contradicts its declared gene selection.");
      if(enrichment.status==="completed"&&(!background.length||!selected.length||selected.length===background.length||!enrichment.rows||enrichment.tested_gene_sets!==enrichment.rows.length))fail("completed enrichment lacks a valid comparison or complete tested-set inventory.");
      const names=(enrichment.rows??[]).map(row=>row.name);unique(names,"duplicate enrichment set names.");
      for(const row of enrichment.rows??[]){unique(row.overlap_genes,"duplicate overlap gene IDs.");if(row.overlap_genes.length!==row.overlap_count||row.overlap_count>row.set_size_in_background||row.set_size_in_background>background.length||row.overlap_genes.some(gene=>!selectedSet.has(gene)||!backgroundSet.has(gene)))fail("enrichment overlap identities are inconsistent.");}
    }
  }
  return result;
}

/** No missing-value imputation or synthetic logarithm floor. Every exclusion is counted. */
export function rnaSeqGenePlot(rows:RnaSeqDifferentialRow[],kind:"volcano"|"ma",alpha:number){
  const points:RnaSeqPlotPoint[]=[],excluded={missing:0,zeroAdjustedP:0,zeroBaseMean:0};
  for(const row of rows){if(row.log2FoldChange===null||(kind==="volcano"?row.padj===null:row.baseMean===null)){excluded.missing++;continue;}if(kind==="volcano"&&row.padj===0){excluded.zeroAdjustedP++;continue;}if(kind==="ma"&&row.baseMean===0){excluded.zeroBaseMean++;continue;}
    points.push({id:row.gene_id,x:kind==="volcano"?row.log2FoldChange:Math.log10(row.baseMean!),y:kind==="volcano"?-Math.log10(row.padj!):row.log2FoldChange,group:row.padj!==null&&row.padj<alpha?(row.log2FoldChange>0?"Higher":row.log2FoldChange<0?"Lower":"Zero fold change"):row.padj===null?"Adjusted p unavailable":"Other"});
  }
  return {points,total:rows.length,excluded};
}
export function rnaSeqGenePage(rows:RnaSeqDifferentialRow[],query:string,page:number){const needle=query.trim().toLocaleLowerCase(),matches=needle?rows.filter(row=>row.gene_id.toLocaleLowerCase().includes(needle)):rows,totalPages=Math.max(1,Math.ceil(matches.length/RNASEQ_VIEW_LIMITS.tablePage)),current=Math.min(Math.max(0,Number.isSafeInteger(page)?page:0),totalPages-1),start=current*RNASEQ_VIEW_LIMITS.tablePage;return {rows:matches.slice(start,start+RNASEQ_VIEW_LIMITS.tablePage),matching:matches.length,total:rows.length,page:current,totalPages,start};}
