"""Local physical chemistry adapters. References and assumptions accompany results."""
from __future__ import annotations
import math
from chem_analysis import obj, number, integer, text, vector, array, choice, fail, finite_result, series, visual

R = 8.31446261815324

def _fit(residual, initial):
    import numpy as np
    from scipy.optimize import least_squares
    solution = least_squares(residual, initial, bounds=(-27., 27.), max_nfev=10000, xtol=1e-12, ftol=1e-12, gtol=1e-12)
    rank = int(np.linalg.matrix_rank(solution.jac))
    condition = float(np.linalg.cond(solution.jac))
    if not solution.success or rank < len(initial) or not math.isfinite(condition) or condition > 1e10:
        fail('The supplied observations do not support a numerically identifiable fit.', 'UNIDENTIFIABLE_FIT')
    if np.any(np.abs(solution.x) > 26.9):
        fail('Fit reaches the supported parameter boundary; inspect the model and measurement range.', 'FIT_BOUNDARY')
    return np.exp(solution.x), {'solver':'SciPy bounded least_squares in log parameters', 'jacobian_rank':rank,
        'jacobian_condition':condition, 'evaluations':solution.nfev, 'converged':True}

@finite_result
def fit_adsorption_isotherm(data):
    import numpy as np
    obj(data,'input',{'concentrations','loadings','concentration_unit','loading_unit','model'})
    c=np.asarray(vector(data.get('concentrations'),'concentrations',5,1000))
    q=np.asarray(vector(data.get('loadings'),'loadings',5,1000))
    if len(c)!=len(q) or min(c)<0 or min(q)<0 or len(set(c[c>0]))<4 or np.ptp(q)<=0:
        fail('Supply aligned nonnegative observations with at least four distinct positive concentrations and varying loadings.')
    cu,qu=text(data.get('concentration_unit'),'concentration_unit'),text(data.get('loading_unit'),'loading_unit')
    model=choice(data.get('model','langmuir'),'model',('langmuir','freundlich'))
    cscale,qscale=float(np.median(c[c>0])),float(max(q)); x=c/cscale;y=q/qscale
    def predicted(p,values):
        a,b=p
        return a*b*values/(1+b*values) if model=='langmuir' else a*np.power(values,b)
    parameters,diagnostics=_fit(lambda logs:predicted(np.exp(logs),x)-y,[math.log(1.2),0.])
    fitted=predicted(parameters,x)*qscale
    if model=='langmuir':
        coefficients=[{'parameter':'q_max','value':float(parameters[0]*qscale),'unit':qu},
                      {'parameter':'K','value':float(parameters[1]/cscale),'unit':f'1/({cu})'}]
        equation='q = q_max K c / (1 + K c)'
    else:
        coefficients=[{'parameter':'K_F','value':float(parameters[0]*qscale/cscale**parameters[1]),'unit':f'({qu})/({cu})^n'},
                      {'parameter':'n','value':float(parameters[1]),'unit':'dimensionless'}]
        equation='q = K_F c^n; n is the exponent, not its reciprocal'
    residual=q-fitted; plot=np.linspace(0,float(max(c)),151)
    return {'model':model,'coefficients':coefficients,'rows':[{'concentration':float(ci),'loading':float(qi),'fitted':float(fi),'residual':float(ri)} for ci,qi,fi,ri in zip(c,q,fitted,residual)],
        'diagnostics':{**diagnostics,'rmse':float(np.sqrt(np.mean(residual**2))),'r_squared':float(1-np.sum(residual**2)/np.sum((q-np.mean(q))**2))},
        'method':{'equation':equation,'weighting':'Uniform residuals on original loading scale','concentration_unit':cu,'loading_unit':qu},
        'warnings':['The model fits supplied equilibrium observations. Fit quality does not establish equilibrium, adsorption mechanism or validity outside the supplied range.'],
        'visualization':visual('Equilibrium concentration',cu,'Adsorbed loading',qu,[series('observations','Observations',c.tolist(),q.tolist(),'points'),series('fit',model,plot.tolist(),(predicted(parameters,plot/cscale)*qscale).tolist())]),
        'residual_visualization':visual('Equilibrium concentration',cu,'Observed − fitted',qu,[series('residual','Residual',c.tolist(),residual.tolist(),'points')])}

@finite_result
def analyze_vanthoff_equilibrium(data):
    import numpy as np
    from scipy.stats import linregress
    obj(data,'input',{'temperatures_k','equilibrium_constants'})
    temps=np.asarray(vector(data.get('temperatures_k'),'temperatures_k',3,1000))
    constants=np.asarray(vector(data.get('equilibrium_constants'),'equilibrium_constants',3,1000))
    if len(temps)!=len(constants) or min(temps)<=0 or min(constants)<=0 or len(set(temps))<3:
        fail('Use aligned positive temperatures in kelvin and dimensionless equilibrium constants at three or more distinct temperatures.')
    x=1/temps;y=np.log(constants)
    if np.ptp(y)==0:
        # SciPy releases differ on stderr for constant responses. The declared
        # fixed-design OLS residual variance is exactly zero in this case.
        from types import SimpleNamespace
        fit=SimpleNamespace(slope=0.,intercept=float(y[0]),stderr=0.,intercept_stderr=0.)
    else:
        fit=linregress(x,y)
    fitted=fit.intercept+fit.slope*x
    delta_h=-R*fit.slope;delta_s=R*fit.intercept
    order=np.argsort(x)
    return {'delta_h_j_mol':float(delta_h),'delta_s_j_mol_k':float(delta_s),
        'delta_h_standard_error_j_mol':float(R*fit.stderr),'delta_s_standard_error_j_mol_k':float(R*fit.intercept_stderr),
        'rows':[{'temperature_k':float(t),'equilibrium_constant':float(k),'ln_k':float(l),'fitted_ln_k':float(f),'residual_ln_k':float(l-f),'delta_g_j_mol':float(-R*t*l)} for t,k,l,f in zip(temps,constants,y,fitted)],
        'method':'OLS ln(K) = -delta_H/(R T) + delta_S/R; R = 8.31446261815324 J mol^-1 K^-1',
        'warnings':['K must be dimensionless on one consistent standard-state convention. Dimensional concentration ratios require conversion before use.','Enthalpy and entropy are assumed constant over the supplied temperature interval; no heat-capacity correction. Standard errors assume independent homoscedastic log(K) errors.'],
        'visualization':visual('Inverse temperature','K⁻¹','ln(K)','dimensionless',[series('observations','Observations',x.tolist(),y.tolist(),'points'),series('fit','van’t Hoff fit',x[order].tolist(),fitted[order].tolist())])}

@finite_result
def calculate_acid_base_speciation(data):
    import numpy as np
    from scipy.special import logsumexp
    obj(data,'input',{'pka_values','ph_values','fully_protonated_charge'})
    pka=vector(data.get('pka_values'),'pka_values',1,8)
    ph=vector(data.get('ph_values'),'ph_values',1,501)
    if any(not -20<=x<=40 for x in pka) or any(not -10<=x<=30 for x in ph) or pka!=sorted(pka):
        fail('Sequential pKa values must be ascending in [-20,40]; pH values must lie in [-10,30].')
    charge=integer(data.get('fully_protonated_charge',0),'fully_protonated_charge',-10,10)
    n=len(pka); cumulative=np.r_[0,np.cumsum(pka)]
    logs=np.log(10)*(np.outer(ph,np.arange(n+1))-cumulative)
    fractions=np.exp(logs-logsumexp(logs,axis=1)[:,None]);charges=charge-np.arange(n+1)
    rows=[{'ph':p,**{f'alpha_{i}':float(f) for i,f in enumerate(row)},'mean_charge':float(row@charges),'fraction_sum':float(row.sum())} for p,row in zip(ph,fractions)]
    order=np.argsort(ph)
    return {'rows':rows,'species':[{'id':f'alpha_{i}','protons_lost':i,'formal_charge':int(charges[i])} for i in range(n+1)],
        'method':'Sequential polyprotic acid fractions from alpha_i proportional to 10^(i pH - sum(pKa_1..pKa_i)), normalized with logsumexp',
        'warnings':['Ideal dilute equilibrium at supplied pH and pKa values; activity coefficients, metal binding and coupled equilibria are not modeled. This calculation does not solve pH from analytical concentration.'],
        'visualization':visual('pH','', 'Species fraction','dimensionless',[series(f'alpha_{i}',f'{i} proton(s) lost; charge {charges[i]:+d}',np.asarray(ph)[order].tolist(),fractions[order,i].tolist()) for i in range(n+1)])}

@finite_result
def fit_electrochemical_impedance(data):
    import numpy as np
    obj(data,'input',{'frequencies_hz','z_real_ohm','z_imag_ohm','weighting'})
    f=np.asarray(vector(data.get('frequencies_hz'),'frequencies_hz',6,2000));re=np.asarray(vector(data.get('z_real_ohm'),'z_real_ohm',6,2000));im=np.asarray(vector(data.get('z_imag_ohm'),'z_imag_ohm',6,2000))
    if len(f)!=len(re) or len(f)!=len(im) or min(f)<=0 or len(set(f))<6 or max(f)/min(f)<2 or np.ptp(re)<=0:
        fail('Supply aligned impedance components and six distinct positive frequencies spanning at least a factor of two, with varying real impedance.')
    weighting=choice(data.get('weighting','uniform'),'weighting',('uniform','modulus'))
    scale=float(max(np.hypot(re,im)))
    if scale<=0:fail('Impedance magnitude must be positive.')
    observed=(re+1j*im)/scale; frequency_scale=float(np.median(f)); omega=2*np.pi*f/frequency_scale
    initial_rs=max(float(min(re))/scale,1e-5);initial_rct=max(float(np.ptp(re))/scale,1e-4)
    initial_c=1/(omega[int(np.argmax(-im))]*initial_rct)
    def model(p):return p[0]+p[1]/(1+1j*omega*p[1]*p[2])
    weights=np.maximum(np.abs(observed),1e-12) if weighting=='modulus' else np.ones(len(f))
    def residual(logs):
        difference=(model(np.exp(logs))-observed)/weights
        return np.r_[difference.real,difference.imag]
    p,diagnostics=_fit(residual,np.log([initial_rs,initial_rct,initial_c]))
    predicted=model(p)*scale; order=np.argsort(f)
    return {'r_series_ohm':float(p[0]*scale),'r_transfer_ohm':float(p[1]*scale),'capacitance_f':float(p[2]/(scale*frequency_scale)),
        'rows':[{'frequency_hz':float(fi),'z_real_ohm':float(zr),'z_imag_ohm':float(zi),'fitted_real_ohm':float(pr),'fitted_imag_ohm':float(pi),'residual_real_ohm':float(zr-pr),'residual_imag_ohm':float(zi-pi)} for fi,zr,zi,pr,pi in zip(f,re,im,predicted.real,predicted.imag)],
        'diagnostics':{**diagnostics,'complex_rmse_ohm':float(np.sqrt(np.mean(np.abs(re+1j*im-predicted)**2)))},
        'method':{'circuit':'R_s + (R_ct parallel C)','equation':'Z = R_s + R_ct / (1 + j 2 pi f R_ct C)','input_imaginary_sign':'Im(Z); capacitive observations are negative','weighting':weighting},
        'warnings':['Fixed ideal RC topology without diffusion, CPE or inductance. Parameter fit is not a Kramers–Kronig or physical-model validation. All supplied observations are retained.'],
        'visualization':visual('Re(Z)','Ω','−Im(Z)','Ω',[series('observations','Observed Nyquist',re.tolist(),(-im).tolist(),'points'),series('fit','RC fit',predicted.real[order].tolist(),(-predicted.imag[order]).tolist())])}

def operator_specs():
    def schema(properties,required):return {'type':'object','properties':properties,'required':required,'additionalProperties':False}
    vec={'type':'array','items':{'type':'number'},'minItems':1,'maxItems':2000};unit={'type':'string','minLength':1,'maxLength':100}
    f=[.1,1,10,100,1000,10000];z=[5+50/(1+2j*math.pi*v*50*.001) for v in f]
    return [
      ('fit_adsorption_isotherm','Adsorption isotherm fitting','analysis','Fit Langmuir or Freundlich equilibrium adsorption with measured loadings, residuals and identifiability diagnostics.',schema({'concentrations':vec,'loadings':vec,'concentration_unit':unit,'loading_unit':unit,'model':{'type':'string','enum':['langmuir','freundlich']}},['concentrations','loadings','concentration_unit','loading_unit']),{'concentrations':[.2,.5,1,2,5,10],'loadings':[1.6666666667,3.3333333333,5,6.6666666667,8.3333333333,9.0909090909],'concentration_unit':'mg/L','loading_unit':'mg/g','model':'langmuir'},'SciPy nonlinear least squares / pyGAPS model reference',['numpy','scipy']),
      ('analyze_vanthoff_equilibrium','van’t Hoff equilibrium analysis','analysis','Estimate enthalpy and entropy from dimensionless equilibrium constants at supplied temperatures in kelvin.',schema({'temperatures_k':vec,'equilibrium_constants':vec},['temperatures_k','equilibrium_constants']),{'temperatures_k':[280,290,300,310,320],'equilibrium_constants':[math.exp(-20000/(R*t)+80/R) for t in [280,290,300,310,320]]},'SciPy linear regression / van’t Hoff relation',['numpy','scipy']),
      ('calculate_acid_base_speciation','Acid–base species distribution','chemical-data','Calculate polyprotic species fractions and average charge at explicit pH and sequential pKa values.',schema({'pka_values':vec,'ph_values':vec,'fully_protonated_charge':{'type':'integer','minimum':-10,'maximum':10}},['pka_values','ph_values']),{'pka_values':[4.76],'ph_values':[2,3,4,4.76,5,6,7,8],'fully_protonated_charge':0},'Sequential mass-action equilibrium / SciPy logsumexp',['numpy','scipy']),
      ('fit_electrochemical_impedance','Electrochemical impedance fit','analysis','Fit a declared R_s + (R_ct parallel C) circuit to actual complex impedance; Nyquist output, residuals and numerical diagnostics.',schema({'frequencies_hz':vec,'z_real_ohm':vec,'z_imag_ohm':vec,'weighting':{'type':'string','enum':['uniform','modulus']}},['frequencies_hz','z_real_ohm','z_imag_ohm']),{'frequencies_hz':f,'z_real_ohm':[v.real for v in z],'z_imag_ohm':[v.imag for v in z],'weighting':'uniform'},'SciPy complex least squares / impedance.py workflow reference',['numpy','scipy'])]

OPERATORS={name:globals()[name] for name in ['fit_adsorption_isotherm','analyze_vanthoff_equilibrium','calculate_acid_base_speciation','fit_electrochemical_impedance']}
