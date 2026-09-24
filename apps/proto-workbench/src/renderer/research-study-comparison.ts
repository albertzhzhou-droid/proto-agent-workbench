/** JSON field comparisons only: no unit conversion, statistical inference or scientific equivalence. */
export interface ComparedValue { kind: "missing" | "null" | "array" | "object" | "string" | "number" | "boolean"; value?: unknown }
export interface ComparisonRow { pointer: string; left: ComparedValue; right: ComparedValue; changed: boolean }
const missing = Symbol("missing");
const value = (entry: unknown | typeof missing): ComparedValue => entry === missing ? {kind:"missing"}
  : {kind:entry===null?"null":Array.isArray(entry)?"array":typeof entry as ComparedValue["kind"],value:entry};
const segment = (key:string) => key.replaceAll("~","~0").replaceAll("/","~1");

export function compareStudyJson(left: unknown, right: unknown, limit=200): {rows:ComparisonRow[];truncated:boolean} {
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new Error("Comparison requires a field limit between 1 and 500.");
  const rows:ComparisonRow[]=[];let truncated=false,visited=0;
  const visit=(a:unknown|typeof missing,b:unknown|typeof missing,pointer:string,depth:number):void=>{
    if(rows.length>=limit||++visited>2000){truncated=true;return;}
    const aContainer=a!==null&&typeof a==="object",bContainer=b!==null&&typeof b==="object";
    if(aContainer&&bContainer&&Array.isArray(a)===Array.isArray(b)){
      const aObject=a as Record<string,unknown>,bObject=b as Record<string,unknown>;
      const keys=Array.isArray(a)?undefined:[...new Set([...Object.keys(aObject),...Object.keys(bObject)])].sort();
      const length=keys?.length??Math.max((a as unknown[]).length,(b as unknown[]).length);
      if(length){
        if(depth>=12){truncated=true;return;}
        for(let index=0;index<length;index++){
          const key=keys?.[index]??String(index);
          visit(Object.hasOwn(aObject,key)?aObject[key]:missing,Object.hasOwn(bObject,key)?bObject[key]:missing,`${pointer}/${segment(key)}`,depth+1);
          if(truncated)break;
        }
        return;
      }
    }
    const changed=aContainer&&bContainer?Array.isArray(a)!==Array.isArray(b):!Object.is(a,b);
    rows.push({pointer,left:value(a),right:value(b),changed});
  };
  visit(left,right,"",0);return {rows,truncated};
}

export function displayComparedValue(entry:ComparedValue,limit=1200):string {
  if(entry.kind==="missing")return "Not present";
  if(entry.kind==="number"&&Object.is(entry.value,-0))return "-0";
  const text=JSON.stringify(entry.value)??"Unsupported value";
  return text.length>limit?`${text.slice(0,limit)}… [display truncated]`:text;
}

/** Scope/request generations do not regain authority when a user returns to an old selection. */
export function createStudyRequestScope() {
  let workspace="",epoch=0,selection=0;
  const requests=new Map<string,number>();
  type Token={workspace:string;epoch:number;selection:number;channel:string;request:number};
  return {
    activate(next:string){if(next!==workspace){workspace=next;epoch++;selection++;requests.clear();return true;}return false;},
    select(){selection++;},
    begin(channel:string):Token{const request=(requests.get(channel)??0)+1;requests.set(channel,request);return {workspace,epoch,selection,channel,request};},
    current(token:Token,requireSelection=true){return token.workspace===workspace&&token.epoch===epoch&&(!requireSelection||token.selection===selection)&&requests.get(token.channel)===token.request;},
  };
}
