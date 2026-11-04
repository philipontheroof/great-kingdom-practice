import {lineThrough} from './study.mjs';

export const BUDGET_RANGE={visits:{min:1,max:10_000_000},seconds:{min:.1,max:3600}};
export const BUDGET_DEFAULT={visits:1600,seconds:5};

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

export function budgetReached(budget,analysis){
 if(!analysis||!budget||budget.unit==='none')return false;
 if(analysis.source==='rule')return true;
 if(budget.unit==='visits')return (analysis.mcts?.root_visits||0)>=budget.value;
 return (analysis.cumulative_elapsed_seconds??analysis.mcts?.elapsed_seconds??0)>=budget.value;
}

export const budgetLabel=b=>b.unit==='none'?'무제한':b.unit==='visits'?`${b.value.toLocaleString()} visits`:`${b.value}초`;

export function missingNodes(doc,scope='branch',backend=null,target='missing'){
 const nodes=scope==='all'?doc.nodes:lineThrough(doc,doc.selected);
 if(target==='all')return nodes;
 return nodes.filter(n=>!n.analysis||(n.analysis.model&&n.analysis.model.id!==doc.model_id)||(backend&&n.analysis.backend!==backend));
}
