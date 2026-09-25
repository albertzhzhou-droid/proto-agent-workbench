import { useEffect, useRef, useState } from 'react';
import { BookOpen, Play, RefreshCw, Square, X } from 'lucide-react';
import type { ComputeTool } from '../shared/compute.ts';
import type { ManagedResearchDraft, ManagedResearchRequest, ManagedResearchResponse, ManagedPlanSummary } from '../shared/managed-research.ts';
import { workbenchApi } from './mock-api.ts';
import { useManagedStudySelection } from './managed-study-state.ts';
import { useResearchChat } from './research-chat-store.ts';
import './managed-study.css';

export function ManagedStudyPanel({workspace, onClose, onMode}: {workspace: string; onClose(): void; onMode(mode: 'chat' | 'design' | 'compute'): void}) {
  const selected = useManagedStudySelection(state => state.byWorkspace[workspace]);
  const [data, setData] = useState<ManagedResearchResponse>({});
  const [studies, setStudies] = useState<NonNullable<ManagedResearchResponse['studies']>>([]);
  const [tools, setTools] = useState<ComputeTool[]>([]);
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<ManagedPlanSummary>();
  const [comparePlan, setComparePlan] = useState('');
  const [evidenceNode, setEvidenceNode] = useState('');
  const generation = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const activeExecution = data.execution && ['running', 'pending'].includes(data.execution.status);
  const call = async (request: ManagedResearchRequest) => {
    const token = ++generation.current;
    setBusy(true); setError('');
    if(request.action==='compile') {setSelectedPlan(undefined);setComparePlan('');setEvidenceNode('');setData(previous=>({study:previous.study,plans:previous.plans}));}
    try {
      const response = await workbenchApi().research.request(request);
      if (token !== generation.current) return;
      if (response.studies) setStudies(response.studies);
      if (request.action !== 'list') setData(previous => request.action === 'get' || request.action === 'create' ? response : {...previous, ...response});
      if (response.study) useManagedStudySelection.getState().select(workspace, {studyId: response.study.id, name: response.study.name, question: response.study.question});
      if (response.plan) setSelectedPlan(response.plan);
      return response;
    } catch (cause) {if (token === generation.current) setError(cause instanceof Error ? cause.message : String(cause));}
    finally {if (token === generation.current) setBusy(false);}
  };
  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    void workbenchApi().research.request({action: 'list'}).then(response => {if (live) setStudies(response.studies ?? []);}).catch(cause => {if (live) setError(String(cause));});
    void workbenchApi().compute.catalog().then(catalog => {if (live) setTools(catalog.tools);}).catch(cause => {if (live) setError(String(cause));});
    return () => {live = false; generation.current++;};
  }, [workspace]);
  useEffect(() => {setSelectedPlan(undefined); setData({}); setDraft(''); setComparePlan(''); if (selected?.studyId) void call({action: 'get', studyId: selected.studyId});}, [workspace, selected?.studyId]);
  useEffect(() => {
    if (!activeExecution || !selected || !selectedPlan) return;
    let disposed = false;
    const executionId = data.execution!.id;
    const poll = async () => {
      try {
        const response = await workbenchApi().research.request({action: 'execution', studyId: selected.studyId, planId: selectedPlan.id, executionId});
        if (!disposed) setData(previous => ({...previous, ...response}));
      } catch (cause) {if (!disposed) setError(String(cause));}
      if (!disposed) timer = setTimeout(() => void poll(), 1500);
    };
    let timer = setTimeout(() => void poll(), 800);
    return () => {disposed = true; clearTimeout(timer);};
  }, [activeExecution, data.execution?.id, selected?.studyId, selectedPlan?.id]);
  const loadMethod = async (id: string) => {
    const token=++generation.current;
    setBusy(true);setError('');
    try {
    const catalog=await workbenchApi().compute.catalog(id);
    if(token!==generation.current)return;
    const tool = catalog.tools.find(item => item.id === id); if (!tool) throw new Error('The selected method is unavailable.');
    const value: ManagedResearchDraft = {
      workflow: {name: tool.title, description: 'Development example. Replace inputs and record the assumptions for your study.', steps: [{id: 'analysis', title: tool.title, tool: tool.id, arguments: (tool.example ?? {}) as Record<string, never>, bindings: []}]},
      datasets: [],
      stepSemantics: [{stepId: 'analysis', role: 'required', datasetIds: [], assumptions: ['Development example only; applicability to a research dataset has not been reviewed.']}],
    };
    setDraft(JSON.stringify(value, null, 2));
    } catch(cause) {if(token===generation.current)setError(String(cause));}
    finally {if(token===generation.current)setBusy(false);}
  };
  const openPlan = async (plan: ManagedPlanSummary) => {
    setSelectedPlan(plan); setComparePlan(''); setEvidenceNode(''); setData(previous => ({study: previous.study, plans: previous.plans}));
    const opened=await call({action:'inspect-plan',studyId:selected!.studyId,planId:plan.id});
    if(opened?.execution) await call({action:'execution',studyId:selected!.studyId,planId:plan.id,executionId:opened.execution.id});
  };
  return <dialog ref={dialog} className="managed-study-dialog" aria-labelledby="managed-study-title" onCancel={event => {event.preventDefault(); onClose();}}>
    <header><div><span className="managed-study-overline">RESEARCH WORKSPACE</span><h1 id="managed-study-title">Study desk</h1></div><button className="quiet-button" type="button" aria-label="Close Study desk" onClick={onClose}><X size={18}/></button></header>
    <div className="managed-study-layout">
      <aside aria-label="Study navigation">
        <p className="managed-study-muted">One question, shared across Chat, Design and Compute.</p>
        <button className="quiet-button" disabled={busy} onClick={() => void call({action: 'list'})}><RefreshCw size={14}/> Refresh studies</button>
        <div className="managed-study-list">{studies.map(study => <button key={study.id} className={selected?.studyId === study.id ? 'is-selected' : ''} onClick={() => useManagedStudySelection.getState().select(workspace, {studyId: study.id, name: study.name, question: study.question})}><BookOpen size={16}/><span>{study.name}<small>{study.runCount} linked results</small></span></button>)}</div>
        <form onSubmit={event => {event.preventDefault(); void call({action: 'create', name, question}).then(response => {if(response?.study){setStudies(previous => [response.study!, ...previous]); setName(''); setQuestion('');}});}}>
          <h2>New Study</h2><label>Name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label><label>Research question<textarea required maxLength={8000} rows={3} value={question} onChange={event => setQuestion(event.target.value)}/></label><button className="quiet-button" disabled={busy || !name.trim() || !question.trim()}>Create Study</button>
        </form>
      </aside>
      <main>
        {error && <p role="alert" className="managed-study-notice">{error}</p>}
        {busy && <p role="status">Checking project records…</p>}
        {!selected ? <div className="managed-study-empty"><h2>Begin with a research question</h2><p>Create a Study, choose a method and inspect its plan before execution. Saved results retain their source and method identities.</p></div> : <>
          <section className="managed-study-question"><span className="managed-study-overline">CURRENT QUESTION</span><h2>{selected.name}</h2><p>{selected.question}</p><code>{selected.studyId}</code><div className="managed-study-actions"><button className="quiet-button" onClick={() => {useResearchChat.getState().setDraft(`Study: ${selected.name}\nStudy ID: ${selected.studyId}\nResearch question: ${selected.question}\n\nHelp me review the analysis assumptions and evidence gaps. Treat any proposed plan as a draft.`); onMode('chat'); onClose();}}>Discuss in Chat</button><button className="quiet-button" onClick={() => {onMode('compute'); onClose();}}>Open Compute</button></div></section>
          <section><h2>Analysis plan</h2><p className="managed-study-muted">Choose a catalogue example or enter a plan. Examples are development inputs. Dataset declarations require real source paths, units, entity identities and reference versions.</p>
            <label>Method example<select defaultValue="" disabled={busy} onChange={event => void loadMethod(event.target.value)}><option value="" disabled>Select a method</option>{tools.map(tool => <option key={tool.id} value={tool.id}>{tool.title}{tool.available ? '' : ' · dependency missing'}</option>)}</select></label>
            <details><summary>Dataset declaration format</summary><pre>{JSON.stringify({id:'observations',version:1,sourcePath:'sources/observations.json',entityIds:['your-recorded-sample-id'],units:['1'],referenceVersion:'your-recorded-reference-version'},null,2)}</pre><p>Use the same dataset id in stepSemantics.datasetIds. Units and identities are declarations checked against supported contracts; they are not inferred from filenames.</p></details>
            <label>Research plan JSON<textarea className="managed-study-code" rows={13} value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false}/></label>
            <button className="quiet-button" disabled={busy || !draft || !data.study} onClick={() => {try {const parsed = JSON.parse(draft); void call({action: 'compile', studyId: selected.studyId, expectedStudyRevision: data.study!.revision, draft: parsed}).then(response => {if(response?.plan) setData(previous => ({...previous, plans: [response.plan!, ...(previous.plans ?? [])]}));});} catch(cause) {setError(String(cause));}}}>Compile and freeze plan</button>
            {!!data.diagnostics?.length && <ul aria-label="Plan diagnostics">{data.diagnostics.map((item,index) => <li key={index}><strong>{item.code}</strong> {item.message}</li>)}</ul>}
          </section>
          <section><h2>Plan versions</h2>{!data.plans?.length && <p className="managed-study-muted">No frozen plans yet.</p>}<div className="managed-study-versions">{data.plans?.map(plan => <button key={plan.id} className={selectedPlan?.id === plan.id ? 'is-selected' : ''} onClick={() => void openPlan(plan)}>{plan.title}<small>{new Date(plan.createdAt).toLocaleString()}</small><code>{plan.sha256.slice(0,16)}</code></button>)}</div>
            {selectedPlan && (data.plans?.length ?? 0) > 1 && <div className="managed-study-actions"><label>Compare with<select value={comparePlan} onChange={event => setComparePlan(event.target.value)}><option value="">Choose a version</option>{data.plans?.filter(plan => plan.id !== selectedPlan.id).map(plan => <option key={plan.id} value={plan.id}>{plan.title} · {new Date(plan.createdAt).toLocaleString()}</option>)}</select></label><button className="quiet-button" disabled={busy || !comparePlan} onClick={() => void call({action: 'compare',studyId:selected.studyId,leftPlanId:selectedPlan.id,rightPlanId:comparePlan})}>Scientific diff</button></div>}
            {data.comparison !== undefined && <details open><summary>Recorded changes</summary><pre>{JSON.stringify(data.comparison,null,2)}</pre></details>}
          </section>
          {selectedPlan && <button className="quiet-button" disabled={busy || activeExecution} onClick={() => void call({action:'preview',studyId:selected.studyId,planId:selectedPlan.id})}>Refresh execution preview</button>}
          {data.preview && selectedPlan && <section aria-label="Plan dry run"><h2>Before execution</h2><p>Resource estimate: <strong>unknown</strong>. Computation uses the installed local runtime; unavailable methods are blocked.</p><p className="managed-study-muted">{data.preview.resourceEstimate.reason}</p>{data.preview.steps.map(step => <article className="managed-study-step" key={step.stepId}><strong>{step.title}</strong><span>{step.state}</span><p>{step.reason}</p></article>)}<button className="quiet-button" disabled={busy || !data.preview.canStart || activeExecution} onClick={() => void call({action:'start',studyId:selected.studyId,planId:selectedPlan.id,expectedPreviewSha256:data.preview!.planSha256})}><Play size={14}/> Run reviewed plan</button></section>}
          {data.execution && <section aria-label="Study Run Center"><h2>Run Center</h2><p><strong>{data.execution.status}</strong>{data.execution.cancelRequested ? ' · cancellation requested; waiting for worker termination' : ''}</p><code>{data.execution.id}</code>{data.execution.steps.map(step => <article className="managed-study-step" key={step.stepId}><strong>{step.title}</strong><span>{step.status}</span>{step.error && <p>{step.error.code}: {step.error.message}</p>}{step.runId && <code>{step.runId}</code>}</article>)}{activeExecution && selectedPlan && <button className="quiet-button" disabled={busy || data.execution.cancelRequested} onClick={() => void call({action:'cancel',studyId:selected.studyId,planId:selectedPlan.id,executionId:data.execution!.id})}><Square size={14}/> Request cancellation</button>}</section>}
          {data.evidence && <section aria-label="Study evidence"><h2>Evidence Inspector</h2><p>Saved results verified: {data.evidence.verifiedRuns}. Missing or damaged: {data.evidence.missingRuns}.</p><p>Source freshness: {data.evidence.sourceFreshness.join(', ') || 'No source checks yet'}. Scientific review: <strong>unreviewed</strong>.</p>{data.evidence.objects.map(object => <details key={object.runId}><summary>{object.runId}</summary><code>{object.sha256}</code></details>)}</section>}
          {data.completion && <section><h2>{data.completion.complete?'Required evidence is present':'Evidence still needed'}</h2><p className="managed-study-muted">{data.completion.scope}</p><ul>{data.completion.blockers.map((block,index)=><li key={index}>{block.code}: {block.message}</li>)}</ul>{!!data.completion.optionalFailures.length&&<p>Retained optional failures: {data.completion.optionalFailures.join(', ')}</p>}</section>}
          {data.graph && <section><h2>Trace evidence</h2><label>Source or result<select value={evidenceNode} onChange={event=>setEvidenceNode(event.target.value)}><option value="">Select an evidence object</option>{data.graph.nodes.map(node=><option key={node.id} value={node.id}>{node.kind} · {node.id}</option>)}</select></label>{evidenceNode && <pre>{JSON.stringify({node:data.graph.nodes.find(node=>node.id===evidenceNode),links:data.graph.edges.filter(edge=>edge.from===evidenceNode||edge.to===evidenceNode)},null,2)}</pre>}</section>}
          <section><h2>Research capsule</h2><p className="managed-study-muted">Export frozen plans and retained result evidence for inspection. Runtime installation and permission to recompute are separate.</p><div className="managed-study-actions"><button className="quiet-button" disabled={busy} onClick={() => void call({action:'capsule',studyId:selected.studyId,mode:'manifest-only'})}>Export manifest</button><button className="quiet-button" disabled={busy} onClick={() => void call({action:'capsule',studyId:selected.studyId,mode:'full'})}>Export with result data</button></div>{data.capsule && <div role="status"><p>Export saved and reopened.</p><code>{data.capsule.path}</code><p>{data.capsule.bytes} bytes · {data.capsule.mode}</p><code>{data.capsule.sha256}</code></div>}</section>
          {data.limits && <details><summary>Current implementation scope</summary><ul>{data.limits.map(limit => <li key={limit}>{limit}</li>)}</ul></details>}
        </>}
      </main>
    </div>
  </dialog>;
}
