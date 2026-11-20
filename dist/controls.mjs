import {lineThrough} from './study.mjs';

export const BUDGET_RANGE={visits:{min:1,max:10_000_000},seconds:{min:.1,max:3600}};
export const BUDGET_DEFAULT={visits:1600,seconds:5};
export const TEMPERATURE_RANGE={min:0,max:2};
export const TEMPERATURE_DEFAULT=0.4;

export class PracticeControls {
 constructor(){
   this.continuous={first:false,second:false};
   this.visualContinuous=false;
   this.visible=false;
   this.aiSide={first:false,second:false};
   this._aiString=null;
   this._autoAnalysis=false;
   this.playing=true;
   this.epoch=0;
 }
 get autoAnalysis(){return Boolean(this.continuous.first||this.continuous.second||this._autoAnalysis);}
 set autoAnalysis(v){this._autoAnalysis=Boolean(v);this.continuous.first=this.continuous.second=Boolean(v);}
 get autoVisual(){return this.visualContinuous;}
 set autoVisual(v){this.visualContinuous=Boolean(v);}
 get ai(){
   if(this._aiString!==null)return this._aiString;
   return this.aiSide;
 }
 set ai(val){
   if(typeof val==='string'){
     this._aiString=val;
     this.aiSide={first:['first','both'].includes(val),second:['second','both'].includes(val)};
   }else if(typeof val==='object'&&val!==null){
     this.aiSide=val;
     this._aiString=null;
   }
 }
 visualize(){this.visible=!this.visible;if(!this.visible)this.visualContinuous=false;}
 invalidate(){this.epoch++;}
 begin(node,model,backend){return {epoch:++this.epoch,node,model,backend};}
 accepts(t,node,model,backend){return t.epoch===this.epoch&&t.node===node&&t.model===model&&t.backend===backend;}
 anyContinuous(){return Boolean(this.continuous.first||this.continuous.second);}
 anyAI(){return Boolean(this.aiSide.first||this.aiSide.second||(this._aiString&&this._aiString!=='none'));}
 aiTurn(p){
   if(!p||p.result)return false;
   if(this._aiString!==null)return this._aiString==='both'||this._aiString===p.side_to_move;
   return Boolean(this.aiSide[p.side_to_move]);
 }
 shouldAnalyze(p){
   return !p.result&&(this.autoAnalysis||Boolean(this.continuous[p.side_to_move])||this.aiTurn(p));
 }
}

export function normalizeBudget(budget,{allowNone=false,fallback='visits'}={}){
 const unit=budget?.unit==='none'&&allowNone?'none':budget?.unit in BUDGET_RANGE?budget.unit:fallback;
 if(unit==='none')return {unit,value:null};
 const range=BUDGET_RANGE[unit];let value=Number(budget?.value);
 if(!Number.isFinite(value))value=BUDGET_DEFAULT[unit];
 value=Math.min(range.max,Math.max(range.min,value));
 value=unit==='visits'?Math.round(value):Math.round(value*10)/10;
 return {unit,value};
}

export function analysisFloor(unit,plays){
 if(unit==='none')return null;
 const values=plays.filter(p=>p.on&&p.budget.unit===unit).map(p=>p.budget.value);
 return values.length?Math.max(...values):null;
}

export function budgetPayload(budget){
 return budget.unit==='visits'?{max_visits:budget.value}:budget.unit==='seconds'?{max_seconds:budget.value}:{};
}

export function searchRequestBudget(budget){
 const normalized=normalizeBudget(budget,{allowNone:true,fallback:'seconds'});
 const oneShotSeconds=normalized.unit==='seconds'?Math.min(10,Math.max(0.05,normalized.value)):2;
 return {visits:1600,seconds:oneShotSeconds,continuous:true,...budgetPayload(normalized)};
}

export function budgetReached(budget,analysis){
 if(!analysis)return false;
 if(analysis.source==='rule'||['proven_win','proven_loss','fully_explored','terminal'].includes(analysis.stop_reason))return true;
 if(!budget||budget.unit==='none')return false;
 if(budget.unit==='visits')return (analysis.mcts?.root_visits||0)>=budget.value;
 return (analysis.cumulative_elapsed_seconds??analysis.mcts?.elapsed_seconds??0)>=budget.value;
}

export const budgetLabel=b=>b.unit==='none'?'무제한':b.unit==='visits'?`${b.value.toLocaleString()} visits`:`${b.value}초`;

export function missingNodes(doc,scope='branch',backend=null,target='missing'){
 const nodes=scope==='all'?doc.nodes:lineThrough(doc,doc.selected,doc.branch_leaf);
 if(target==='all')return nodes;
 return nodes.filter(n=>!n.analysis||(n.analysis.model&&n.analysis.model.id!==doc.model_id)||(backend&&n.analysis.backend!==backend));
}

export function normalizeTemperature(value,{fallback=TEMPERATURE_DEFAULT}={}){
 const n=Number(value);
 if(!Number.isFinite(n))return fallback;
 const clamped=Math.min(TEMPERATURE_RANGE.max,Math.max(TEMPERATURE_RANGE.min,n));
 return Math.round(clamped*10)/10;
}

export function isProvenWinCandidate(c,result){
 if(!c)return false;
 if(c.proven_winner&&result?.perspective)return c.proven_winner===result.perspective;
 if(result?.exact?.status==='immediate_win')return true;
 return c.q===1;
}

export function isProvenLossCandidate(c,result){
 if(!c)return false;
 if(c.proven_winner&&result?.perspective)return c.proven_winner!==result.perspective;
 return c.visits>0&&c.q===-1;
}

export function pickAiAction(result,temperature=0,rng=Math.random,options={}){
 if(typeof rng==='object'&&rng!==null){options=rng;rng=Math.random;}
 if(typeof rng!=='function')rng=Math.random;
 const {ignoreProvenLoss=true,forceProvenWin=true}=options;
 const bestAction=result?.recommended_action??result?.mcts?.candidates?.[0]?.action??null;
 if(bestAction===null)return null;
 const temp=normalizeTemperature(temperature,{fallback:0});
 const candidates=result?.mcts?.candidates||[];
 const visited=candidates.filter(c=>c&&c.visits>0);
 const isGumbel=result?.search_mode==='gumbel';
 const rawPool=isGumbel?candidates.filter(c=>c&&(c.visits>0||(typeof c.improved_policy==='number'&&c.improved_policy>0))):visited;
 const winning=candidates.filter(c=>isProvenWinCandidate(c,result));
 if(forceProvenWin){
   if(winning.length>0)return winning[0].action;
   if(result?.source==='tactical'||(result?.proven_winner&&(!result?.perspective||result.proven_winner===result.perspective)))return bestAction;
 }
 if(temp<=0){
   if(ignoreProvenLoss&&rawPool.length>1){
     const bestCand=rawPool.find(c=>c.action===bestAction);
     if(bestCand&&isProvenLossCandidate(bestCand,result)){
       const nonLosing=rawPool.filter(c=>!isProvenLossCandidate(c,result));
       if(nonLosing.length)return nonLosing[0].action;
     }
   }
   return bestAction;
 }
 if(rawPool.length<=1)return bestAction;
 const nonLosing=ignoreProvenLoss?rawPool.filter(c=>!isProvenLossCandidate(c,result)):rawPool;
 const pool=nonLosing.length?nonLosing:rawPool;
 if(pool.length<=1)return pool[0].action;
 const invTemp=1/temp;
 const useImproved=isGumbel&&pool.some(c=>typeof c.improved_policy==='number'&&c.improved_policy>0);
 const scores=pool.map(c=>useImproved?Math.max(0,c.improved_policy||0):c.visits);
 const maxScore=Math.max(...scores);
 if(!Number.isFinite(maxScore)||maxScore<=0)return bestAction;
 const weights=scores.map(s=>Math.pow(s/maxScore,invTemp));
 const total=weights.reduce((a,b)=>a+b,0);
 if(!Number.isFinite(total)||total<=0)return bestAction;
 let r=rng()*total;
 for(let i=0;i<pool.length;i++){
   r-=weights[i];
   if(r<=0)return pool[i].action;
 }
 return pool[pool.length-1].action;
}
