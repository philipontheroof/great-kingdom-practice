import {canonicalState,facts,moveOrbits,playAction,positionPayload,stateStabilizer} from './engine.mjs?v=22';
const now=()=>globalThis.performance?.now?.()??Date.now();
const opponent=p=>p==='first'?'second':'first';
const winnerValue=(state,winner)=>state.side_to_move===winner?1:-1;

function flipScoreDistribution(dist,scoreMin){
  const n=dist.length;
  if(!n)return dist;
  if(scoreMin===null||scoreMin===undefined||scoreMin===-((n-1)/2)){
    const out=new Float64Array(n);
    for(let i=0;i<n;i++)out[i]=dist[n-1-i];
    return out;
  }
  const out=new Float64Array(n);
  for(let i=0;i<n;i++){
    const score=scoreMin+i;
    const j=Math.max(0,Math.min(n-1,Math.round(-score-scoreMin)));
    out[j]+=dist[i];
  }
  return out;
}

export class BrowserSearch {
  constructor(state,evaluateAsync,{cPuct=1.5,searchMode='puct',gumbelMaxConsidered=16,gumbelCVisit=50,gumbelCScale=1,rootSymmetryQuotient=false}={}) {
    if(typeof evaluateAsync!=='function')throw new TypeError('evaluateAsync must be a function');
    if(!Number.isFinite(cPuct)||cPuct<=0)throw new RangeError('cPuct must be positive');
    if(searchMode!=='puct'&&searchMode!=='gumbel')throw new RangeError('searchMode must be "puct" or "gumbel"');
    if(!Number.isInteger(gumbelMaxConsidered)||gumbelMaxConsidered<2)throw new RangeError('gumbelMaxConsidered must be >= 2');
    if(!Number.isFinite(gumbelCVisit)||gumbelCVisit<=0)throw new RangeError('gumbelCVisit must be positive');
    if(!Number.isFinite(gumbelCScale)||gumbelCScale<=0)throw new RangeError('gumbelCScale must be positive');
    this.state=state;this.evaluateAsync=evaluateAsync;this.cPuct=cPuct;
    this.searchMode=searchMode;this.gumbelMaxConsidered=gumbelMaxConsidered;
    this.gumbelCVisit=gumbelCVisit;this.gumbelCScale=gumbelCScale;
    this.rootSymmetryQuotient=Boolean(rootSymmetryQuotient);
    this.started=now();this.rootVisits=0;this.root=null;this.raw=null;this.exact=null;
    this.source=state.result?'rule':null;this._earlyStop=false;
    this._gumbel=null;this._gumbelScores=null;this._gumbelSelectedAction=null;
  }
  async _expand(state,isRoot=false){
    const f=facts(state),t=f.tactical;
    const winner=t.winner??(t.status==='proven_loss'?opponent(state.side_to_move):null);
    if(state.result)return {state,visits:0,value:0,evalValue:winnerValue(state,state.result.winner),expectedScore:null,scoreDist:null,scoreMin:null,edges:[],tactical:t,provenWinner:state.result.winner,fullyExplored:true,expanded:true};
    if(t.status==='proven_loss'&&!isRoot)return {state,visits:0,value:0,evalValue:-1,expectedScore:null,scoreDist:null,scoreMin:null,edges:[],tactical:t,provenWinner:winner,fullyExplored:true,expanded:true};
    let actions=t.status==='immediate_win'?t.candidates:t.status==='must_defend'?t.candidates:f.legal_actions;
    // Diagnostic continuation preserves every legal reply even after a proven loss.
    if(t.status==='proven_loss')actions=f.legal_actions;
    if(t.status==='immediate_win')return {state,visits:0,value:0,evalValue:1,expectedScore:null,scoreDist:null,scoreMin:null,edges:actions.map(action=>({action,prior:1/actions.length,visits:0,value:0,expectedScore:null,expectedScoreCount:0,scoreDistSum:null,scoreDistCount:0,scoreMin:null,child:null})),tactical:t,provenWinner:winner,fullyExplored:false,expanded:true};
    if(!actions.length)return {state,visits:0,value:0,evalValue:-1,expectedScore:null,scoreDist:null,scoreMin:null,edges:[],tactical:t,provenWinner:winner,fullyExplored:true,expanded:true};
    const raw=this.evaluateAsync.length>=2?await this.evaluateAsync(state,positionPayload(state)):await this.evaluateAsync(state);
    if(!raw||!Array.isArray(raw.policy82)||raw.policy82.length!==82)throw new Error('evaluation policy82 must contain 82 values');
    if(!Number.isFinite(raw.value)||raw.value < -1||raw.value>1)throw new Error('evaluation value must be between -1 and 1');
    if(state===this.state)this.raw=raw;
    let expandActions=actions,orbitMap=null;
    if(isRoot&&this.rootSymmetryQuotient&&actions.length>1&&stateStabilizer(state).length>1){
      const {membersByRep}=moveOrbits(state,actions);
      if(membersByRep.size<actions.length){
        orbitMap=membersByRep;
        expandActions=[...membersByRep.keys()];
      }
    }
    const probs=expandActions.map(a=>{
      const members=orbitMap?.get(a);
      if(!members)return Math.max(0,Number(raw.policy82[a])||0);
      let s=0;for(const m of members)s+=Math.max(0,Number(raw.policy82[m])||0);
      return s;
    }),sum=probs.reduce((a,b)=>a+b,0);
    const edges=expandActions.map((action,i)=>({action,orbitMembers:orbitMap?.get(action)??null,prior:sum?probs[i]/sum:1/expandActions.length,visits:0,value:0,expectedScore:null,expectedScoreCount:0,scoreDistSum:null,scoreDistCount:0,scoreMin:null,child:null}));
    const evalValue=t.status==='proven_loss'?-1:raw.value;
    const scoreDist=Array.isArray(raw.score_distribution)&&raw.score_distribution.length?Float64Array.from(raw.score_distribution):null;
    const scoreMin=Number.isFinite(raw.score_min)?raw.score_min:null;
    return {state,visits:0,value:0,evalValue,expectedScore:Number.isFinite(raw.expected_score)?raw.expected_score:null,scoreDist,scoreMin,edges,tactical:t,provenWinner:winner,fullyExplored:false,expanded:true};
  }
  _provenTier(parent,edge,{respectBudget=false}={}){
    const pw=edge?.child?.provenWinner;
    if(!pw||!parent?.state)return 1;
    if(respectBudget&&!this._earlyStop&&this.rootVisits<32)return 1;
    return pw===parent.state.side_to_move?0:2;
  }
  _qForParent(parent,edge){
    if(edge.child?.provenWinner)return winnerValue(parent.state,edge.child.provenWinner);
    return edge.visits?edge.value/edge.visits:0;
  }
  _completedQValues(root){
    let visitedPriorSum=0,weightedQSum=0,totalChildVisits=0;
    const edges=root?.edges||[];
    for(const edge of edges){
      if(edge.visits>0){
        visitedPriorSum+=edge.prior;
        weightedQSum+=edge.prior*this._qForParent(root,edge);
        totalChildVisits+=edge.visits;
      }
    }
    const vMix=(totalChildVisits>0&&visitedPriorSum>0)?(root.evalValue+(totalChildVisits/visitedPriorSum)*weightedQSum)/(1+totalChildVisits):root.evalValue;
    const map=new Map();
    for(const edge of edges)map.set(edge.action,edge.visits>0?this._qForParent(root,edge):vMix);
    return map;
  }
  _gumbelSigmaQ(root,budgetCap=null){
    const completedQ=this._completedQValues(root);
    const edges=root?.edges||[];
    let maxVisits=0;
    for(const edge of edges)if(edge.visits>maxVisits)maxVisits=edge.visits;
    if(budgetCap!==null&&budgetCap>0)maxVisits=Math.min(maxVisits,Math.max(1,budgetCap));
    const scale=(this.gumbelCVisit+maxVisits)*this.gumbelCScale;
    const sigmaQ=new Map();
    for(const [action,qVal] of completedQ)sigmaQ.set(action,scale*((qVal+1)*0.5));
    return sigmaQ;
  }
  _updateGumbelScores(budgetCap=null){
    const root=this.root;
    if(!root?.edges?.length)return new Map();
    const sigmaQ=this._gumbelSigmaQ(root,budgetCap);
    const scores=new Map();
    for(const edge of root.edges){
      const logPrior=Math.log(Math.max(edge.prior,1e-12));
      scores.set(edge.action,logPrior+(sigmaQ.get(edge.action)??0));
    }
    this._gumbelScores=scores;
    return scores;
  }
  _gumbelCompare(a,b,scores){
    const ta=this._provenTier(this.root,a),tb=this._provenTier(this.root,b);
    if(ta!==tb)return ta-tb;
    const fa=a.child?.fullyExplored?1:0,fb=b.child?.fullyExplored?1:0;
    if(fa!==fb)return fa-fb;
    const sa=scores.get(a.action)??-Infinity,sb=scores.get(b.action)??-Infinity;
    if(sa!==sb)return sb-sa;
    return a.action-b.action;
  }
  _improvedPolicy(root,budgetCap=null){
    const edges=root?.edges||[];
    const probs=new Map();
    if(!edges.length)return probs;
    const turn=root.state.side_to_move;
    const winning=edges.filter(e=>e.child?.provenWinner===turn);
    if(winning.length){
      const total=winning.reduce((s,e)=>s+Math.max(1,e.visits),0);
      for(const e of edges)probs.set(e.action,e.child?.provenWinner===turn?Math.max(1,e.visits)/total:0);
      return probs;
    }
    const nonLosing=edges.filter(e=>!e.child?.provenWinner||e.child.provenWinner===turn);
    const eligible=nonLosing.length?nonLosing:edges;
    const sigmaQ=this._gumbelSigmaQ(root,budgetCap);
    const logits=eligible.map(e=>({action:e.action,logit:Math.log(Math.max(e.prior,1e-12))+(sigmaQ.get(e.action)??0)}));
    const maxLogit=Math.max(...logits.map(l=>l.logit));
    let sum=0;
    const exps=logits.map(l=>{const v=Math.exp(l.logit-maxLogit);sum+=v;return {action:l.action,v};});
    for(const e of edges)probs.set(e.action,0);
    if(sum>0&&Number.isFinite(sum)){
      for(const x of exps)probs.set(x.action,x.v/sum);
    }
    return probs;
  }
  _initGumbelBracket(bracketVisits){
    const edges=this.root?.edges||[];
    if(!edges.length||bracketVisits<=0)return;
    const scores=this._updateGumbelScores(bracketVisits);
    if(edges.length===1){
      this._gumbelSelectedAction=edges[0].action;
      this._gumbel={totalBudget:bracketVisits,shBudget:bracketVisits,used:0,stageSizes:[],phaseIdx:0,active:[edges[0]],phaseRoundsRemaining:bracketVisits,cursor:0,statusByAction:new Map([[edges[0].action,'selected']]),finalists:[edges[0]],selectedAction:edges[0].action};
      return;
    }
    const shBudget=Math.max(0,bracketVisits-1);
    const mInit=Math.min(edges.length,this.gumbelMaxConsidered,shBudget>=2?Math.max(2,shBudget):edges.length);
    const sorted=[...edges].sort((a,b)=>this._gumbelCompare(a,b,scores));
    const active=sorted.slice(0,mInit);
    const activeSet=new Set(active.map(e=>e.action));
    const statusByAction=new Map();
    for(const e of edges)statusByAction.set(e.action,activeSet.has(e.action)?'active':'unconsidered');
    const stageSizes=[];
    if(shBudget>=2){
      let k=active.length;
      while(k>=2){stageSizes.push(k);if(k===2)break;k=Math.max(2,Math.floor(k/2));}
    }
    this._gumbelSelectedAction=active[0].action;
    this._gumbel={totalBudget:bracketVisits,shBudget,used:0,stageSizes,phaseIdx:0,active,phaseRoundsRemaining:0,cursor:0,statusByAction,finalists:active,selectedAction:active[0].action};
  }
  _finalizeGumbelSelection(scores){
    const g=this._gumbel,edges=this.root?.edges||[];
    if(!g||!edges.length)return null;
    const available=g.active.filter(e=>!e.child?.fullyExplored);
    const finalists=available.length?available:g.active;
    g.finalists=finalists;
    let best= [...finalists].sort((a,b)=>this._gumbelCompare(a,b,scores))[0];
    const bestTier=Math.min(...edges.map(e=>this._provenTier(this.root,e)));
    if(!best||best.visits===0||this._provenTier(this.root,best)!==bestTier){
      const eligible=edges.filter(e=>this._provenTier(this.root,e)===bestTier);
      const tried=eligible.filter(e=>e.visits>0);
      const finalistSet=new Set(finalists.map(e=>e.action));
      const triedFinalists=tried.filter(e=>finalistSet.has(e.action));
      const pool=triedFinalists.length?triedFinalists:(tried.length?tried:eligible);
      best=[...pool].sort((a,b)=>this._gumbelCompare(a,b,scores))[0];
    }
    if(best){
      g.selectedAction=best.action;
      this._gumbelSelectedAction=best.action;
      for(const e of finalists){
        if(g.statusByAction.get(e.action)!=='eliminated')g.statusByAction.set(e.action,'finalist');
      }
      g.statusByAction.set(best.action,'selected');
    }
    return best;
  }
  async _stepGumbel(stopped){
    const g=this._gumbel,edges=this.root?.edges||[];
    if(!g||!edges.length||g.used>=g.totalBudget)return null;
    if(edges.length===1){
      if(edges[0].child?.fullyExplored)return null;
      const v=await this._simulate(this.root,stopped,edges[0]);
      if(v===null)return null;
      g.used++;this._updateGumbelScores(g.totalBudget);
      return v;
    }
    if(g.used<g.shBudget&&g.phaseIdx<g.stageSizes.length){
      if(g.phaseRoundsRemaining<=0){
        const stageSize=g.stageSizes[g.phaseIdx];
        if(g.active.length>stageSize)g.active=g.active.slice(0,stageSize);
        const remainingPhases=g.stageSizes.length-g.phaseIdx;
        const remainingSh=g.shBudget-g.used;
        g.phaseRoundsRemaining=Math.max(1,Math.floor(remainingSh/(remainingPhases*g.active.length)));
        g.cursor=0;
      }
      let targetEdge=null;
      while(g.cursor<g.active.length){
        const candidate=g.active[g.cursor++];
        if(!candidate.child?.fullyExplored){targetEdge=candidate;break;}
      }
      if(!targetEdge){
        g.phaseRoundsRemaining=0;
      }else{
        const v=await this._simulate(this.root,stopped,targetEdge);
        if(v===null)return null;
        g.used++;
        if(g.cursor>=g.active.length){g.cursor=0;g.phaseRoundsRemaining--;}
        const allExplored=g.active.every(e=>e.child?.fullyExplored);
        if(g.phaseRoundsRemaining<=0||allExplored||g.used>=g.shBudget){
          const scores=this._updateGumbelScores(g.totalBudget);
          if(g.phaseIdx+1<g.stageSizes.length){
            const nextSize=g.stageSizes[g.phaseIdx+1];
            const pool=[...g.active];
            const unexploredActive=pool.filter(e=>!e.child?.fullyExplored);
            if(unexploredActive.length<nextSize){
              const needed=nextSize-unexploredActive.length;
              const activeSet=new Set(pool.map(e=>e.action));
              const extras=edges.filter(e=>!activeSet.has(e.action)&&!e.child?.fullyExplored).sort((a,b)=>this._gumbelCompare(a,b,scores));
              pool.push(...extras.slice(0,needed));
            }
            const nextActive=pool.sort((a,b)=>this._gumbelCompare(a,b,scores)).slice(0,nextSize);
            const nextSet=new Set(nextActive.map(e=>e.action));
            for(const e of g.active)if(!nextSet.has(e.action))g.statusByAction.set(e.action,'eliminated');
            for(const e of nextActive)g.statusByAction.set(e.action,'active');
            g.active=nextActive;
          }
          g.phaseIdx++;g.phaseRoundsRemaining=0;g.cursor=0;
          this._finalizeGumbelSelection(scores);
        }
        return v;
      }
    }
    if(g.used<g.shBudget){
      if(g.active.every(e=>e.child?.fullyExplored)){
        const scores=this._updateGumbelScores(g.totalBudget);
        const remaining=edges.filter(e=>!e.child?.fullyExplored).sort((a,b)=>this._gumbelCompare(a,b,scores));
        if(!remaining.length)return null;
        g.active=remaining.slice(0,2);g.cursor=0;
      }
      while(g.cursor<g.active.length){
        const candidate=g.active[g.cursor++];
        if(!candidate.child?.fullyExplored){
          const v=await this._simulate(this.root,stopped,candidate);
          if(v===null)return null;
          g.used++;
          if(g.cursor>=g.active.length)g.cursor=0;
          const scores=this._updateGumbelScores(g.totalBudget);
          this._finalizeGumbelSelection(scores);
          return v;
        }
      }
      g.cursor=0;
      return null;
    }
    // Final simulation(s) belong to the sequential-halving winner.
    let scores=this._updateGumbelScores(g.totalBudget);
    const avail=g.active.filter(e=>!e.child?.fullyExplored);
    let bestPool=avail.length?avail:edges.filter(e=>!e.child?.fullyExplored);
    if(!bestPool.length)return null;
    const bestEdge=[...bestPool].sort((a,b)=>this._gumbelCompare(a,b,scores))[0];
    const v=await this._simulate(this.root,stopped,bestEdge);
    if(v===null)return null;
    g.used++;
    scores=this._updateGumbelScores(g.totalBudget);
    this._finalizeGumbelSelection(scores);
    return v;
  }
  async _simulate(node,stopped=()=>false,forcedRootEdge=null){
    const res=await this._simulateLeaf(node,stopped,forcedRootEdge);
    return res===null?null:res.value;
  }
  async _simulateLeaf(node,stopped=()=>false,forcedRootEdge=null){
    if(stopped())return null;
    if(node.state.result){node.provenWinner=node.state.result.winner;node.fullyExplored=true;const value=winnerValue(node.state,node.state.result.winner);node.visits++;node.value+=value;return {value,scoreDist:node.scoreDist,scoreMin:node.scoreMin,side:node.state.side_to_move};}
    if(!node.expanded){const expanded=await this._expand(node.state,node===this.root);if(stopped())return null;Object.assign(node,expanded);node.visits++;node.value+=node.evalValue;return {value:node.evalValue,scoreDist:node.scoreDist,scoreMin:node.scoreMin,side:node.state.side_to_move};}
    let best=forcedRootEdge;
    if(!best){
      const parentN=Math.max(1,node.visits),sqrt=Math.sqrt(parentN);let bestScore=-Infinity;
      let pool=node.edges;
      if(this._earlyStop){
        const open=node.edges.filter(e=>!e.child?.fullyExplored);
        if(open.length)pool=open;
      }
      for(const edge of pool){
        const q=edge.child?.provenWinner?winnerValue(node.state,edge.child.provenWinner):(edge.visits?edge.value/edge.visits:0);
        const score=q+this.cPuct*edge.prior*sqrt/(1+edge.visits);
        if(score>bestScore){bestScore=score;best=edge;}
      }
    }
    if(!best)return {value:node.evalValue,scoreDist:node.scoreDist,scoreMin:node.scoreMin,side:node.state.side_to_move};
    if(!best.child){const childState=playAction(node.state,best.action);best.child={state:childState,visits:0,value:0,evalValue:0,expectedScore:null,scoreDist:null,scoreMin:null,edges:null,expanded:false,fullyExplored:false,provenWinner:null};}
    const child=best.child,childRes=await this._simulateLeaf(child,stopped,null);
    if(childRes===null||stopped())return null;
    const sameSide=child.state.side_to_move===node.state.side_to_move;
    const parentValue=sameSide?childRes.value:-childRes.value;
    if(child.expectedScore!==null){
      const signedScore=sameSide?child.expectedScore:-child.expectedScore;
      const count=(best.expectedScoreCount||0)+1;
      best.expectedScore=best.expectedScore===null?signedScore:best.expectedScore+(signedScore-best.expectedScore)/count;
      best.expectedScoreCount=count;
    }
    let alignedDist=childRes.scoreDist;
    if(alignedDist){
      if(childRes.side!==node.state.side_to_move)alignedDist=flipScoreDistribution(alignedDist,childRes.scoreMin);
      if(!best.scoreDistSum||best.scoreDistSum.length!==alignedDist.length){
        best.scoreDistSum=new Float64Array(alignedDist.length);
        best.scoreDistCount=0;
        best.scoreMin=childRes.scoreMin;
      }
      for(let i=0;i<alignedDist.length;i++)best.scoreDistSum[i]+=alignedDist[i];
      best.scoreDistCount=(best.scoreDistCount||0)+1;
    }
    best.visits++;best.value+=parentValue;node.visits++;node.value+=parentValue;
    if(node.edges&&node.edges.length>0){
      const turn=node.state.side_to_move;
      if(node.edges.every(e=>e.child?.fullyExplored)){
        node.fullyExplored=true;
      }
      if(node.edges.some(e=>e.child?.provenWinner===turn)){
        node.provenWinner=turn;
        if(node!==this.root)node.fullyExplored=true;
      }else{
        const winners=node.edges.map(e=>e.child?.provenWinner??null);
        if(winners.every(w=>w!==null&&w!==turn)){
          node.provenWinner=winners[0];
          if(node!==this.root)node.fullyExplored=true;
        }
      }
    }
    return {value:parentValue,scoreDist:alignedDist,scoreMin:childRes.scoreMin,side:node.state.side_to_move};
  }
  shouldStopEarly(){
    if(!this.root||this.root.visits===0)return false;
    if(this.root.fullyExplored)return true;
    if(this.root.provenWinner&&this.root.provenWinner===this.state.side_to_move)return true;
    return false;
  }
  stopReason(){
    if(this.state.result)return 'terminal';
    if(!this.root||this.root.visits===0)return null;
    if(this.root.provenWinner===this.state.side_to_move&&(this._earlyStop||this.root.fullyExplored))return 'proven_win';
    if(this.root.fullyExplored){
      if(this.root.provenWinner&&this.root.provenWinner!==this.state.side_to_move)return 'proven_loss';
      return 'fully_explored';
    }
    return null;
  }
  async advance(visits,{deadline=Infinity,stopped=()=>false,earlyStop=false,gumbelBudget=null}={}){
    if(!Number.isInteger(visits)||visits<0)throw new RangeError('visits must be a non-negative integer');
    if(earlyStop)this._earlyStop=true;
    if(this.state.result)return this.snapshot();
    if(!this.root){const root={state:this.state,visits:0,value:0,evalValue:0,expectedScore:null,edges:null,expanded:false,fullyExplored:false,provenWinner:null};Object.assign(root,await this._expand(this.state,true));if(stopped())return this.snapshot();this.root=root;this.exact=this.root.tactical;this.source=this.exact.status==='immediate_win'?'tactical':'network';}
    const target=this.rootVisits+visits;
    const initialRootVisits=this.rootVisits;
    if(this.searchMode==='gumbel'&&this.exact?.status!=='immediate_win'){
      while(this.rootVisits<target&&(this.rootVisits===initialRootVisits||now()<deadline)&&!stopped()){
        if(this._earlyStop&&this.shouldStopEarly())break;
        if(!this._gumbel||this._gumbel.used>=this._gumbel.totalBudget){
          const finiteRemaining=gumbelBudget!==null?Math.max(0,gumbelBudget-this.rootVisits):null;
          const nextBracket=finiteRemaining!==null?finiteRemaining:Math.max(128,this.rootVisits||128,visits);
          if(nextBracket<=0)break;
          this._initGumbelBracket(nextBracket);
        }
        const v=await this._stepGumbel(stopped);
        if(v===null)break;
        this.rootVisits=this.root.visits;
      }
    }else{
      while(this.rootVisits<target&&(this.rootVisits===initialRootVisits||now()<deadline)&&!stopped()){
        if(this._earlyStop&&this.shouldStopEarly())break;
        const v=await this._simulate(this.root,stopped);
        if(v===null)break;
        this.rootVisits=this.root.visits;
      }
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
  static fromNode(node,evaluateAsync,{cPuct=1.5,searchMode='puct',gumbelMaxConsidered=16,gumbelCVisit=50,gumbelCScale=1,rootSymmetryQuotient=false}={}){
    if(node.state.result===null&&node.expanded&&(!node.edges||!node.edges.length)){
      node.expanded=false;
      node.fullyExplored=false;
    }
    if(node.edges?.length&&!node.edges.every(e=>e.child?.fullyExplored)){
      node.fullyExplored=false;
    }
    const search=new BrowserSearch(node.state,evaluateAsync,{cPuct,searchMode,gumbelMaxConsidered,gumbelCVisit,gumbelCScale,rootSymmetryQuotient});
    search.root=node;
    search.rootVisits=node.visits;
    search.exact=node.tactical??null;
    search.source=node.state.result?'rule':(node.tactical?.status==='immediate_win'?'tactical':(node.visits?'mcts':'network'));
    return search;
  }
  snapshot(){
    if(this.state.result){const win=this.state.result.winner===this.state.side_to_move?1:0;return {source:'rule',search_mode:this.searchMode,proven_winner:this.state.result.winner,stop_reason:'terminal',exact:{source:'rule',status:'terminal',proven_winner:this.state.result.winner,threats:[]},recommended_action:null,mcts:{root_visits:0,root_win_probability:win,fully_explored:true,candidates:[],principal_variation:[],elapsed_seconds:0}};}
    if(!this.root)return {source:this.source,search_mode:this.searchMode,proven_winner:null,stop_reason:null,exact:null,recommended_action:null,mcts:{root_visits:0,root_win_probability:null,fully_explored:false,candidates:[],principal_variation:[],elapsed_seconds:(now()-this.started)/1000}};
    const edges=this.root.edges||[],n=this.root.visits;
    const useGumbel=this.searchMode==='gumbel'&&this.exact?.status!=='immediate_win'&&edges.length>0;
    const gumbelScores=useGumbel?(this._gumbelScores??this._updateGumbelScores(this._gumbel?.totalBudget??null)):null;
    const improvedPolicy=useGumbel?this._improvedPolicy(this.root,this._gumbel?.totalBudget??null):null;
    const selectedAction=useGumbel?(this._gumbelSelectedAction??this._gumbel?.selectedAction??null):null;
    const statusMap=useGumbel?(this._gumbel?.statusByAction??null):null;
    const provenTier=(parent,edge)=>this._provenTier(parent,edge);
    const ordered=[...edges].sort((a,b)=>{
      const ta=provenTier(this.root,a),tb=provenTier(this.root,b);
      if(ta!==tb)return ta-tb;
      if(useGumbel){
        const sa=a.action===selectedAction?0:1,sb=b.action===selectedAction?0:1;
        if(sa!==sb)return sa-sb;
        const ga=gumbelScores?.get(a.action)??-Infinity,gb=gumbelScores?.get(b.action)??-Infinity;
        if(ga!==gb)return gb-ga;
      }
      if(b.visits!==a.visits)return b.visits-a.visits;
      if(gumbelScores){
        const ga=gumbelScores.get(a.action)??-Infinity,gb=gumbelScores.get(b.action)??-Infinity;
        if(ga!==gb)return gb-ga;
      }
      return a.action-b.action;
    });
    const candidates=[];
    for(const e of ordered){
      const q=e.child?.provenWinner?winnerValue(this.state,e.child.provenWinner):e.visits?Math.max(-1,Math.min(1,e.value/e.visits)):null;
      const scoreDistribution=e.scoreDistSum&&e.scoreDistCount?Array.from(e.scoreDistSum,v=>v/e.scoreDistCount):null;
      const gumbelStatus=useGumbel?(e.action===selectedAction?'selected':(statusMap?.get(e.action)??'unconsidered')):null;
      const members=e.orbitMembers&&e.orbitMembers.length>1?e.orbitMembers:[e.action];
      const k=members.length;
      const visitShare=(n?e.visits/n:0)/k;
      const impPol=improvedPolicy?(improvedPolicy.get(e.action)??0)/k:null;
      const priorShare=e.prior/k;
      for(const action of members){
        candidates.push({action,prior:priorShare,visits:e.visits,visit_share:visitShare,improved_policy:impPol,gumbel_score:gumbelScores?(gumbelScores.get(e.action)??null):null,gumbel_status:gumbelStatus,orbit_size:k,orbit_rep:e.action,q,win_probability:q!==null?(q+1)/2:null,expected_score:e.visits?e.expectedScore??null:null,score_distribution:scoreDistribution,score_min:e.scoreMin??null,proven_winner:e.child?.provenWinner??null,fully_explored:Boolean(e.child?.fullyExplored)});
      }
    }
    let pv=[],node=this.root;
    for(let i=0;i<40&&node?.edges?.length;i++){
      const isRoot=node===this.root;
      const edge=[...node.edges].sort((a,b)=>{
        const ta=provenTier(node,a),tb=provenTier(node,b);
        if(ta!==tb)return ta-tb;
        if(isRoot&&useGumbel){
          const sa=a.action===selectedAction?0:1,sb=b.action===selectedAction?0:1;
          if(sa!==sb)return sa-sb;
          const ga=gumbelScores?.get(a.action)??-Infinity,gb=gumbelScores?.get(b.action)??-Infinity;
          if(ga!==gb)return gb-ga;
        }
        return b.visits-a.visits||a.action-b.action;
      })[0];
      if(!edge||!edge.visits)break;
      pv.push(edge.action);node=edge.child;
    }
    const winner=this.root.provenWinner??null;
    const chosen=useGumbel?(candidates.find(c=>c.action===selectedAction)||candidates[0]):(candidates.find(c=>c.visits)||candidates[0]);
    const rootEstimate=Math.max(-1,Math.min(1,n?this.root.value/n:this.root.evalValue));
    return {source:this.source,search_mode:this.searchMode,proven_winner:winner,stop_reason:this.stopReason(),exact:{source:winner?'tactical':null,status:this.exact?.status??null,proven_winner:winner,threats:this.exact?.threats??[]},recommended_action:chosen?.action??null,mcts:{root_visits:n,root_win_probability:(rootEstimate+1)/2,fully_explored:Boolean(this.root?.fullyExplored),candidates,principal_variation:pv,elapsed_seconds:(now()-this.started)/1000}};
  }
}
