export const RULESET='gk-v2.2';
const SIZE=9, AREA=81, PASS=81;
const neighbors=i=>{const r=Math.floor(i/9),c=i%9,o=[];if(r)o.push(i-9);if(c<8)o.push(i+1);if(r<8)o.push(i+9);if(c)o.push(i-1);return o;};
function validateKomi(k){if(typeof k!=='number'||!Number.isFinite(k))throw Error('komi must be finite');return Object.is(k,-0)?0:k;}
function group(board,start){const color=board[start];if(color!==1&&color!==2)throw Error('group must start on castle');const stones=new Set([start]),q=[start];for(let n=0;n<q.length;n++)for(const j of neighbors(q[n]))if(board[j]===color&&!stones.has(j)){stones.add(j);q.push(j);}const libs=new Set();for(const i of stones)for(const j of neighbors(i))if(board[j]===0)libs.add(j);return {color,stones:[...stones].sort((a,b)=>a-b),liberties:[...libs].sort((a,b)=>a-b)};}
export function stateGroups(s){const seen=new Set(),gs=[];for(let i=0;i<AREA;i++)if((s.board[i]===1||s.board[i]===2)&&!seen.has(i)){const g=group(s.board,i);for(const x of g.stones)seen.add(x);gs.push(g);}return gs;}
export function initialState(setup={}){
  if(!setup||typeof setup!=='object'||Array.isArray(setup))throw Error('invalid setup');
  const board=Array(AREA).fill(0);
  if(Array.isArray(setup.board)&&setup.board.length===AREA){
    for(let i=0;i<AREA;i++){const v=setup.board[i];board[i]=[1,2,3].includes(v)?v:0;}
  }else{
    const neutral=Object.hasOwn(setup,'neutral')?setup.neutral:[4,4];
    if(neutral!==null){
      if(!Array.isArray(neutral)||neutral.length!==2||neutral.some(x=>!Number.isInteger(x)||x<0||x>8))throw Error('invalid neutral');
      board[neutral[0]*9+neutral[1]]=3;
    }
    if(Array.isArray(setup.stones)){
      for(const s of setup.stones){
        if(s&&Number.isInteger(s.action)&&s.action>=0&&s.action<AREA&&[1,2,3].includes(s.color)){
          board[s.action]=s.color;
        }
      }
    }
  }
  const side=setup.side_to_move==='second'?'second':'first';
  let result=setup.result?{winner:setup.result.winner,reason:setup.result.reason}:null;
  if(!result&&Array.isArray(setup.board)){
    const gs=stateGroups({board});
    const dead=gs.filter(g=>g.liberties.length===0);
    if(dead.length){
      result={winner:dead[0].color===1?'second':'first',reason:'siege'};
    }
  }
  const previous_move_was_pass=Boolean(setup.previous_move_was_pass);
  return {board,side_to_move:side,previous_move_was_pass,komi:validateKomi(setup.komi??2.5),result,ruleset_version:RULESET};
}
export function territory(board){const out=Array(AREA).fill(0),seen=new Set();for(let i=0;i<AREA;i++){if(board[i]!==0||seen.has(i))continue;const q=[i],component=[i];seen.add(i);const adj=new Set(),edges=new Set();for(let n=0;n<q.length;n++){const x=q[n],r=Math.floor(x/9),c=x%9;if(r===0)edges.add('t');if(r===8)edges.add('b');if(c===0)edges.add('l');if(c===8)edges.add('r');for(const j of neighbors(x)){if(board[j]===0&&!seen.has(j)){seen.add(j);q.push(j);component.push(j);}else if(board[j]===1||board[j]===2)adj.add(board[j]);}}if(edges.size===4)continue;if(!adj.has(2))for(const x of component)out[x]=1;else if(!adj.has(1))for(const x of component)out[x]=2;}return out;}
function legal(s,terr=territory(s.board)){if(s.result)return [];const own=s.side_to_move==='first'?1:2,opp=3-own,out=[];for(let i=0;i<AREA;i++)if(!s.board[i]&&terr[i]!==opp&&!(terr[i]===own&&s.ruleset_version===RULESET))out.push(i);out.push(PASS);return out;}
function playUnchecked(s,a){if(a===PASS){if(s.previous_move_was_pass){const t=territory(s.board),first=t.filter(x=>x===1).length,second=t.filter(x=>x===2).length;return {...s,result:{winner:first-second>s.komi?'first':'second',reason:'pass_score'}};}return {...s,side_to_move:s.side_to_move==='first'?'second':'first',previous_move_was_pass:true};}const board=s.board.slice(),mover=s.side_to_move,me=mover==='first'?1:2,opp=3-me;board[a]=me;const provisional={...s,board,previous_move_was_pass:false};const checked=new Set();for(const j of neighbors(a))if(board[j]===opp&&!checked.has(j)){const g=group(board,j);g.stones.forEach(x=>checked.add(x));if(!g.liberties.length)return {...provisional,result:{winner:mover,reason:'siege'}};}const own=group(board,a);if(!own.liberties.length)return {...provisional,result:{winner:mover==='first'?'second':'first',reason:'siege'}};return {...provisional,side_to_move:mover==='first'?'second':'first'};}
export const legalActions=legal;
export function playAction(s,a){if(!Number.isInteger(a)||a<0||a>PASS)throw Error('action must be integer 0..81');if(!legal(s).includes(a))throw Error('illegal move');return playUnchecked(s,a);}
function immediateWins(s,groups=stateGroups(s),actions=legal(s)){const opp=s.side_to_move==='first'?2:1,wins=[];for(const g of groups)if(g.color===opp&&g.liberties.length===1){const a=g.liberties[0];if(actions.includes(a)){const next=playUnchecked(s,a);if(next.result?.winner===s.side_to_move&&next.result.reason==='siege'&&!wins.includes(a))wins.push(a);}}return wins.sort((a,b)=>a-b);}
export function facts(s){const t=territory(s.board),legal_actions=legal(s,t),groups=stateGroups(s).map(g=>({...g,protected:g.stones.some(i=>neighbors(i).some(j=>t[j]===g.color))}));let tactical;if(s.result)tactical={status:'terminal',candidates:[],threats:[],winner:s.result.winner};else {const wins=immediateWins(s,groups,legal_actions);if(wins.length)tactical={status:'immediate_win',candidates:wins,threats:[],winner:s.side_to_move};else {const opp=s.side_to_move==='first'?'second':'first',os={...s,side_to_move:opp,previous_move_was_pass:false},threats=immediateWins(os,groups,legal(os,t));if(!threats.length)tactical={status:'quiet',candidates:legal_actions,threats:[],winner:null};else {const candidates=legal_actions.filter(a=>{const n=playUnchecked(s,a);return (n.result?.winner===s.side_to_move)||(!n.result&&!immediateWins(n).length);});tactical=candidates.length?{status:'must_defend',candidates,threats,winner:null}:{status:'proven_loss',candidates:[],threats,winner:opp};}}}return {territory:t,legal_actions,groups,tactical};}
export function features(s){const t=territory(s.board),groups=stateGroups(s).map(g=>({...g,protected:g.stones.some(i=>neighbors(i).some(j=>t[j]===g.color))})),spatial=new Float32Array(12*AREA),me=s.side_to_move==='first'?1:2,opp=3-me;for(let i=0;i<AREA;i++){const c=s.board[i];if(c===3)spatial[4*AREA+i]=1;if(t[i]===(me===1?1:2))spatial[5*AREA+i]=1;else if(t[i]===(opp===1?1:2))spatial[6*AREA+i]=1;}for(const g of groups){const protectedGroup=g.protected;for(const i of g.stones){const category=g.color===me?(protectedGroup?0:1):(protectedGroup?2:3);spatial[category*AREA+i]=1;spatial[11*AREA+i]=g.stones.length/81;}if(protectedGroup)continue;const l=g.liberties.length;if(l>0&&l<=3)for(const i of g.stones)spatial[(6+l)*AREA+i]=1;for(const i of g.stones)spatial[10*AREA+i]=l/81;}const my=t.filter(x=>x===(me===1?1:2)).length,other=t.filter(x=>x===(opp===1?1:2)).length;return {spatial,global_features:new Float32Array([(my-other)/81,(me===2?s.komi:-s.komi)/81,+s.previous_move_was_pass])};}
export function canonicalState(s){const hex=floatHex(s.komi);return JSON.stringify({board:s.board.join(''),komi:hex,previous_move_was_pass:s.previous_move_was_pass,result:s.result?{reason:s.result.reason,winner:s.result.winner}:null,ruleset:s.ruleset_version,side_to_move:s.side_to_move});}
function floatHex(x){if(x===0)return '0x0.0p+0';const b=new ArrayBuffer(8),v=new DataView(b);v.setFloat64(0,x,false);const bits=v.getBigUint64(0,false),negative=Boolean(bits>>63n),exponent=Number((bits>>52n)&0x7ffn),fraction=(bits&0xfffffffffffffn).toString(16).padStart(13,'0'),sign=negative?'-':'';if(exponent===0)return `${sign}0x0.${fraction}p-1022`;const power=exponent-1023;return `${sign}0x1.${fraction}p${power>=0?'+':''}${power}`;}
export function positionPayload(s){const f=facts(s),scores={blue:f.territory.filter(x=>x===1).length,red:f.territory.filter(x=>x===2).length};const marks=[];if(s.result?.reason==='siege'){const losing=s.result.winner==='first'?2:1;for(const g of f.groups)if(g.color===losing&&!g.liberties.length)marks.push(...g.stones);}return {ruleset_version:s.ruleset_version,board:s.board.slice(),territory:f.territory,side_to_move:s.side_to_move,previous_move_was_pass:s.previous_move_was_pass,komi:s.komi,legal_actions:f.legal_actions,score:{...scores,blue_margin:scores.blue-scores.red-s.komi,red_margin:scores.red-scores.blue+s.komi},result:s.result?{winner:s.result.winner,reason:s.result.reason}:null,terminal_marks:marks.sort((a,b)=>a-b)};}
export function replayPosition(payload={}){if(!payload||typeof payload!=='object'||(payload.ruleset_version??RULESET)!==RULESET)throw Error('unsupported ruleset or request');const actions=payload.actions??[];if(!Array.isArray(actions)||actions.length>2000)throw Error('actions must be <= 2000');let s=initialState(payload.setup??{});for(const a of actions){if(!Number.isInteger(a)||a<0||a>81)throw Error('invalid action');s=playAction(s,a);}return s;}

export const D4_INVERSE=[0,3,2,1,4,5,6,7];
export function transformAction(action,sym){
  if(action===PASS||sym===0)return action;
  const r=Math.floor(action/SIZE),c=action%SIZE,e=SIZE-1;
  let tr=r,tc=c;
  if(sym===1){tr=c;tc=e-r;}
  else if(sym===2){tr=e-r;tc=e-c;}
  else if(sym===3){tr=e-c;tc=r;}
  else if(sym===4){tr=r;tc=e-c;}
  else if(sym===5){tr=e-c;tc=e-r;}
  else if(sym===6){tr=e-r;tc=c;}
  else if(sym===7){tr=c;tc=r;}
  return tr*SIZE+tc;
}
const D4_ACTION_PERMS=Array.from({length:8},(_,sym)=>Array.from({length:AREA},(__,a)=>transformAction(a,sym)));
export function transformState(state,sym){
  if(sym===0)return {...state,board:state.board.slice()};
  const perm=D4_ACTION_PERMS[sym],board=Array(AREA).fill(0);
  for(let a=0;a<AREA;a++)board[perm[a]]=state.board[a];
  return {...state,board};
}
export function stateStabilizer(state){
  const b=state.board,out=[];
  for(let sym=0;sym<8;sym++){
    if(sym===0){out.push(0);continue;}
    const perm=D4_ACTION_PERMS[sym];let same=true;
    for(let a=0;a<AREA;a++){if(b[perm[a]]!==b[a]){same=false;break;}}
    if(same)out.push(sym);
  }
  return out;
}
export function canonicalD4State(state){
  const b=state.board,stabilizer=[];let bestKey=null,bestSym=0,bestBoard=b;
  for(let sym=0;sym<8;sym++){
    const perm=D4_ACTION_PERMS[sym],tb=Array(AREA);
    let same=true;
    for(let a=0;a<AREA;a++){const v=b[a];tb[perm[a]]=v;}
    for(let a=0;a<AREA;a++){if(tb[a]!==b[a]){same=false;break;}}
    if(same)stabilizer.push(sym);
    const key=tb.join('');
    if(bestKey===null||key<bestKey){bestKey=key;bestSym=sym;bestBoard=tb;}
  }
  return {state:{...state,board:bestBoard},sym:bestSym,stabilizer};
}
export function moveOrbits(state,actions){
  const stabilizer=stateStabilizer(state);
  const actionSet=new Set(actions),sorted=[...actionSet].sort((a,b)=>a-b);
  const repByAction=new Map(),membersByRep=new Map();
  for(const a of sorted){
    if(repByAction.has(a))continue;
    const members=[],seen=new Set();
    for(const sym of stabilizer){
      const t=transformAction(a,sym);
      if(actionSet.has(t)&&!seen.has(t)){seen.add(t);members.push(t);}
    }
    members.sort((x,y)=>x-y);
    const rep=members[0];
    membersByRep.set(rep,members);
    for(const m of members)repByAction.set(m,rep);
  }
  return {repByAction,membersByRep};
}
export function inverseTransformEvaluation(raw,sym){
  if(!raw||sym===0)return raw;
  const perm=D4_ACTION_PERMS[sym],policy82=Array(82);
  for(let a=0;a<AREA;a++)policy82[a]=raw.policy82[perm[a]];
  policy82[PASS]=raw.policy82[PASS];
  let ownership=raw.ownership,territory_probabilities=raw.territory_probabilities;
  if(Array.isArray(raw.ownership)&&raw.ownership.length===3*AREA){
    ownership=Array(3*AREA);
    for(let c=0;c<3;c++)for(let a=0;a<AREA;a++)ownership[c*AREA+a]=raw.ownership[c*AREA+perm[a]];
  }
  if(Array.isArray(raw.territory_probabilities)&&raw.territory_probabilities.length===AREA){
    territory_probabilities=Array(AREA);
    for(let a=0;a<AREA;a++)territory_probabilities[a]=raw.territory_probabilities[perm[a]];
  }
  return {...raw,policy82,ownership,territory_probabilities};
}
export function sampleD4Orientations(state,maxSamples=1,rng=Math.random,canonical=canonicalD4State(state)){
  const {state:canon,sym:toCanon,stabilizer}=canonical;
  const byBoard=new Map();
  for(let sym=0;sym<8;sym++){
    const ts=transformState(canon,sym),bkey=ts.board.join('');
    let g=byBoard.get(bkey);
    if(!g){g={boardState:ts,syms:[]};byBoard.set(bkey,g);}
    g.syms.push(sym);
  }
  const groups=[...byBoard.values()];
  const limit=Math.max(1,Math.min(8,Math.trunc(Number(maxSamples))||1));
  const k=Math.min(limit,groups.length);
  let chosen;
  if(k===groups.length){
    chosen=groups;
  }else if(k===1){
    chosen=[groups[0]];
  }else{
    const pool=groups.slice();
    for(let i=0;i<k;i++){
      const j=i+Math.floor(rng()*(pool.length-i));
      const tmp=pool[i];pool[i]=pool[j];pool[j]=tmp;
    }
    chosen=pool.slice(0,k);
  }
  return {canon,toCanon,stabilizer,totalDistinct:groups.length,chosenGroups:chosen};
}
export function averageD4Evaluations(groupEvals){
  const expanded=[];
  for(const {eval:raw,syms} of groupEvals){
    for(const sym of syms)expanded.push(inverseTransformEvaluation(raw,sym));
  }
  const count=expanded.length;
  const first=expanded[0];
  const policy82=Array(82).fill(0);
  let value=0,winProb=0,expScore=0;
  const hasOwnership=Array.isArray(first.ownership)&&first.ownership.length===3*AREA;
  const hasTerr=Array.isArray(first.territory_probabilities)&&first.territory_probabilities.length===AREA;
  const hasScoreDist=Array.isArray(first.score_distribution)&&first.score_distribution.length>0;
  const ownership=hasOwnership?Array(3*AREA).fill(0):first.ownership;
  const terr=hasTerr?Array.from({length:AREA},()=>[0,0,0]):first.territory_probabilities;
  const scoreDist=hasScoreDist?Array(first.score_distribution.length).fill(0):first.score_distribution;
  for(const ev of expanded){
    for(let a=0;a<82;a++)policy82[a]+=ev.policy82[a]/count;
    value+=ev.value/count;
    winProb+=ev.win_probability/count;
    expScore+=ev.expected_score/count;
    if(hasOwnership)for(let i=0;i<3*AREA;i++)ownership[i]+=ev.ownership[i]/count;
    if(hasTerr)for(let i=0;i<AREA;i++){terr[i][0]+=ev.territory_probabilities[i][0]/count;terr[i][1]+=ev.territory_probabilities[i][1]/count;terr[i][2]+=ev.territory_probabilities[i][2]/count;}
    if(hasScoreDist)for(let i=0;i<scoreDist.length;i++)scoreDist[i]+=ev.score_distribution[i]/count;
  }
  return {...first,policy82,value:Math.max(-1,Math.min(1,value)),win_probability:winProb,expected_score:expScore,score_distribution:scoreDist,ownership,territory_probabilities:terr};
}

// A score bound is conditional on both players reaching scoring. The protected
// liberties separately certify that the leader can force that result or better.
export function endgameProof(state, position=facts(state), {root=true, expired=()=>false}={}){
  if(state.result || state.ruleset_version!==RULESET || state.extra_moves_remaining)return null;
  const {territory:t, legal_actions:actions, groups}=position;
  function solveSmall(limit){
    const memo=new Map();
    let remaining=limit;
    function solve(s){
      const key=canonicalState(s);
      if(memo.has(key))return memo.get(key);
      if(--remaining<0||expired())return null;
      let proof;
      if(s.result){
        const cells=s.result.reason==='pass_score'?territory(s.board):null;
        const margin=cells?cells.filter(x=>x===1).length-cells.filter(x=>x===2).length:null;
        proof={winner:s.result.winner,margin};
      }else{
        const children=[];
        for(const action of legal(s)){
          const child=solve(playUnchecked(s,action));
          if(!child)return null;
          children.push({action,...child});
        }
        const wins=children.filter(child=>child.winner===s.side_to_move);
        let options=wins.length?wins:children;
        let margin=null;
        if(options.every(child=>child.margin!==null)){
          const choose=s.side_to_move==='first'?Math.max:Math.min;
          margin=choose(...options.map(child=>child.margin));
          options=options.filter(child=>child.margin===margin);
        }
        proof={winner:options[0].winner,margin,moves:options.map(child=>child.action),unique:wins.length===1};
      }
      memo.set(key,proof);
      return proof;
    }
    const exact=solve(state);
    return exact?{...exact,bounds:exact.margin===null?null:[exact.margin,exact.margin]}:null;
  }
  if(root&&actions.length<=6){
    const exact=solveSmall(1024);
    if(exact)return exact;
  }
  if(position.tactical.winner)return null;
  const difference=t.filter(x=>x===1).length-t.filter(x=>x===2).length;
  for(const color of [1,2]){
    if(color===1?difference<=state.komi:difference>state.komi)continue;
    if(groups.some(g=>g.color===color&&!g.liberties.some(x=>t[x]===color)))continue;
    const open=actions.filter(a=>a!==PASS);
    const possible=color=>open.filter(a=>neighbors(a).every(i=>state.board[i]!==3-color)).length;
    const bounds=[difference-possible(2),difference+possible(1)];
    if(color===1?bounds[0]<=state.komi:bounds[1]>state.komi)continue;
    const winner=color===1?'first':'second';
    return {winner,bounds,margin:null,unique:false,moves:winner===state.side_to_move?[PASS]:actions};
  }
  return !root&&actions.length<=4?solveSmall(64):null;
}
