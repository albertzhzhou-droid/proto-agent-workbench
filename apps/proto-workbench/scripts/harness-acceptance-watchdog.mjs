/** Runner liveness guard, independent of the model/controller's task policy.
 * A live queued task can wait indefinitely without spending its active budget. */
export const ACCEPTANCE_WATCHDOG = Object.freeze({startupMs:180000,checkpointLivenessMs:90000,cleanupMs:60000,pollMs:1000});
const terminalStates=new Set(["paused","completed","incomplete","blocked","cancelled","effect-unknown","failed"]);
export class AcceptanceWatchdog {
  constructor({startedAt=performance.now(),...limits}={}) {this.limits={...ACCEPTANCE_WATCHDOG,...limits};this.startedAt=startedAt;this.lastObservedAt=startedAt;}
  observe(checkpoint,{now=performance.now(),active=true}={}) {
    const violation=(code,message)=>({code,message,state:checkpoint?.state,revision:checkpoint?.revision,activeTimeMs:checkpoint?.activeTimeMs,activeBudgetMs:checkpoint?.contract?.budgets?.activeTimeMs,checkpointSilenceMs:now-this.lastObservedAt});
    if(!checkpoint)return now-this.startedAt>=this.limits.startupMs?violation("CHECKPOINT_STARTUP_TIMEOUT","No durable mission checkpoint appeared within the preparation liveness bound."):undefined;
    const budget=checkpoint.contract?.budgets?.activeTimeMs;
    if(!Number.isSafeInteger(checkpoint.revision)||!Number.isFinite(checkpoint.activeTimeMs)||!Number.isFinite(budget)||budget<=0)return violation("CHECKPOINT_INVALID","The persisted checkpoint cannot establish its active budget or revision.");
    if(this.runId&&this.runId!==checkpoint.contract.runId)return violation("CHECKPOINT_IDENTITY_CHANGED","The observed checkpoint belongs to a different mission.");
    if(this.revision!==undefined&&(checkpoint.revision<this.revision||checkpoint.activeTimeMs<this.activeTimeMs||budget!==this.budget))return violation("CHECKPOINT_ACCOUNTING_REGRESSED","Persisted revision, used time or immutable active budget changed inconsistently.");
    if(this.revision!==checkpoint.revision){this.lastObservedAt=now;this.revision=checkpoint.revision;}
    this.runId=checkpoint.contract.runId;this.activeTimeMs=checkpoint.activeTimeMs;this.budget=budget;
    if(terminalStates.has(checkpoint.state)||!active){
      this.terminalSince??=now;
      if(now-this.terminalSince>=this.limits.cleanupMs)return violation("TERMINAL_SETTLEMENT_TIMEOUT","The checkpoint is settled but its owned teardown or terminal event did not finish within the cleanup bound.");
      return;
    }
    this.terminalSince=undefined;
    if(checkpoint.activeTimeMs>=budget){
      this.budgetReachedAt??=now;
      if(now-this.budgetReachedAt>=this.limits.cleanupMs)return violation("ACTIVE_BUDGET_SETTLEMENT_TIMEOUT","The persisted active budget is exhausted but execution did not settle within the cleanup bound.");
    }
    if(now-this.lastObservedAt>=this.limits.checkpointLivenessMs)return violation("CHECKPOINT_LIVENESS_TIMEOUT","No newer durable checkpoint appeared within the liveness bound; queue time is excluded only while the execution remains observable.");
  }
}

export function boundedSettlement(promise,timeoutMs=ACCEPTANCE_WATCHDOG.cleanupMs,label="Owned execution cleanup") {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`${label} did not settle within ${timeoutMs} ms.`),{code:"OWNED_CLEANUP_TIMEOUT"})),timeoutMs);})]).finally(()=>clearTimeout(timer));
}
