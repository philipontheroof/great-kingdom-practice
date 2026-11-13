import {canonicalState,facts,playAction,positionPayload} from './engine.mjs';
const now=()=>globalThis.performance?.now?.()??Date.now();
const opponent=p=>p==='first'?'second':'first';
const winnerValue=(state,winner)=>state.side_to_move===winner?1:-1;

export class BrowserSearch {
  constructor(state,evaluateAsync,{cPuct=1.5}={}) {
    if(typeof evaluateAsync!=='function')throw new TypeError('evaluateAsync must be a function');
    if(!Number.isFinite(cPuct)||cPuct<=0)throw new RangeError('cPuct must be positive');
    this.state=state;this.evaluateAsync=evaluateAsync;this.cPuct=cPuct;this.started=now();this.rootVisits=0;this.root=null;this.raw=null;this.exact=null;this.source=state.result?'rule':null;
  }
  async _expand(state){
    const f=facts(state),t=f.tactical;
    const winner=t.winner??(t.status==='proven_loss'?opponent(state.side_to_move):null);
    if(state.result)return {state,visits:0,value:0,evalValue:winnerValue(state,state.result.winner),expectedScore:null,edges:[],tactical:t,provenWinner:state.result.winner,expanded:true};
    let actions=t.status==='immediate_win'?t.candidates:t.status==='must_defend'?t.candidates:f.legal_actions;
    // Diagnostic continuation preserves every legal reply even after a proven loss.
    if(t.status==='proven_loss')actions=f.legal_actions;
    if(t.status==='immediate_win')return {state,visits:0,value:0,evalValue:1,expectedScore:null,edges:actions.map(action=>({action,prior:1/actions.length,visits:0,value:0,expectedScore:null,child:null})),tactical:t,provenWinner:winner,expanded:true};
    if(!actions.length)return {state,visits:0,value:0,evalValue:-1,expectedScore:null,edges:[],tactical:t,provenWinner:winner,expanded:true};
    const raw=await this.evaluateAsync(state,positionPayload(state));
    if(!raw||!Array.isArray(raw.policy82)||raw.policy82.length!==82)throw new Error('evaluation policy82 must contain 82 values');
    if(!Number.isFinite(raw.value)||raw.value < -1||raw.value>1)throw new Error('evaluation value must be between -1 and 1');
    if(state===this.state)this.raw=raw;
    const probs=actions.map(a=>Math.max(0,Number(raw.policy82[a])||0)),sum=probs.reduce((a,b)=>a+b,0);
    const edges=actions.map((action,i)=>({action,prior:sum?probs[i]/sum:1/actions.length,visits:0,value:0,expectedScore:null,child:null}));
    const evalValue=t.status==='proven_loss'?-1:raw.value;
    return {state,visits:0,value:0,evalValue,expectedScore:Number.isFinite(raw.expected_score)?raw.expected_score:null,edges,tactical:t,provenWinner:winner,expanded:true};
  }
  async _simulate(node,stopped=()=>false){
    if(stopped())return null;
    if(node.state.result){node.provenWinner=node.state.result.winner;const value=winnerValue(node.state,node.state.result.winner);node.visits++;node.value+=value;return value;}
    if(!node.expanded){const expanded=await this._expand(node.state);if(stopped())return null;Object.assign(node,expanded);node.visits++;node.value+=node.evalValue;return node.evalValue;}
    const parentN=Math.max(1,node.visits),sqrt=Math.sqrt(parentN);let best=null,bestScore=-Infinity;
    for(const edge of node.edges){
      const q=edge.child?.provenWinner?winnerValue(node.state,edge.child.provenWinner):(edge.visits?edge.value/edge.visits:0);
      const score=q+this.cPuct*edge.prior*sqrt/(1+edge.visits);
      if(score>bestScore){bestScore=score;best=edge;}
    }
    if(!best)return node.evalValue;
    if(!best.child){const childState=playAction(node.state,best.action);best.child={state:childState,visits:0,value:0,evalValue:0,expectedScore:null,edges:null,expanded:false,provenWinner:null};}
    const child=best.child,childValue=await this._simulate(child,stopped);
    if(childValue===null||stopped())return null;
    const parentValue=child.state.side_to_move===node.state.side_to_move?childValue:-childValue;
    if(best.expectedScore===null&&child.expectedScore!==null)best.expectedScore=child.state.side_to_move===node.state.side_to_move?child.expectedScore:-child.expectedScore;
    best.visits++;best.value+=parentValue;node.visits++;node.value+=parentValue;
    return parentValue;
  }
  async advance(visits,{deadline=Infinity,stopped=()=>false}={}){
    if(!Number.isInteger(visits)||visits<0)throw new RangeError('visits must be a non-negative integer');
    if(this.state.result)return this.snapshot();
    if(!this.root){const root={state:this.state,visits:0,value:0,evalValue:0,expectedScore:null,edges:null,expanded:false,provenWinner:null};Object.assign(root,await this._expand(this.state));if(stopped())return this.snapshot();this.root=root;this.exact=this.root.tactical;this.source=this.exact.status==='immediate_win'?'tactical':'network';}
    const target=this.rootVisits+visits;
    while(this.rootVisits<target&&now()<deadline&&!stopped()){
      const v=await this._simulate(this.root,stopped);
      if(v===null)break;
      this.rootVisits=this.root.visits;
    }
    if(this.rootVisits&&this.exact?.status!=='immediate_win')this.source='mcts';
    return this.snapshot();
  }
  findSubtree(targetCanonical){
    for(const e of this.root?.edges||[]){
      if(e.child?.expanded&&canonicalState(e.child.state)===targetCanonical)return e.child;
    }
    return null;
  }
  static fromNode(node,evaluateAsync,{cPuct=1.5}={}){
    const search=new BrowserSearch(node.state,evaluateAsync,{cPuct});
    search.root=node;
    search.rootVisits=node.visits;
    search.exact=node.tactical??null;
    search.source=node.state.result?'rule':(node.tactical?.status==='immediate_win'?'tactical':(node.visits?'mcts':'network'));
    return search;
  }
  snapshot(){
    if(this.state.result){const win=this.state.result.winner===this.state.side_to_move?1:0;return {source:'rule',proven_winner:this.state.result.winner,exact:{source:'rule',status:'terminal',proven_winner:this.state.result.winner,threats:[]},recommended_action:null,mcts:{root_visits:0,root_win_probability:win,candidates:[],principal_variation:[],elapsed_seconds:0}};}
    if(!this.root)return {source:this.source,proven_winner:null,exact:null,recommended_action:null,mcts:{root_visits:0,root_win_probability:null,candidates:[],principal_variation:[],elapsed_seconds:(now()-this.started)/1000}};
    const edges=this.root.edges||[],ordered=[...edges].sort((a,b)=>b.visits-a.visits||a.action-b.action),n=this.root.visits;
    const candidates=ordered.map(e=>{const q=e.child?.provenWinner?winnerValue(this.state,e.child.provenWinner):e.visits?Math.max(-1,Math.min(1,e.value/e.visits)):null;return {action:e.action,prior:e.prior,visits:e.visits,visit_share:n?e.visits/n:0,q,win_probability:q!==null?(q+1)/2:null,expected_score:e.visits?e.expectedScore??null:null};});
    let pv=[],node=this.root;for(let i=0;i<40&&node?.edges?.length;i++){const edge=[...node.edges].sort((a,b)=>b.visits-a.visits||a.action-b.action)[0];if(!edge||!edge.visits)break;pv.push(edge.action);node=edge.child;}
    const winner=this.root.provenWinner??null;
    const chosen=candidates.find(c=>c.visits)||candidates[0];const rootEstimate=Math.max(-1,Math.min(1,n?this.root.value/n:this.root.evalValue));
    return {source:this.source,proven_winner:winner,exact:{source:winner?'tactical':null,status:this.exact?.status??null,proven_winner:winner,threats:this.exact?.threats??[]},recommended_action:chosen?.action??null,mcts:{root_visits:n,root_win_probability:(rootEstimate+1)/2,candidates,principal_variation:pv,elapsed_seconds:(now()-this.started)/1000}};
  }
}
