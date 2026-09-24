/** User-selected development baseline; preference never implies a live instance. */
export const RESEARCH_BASELINE = {
  modelId:"unsloth/qwen3.8-27b",
  displayName:"Qwen 3.8 27B Q4_K_M",
  endpoint:"http://127.0.0.1:1234",
} as const;
export function isResearchBaseline(model:{id:string;providerModelId?:string;quantization:string}):boolean {
  return (model.providerModelId??model.id).toLowerCase()===RESEARCH_BASELINE.modelId && model.quantization.toUpperCase()==="Q4_K_M";
}
