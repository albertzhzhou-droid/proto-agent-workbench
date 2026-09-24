import attachment from "./fixtures/1GFL.json" with { type: "json" };
import type { ProteinStructureAttachment, ProteinStructureData, ProteinStructureTarget } from "../shared/protein-structures.ts";

export const PREVIEW_PROTEIN_PATH = "build/preview/gfp-reference.ir.json";
export function previewProteinAttachments(target: ProteinStructureTarget): ProteinStructureAttachment[] {
  return target.proteinId === attachment.proteinId && target.sequenceSha256 === attachment.sequenceSha256
    ? [structuredClone(attachment) as ProteinStructureAttachment] : [];
}
export async function readPreviewStructure(input: { target: ProteinStructureTarget; attachmentId: string }): Promise<ProteinStructureData> {
  if(input.attachmentId !== attachment.id || !previewProteinAttachments(input.target).length) throw new Error("This preview attachment does not match the selected protein.");
  const {default:text} = await import("./fixtures/1GFL.cif?raw");
  return {attachment:structuredClone(attachment) as ProteinStructureAttachment,text};
}
export async function readPreviewProtein() {
  const {default:record} = await import("./fixtures/gfp-reference.ir.json");
  return JSON.stringify(record,null,2);
}
