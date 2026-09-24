import type { SchemaMigrationReport } from "./storage-migrations.ts";
import {z} from 'zod';
import type {ComputeStudyRunBinding,ComputeStudySourceFreshness} from './compute-studies.ts';
const uuid=z.string().uuid(),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const pointer=z.string().max(512).refine(value=>value===''||value.startsWith('/'),'Use a JSON pointer.');
export const FigureSelectorSchema=z.object({from:z.enum(['input','result']),pointer,field:pointer.optional()}).strict();
export type FigureSelector=z.infer<typeof FigureSelectorSchema>;
export const FigurePanelDraftSchema=z.object({id:uuid,runId:z.string().regex(/^[a-f0-9]{32}$/),title:z.string().trim().min(1).max(160),kind:z.enum(['line','scatter','bar']),xLabel:z.string().max(120),yLabel:z.string().max(120),xUnit:z.string().max(64),yUnit:z.string().max(64),y:FigureSelectorSchema,x:FigureSelectorSchema.optional()}).strict();
export const FigureDraftSchema=z.object({title:z.string().trim().min(1).max(160),caption:z.string().max(4000),columns:z.union([z.literal(1),z.literal(2)]),panels:z.array(FigurePanelDraftSchema).min(1).max(6).refine(panels=>new Set(panels.map(panel=>panel.id)).size===panels.length,'Panel IDs must be unique.')}).strict();
export type FigurePanelDraft=z.infer<typeof FigurePanelDraftSchema>;
export type FigureDraft=z.infer<typeof FigureDraftSchema>;
export const ResearchFiguresRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('list'),studyId:uuid}).strict(),
 z.object({action:z.literal('series'),studyId:uuid,runId:z.string().regex(/^[a-f0-9]{32}$/)}).strict(),
 z.object({action:z.literal('get'),studyId:uuid,figureId:uuid}).strict(),
 z.object({action:z.literal('save'),studyId:uuid,expectedStudyRevision:revision,figureId:uuid.optional(),expectedRevision:revision.optional(),draft:FigureDraftSchema}).strict(),
 z.object({action:z.literal('rebind'),studyId:uuid,figureId:uuid,expectedRevision:revision,expectedStudyRevision:revision,panelIds:z.array(uuid).min(1).max(6)}).strict(),
 z.object({action:z.literal('inspect'),studyId:uuid,figureId:uuid}).strict(),
 z.object({action:z.literal('export'),studyId:uuid,figureId:uuid,expectedRevision:revision,expectedStudyRevision:revision,acknowledgeChangedSources:z.boolean()}).strict(),
 z.object({action:z.literal('artifact'),studyId:uuid,figureId:uuid,exportId:z.string().regex(/^[a-f0-9]{32}$/),format:z.enum(['svg','pdf','csv','data','methods','methods-json'])}).strict(),
]);
export type ResearchFiguresRequest=z.infer<typeof ResearchFiguresRequestSchema>;
export interface FigurePanel extends FigurePanelDraft {binding:ComputeStudyRunBinding}
export interface ResearchFigure extends Omit<FigureDraft,'panels'> {id:string;studyId:string;revision:number;createdAt:string;updatedAt:string;change:'create'|'edit'|'rebind';panels:FigurePanel[]}
export interface ResearchFigureSummary {id:string;studyId:string;revision:number;title:string;panelCount:number;updatedAt:string}
export interface FigureSeries {selector:FigureSelector;label:string;length:number;kind:'numeric'|'categorical'}
export interface FigurePoint {x:number|string;y:number}
export interface FigurePanelView {id:string;status:'ready'|'source-changed'|'binding-changed'|'unavailable'|'invalid-selection';message:string;points?:FigurePoint[];sourceFreshness?:ComputeStudySourceFreshness}
export interface FigureInspection {figure:ResearchFigure;panels:FigurePanelView[];canExport:boolean;requiresSourceAcknowledgement:boolean;methodsMarkdown:string;methods:Record<string,unknown>}
export interface FigureExportFile {format:'svg'|'pdf'|'csv'|'data'|'methods'|'methods-json';path:string;sha256:string;bytes:number;mimeType:string}
export interface ResearchFigureExport {exportId:string;figureId:string;figureRevision:number;createdAt:string;files:FigureExportFile[];manifestPath:string;manifestSha256:string}
export interface ResearchFiguresResponse {migrationReport?:SchemaMigrationReport;figures?:ResearchFigureSummary[];figure?:ResearchFigure;series?:FigureSeries[];seriesTruncated?:boolean;inspection?:FigureInspection;export?:ResearchFigureExport;exports?:ResearchFigureExport[];artifact?:{name:string;mimeType:string;base64:string;sha256:string}}
