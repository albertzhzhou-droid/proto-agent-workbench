import { create } from "zustand";
import type { ResearchChatRequest, ResearchChatResponse, ResearchChatSession, ResearchChatRecoveryIssue, ResearchMessagePage } from "../shared/research-chat.ts";
import type { ModelDescriptor } from "../shared/contracts.ts";
import { workbenchApi } from "./mock-api.ts";
import {isResearchBaseline} from "../shared/research-baseline.ts";
import {canAcceptResearchSession,isCurrentResearchSelection} from "./research-chat-client-state.ts";
import {applySessionListPage,emptySessionList,SESSION_PAGE_SIZE,SESSION_WINDOW_LIMIT,type SessionListMode,type SessionListState} from "./research-chat-paging.ts";

interface ChatState extends SessionListState {
  session?: ResearchChatSession; models: ModelDescriptor[];
  messagePage?: ResearchMessagePage; messagePageBusy:boolean;
  recoveryIssues: ResearchChatRecoveryIssue[];
  recoveryIssueCount: number; listBusy: boolean; listError?: string;
  error?: string; modelError?: string; busy: boolean; selectedModel: string;
  draft: string; selectedDocuments: string[];
  workflow: import("../shared/research-chat.ts").ResearchWorkflow; toolsEnabled:boolean; networkEnabled:boolean; codeExecutionEnabled:boolean;
  setDraft(value: string): void; setModel(value: string): void; selectDocuments(value: string[]): void;
  refresh(): Promise<void>; refreshModels(): Promise<void>; select(id: string): Promise<void>;
  reloadSessions(): Promise<void>; loadOlderSessions(): Promise<void>; nextSessionWindow(): Promise<void>;
  newChat(): Promise<void>; send(): Promise<void>; cancel(): Promise<void>; connect(instanceId?: string): Promise<void>;
  recover(confirmUnowned?: true): Promise<void>;
  loadOlderMessages(): Promise<void>;
  request(input: ResearchChatRequest): Promise<import("../shared/research-chat.ts").ResearchChatResponse>;
  reset(): void;
}
let epoch = 0;
let selectionGeneration = 0;
let selectionTarget = "";
let busyOperationGeneration = 0;
let listRequestGeneration = 0;
let sessionReadGeneration = 0;
let messageReadGeneration = 0;
const initial = { ...emptySessionList(), models: [], recoveryIssues: [], recoveryIssueCount:0, listBusy:false, messagePageBusy:false, selectedModel: "", draft: "", selectedDocuments: [], busy: false,workflow:"explore" as const,toolsEnabled:true,networkEnabled:true,codeExecutionEnabled:true };

function mergeTranscriptPage(previous:ResearchChatSession|undefined,previousPage:ResearchMessagePage|undefined,next:ResearchChatSession,page:ResearchMessagePage|undefined):{session:ResearchChatSession;page?:ResearchMessagePage} {
  if(!page||previous?.id!==next.id||!previousPage||previousPage.totalMessages>page.totalMessages)return {session:next,page};
  const messagesByIndex=new Map<number,ResearchChatSession["messages"][number]>();
  previous.messages.forEach((message,index)=>messagesByIndex.set(previousPage.startIndex+index,message));
  page.messages.forEach((message,index)=>{
    const position=page.startIndex+index,older=messagesByIndex.get(position);
    if(older&&older.id!==message.id)messagesByIndex.clear();
    messagesByIndex.set(position,message);
  });
  if(!messagesByIndex.size)return {session:next,page};
  const indices=[...messagesByIndex.keys()].sort((a,b)=>a-b),startIndex=indices[0],endIndex=indices.at(-1)!;
  if(indices.length!==endIndex-startIndex+1)return {session:next,page};
  const mergedPage={...page,startIndex,nextCursor:startIndex===page.startIndex?page.nextCursor:previousPage.nextCursor};
  return {session:{...next,messages:indices.map(index=>messagesByIndex.get(index)!)},page:mergedPage};
}
export const useResearchChat = create<ChatState>((set,get) => {
  const scope=()=>({epoch,selection:selectionGeneration,sessionId:get().session?.id});
  const current=(token:ReturnType<typeof scope>)=>token.epoch===epoch&&token.selection===selectionGeneration&&token.sessionId===get().session?.id;
  const beginBusy=()=>({...scope(),operation:++busyOperationGeneration});
  const currentBusy=(token:ReturnType<typeof beginBusy>)=>current(token)&&token.operation===busyOperationGeneration;
  const adoptCreated=(token:ReturnType<typeof beginBusy>,session:ResearchChatSession|undefined)=>{
    // request(create) advances the selection only when its original selection
    // is still current. An intervening selection must cancel a pending send.
    if(!session||token.epoch!==epoch||token.operation!==busyOperationGeneration
      ||selectionGeneration!==token.selection+1||get().session?.id!==session.id)return false;
    token.selection=selectionGeneration;token.sessionId=session.id;return true;
  };
  const loadList=async(mode:SessionListMode,supplied?:Extract<ResearchChatRequest,{action:"list"}>):Promise<ResearchChatResponse>=>{
    const previous=get();
    if(previous.listBusy&&mode!=="reset")return {};
    const older=mode==="older"||mode==="window";
    if(older&&(!previous.listNextCursor||previous.listChanged||mode==="older"&&previous.sessions.length>=SESSION_WINDOW_LIMIT))return {};
    if(mode==="window"&&previous.sessions.length<SESSION_WINDOW_LIMIT)return {};
    if(supplied?.cursor&&supplied.cursor!==previous.listNextCursor)throw new Error("This conversation cursor is no longer current. Refresh the list.");
    const token={epoch,request:++listRequestGeneration};
    const active=()=>token.epoch===epoch&&token.request===listRequestGeneration;
    set({listBusy:true,listError:undefined});
    try {
      const limit=Math.min(SESSION_PAGE_SIZE,supplied?.limit??SESSION_PAGE_SIZE,mode==="older"?SESSION_WINDOW_LIMIT-previous.sessions.length:SESSION_PAGE_SIZE);
      const result=await workbenchApi().chat.request({action:"list",limit,...(older?{cursor:previous.listNextCursor!}:{})});
      if(!active())return result;
      if(older&&(get().listGeneration!==previous.listGeneration||get().listNextCursor!==previous.listNextCursor))return result;
      const next=applySessionListPage(get(),result,mode);
      set({...next,...(result.recoveryIssues?{recoveryIssues:result.recoveryIssues.slice(0,50),recoveryIssueCount:result.recoveryIssueCount??result.recoveryIssues.length}:{})});
      return result;
    }catch(error){if(active())set({listError:error instanceof Error?error.message:String(error)});throw error;}
    finally{if(active())set({listBusy:false});}
  };
  return ({
  ...initial,
  reset() { epoch++; selectionGeneration++; busyOperationGeneration++; listRequestGeneration++; sessionReadGeneration++; messageReadGeneration++; selectionTarget=""; set({...initial,session:undefined,messagePage:undefined,error:undefined,modelError:undefined,listError:undefined}); },
  setDraft: draft => set({draft}), setModel: selectedModel => set({selectedModel}), selectDocuments: selectedDocuments => set({selectedDocuments}),
  async request(input) {
    if(input.action==="list")return loadList(input.cursor?"older":"poll",input);
    const generation = epoch;
    const selection = selectionGeneration;
    const readGeneration=input.action==="get"?++sessionReadGeneration:undefined;
    const result = await workbenchApi().chat.request(input);
    if (generation !== epoch) throw new Error("Workspace changed while Chat was updating.");
    const current=get().session;
    const selectingCreated=input.action==="create"&&selection===selectionGeneration;
    if (result.session && selection===selectionGeneration && (readGeneration===undefined||readGeneration===sessionReadGeneration) && (result.session.id===current?.id || !current || selectingCreated)
      && canAcceptResearchSession(current?.id===result.session.id?current:undefined,result.session)) {
      if(selectingCreated){selectionGeneration++;selectionTarget=result.session.id;}
      const merged=mergeTranscriptPage(current,get().messagePage,result.session,result.messagePage);
      set({session:merged.session,messagePage:merged.page,error:undefined});
    }
    if (result.models) set({models:result.models,modelError:undefined});
    if (result.recoveryIssues&&selection===selectionGeneration) set({recoveryIssues:result.recoveryIssues.slice(0,50),recoveryIssueCount:result.recoveryIssueCount??result.recoveryIssues.length});
    return result;
  },
  async refresh() {
    const token=scope();
    const active=()=>token.epoch===epoch&&(!token.sessionId||current(token));
    try {await get().request({action:"list"});}catch{/* List errors stay in the navigation; selected-session refresh remains independent. */}
    if(token.sessionId&&active())try {await get().request({action:"get",sessionId:token.sessionId});}
    catch(error){if(active())set({error:error instanceof Error?error.message:String(error)});}
  },
  async reloadSessions(){try{await loadList("reset");}catch{/* loadList retains the scoped error. */}},
  async loadOlderSessions(){try{await loadList("older");}catch{/* loadList retains the scoped error. */}},
  async nextSessionWindow(){try{await loadList("window");}catch{/* loadList retains the scoped error. */}},
  async refreshModels() {
    const generation = epoch;
    try {
      const result = await get().request({action:"models"});
      if (generation !== epoch) return;
      const models = (result.models ?? []).filter(model => model.modelKind !== "embedding");
      const selected = models.find(model => model.id === get().selectedModel);
      set({models,selectedModel:selected?.id ?? models.find(isResearchBaseline)?.id ?? "", modelError:undefined});
    } catch(error) { if (generation === epoch) set({models:[],selectedModel:"",modelError:error instanceof Error ? error.message : String(error)}); }
  },
  async select(id) {
    const token={workspaceGeneration:epoch,selectionGeneration:++selectionGeneration,sessionId:id};
    const operation=++busyOperationGeneration;
    selectionTarget=id;
    set({busy:true});
    const currentToken=()=>({workspaceGeneration:epoch,selectionGeneration,sessionId:selectionTarget});
    try {
      const result = await workbenchApi().chat.request({action:"get",sessionId:id});
      const current=get().session;
      if (result.session && isCurrentResearchSelection(token,currentToken(),result.session.id)
        && canAcceptResearchSession(current?.id===id?current:undefined,result.session)) {
        const merged=mergeTranscriptPage(current,get().messagePage,result.session,result.messagePage);
        set({session:merged.session,messagePage:merged.page,draft:"",selectedDocuments:[],error:undefined,selectedModel:result.session.modelId ?? get().selectedModel});
      }
    } catch(error) {if(isCurrentResearchSelection(token,currentToken()))set({error:String(error)});}
    finally {if(operation===busyOperationGeneration&&isCurrentResearchSelection(token,currentToken()))set({busy:false});}
  },
  async loadOlderMessages() {
    const state=get(),sessionId=state.session?.id,cursor=state.messagePage?.nextCursor;
    if(!sessionId||!cursor||state.messagePageBusy)return;
    const token={epoch,selection:selectionGeneration,sessionId,cursor,request:++messageReadGeneration};
    const active=()=>token.epoch===epoch&&token.selection===selectionGeneration&&token.sessionId===get().session?.id&&token.request===messageReadGeneration&&token.cursor===get().messagePage?.nextCursor;
    set({messagePageBusy:true});
    try {
      const result=await workbenchApi().chat.request({action:"messages",sessionId,cursor,limit:40});
      if(!active()||!result.messagePage)return;
      const current=get(),page=result.messagePage,next={...current.session!,messages:current.session!.messages};
      const merged=mergeTranscriptPage(current.session,current.messagePage,next,page);
      set({session:merged.session,messagePage:merged.page,...(page.resetRequired?{error:"The transcript changed before this page was read. The latest saved page is shown; load earlier messages again."}:{})});
    }catch(error){if(active())set({error:error instanceof Error?error.message:String(error)});}
    finally{if(token.epoch===epoch&&token.sessionId===get().session?.id&&token.request===messageReadGeneration)set({messagePageBusy:false});}
  },
  async newChat() {
    selectionGeneration++;selectionTarget="";
    const token=beginBusy();set({busy:true,error:undefined});
    try {
      const result=await get().request({action:"create"});
      if(!adoptCreated(token,result.session))return;
      set({draft:"",selectedDocuments:[],error:undefined});await get().refresh();
    } catch(error) {if(currentBusy(token))set({error:String(error)});}
    finally {if(currentBusy(token))set({busy:false});}
  },
  async send() {
    const initialState=get();
    if (initialState.busy || initialState.session?.status === "generating"
      || initialState.session?.execution&&initialState.session.execution.status!=="none") return;
    const draft=initialState.draft,content=draft.trim(); if (!content) return;
    const input={modelId:initialState.selectedModel,content,documentIds:[...initialState.selectedDocuments],workflow:initialState.workflow,toolsEnabled:initialState.toolsEnabled,networkEnabled:initialState.networkEnabled,codeExecutionEnabled:initialState.codeExecutionEnabled};
    const token=beginBusy();
    set({busy:true,error:undefined});
    try {
      if (!token.sessionId) {
        const result=await get().request({action:"create"});
        if(!adoptCreated(token,result.session))return;
      }
      if(!currentBusy(token))return;
      await get().request({action:"send",sessionId:token.sessionId!,...input});
      if(!currentBusy(token))return;
      if(get().draft===draft)set({draft:""});
      await get().refresh();
    } catch(error) {if(currentBusy(token))set({error:error instanceof Error ? error.message : String(error)});}
    finally {if(currentBusy(token))set({busy:false});}
  },
  async cancel() { const token=scope();if(token.sessionId&&get().session?.execution?.canCancel!==false){try {await get().request({action:"cancel",sessionId:token.sessionId});} catch(error) {if(current(token))set({error:String(error)});}} },
  async recover(confirmUnowned) {
    const selected=get().session;
    if(!selected?.execution?.canRecover||get().busy||!selected.revision||selected.execution.status==="owner-unknown"&&!confirmUnowned)return;
    const token=beginBusy();set({busy:true,error:undefined});
    try{await get().request({action:"recover",sessionId:selected.id,expectedRevision:selected.revision,...(confirmUnowned?{confirmUnowned}:{})});}
    catch(error){if(currentBusy(token))set({error:error instanceof Error?error.message:String(error)});}
    finally{if(currentBusy(token))set({busy:false});}
  },
  async connect(instanceId) {
    const token=beginBusy(),modelId=get().selectedModel;
    set({busy:true,error:undefined});
    try {await get().request({action:"connect",modelId,instanceId});if(currentBusy(token))await get().refreshModels();}
    catch(error) {if(currentBusy(token))set({error:error instanceof Error ? error.message : String(error)});}
    finally {if(currentBusy(token))set({busy:false});}
  },
});});
