"""New local biology methods; source references are separate from Biomni ports."""
from __future__ import annotations
import math
from collections import Counter

def _obj(value,allowed):
    if not isinstance(value,dict) or set(value)-set(allowed):raise ValueError('Unknown fields or non-object input.')
    return value

def _text(value,label,limit=200):
    if not isinstance(value,str) or not value.strip() or len(value)>limit:raise ValueError(f'{label} must be nonempty text of at most {limit} characters.')
    return value

def _number(value,label,low=0,high=1e12):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:raise ValueError(f'{label} must be a finite number in [{low},{high}].')
    return float(value)

def _list(value,label,minimum=1,maximum=2000):
    if not isinstance(value,list) or not minimum<=len(value)<=maximum:raise ValueError(f'{label} needs {minimum}–{maximum} entries.')
    return value

def _ids(value,label,maximum=2000):
    values=[_text(v,label) for v in _list(value,label,maximum=maximum)]
    if len(values)!=len(set(values)):raise ValueError(f'{label} must be unique.')
    return values

def _counts(values,label,size):
    values=_list(values,label,maximum=2000)
    if len(values)!=size:raise ValueError(f'{label} must match the declared dimension.')
    for v in values:
        _number(v,label)
        if int(v)!=v:raise ValueError(f'{label} must contain nonnegative integer counts.')
    return values

def analyze_qpcr_relative_expression(a):
    _obj(a,{'samples','control_group'})
    control=_text(a.get('control_group'),'control_group');samples=_list(a.get('samples'),'samples',2,256)
    rows=[];seen=set()
    for sample in samples:
        _obj(sample,{'id','group','target_ct','reference_ct'})
        identifier=_text(sample.get('id'),'id');group=_text(sample.get('group'),'group')
        if identifier in seen:raise ValueError('Biological sample IDs must be unique; technical replicates belong inside that sample.')
        seen.add(identifier)
        values={key:[_number(v,key,0,60) for v in _list(sample.get(key),key,1,32)] for key in ['target_ct','reference_ct']}
        means={key:sum(v)/len(v) for key,v in values.items()}
        rows.append({'id':identifier,'group':group,'target_ct_mean':means['target_ct'],'reference_ct_mean':means['reference_ct'],
            'target_technical_replicates':len(values['target_ct']),'reference_technical_replicates':len(values['reference_ct']),
            'delta_ct':means['target_ct']-means['reference_ct']})
    controls=[r['delta_ct'] for r in rows if r['group']==control]
    if not controls:raise ValueError('control_group must match at least one supplied sample.')
    baseline=sum(controls)/len(controls)
    for row in rows:
        row['delta_delta_ct']=row['delta_ct']-baseline;row['relative_expression']=2**(-row['delta_delta_ct'])
    groups=[]
    for group in dict.fromkeys(r['group'] for r in rows):
        delta=[r['delta_ct'] for r in rows if r['group']==group];mean=sum(delta)/len(delta)
        sd=math.sqrt(sum((v-mean)**2 for v in delta)/(len(delta)-1)) if len(delta)>1 else None
        groups.append({'group':group,'biological_samples':len(delta),'mean_delta_ct':mean,'sd_delta_ct':sd,'delta_delta_ct':mean-baseline,'geometric_mean_fold_change':2**(-(mean-baseline))})
    return {'rows':rows,'groups':groups,'control_group':control,'control_mean_delta_ct':baseline,
        'method':'Livak–Schmittgen 2^(-delta_delta_Ct); technical Ct values averaged within each named biological sample before group summaries',
        'warnings':['Assumes target/reference amplification efficiencies are approximately equal and near doubling, and the reference is stable. These assumptions are not validated by Ct values alone.','Group fold change is a geometric mean relative to the control mean delta Ct. Technical replicates are not independent biological samples; no inferential interval is reported.']}

def normalize_gene_expression_counts(a):
    import numpy as np
    _obj(a,{'gene_ids','sample_ids','counts','lengths_bp','method'})
    genes=_ids(a.get('gene_ids'),'gene_ids');samples=_ids(a.get('sample_ids'),'sample_ids',64)
    counts=_list(a.get('counts'),'counts',maximum=2000)
    if len(counts)!=len(genes):raise ValueError('Each row of counts must match one gene.')
    matrix=np.asarray([_counts(row,'counts row',len(samples)) for row in counts],dtype=float)
    method=a.get('method','tpm')
    if method not in ['cpm','tpm','rpkm']:raise ValueError('method must be cpm, tpm or rpkm.')
    totals=matrix.sum(axis=0)
    if np.any(totals<=0):raise ValueError('Every library must contain a positive total count; zero libraries cannot be normalized.')
    if method!='cpm':
        lengths=np.asarray([_number(v,'lengths_bp',1,1e9) for v in _list(a.get('lengths_bp'),'lengths_bp',maximum=2000)])
        if len(lengths)!=len(genes):raise ValueError('Exactly one effective gene/transcript length is required per row.')
        rpk=matrix/(lengths[:,None]/1000)
        normalized=rpk/rpk.sum(axis=0)*1e6 if method=='tpm' else rpk/totals*1e6
    else:
        if 'lengths_bp' in a:raise ValueError('CPM does not use lengths_bp; remove it or select TPM/RPKM.')
        normalized=matrix/totals*1e6
    rows=[{'gene_id':gene,**{name:float(normalized[i,j]) for j,name in enumerate(samples)}} for i,gene in enumerate(genes)]
    if any(name=='gene_id' for name in samples):raise ValueError('sample_ids cannot use reserved table field gene_id.')
    return {'method':method.upper(),'rows':rows,'libraries':[{'sample_id':name,'total_counts':float(totals[j]),'normalized_sum':float(normalized[:,j].sum())} for j,name in enumerate(samples)],
        'warnings':['Normalization uses only the supplied count matrix and declared lengths. TPM/CPM totals are one million per supplied library.','This is abundance normalization, not differential-expression inference. Library composition and sequencing protocols affect cross-sample comparability; no automatic batch correction.']}

def analyze_ecological_diversity(a):
    _obj(a,{'taxa','samples','distance_basis'})
    taxa=_ids(a.get('taxa'),'taxa');samples=_list(a.get('samples'),'samples',1,64)
    basis=a.get('distance_basis','relative')
    if basis not in ['relative','counts']:raise ValueError('distance_basis must be relative or counts.')
    rows=[];vectors=[];seen=set()
    for sample in samples:
        _obj(sample,{'id','counts'});identifier=_text(sample.get('id'),'id')
        if identifier in seen:raise ValueError('Sample IDs must be unique.')
        seen.add(identifier);counts=_counts(sample.get('counts'),'counts',len(taxa));n=sum(counts)
        p=[v/n for v in counts] if n else [];richness=sum(v>0 for v in counts)
        h=-sum(v*math.log(v) for v in p if v) if n else None
        rows.append({'sample_id':identifier,'total_count':n,'observed_richness':richness,'shannon_nats':h,
            'simpson_diversity':1-sum(v*v for v in p) if n else None,'pielou_evenness':h/math.log(richness) if richness>1 else None})
        vectors.append((p if basis=='relative' else counts) if n else None)
    pairs=[]
    for i in range(len(rows)):
        for j in range(i):
            x,y=vectors[i],vectors[j]
            pairs.append({'sample_a':rows[j]['sample_id'],'sample_b':rows[i]['sample_id'],'bray_curtis':sum(abs(u-v) for u,v in zip(x,y))/sum(x+y) if x is not None and y is not None else None})
    return {'rows':rows,'pairwise_distances':pairs,'distance_basis':basis,
        'method':'Shannon uses natural logarithms; Simpson = 1-sum(p_i^2); Pielou = H/ln(S); Bray–Curtis = sum(abs(x-y))/sum(x+y)',
        'warnings':['Empty communities have undefined diversity and pairwise distances. Evenness is undefined below two observed taxa.','This analysis uses declared taxa counts without taxonomy assignment, rarefaction, unseen-richness estimation or phylogenetic distance. Counts and relative-abundance distances have different library-depth sensitivity.']}

def analyze_protein_physicochemistry(a):
    from Bio.SeqUtils.ProtParam import ProteinAnalysis
    _obj(a,{'sequence','ph_values'})
    sequence=''.join(_text(a.get('sequence'),'sequence',50000).split()).upper()
    if not sequence or set(sequence)-set('ACDEFGHIKLMNPQRSTVWY'):raise ValueError('Use the 20 standard amino-acid one-letter codes; ambiguous residues, gaps and stop symbols require explicit resolution.')
    ph=[_number(v,'ph_values',0,14) for v in _list(a.get('ph_values',[3,5,7,9,11]),'ph_values',1,101)]
    protein=ProteinAnalysis(sequence);counts=protein.count_amino_acids();reduced,oxidized=protein.molar_extinction_coefficient()
    pi=protein.isoelectric_point()
    return {'length':len(sequence),'molecular_weight_da':protein.molecular_weight(),'isoelectric_point':pi,
        'aromaticity':protein.aromaticity(),'gravy':protein.gravy(),'instability_index':protein.instability_index(),
        'extinction_reduced_m_inv_cm_inv':reduced,'extinction_cystine_m_inv_cm_inv':oxidized,
        'composition':[{'residue':aa,'count':count,'fraction':count/len(sequence)} for aa,count in counts.items()],
        'charge_profile':[{'ph':p,'estimated_charge':protein.charge_at_pH(p)} for p in ph],
        'method':'Biopython ProtParam; unmodified linear chain with free termini and average masses',
        'warnings':['Sequence-derived estimates do not establish experimental stability, solubility or modifications. Extinction estimates use reduced cysteines or maximally paired cystines.','Biopython pI uses its bounded pH search (approximately 4.05–12); values near these boundaries are range-limited estimates.']}

def analyze_sequence_composition(a):
    _obj(a,{'sequence','window','step'})
    sequence=''.join(_text(a.get('sequence'),'sequence',100000).split()).upper()
    if not sequence or set(sequence)-set('ACGTN'):raise ValueError('Use DNA A/C/G/T and explicit unknown N; other ambiguity codes are not guessed.')
    window=a.get('window',100);step=a.get('step',window)
    for key,value in [('window',window),('step',step)]:
        if isinstance(value,bool) or not isinstance(value,int) or not 1<=value<=100000:raise ValueError(f'{key} must be a positive integer at most 100000.')
    if math.ceil(len(sequence)/step)>2000:raise ValueError('At most 2000 windows; increase step.')
    def summary(seq):
        count=Counter(seq);known=sum(count[c] for c in 'ACGT')
        pairs=[seq[i:i+2] for i in range(len(seq)-1) if 'N' not in seq[i:i+2]]
        cpg=pairs.count('CG')
        # CpG O/E uses marginal C/G frequencies among known bases and valid adjacent pairs.
        expected=len(pairs)*(count['C']/known)*(count['G']/known) if known else 0
        return {'length':len(seq),'known_bases':known,'unknown_bases':count['N'],'gc_fraction':(count['G']+count['C'])/known if known else None,
            'gc_skew':(count['G']-count['C'])/(count['G']+count['C']) if count['G']+count['C'] else None,
            'valid_adjacent_pairs':len(pairs),'cpg_count':cpg,'cpg_observed_expected':cpg/expected if expected else None}
    rows=[{'start_zero_based':start,'end_exclusive':min(start+window,len(sequence)),**summary(sequence[start:start+window])} for start in range(0,len(sequence),step)]
    return {'summary':summary(sequence),'windows':rows,'base_counts':[{'base':base,'count':sequence.count(base)} for base in 'ACGTN'],
        'method':'Linear half-open windows; GC denominator excludes N; CpG expectation uses valid adjacent pairs times marginal C and G frequencies',
        'warnings':['Unknown bases remain counted explicitly. Windows include a shorter terminal window and do not wrap circularly. No CpG-island, coding-region or biological function prediction is made.']}

def _schema(properties,required):return {'type':'object','properties':properties,'required':required,'additionalProperties':False}
S={'type':'string','minLength':1,'maxLength':200}
N={'type':'array','items':{'type':'number'},'minItems':1,'maxItems':2000}
IDS={'type':'array','items':S,'minItems':1,'maxItems':2000}
def _tool(title,description,schema,example,dependencies,references):
    return {'title':title,'description':description,'input_schema':schema,'example':example,'dependency':dependencies,'implementation':'proto-native','upstream_functions':[], 'method_references':references}

TOOLS={
 'analyze_qpcr_relative_expression':_tool('qPCR relative expression','Calculate biological-sample delta Ct, delta delta Ct and fold changes while keeping technical replicates distinct.',_schema({'samples':{'type':'array','minItems':2,'maxItems':256,'items':_schema({'id':S,'group':S,'target_ct':N,'reference_ct':N},['id','group','target_ct','reference_ct'])},'control_group':S},['samples','control_group']),{'samples':[{'id':'control-1','group':'control','target_ct':[25,25.2],'reference_ct':[20,20.2]},{'id':'treated-1','group':'treated','target_ct':[23,23.2],'reference_ct':[20,20.2]}],'control_group':'control'},[],['https://pubmed.ncbi.nlm.nih.gov/11846609/']),
 'normalize_gene_expression_counts':_tool('Gene expression normalization','Convert an explicit gene-by-sample count matrix to CPM, TPM or RPKM with library sums and supplied effective lengths.',_schema({'gene_ids':IDS,'sample_ids':IDS,'counts':{'type':'array','items':N,'minItems':1,'maxItems':2000},'lengths_bp':N,'method':{'type':'string','enum':['cpm','tpm','rpkm']}},['gene_ids','sample_ids','counts','method']),{'gene_ids':['gene-a','gene-b'],'sample_ids':['sample-a','sample-b'],'counts':[[100,200],[100,400]],'lengths_bp':[1000,2000],'method':'tpm'},['numpy'],['https://pubmed.ncbi.nlm.nih.gov/22872506/']),
 'analyze_ecological_diversity':_tool('Community diversity','Shannon, Simpson, evenness and explicit Bray–Curtis distances from taxon counts; empty communities remain undefined.',_schema({'taxa':IDS,'samples':{'type':'array','minItems':1,'maxItems':64,'items':_schema({'id':S,'counts':N},['id','counts'])},'distance_basis':{'type':'string','enum':['relative','counts']}},['taxa','samples']),{'taxa':['taxon-a','taxon-b','taxon-c'],'samples':[{'id':'community-a','counts':[10,10,0]},{'id':'community-b','counts':[0,10,10]}],'distance_basis':'relative'},[],['https://scikit.bio/docs/latest/generated/skbio.diversity.alpha.shannon.html']),
 'analyze_protein_physicochemistry':_tool('Protein physicochemical profile','Biopython ProtParam molecular mass, pI, hydropathy, residue composition, extinction and charge across supplied pH values.',_schema({'sequence':{'type':'string','minLength':1,'maxLength':50000},'ph_values':N},['sequence']),{'sequence':'MPEPTIDEACDEFGHIKLMNPQRSTVWY','ph_values':[3,5,7,9,11]},['Bio'],['https://biopython.org/docs/latest/api/Bio.SeqUtils.ProtParam.html']),
 'analyze_sequence_composition':_tool('DNA composition and GC windows','Inspect GC content, skew, unknown bases and CpG observed/expected with explicit half-open windows.',_schema({'sequence':{'type':'string','minLength':1,'maxLength':100000},'window':{'type':'integer','minimum':1,'maximum':100000},'step':{'type':'integer','minimum':1,'maximum':100000}},['sequence']),{'sequence':'ACGTCGNNACGTACGTCG','window':6,'step':6},[],['https://biopython.org/docs/latest/api/Bio.SeqUtils.html'])
}
HANDLERS={name:globals()[name] for name in TOOLS}
