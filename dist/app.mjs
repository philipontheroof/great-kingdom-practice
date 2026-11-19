import {newStudy,addNode,pathTo,lineThrough,importDocument,blueEvaluation,studyForSave,resolveBranchLeaf,nextInBranch,branchLeaves,cloneStudyAsLeaf,FORMAT} from './study.mjs?v=24';
import {facts,stateGroups,territory,canonicalState,positionPayload} from './engine.mjs?v=24';
import {boardSvg,candidateOutcome,candidateShare} from './board.mjs?v=24';
import {STORE,persistStudy,retryAnalysis} from './client.mjs?v=24';
import {PracticeControls,missingNodes,normalizeBudget,analysisFloor,budgetPayload,budgetReached,budgetLabel,BUDGET_RANGE,BUDGET_DEFAULT,TEMPERATURE_DEFAULT,normalizeTemperature,pickAiAction} from './controls.mjs?v=24';
import {timelineSvg} from './timeline.mjs?v=24';
import {LocalEngine} from './local-client.mjs?v=24';
import {loadStaticConfig,loadStaticManifest} from './deployment.mjs?v=24';
const staticOnly=document.documentElement?.dataset?.execution==='local';

const $=id=>document.getElementById(id),controls=new PracticeControls(),shown=new Map(),SETTINGS='gk-practice-settings-v1';
const SIDES=['first','second'];
const STOP_REASON_LABELS={
 proven_win:{label:'필승법 발견',cls:'win'},
 proven_loss:{label:'필패 발견',cls:'loss'},
 fully_explored:{label:'전체 탐색완료',cls:'complete'},
};
const settings={
 theme:'system',
 searchMode:'puct',
 d4Samples:1,
 analysisLimit:{unit:'seconds',value:2.0},
 analysisPinned:false,
 onceAutoShow:true,
 layers:{ownership:true,policy:true,win:true,margin:true,pv:true},
 pins:{ownership:true,policy:true,win:true,margin:true,pv:true,territory:true,numbers:true},
 play:{first:{unit:'seconds',value:2.0},second:{unit:'seconds',value:2.0}},
 playTemperature:TEMPERATURE_DEFAULT,
 forceProvenWin:true,
 ignoreProvenLoss:true,
 ponder:true,
 territory:true,numbers:true,
 batch:{scope:'branch',target:'missing',budget:{unit:'seconds',value:1.0}},
};
let lastPaint=0,doc=null,config=null,analyzing=false,analysisKind=null,moving=false,analysisController=null,preview=null,graphMode='win',saveTimer=null,local=null,localModel=null,lastRuntimeStats=null,batching=false,backendReady=true,onceNode=null,placeMode='alternate',reading=null;
const isLeafNode=(d,id)=>!d?.nodes?.some?.(n=>n.parent===id);
const isReading=()=>Boolean(reading);
const currentDoc=()=>reading?reading.doc:doc;
const analysisKey=n=>{
 if(!n)return null;
 return reading&&reading.doc?.nodes?.includes?.(n)?`reading:${n.id}`:n.id;
};
function clearReadingShown(){
 for(const k of [...shown.keys()])if(typeof k==='string'&&k.startsWith('reading:'))shown.delete(k);
}
function resolveTheme(mode=settings.theme){
 if(mode==='dark'||mode==='light')return mode;
 return globalThis.window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches?'dark':'light';
}
function applyTheme(){
 const mode=['system','light','dark'].includes(settings.theme)?settings.theme:'system';
 const effective=resolveTheme(mode);
 const root=document.documentElement;
 if(root){
  if(root.dataset){root.dataset.themeMode=mode;root.dataset.theme=effective;}
  if(root.style)root.style.colorScheme=effective;
 }
 const meta=document.querySelector?.('meta[name="theme-color"]');
 if(meta)meta.setAttribute?.('content',effective==='dark'?'#0f172a':'#172e45');
 for(const m of ['system','light','dark']){
  const btn=$(`theme-${m}`);
  if(btn){btn.classList?.toggle?.('active',mode===m);btn.setAttribute?.('aria-pressed',String(mode===m));}
 }
}
function effectiveStopReason(a){
 if(!a)return null;
 if(a.stop_reason&&STOP_REASON_LABELS[a.stop_reason])return a.stop_reason;
 if(a.mcts?.fully_explored){
  if(a.proven_winner&&a.proven_winner===a.perspective)return 'proven_win';
  if(a.proven_winner&&a.proven_winner!==a.perspective)return 'proven_loss';
  return 'fully_explored';
 }
 if(a.proven_winner&&a.proven_winner===a.perspective&&a.source!=='rule'&&(a.mcts?.root_visits||0)>0)return 'proven_win';
 return null;
}
function applyPinsOnNavigation(){
 for(const k of Object.keys(settings.layers)){
  if(!settings.pins[k])settings.layers[k]=false;
 }
 if(!settings.pins.territory)settings.territory=false;
 if(!settings.pins.numbers)settings.numbers=false;
}
const canAiPlay=()=>!isReading()&&placeMode==='alternate';
const currentAiTurn=(n=active())=>Boolean(n&&!n.position?.result&&canAiPlay()&&isLeafNode(doc,n.id)&&controls.aiTurn(n.position));
const active=()=>{const d=currentDoc();return d?.nodes.find(n=>n.id===d.selected);};
const anchorNode=()=>doc?.nodes.find(n=>n.id===(reading?.anchorId??doc?.selected));
const backend=()=>$('backend')?.value||(staticOnly?'local':'host');
const modelAvailable=()=>backendReady&&Boolean(config?.models.some(m=>m.id===doc?.model_id))&&(backend()==='host'||localModel===doc?.model_id);
const nodeAnalysis=n=>n?.analysis&&n.analysis.backend===backend()&&(!n.analysis.model||n.analysis.model.id===doc?.model_id)&&(n.analysis.search_mode||'puct')===settings.searchMode&&(backend()!=='local'||(n.analysis.d4_samples??1)===settings.d4Samples)?n.analysis:null;
const displayAnalysis=n=>{
 if(!n)return null;
 const a=shown.get(analysisKey(n))||nodeAnalysis(n);
 if(!a)return null;
 if(a.backend!==backend())return null;
 if(a.model&&a.model.id!==doc?.model_id)return null;
 return a;
};
const visibleFor=n=>Boolean(displayAnalysis(n));
const visibleAnalysis=()=>displayAnalysis(active());
const graphAnalysis=n=>nodeAnalysis(n);
const coord=a=>a===81?'패스':`${Math.floor(a/9)+1}·${a%9+1}`;
const pct=v=>typeof v==='number'?`${(v*100).toFixed(1)}%`:'—';
const signed=v=>typeof v==='number'?`${v>0?'+':''}${v.toFixed(1)}`:'—';
const sourceLabel=s=>({network:'모델 원평가',mcts:'MCTS 탐색',tactical:'전술 증명',rule:'규칙 판정'}[s]||'분석 전');
const sideName=s=>s==='first'?'파랑':'빨강';
function notice(message,error=false){if(!$('notice'))return;$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=!message;}
async function api(path,payload,signal){if(staticOnly)throw Error('이 배포본은 모든 대국과 분석을 기기에서 실행합니다.');const response=await fetch(`/api/v1/${path}`,payload===undefined?{signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'실행부 요청 실패'),{status:response.status});return data;}
function library(){const v=JSON.parse(localStorage.getItem(STORE)||'[]');if(!Array.isArray(v))throw Error('저장 목록을 읽을 수 없어요.');return v;}
function saveNow(){if(!doc)return true;try{persistStudy(localStorage,doc);if($('save-state'))$('save-state').textContent='기기에 저장됨';return true;}catch{notice('자동 저장 실패 · 내보내기로 기보를 보관해 주세요.',true);if($('save-state'))$('save-state').textContent='저장 실패';return false;}}
function save(){clearTimeout(saveTimer);if($('save-state'))$('save-state').textContent='저장 중';saveTimer=setTimeout(saveNow,200);}
function cancel(){controls.invalidate();analysisController?.abort();analysisController=null;local?.cancel();analyzing=false;analysisKind=null;batching=false;moving=false;preview=null;}
function positionRequest(node=active()){return {ruleset_version:doc.ruleset_version,setup:{board:node.position.board.slice(),side_to_move:node.position.side_to_move,previous_move_was_pass:Boolean(node.position.previous_move_was_pass),komi:doc.setup.komi,result:node.position.result},actions:[]};}
async function position(payload){if(backend()==='local'){if(!local)throw Error('기기 내 엔진을 먼저 준비해 주세요.');return local.position(payload);}return api('position',payload);}
function capture(){for(const n of doc.nodes){const a=nodeAnalysis(n);if(a)shown.set(n.id,a);}}

// ---- Settings -------------------------------------------------------------
function loadSettings(){
 let saved=null;try{saved=JSON.parse(localStorage.getItem(SETTINGS)||'null');}catch{saved=null;}
 if(!saved||typeof saved!=='object'||Array.isArray(saved))return;
 if(['system','light','dark'].includes(saved.theme))settings.theme=saved.theme;
 if(['puct','gumbel'].includes(saved.searchMode))settings.searchMode=saved.searchMode;
 if(Number.isInteger(saved.d4Samples)&&saved.d4Samples>=1&&saved.d4Samples<=8)settings.d4Samples=saved.d4Samples;
 settings.analysisLimit=normalizeBudget(saved.analysisLimit,{allowNone:true,fallback:'seconds'});
 if(typeof saved.analysisPinned==='boolean')settings.analysisPinned=saved.analysisPinned;
 if(typeof saved.onceAutoShow==='boolean')settings.onceAutoShow=saved.onceAutoShow;
 for(const k of Object.keys(settings.layers))if(typeof saved.layers?.[k]==='boolean')settings.layers[k]=saved.layers[k];
 if(saved.pins&&typeof saved.pins==='object'){
  for(const k of Object.keys(settings.pins))if(typeof saved.pins[k]==='boolean')settings.pins[k]=saved.pins[k];
 }
 for(const s of SIDES)if(saved.play?.[s])settings.play[s]=normalizeBudget(saved.play[s],{fallback:'seconds'});
 if('playTemperature' in saved)settings.playTemperature=normalizeTemperature(saved.playTemperature,{fallback:TEMPERATURE_DEFAULT});
 if(typeof saved.forceProvenWin==='boolean')settings.forceProvenWin=saved.forceProvenWin;
 if(typeof saved.ignoreProvenLoss==='boolean')settings.ignoreProvenLoss=saved.ignoreProvenLoss;
 for(const k of ['territory','numbers','ponder'])if(typeof saved[k]==='boolean')settings[k]=saved[k];
 if(['branch','all'].includes(saved.batch?.scope))settings.batch.scope=saved.batch.scope;
 if(['missing','all'].includes(saved.batch?.target))settings.batch.target=saved.batch.target;
 if(saved.batch?.budget)settings.batch.budget=normalizeBudget(saved.batch.budget,{fallback:'seconds'});
 for(const s of SIDES)if(typeof saved.continuous?.[s]==='boolean')controls.continuous[s]=saved.continuous[s];
 controls.visualContinuous=saved.visualContinuous===true&&controls.anyContinuous();
}
function saveSettings(){try{localStorage.setItem(SETTINGS,JSON.stringify({...settings,continuous:controls.continuous,visualContinuous:controls.visualContinuous}));}catch{/* optional */}}
const plays=()=>SIDES.map(s=>({on:controls.aiSide[s],budget:settings.play[s]}));
const floor=()=>analysisFloor(settings.analysisLimit.unit,plays());
function enforceFloor(){const f=floor(),l=settings.analysisLimit;if(f!==null&&l.value<f){settings.analysisLimit={...l,value:f};return true;}return false;}
function readBudget(prefix,current,{allowNone=false,fallback='seconds'}={}){
 const u=$(`${prefix}-unit`);const unit=u?u.value:current.unit;
 const input=$(`${prefix}-value`);const value=unit===current.unit?(input?input.value:current.value):BUDGET_DEFAULT[unit];
 return normalizeBudget({unit,value},{allowNone,fallback});
}
function writeBudget(prefix,budget,min=null){
 const input=$(`${prefix}-value`),u=$(`${prefix}-unit`);if(u)u.value=budget.unit;
 if(!input)return;
 if(budget.unit==='none'){input.value='';input.disabled=true;input.placeholder='제한 없음';return;}
 input.disabled=false;input.placeholder='';const range=BUDGET_RANGE[budget.unit];
 input.min=String(min??range.min);input.max=String(range.max);input.step=budget.unit==='visits'?'1':'0.1';
 input.setAttribute('list',budget.unit==='visits'?'visit-presets':'second-presets');
 if(document.activeElement!==input)input.value=String(budget.value);
}

// ---- Search ---------------------------------------------------------------
async function streamHost(payload,onUpdate,signal){
 const response=await fetch('/api/v1/analyze-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});
 if(!response.ok){const error=await response.json();throw Object.assign(Error(error.error||'분석 실패'),{status:response.status});}
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',last=null;
 try{while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim()){last=JSON.parse(line);if(last.error)throw Error(last.error);onUpdate(last);}}if(done)break;}
 if(buffer.trim()){last=JSON.parse(buffer);onUpdate(last);}if(!last?.done)throw Error('분석 연결이 끝났어요. 다시 분석을 시작해 주세요.');return last;
 }finally{await reader.cancel().catch(()=>{});}
}
async function search(node,budget,{onUpdate=()=>{},signal,force=false,resolveBudget=null}={}){
 const currentBudget=()=>resolveBudget?resolveBudget():budget;
 const b0=currentBudget();
 const payload={...positionRequest(node),model_id:doc.model_id,search_mode:settings.searchMode,d4_samples:settings.d4Samples,visits:1600,seconds:b0.unit==='seconds'?b0.value:2,continuous:true,...budgetPayload(b0),...(force?{force:true}:{})};
 if(backend()==='host')delete payload.max_seconds;
 const inner=new AbortController(),relay=()=>inner.abort();signal?.addEventListener('abort',relay,{once:true});
 let last=null,reached=false;
 const update=r=>{last=r;onUpdate(r);if(!r.done&&(r.mcts?.root_visits>0||r.source==='rule'||r.source==='tactical'||r.stop_reason)&&budgetReached(currentBudget(),r)){reached=true;inner.abort();}};
 try{return await retryAnalysis(()=>backend()==='local'?local.analyze(payload,update,{signal:inner.signal,continuous:true}):streamHost(payload,update,inner.signal),inner.signal);}
 catch(error){if(reached&&last&&!signal?.aborted)return {...last,done:true};throw error;}
 finally{signal?.removeEventListener('abort',relay);}
}
function acceptResult(result,node,model,execution){
 if(result.state_id!==node.position.state_id)throw Error('국면 해시가 일치하지 않습니다.');
 if(result.model&&result.model.id!==model)throw Error('선택 모델과 분석 모델이 다릅니다.');
 if(result.stats)lastRuntimeStats=result.stats;
 node.analysis={...result,provider:result.execution==='browser'?result.backend:null,backend:execution};
 shown.set(analysisKey(node),node.analysis);
 if(execution==='local'&&result.backend&&$('runtime-note'))$('runtime-note').textContent=`서버 추론 미사용 · 브라우저 로컬 전용 · ${result.backend.toUpperCase()} (${result.stats?.precision||'FP32'})`;
}
function setPlaceMode(mode){
 placeMode=mode;
 if(mode!=='alternate'){
  cancel();controls.playing=false;
  notice(mode==='place-red'?'🔴 빨간 성 배치: 판을 클릭하면 빨간 성이 놓여집니다.':mode==='place-blue'?'🔵 파란 성 배치: 판을 클릭하면 파란 성이 놓여집니다.':mode==='place-neutral'?'⚪ 중립 성 배치: 판을 클릭하면 중립 성이 놓여집니다.':'🗑️ 성 제거: 판의 성을 클릭하면 제거됩니다.');
 }else{
  if(!isReading()&&controls.anyAI())controls.playing=true;
  notice('');
 }
 render();
 if(!isReading()&&mode==='alternate')schedule();
}
function enterReadingMode(){
 if(!doc||isReading())return;
 const node=active();if(!node?.position)return;
 cancel();controls.playing=false;preview=null;
 clearReadingShown();
 const rootAnalysis=nodeAnalysis(node);
 reading={
  anchorId:node.id,
  anchorBranchLeaf:doc.branch_leaf,
  doc:{
   format:FORMAT,
   ruleset_version:doc.ruleset_version,
   setup:doc.setup,
   model_id:doc.model_id,
   selected:'r0',
   branch_leaf:'r0',
   nodes:[{id:'r0',parent:null,action:null,ply:node.ply,notes:'',position:node.position,analysis:rootAnalysis}],
  },
 };
 if(rootAnalysis)shown.set('reading:r0',rootAnalysis);
 notice('');
 render();
}
function exitReadingMode(){
 if(!reading)return;
 cancel();preview=null;
 clearReadingShown();
 doc.selected=reading.anchorId;
 doc.branch_leaf=resolveBranchLeaf(doc,doc.selected,reading.anchorBranchLeaf);
 reading=null;
 if(placeMode==='alternate'&&controls.anyAI())controls.playing=true;
 notice('');
 render();
 if(placeMode==='alternate')schedule();
}
function resetReadingMode(){
 if(!reading)return;
 cancel();preview=null;
 clearReadingShown();
 const r0=reading.doc.nodes[0];
 reading.doc.nodes=[r0];
 reading.doc.selected=r0.id;
 reading.doc.branch_leaf=r0.id;
 if(r0.analysis)shown.set(`reading:${r0.id}`,r0.analysis);
 render();
}
function selectReadingNode(id){
 if(!reading)return;
 cancel();preview=null;
 applyPinsOnNavigation();
 reading.doc.selected=id;
 reading.doc.branch_leaf=resolveBranchLeaf(reading.doc,id,reading.doc.branch_leaf);
 render();
}
function readingPrev(){
 if(!reading)return;
 const cur=active();
 if(cur?.parent)selectReadingNode(cur.parent);
}
function readingNext(){
 if(!reading)return;
 const nxt=nextInBranch(reading.doc,reading.doc.selected,reading.doc.branch_leaf);
 if(nxt)selectReadingNode(nxt.id);
}

function makeNextPosition(parentPos,action,customSide=null){
 const curBoard=parentPos.board.slice();
 let nextSide=customSide,result=null,wasPass=false;

 if(action===81){
  wasPass=true;
  if(nextSide===null)nextSide=parentPos.side_to_move==='first'?'second':'first';
  if(parentPos.previous_move_was_pass){
   const t=territory(curBoard),first=t.filter(x=>x===1).length,second=t.filter(x=>x===2).length;
   result={winner:first-second>parentPos.komi?'first':'second',reason:'pass_score'};
  }
 }else if(action>=400){
  const c=action-400;curBoard[c]=0;
  if(nextSide===null)nextSide=parentPos.side_to_move;
  result=null;
 }else if(action>=300){
  const c=action-300;curBoard[c]=3;
  if(nextSide===null)nextSide=parentPos.side_to_move;
  const gs=stateGroups({board:curBoard}),dead=gs.filter(g=>g.liberties.length===0);
  if(dead.length)result={winner:dead[0].color===1?'second':'first',reason:'siege'};
 }else if(action>=200){
  const c=action-200;curBoard[c]=2;
  if(nextSide===null)nextSide='first';
  const gs=stateGroups({board:curBoard}),deadOpp=gs.filter(g=>g.color===1&&g.liberties.length===0),deadOwn=gs.filter(g=>g.color===2&&g.liberties.length===0);
  if(deadOpp.length)result={winner:'second',reason:'siege'};
  else if(deadOwn.length)result={winner:'first',reason:'siege'};
 }else if(action>=100){
  const c=action-100;curBoard[c]=1;
  if(nextSide===null)nextSide='second';
  const gs=stateGroups({board:curBoard}),deadOpp=gs.filter(g=>g.color===2&&g.liberties.length===0),deadOwn=gs.filter(g=>g.color===1&&g.liberties.length===0);
  if(deadOpp.length)result={winner:'first',reason:'siege'};
  else if(deadOwn.length)result={winner:'second',reason:'siege'};
 }else{
  const mover=parentPos.side_to_move,me=mover==='first'?1:2;curBoard[action]=me;
  if(nextSide===null)nextSide=mover==='first'?'second':'first';
  const gs=stateGroups({board:curBoard}),opp=3-me,deadOpp=gs.filter(g=>g.color===opp&&g.liberties.length===0),deadOwn=gs.filter(g=>g.color===me&&g.liberties.length===0);
  if(deadOpp.length)result={winner:mover,reason:'siege'};
  else if(deadOwn.length)result={winner:mover==='first'?'second':'first',reason:'siege'};
 }

 const s={board:curBoard,side_to_move:nextSide,previous_move_was_pass:wasPass,komi:parentPos.komi,result,ruleset_version:parentPos.ruleset_version};
 return positionPayload(s);
}

async function finalizePosition(payload){
 const canonical=canonicalState({board:payload.board,side_to_move:payload.side_to_move,previous_move_was_pass:payload.previous_move_was_pass,komi:payload.komi,result:payload.result,ruleset_version:payload.ruleset_version});
 let state_id;
 if(globalThis.crypto?.subtle){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  state_id=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
 }else{
  const {createHash}=await import('node:crypto');
  state_id=createHash('sha256').update(canonical).digest('hex');
 }
 return {...payload,state_id};
}

async function handleBoardClick(cell){
 const node=active();if(!node?.position)return;
 if(placeMode==='alternate'){await place(cell);return;}
 if(placeMode==='place-blue'){await place(100+cell);return;}
 if(placeMode==='place-red'){await place(200+cell);return;}
 if(placeMode==='place-neutral'){await place(300+cell);return;}
 if(placeMode==='remove'){
  if(node.position.board[cell]===0){notice('제거할 성이 없습니다.',true);return;}
  await place(400+cell);return;
 }
}

async function setTurnSide(side){
 const node=active();if(!node?.position)return;
 if(node.position.side_to_move===side)return;
 cancel();controls.playing=false;
 node.position=await finalizePosition({...node.position,side_to_move:side,legal_actions:facts({board:node.position.board,side_to_move:side,komi:doc.setup.komi,result:node.position.result,ruleset_version:doc.ruleset_version}).legal_actions});
 node.analysis=null;shown.delete(analysisKey(node));onceNode=null;
 if(!isReading()&&placeMode==='alternate'&&controls.anyAI())controls.playing=true;
 if(!isReading())save();
 render();
 if(!isReading()&&placeMode==='alternate')schedule();
}

async function startAnalysis({ai=false,kind=ai?'ai':'once',force=false}={}){
 if(!active()||moving||batching||!modelAvailable()||(ai&&!canAiPlay()))return;
 cancel();const node=active(),nodeKey=analysisKey(node),readingRef=reading,study=doc,model=doc.model_id,execution=backend(),token=controls.begin(nodeKey,model,execution),controller=new AbortController();analysisController=controller;analyzing=true;analysisKind=kind;
 if(force){node.analysis=null;shown.delete(nodeKey);}
 const side=node.position.side_to_move;
 const ponder=kind==='ponder',budget=ai?settings.play[side]:ponder?{unit:'none',value:null}:settings.analysisLimit;if(!ponder)render();else renderSettings();
 const resolveBudget=ai?()=>settings.play[side]:ponder?()=>({unit:'none',value:null}):()=>settings.analysisLimit;
 const valid=()=>study===doc&&reading===readingRef&&controls.accepts(token,analysisKey(active()),doc.model_id,backend());let result;
 try{result=await search(node,budget,{force,resolveBudget,signal:controller.signal,onUpdate:r=>{if(valid()&&!ponder){acceptResult(r,node,model,execution);if(r.done||Date.now()-lastPaint>=180){lastPaint=Date.now();render();}}}});
 if(!valid())return;if(!ponder){acceptResult(result,node,model,execution);notice('');}
 }catch(error){if(error.name!=='AbortError'&&valid()&&!ponder)notice(error.message,true);return;}
 finally{analyzing=false;analysisKind=null;analysisController=null;if(valid()){if(!ponder)render();else renderSettings();}}
 const aiAction=ai?pickAiAction(result,settings.playTemperature,Math.random,{ignoreProvenLoss:settings.ignoreProvenLoss,forceProvenWin:settings.forceProvenWin}):null;
 if(ai&&valid()&&isLeafNode(doc,node.id)&&controls.aiTurn(node.position)&&aiAction!==null&&aiAction!==undefined){await place(aiAction,true);}
}
function schedule(){
 if(isReading())return;
 const n=active();if(!n)return;if(n.position.result){render();return;}
 if(!canAiPlay())return;
 const isLeaf=isLeafNode(doc,n.id);
 if(isLeaf&&controls.aiTurn(n.position)){
  queueMicrotask(()=>run(()=>startAnalysis({ai:true})));
 }else if(settings.analysisPinned){
  queueMicrotask(()=>run(()=>startAnalysis({kind:'pinned'})));
 }else if(controls.continuous[n.position.side_to_move]&&!budgetReached(settings.analysisLimit,nodeAnalysis(n))){
  queueMicrotask(()=>run(()=>startAnalysis({kind:'continuous'})));
 }else if(isLeaf&&!controls.aiTurn(n.position)&&controls.anyAI()&&settings.ponder&&backend()==='local'){
  queueMicrotask(()=>run(()=>startAnalysis({kind:'ponder'})));
 }
}
async function selectNode(id){
 cancel();
 if(reading){clearReadingShown();reading=null;}
 placeMode='alternate';
 applyPinsOnNavigation();
 if(onceNode!==id)onceNode=null;
 doc.selected=id;
 doc.branch_leaf=resolveBranchLeaf(doc,id,doc.branch_leaf);
 save();
 render();
 schedule();
}
async function place(action,fromAI=false){
 const node=active(),targetDoc=currentDoc(),readingRef=reading;if(moving||(!fromAI&&preview)||node.position.result)return;
 if(!isReading()&&!fromAI&&controls.aiTurn(node.position)&&placeMode==='alternate')return notice('AI 차례입니다. AI 착수 토글을 끄면 직접 둘 수 있어요.');
 if(action<81&&!node.position.legal_actions.includes(action))return notice('그 칸에는 둘 수 없어요.',true);
 cancel();const token=controls.epoch,study=doc;moving=true;
 render();
 try{
  let next;
  const fullPath=readingRef?[...pathTo(doc,readingRef.anchorId),...pathTo(readingRef.doc,node.id)]:pathTo(doc,node.id);
  const canHostReplay=backend()==='host'&&!staticOnly&&action<=81&&fullPath.every(a=>a<=81);
  if(canHostReplay){
   next=await position({...positionRequest(node),actions:[...fullPath,action]});
  }else{
   next=await finalizePosition(makeNextPosition(node.position,action));
  }
  if(study!==doc||reading!==readingRef||token!==controls.epoch)return;
  applyPinsOnNavigation();
  addNode(targetDoc,node.id,action,next);targetDoc.branch_leaf=resolveBranchLeaf(targetDoc,targetDoc.selected,targetDoc.branch_leaf);onceNode=null;
  if(!readingRef)save();
  notice('');
 }finally{moving=false;if(token===controls.epoch)render();}
 if(!readingRef&&token===controls.epoch&&placeMode==='alternate')schedule();
}

// ---- Rendering ------------------------------------------------------------
function renderReadingBar(){
 const on=isReading();
 document.body?.classList?.toggle?.('reading-mode',on);
 $('reading-toggle')?.classList?.toggle?.('active',on);
 $('reading-toggle')?.setAttribute?.('aria-pressed',String(on));
 if($('reading-bar'))$('reading-bar').hidden=!on;
 if(!on)return;
 const cur=active(),anc=anchorNode();
 const delta=Math.max(0,(cur?.ply??0)-(anc?.ply??0));
 if($('reading-status'))$('reading-status').textContent=delta>0?`원래 국면에서 +${delta}수 진행 중`:'원래 국면 · 판을 눌러 임시 돌을 놓아보세요';
 if($('reading-prev'))$('reading-prev').disabled=!cur?.parent;
 if($('reading-next'))$('reading-next').disabled=!nextInBranch(reading.doc,reading.doc.selected,reading.doc.branch_leaf);
 if($('reading-reset'))$('reading-reset').disabled=(reading.doc.nodes?.length||0)<=1;
}
function renderPlacementBar(){
 const side=active()?.position?.side_to_move||'first';
 $('mode-alternate')?.classList?.toggle?.('active',placeMode==='alternate');
 $('mode-alternate')?.setAttribute?.('aria-pressed',String(placeMode==='alternate'));
 $('mode-place-red')?.classList?.toggle?.('active',placeMode==='place-red');
 $('mode-place-red')?.setAttribute?.('aria-pressed',String(placeMode==='place-red'));
 $('mode-place-blue')?.classList?.toggle?.('active',placeMode==='place-blue');
 $('mode-place-blue')?.setAttribute?.('aria-pressed',String(placeMode==='place-blue'));
 $('mode-place-neutral')?.classList?.toggle?.('active',placeMode==='place-neutral');
 $('mode-place-neutral')?.setAttribute?.('aria-pressed',String(placeMode==='place-neutral'));
 $('mode-remove')?.classList?.toggle?.('active',placeMode==='remove');
 $('mode-remove')?.setAttribute?.('aria-pressed',String(placeMode==='remove'));

 const bBtn=$('turn-order-blue'),rBtn=$('turn-order-red');
 if(bBtn){
  bBtn.classList?.toggle?.('active',side==='first');
  bBtn.classList?.toggle?.('side-blue',side==='first');
  bBtn.setAttribute?.('aria-pressed',String(side==='first'));
 }
 if(rBtn){
  rBtn.classList?.toggle?.('active',side==='second');
  rBtn.classList?.toggle?.('side-red',side==='second');
  rBtn.setAttribute?.('aria-pressed',String(side==='second'));
 }
 renderReadingBar();
}
function renderBoard(){
 const node=active(),p=preview?.position||node.position,visible=visibleAnalysis(),L=settings.layers;
 const onReading=isReading();
 const anchorActions=onReading?pathTo(doc,reading.anchorId):pathTo(doc,node.id);
 const readingActions=onReading?pathTo(reading.doc,node.id):[];
 const boardEl=$('board');
 if(boardEl){
  boardEl.classList?.toggle?.('placing-red',placeMode==='place-red');
  boardEl.classList?.toggle?.('placing-blue',placeMode==='place-blue');
  boardEl.classList?.toggle?.('placing-neutral',placeMode==='place-neutral');
  boardEl.classList?.toggle?.('placing-remove',placeMode==='remove');
  const lastAction=preview?.actions.at(-1)??(onReading?(node.parent!==null?node.action:anchorNode()?.action):node.action);
  boardEl.innerHTML=boardSvg(p,{actions:[...anchorActions,...readingActions,...(preview?.actions||[])],lastAction,analysis:preview?null:visible,showTerritory:settings.territory,showOwnership:L.ownership&&Boolean(visible),showCandidates:L.policy&&Boolean(visible)&&!preview,showPV:L.pv&&Boolean(visible)&&!preview,showNumbers:settings.numbers,readingMode:onReading,readingStartIndex:onReading?anchorActions.length:null});
  const svg=boardEl.querySelector?.('svg');
  if(svg){
   svg.classList?.toggle?.('placing-red',placeMode==='place-red');
   svg.classList?.toggle?.('placing-blue',placeMode==='place-blue');
   svg.classList?.toggle?.('placing-neutral',placeMode==='place-neutral');
   svg.classList?.toggle?.('placing-remove',placeMode==='remove');
  }
  boardEl.setAttribute('aria-busy',String(moving));
 }
 if($('blue-score'))$('blue-score').innerHTML=`${p.score.blue}<small>영토</small>`;
 if($('red-score'))$('red-score').innerHTML=`${p.score.red}<small>영토</small>`;
 if($('blue-player'))$('blue-player').textContent=controls.aiSide.first?'AI':'사람';
 if($('red-player'))$('red-player').textContent=controls.aiSide.second?'AI':'사람';
 if($('turn-dot'))$('turn-dot').className=`turn-dot ${p.side_to_move==='first'?'blue':'red'}`;
 if($('turn-label'))$('turn-label').textContent=preview?`예상 수순 ${preview.actions.length}수`:placeMode==='place-red'?'빨간 성 배치 모드 · 판을 클릭하면 빨간 성이 놓여요':placeMode==='place-blue'?'파란 성 배치 모드 · 판을 클릭하면 파란 성이 놓여요':placeMode==='place-neutral'?'중립 성 배치 모드 · 판을 클릭하면 중립 성이 놓여요':p.result?`${p.result.winner==='first'?'파란':'빨간'} 성 승리 · ${p.result.reason==='siege'?'포위':p.result.reason==='pass_score'?'연속 패스 종국':'영토 점수'}`:`${onReading?'💭 수읽기 · ':''}${p.previous_move_was_pass?`${p.side_to_move==='second'?'파란':'빨간'} 성 패스 · `:''}${p.side_to_move==='first'?'파란':'빨간'} 성 차례${!onReading&&controls.aiTurn(p)?' · AI 생각 중':''}`;
 if($('ply-label'))$('ply-label').textContent=onReading?`${node.ply}수째 (수읽기)`:`${node.ply}수째`;
 if($('nav-label'))$('nav-label').textContent=`${node.ply}수`;
 if($('first'))$('first').disabled=$('previous').disabled=onReading||node.parent===null;
 if($('next'))$('next').disabled=$('last').disabled=onReading||!nextInBranch(doc,node.id,doc.branch_leaf);
 const passCand=(L.policy&&visible&&!preview)?(visible.mcts?.candidates||[]).find(c=>c.action===81&&(c.visits>0||(visible.search_mode==='gumbel'&&(c.improved_policy??0)>=0.01))):null;
 const passOut=passCand?candidateOutcome(passCand,visible):null;
 const passShare=passCand?candidateShare(passCand,visible):0;
 if($('pass')){$('pass').disabled=Boolean(p.result||preview||moving||(!onReading&&controls.aiTurn(p))||(backend()==='local'&&!local)||placeMode!=='alternate');$('pass').textContent=passCand?`패스 (${passOut==='win'?'필승 · ':passOut==='loss'?'필패 · ':''}${(passShare*100).toFixed(1)}%)`:'패스';}
 if($('clone-leaf-button'))$('clone-leaf-button').disabled=Boolean(onReading||moving||batching||!node);
 if($('preview-exit'))$('preview-exit').hidden=!preview;
 if($('preview-label'))$('preview-label').hidden=!(settings.layers.ownership&&visible);

 // Left: Winrate vertical bar (Blue on top, Red on bottom)
 const values=blueEvaluation(visible,doc.setup.komi);
 if($('win-column'))$('win-column').hidden=!L.win;
 if($('win-value'))$('win-value').textContent=pct(values.win);
 if($('win-summary-value'))$('win-summary-value').textContent=pct(values.win);
 if($('blue-percent'))$('blue-percent').textContent=pct(values.win);
 if($('red-percent'))$('red-percent').textContent=pct(values.win===null?null:1-values.win);
 if($('win-fill')){$('win-fill').style.height=values.win===null?'0%':`${values.win*100}%`;if($('win-fill').parentElement)$('win-fill').parentElement.style.background=values.win===null?'#f1f5f9':'';}

 // Right: Expected score difference (집차이) vertical bar
 if($('margin-column'))$('margin-column').hidden=!L.margin;
 if(values.margin!==null&&values.margin!==undefined){
  const m=values.margin;
  if(m>=0){
   if($('margin-blue-percent'))$('margin-blue-percent').textContent=`+${m.toFixed(1)}집`;
   if($('margin-red-percent'))$('margin-red-percent').textContent='—';
   if($('margin-fill-blue'))$('margin-fill-blue').style.height=`${Math.min(100,(m/15)*50)}%`;
   if($('margin-fill-red'))$('margin-fill-red').style.height='0%';
   if($('margin-column-value')){$('margin-column-value').textContent=`+${m.toFixed(1)}집`;$('margin-column-value').style.color='#4173e6';}
  }else{
   if($('margin-blue-percent'))$('margin-blue-percent').textContent='—';
   if($('margin-red-percent'))$('margin-red-percent').textContent=`+${(-m).toFixed(1)}집`;
   if($('margin-fill-blue'))$('margin-fill-blue').style.height='0%';
   if($('margin-fill-red'))$('margin-fill-red').style.height=`${Math.min(100,((-m)/15)*50)}%`;
   if($('margin-column-value')){$('margin-column-value').textContent=`${m.toFixed(1)}집`;$('margin-column-value').style.color='#ee6338';}
  }
 }else{
  if($('margin-blue-percent'))$('margin-blue-percent').textContent='—';
  if($('margin-red-percent'))$('margin-red-percent').textContent='—';
  if($('margin-fill-blue'))$('margin-fill-blue').style.height='0%';
  if($('margin-fill-red'))$('margin-fill-red').style.height='0%';
  if($('margin-column-value')){$('margin-column-value').textContent='—';$('margin-column-value').style.color='var(--ink)';}
 }
}
function renderAnalysis(){
 const analysis=visibleAnalysis(),values=blueEvaluation(analysis,doc.setup.komi),L=settings.layers;
 const isGumbel=analysis?.search_mode==='gumbel';
 if($('analysis-source'))$('analysis-source').textContent=analysis?sourceLabel(analysis.source):'분석 전';
 if($('analysis-search-mode')){
  const showMode=Boolean(analysis&&analysis.source!=='rule');
  $('analysis-search-mode').hidden=!showMode;
  $('analysis-search-mode').textContent=isGumbel?'Gumbel SH':'PUCT';
  $('analysis-search-mode').className=`search-mode-badge ${isGumbel?'gumbel':'puct'}`;
 }
 if($('candidate-share-head'))$('candidate-share-head').textContent=isGumbel?'개선 정책':'탐색 비중';
 if($('result-empty'))$('result-empty').hidden=Boolean(analysis);
 if($('result-body'))$('result-body').hidden=!analysis;
 if($('result-empty'))$('result-empty').textContent=!doc.model_id?'모델이 연결되지 않았어요. 양쪽 성을 직접 두며 국면을 살펴볼 수 있어요.':active().position.result?'대국이 종료되었어요. 이전 수로 돌아가 새 가지를 만들어 보세요.':'이 국면은 아직 분석 전이에요. [현재 국면 분석]을 누르거나 [📌 분석 고정]을 켜면 바로 분석돼요.';
 if($('win-column'))$('win-column').hidden=!L.win;
 if($('win-value'))$('win-value').textContent=pct(values.win);
 if($('blue-percent'))$('blue-percent').textContent=pct(values.win);
 if($('red-percent'))$('red-percent').textContent=pct(values.win===null?null:1-values.win);
 if($('win-fill')){$('win-fill').style.height=values.win===null?'0%':`${values.win*100}%`;if($('win-fill').parentElement)$('win-fill').parentElement.style.background=values.win===null?'#f1f5f9':'';}
 if($('margin-box'))$('margin-box').hidden=!L.margin;
 if($('margin-caption'))$('margin-caption').textContent=analysis?.source==='rule'?'종국 영토 차이':'예상 집차이';
 if($('margin-value'))$('margin-value').textContent=values.margin===null?'—':`${signed(values.margin)}집`;
 if($('visits-value'))$('visits-value').textContent=analysis?analysis.mcts.root_visits.toLocaleString():'—';
 const stopReason=effectiveStopReason(analysis);
 const stopInfo=stopReason?STOP_REASON_LABELS[stopReason]:null;
 if($('analysis-stop-reason')){
  $('analysis-stop-reason').hidden=!stopInfo;
  $('analysis-stop-reason').textContent=stopInfo?stopInfo.label:'';
  $('analysis-stop-reason').className=`stop-reason-badge${stopInfo?` ${stopInfo.cls}`:''}`;
 }
 if($('raw-value'))$('raw-value').textContent=analysis?.source==='rule'?'규칙 판정 · 종국의 실제 영토 차이 · 포위 승패는 집수와 별도':analysis?`모델 원평가 ${L.win?pct(values.rawWin):'(승률 숨김)'} · 집차이는 원평가에 덤 반영`:'모델 원평가와 탐색 결과를 구분해서 보여줘요.';
 if($('candidate-box'))$('candidate-box').hidden=!L.policy;
 if($('pv-box'))$('pv-box').hidden=!L.pv;
 function candidateHistogramSvg(candidate,sharedMax,scoreMinDefault){
  const dist=candidate?.score_distribution;
  if(!Array.isArray(dist)||!dist.length)return '';
  const scoreMin=Number.isFinite(candidate.score_min)?candidate.score_min:(Number.isFinite(scoreMinDefault)?scoreMinDefault:-((dist.length-1)/2));
  const w=240,h=32,step=w/dist.length,max=Math.max(sharedMax,0.0001);
  const zeroIdx=0-scoreMin;
  const zeroX=(zeroIdx>=0&&zeroIdx<dist.length)?(zeroIdx+0.5)*step:null;
  const bars=dist.map((p,i)=>{
    if(p<=0.0005)return '';
    const barH=Math.max(1,(p/max)*(h-4));
    const score=scoreMin+i;
    const fill=score>0?'#3b82f6':score<0?'#e07a5f':'#64748b';
    return `<rect x="${(i*step).toFixed(2)}" y="${(h-2-barH).toFixed(2)}" width="${Math.max(0.7,step*0.88).toFixed(2)}" height="${barH.toFixed(2)}" fill="${fill}" fill-opacity="0.82"/>`;
  }).join('');
  const zeroLine=zeroX!==null?`<line x1="${zeroX.toFixed(2)}" y1="1" x2="${zeroX.toFixed(2)}" y2="${h-1}" stroke="#94a3b8" stroke-width="0.7" stroke-dasharray="2 1.5"/>`:'';
  const expectedText=candidate.expected_score===null?'—':`${signed(candidate.expected_score)}집`;
  return `<div class="candidate-hist-wrap"><div class="candidate-hist-meta"><span>MCTS 경로 예상 집차이 분포 (x: 집차이 · y: 확률)</span><span>평균 ${expectedText}</span></div><svg class="candidate-hist-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="후보수 예상 집차이 분포">${zeroLine}${bars}<line x1="0" y1="${h-2}" x2="${w}" y2="${h-2}" stroke="#cbd5e1" stroke-width="0.6"/></svg></div>`;
 }
 const candidates=analysis?.mcts.candidates.slice(0,8)||[];
 if($('candidate-count'))$('candidate-count').textContent=candidates.length?`${analysis.mcts.candidates.length}개 후보`:'상위 후보';
 if($('candidates')){
  $('candidates').replaceChildren();
  if(!candidates.length){const p=document.createElement('p');p.className='empty-state';p.textContent='이 국면의 후보수가 없어요.';$('candidates').append(p);}
  const best=candidates[0]||null;
  const sharedHistMax=candidates.reduce((mx,c)=>Array.isArray(c.score_distribution)?Math.max(mx,...c.score_distribution):mx,0.0001);
  candidates.forEach((candidate,i)=>{
   const outcome=candidateOutcome(candidate,analysis);
   const share=candidateShare(candidate,analysis);
   const button=document.createElement('button');button.className=`candidate-row${outcome==='win'?' proven-win':outcome==='loss'?' proven-loss':''}`;
   const probability=candidate.win_probability===null?null:analysis.perspective==='first'?candidate.win_probability:1-candidate.win_probability;
   const scoreDiff=(i>0&&candidate.expected_score!==null&&best?.expected_score!==null)?(candidate.expected_score-best.expected_score):null;
   const winDiffPp=(i>0&&candidate.win_probability!==null&&best?.win_probability!==null)?((candidate.win_probability-best.win_probability)*100):null;
   const diffLine=(i>0&&(scoreDiff!==null||winDiffPp!==null))?`<small class="candidate-diff">1순위 대비 ${scoreDiff!==null?`${signed(scoreDiff)}집`:'—'} · ${winDiffPp!==null?`${signed(winDiffPp)}%p`:'—'}</small>`:'';
   const provenTag=outcome==='win'?'<span class="proven-badge win">필승</span>':outcome==='loss'?'<span class="proven-badge loss">필패</span>':'';
   const gStageMap={selected:['1순위','selected'],finalist:['결선',''],active:['진행',''],eliminated:['탈락','eliminated'],unconsidered:['후보외','eliminated']};
   const gInfo=isGumbel&&candidate.gumbel_status&&gStageMap[candidate.gumbel_status];
   const gStageTag=gInfo?`<span class="gumbel-stage-badge${gInfo[1]?` ${gInfo[1]}`:''}">${gInfo[0]}</span>`:'';
   const histHtml=L.margin?candidateHistogramSvg(candidate,sharedHistMax,analysis.raw_network?.score_min):'';
   const orbitNote=candidate.orbit_size>1?` · 대칭 ${candidate.orbit_size}`:'';
   button.innerHTML=`<span><span class="candidate-rank">${i+1}</span><span class="candidate-coordinate">${coord(candidate.action)}${provenTag}<small>모델 선호도 ${pct(analysis.raw_network?.policy[candidate.action])}</small></span></span><span>${pct(share)}<small>${candidate.visits} visits${orbitNote}${gStageTag}</small>${diffLine}</span><span>${L.win?pct(probability):'—'}<small>Q ${signed(candidate.q===null?null:(analysis.perspective==='first'?1:-1)*candidate.q)} · 덤 전 ${L.margin?signed(candidate.expected_score===null?null:(analysis.perspective==='first'?1:-1)*candidate.expected_score):'—'}집</small></span>${histHtml}`;
   button.addEventListener('click',()=>run(()=>place(candidate.action)));$('candidates').append(button);
  });
 }
 const pv=analysis?.mcts.principal_variation||[];
 if($('pv')){
  $('pv').replaceChildren();
  if(!pv.length){const span=document.createElement('span');span.className='muted';span.textContent=analysis?'이 국면의 예상 수순이 없어요.':'분석 후 확인할 수 있어요.';$('pv').append(span);}
  pv.slice(0,16).forEach((action,i)=>{
   const button=document.createElement('button');
   const blue=(analysis.perspective==='first')===(i%2===0);
   button.innerHTML=`<i class="castle-mini ${blue?'blue':'red'}"></i>${coord(action)}`;
   button.setAttribute('aria-label',`예상 ${i+1}수까지 보기`);
   button.addEventListener('click',()=>run(()=>previewPV(i+1)));
   $('pv').append(button);
  });
 }
 if($('pv-import'))$('pv-import').disabled=!pv.length||moving;
 if(analysis){
  const model=analysis.model;
  const text=[`출처: ${sourceLabel(analysis.source)}`,`탐색 알고리즘: ${isGumbel?'Gumbel (Sequential Halving)':'PUCT'}`,`대칭 추론: ${analysis.d4_samples??1}방향 (평균)`,`모델 원승률: ${pct(values.rawWin)}`,`예상 영토 차이(덤 전): ${signed(values.rawScore)}`,`탐색 시간: ${(analysis.cumulative_elapsed_seconds??analysis.mcts.elapsed_seconds).toFixed(3)}초`,
   `모델 SHA: ${model?.sha256?.slice(0,16)||'규칙 판정'}`,`국면: ${analysis.state_id.slice(0,16)}`,`실행: ${analysis.provider||analysis.execution||analysis.backend} · 규칙 ${analysis.position.ruleset_version}`,`전술 상태: ${analysis.exact?.status||'없음'} · 위협 ${(analysis.exact?.threats||[]).map(coord).join(', ')||'없음'}`,`정책 엔트로피: ${(-(analysis.raw_network?.policy||[]).reduce((sum,p)=>sum+(p>0?p*Math.log(p):0),0)).toFixed(3)}`,
   ...(analysis.proven_winner?[`증명된 승자: ${analysis.proven_winner==='first'?'파란 성':'빨간 성'}`]:[])];
  if($('more-metrics'))$('more-metrics').replaceChildren(...text.map(t=>{const div=document.createElement('div');div.textContent=t;return div;}));
  const dist=analysis.raw_network?.score_distribution||[],max=Math.max(...dist,0.00001),step=300/Math.max(dist.length,1);
  if($('score-distribution'))$('score-distribution').innerHTML=dist.length?`<svg class="distribution-svg" viewBox="0 0 300 50" role="img" aria-label="현재 둘 차례 관점의 예상 영토 차이 분포">${dist.map((p,i)=>`<rect x="${i*step}" y="${48-p/max*42}" width="${Math.max(.3,step*.85)}" height="${p/max*42}" fill="#809caa"/>`).join('')}</svg>`:'';
 }else{if($('more-metrics'))$('more-metrics').textContent='분석 전';if($('score-distribution'))$('score-distribution').replaceChildren();}
}
function setSwitch(id,on,{soft=false}={}){const el=$(id);if(!el)return;el.checked=Boolean(on);el.setAttribute('aria-checked',String(Boolean(on)));el.classList.toggle('soft-disabled',soft);el.closest?.('label')?.classList.toggle('soft-disabled',soft);}
function renderSettings(){
 const node=active(),a=nodeAnalysis(node),side=node?.position?.side_to_move;
 const stateText=batching?'일괄 분석 중':analyzing?(analysisKind==='ai'?`AI ${sideName(side)} 착수 탐색 중`:analysisKind==='continuous'?`${sideName(side)} 턴 계속 분석 중`:'현재 국면 분석 중'):a?'분석 완료':'분석 전';
 
 // 2.1 현재 분석 visit 수 & 초당 visit 수
 const visitsNum=(a?.mcts?.root_visits||0);
 const elapsedSec=(a?.cumulative_elapsed_seconds??a?.mcts?.elapsed_seconds??0);
 const stats=a?.stats||lastRuntimeStats;
 const vps=(stats?.visits_per_second>0)?stats.visits_per_second:(visitsNum>0&&elapsedSec>0?visitsNum/elapsedSec:null);
 const vpsText=vps!==null?`${vps.toFixed(1)} visits/s`:'— visits/s';
 const stopReason=effectiveStopReason(a);
 const stopInfo=stopReason?STOP_REASON_LABELS[stopReason]:null;
 if($('search-visits-num'))$('search-visits-num').textContent=`${visitsNum.toLocaleString()} visits`;
 if($('search-stop-reason')){
  $('search-stop-reason').hidden=!stopInfo;
  $('search-stop-reason').textContent=stopInfo?stopInfo.label:'';
  $('search-stop-reason').className=`stop-reason-badge${stopInfo?` ${stopInfo.cls}`:''}`;
 }
 if($('search-speed'))$('search-speed').textContent=vpsText;
 if($('search-status'))$('search-status').textContent=`${stateText}${stopInfo?` (${stopInfo.label})`:''} · ${visitsNum.toLocaleString()} visits · ${elapsedSec.toFixed(1)}초 · ${vpsText}`;
 if($('stat-backend'))$('stat-backend').textContent=stats?.backend?(stats.backend==='webgpu'?'WebGPU':`WASM (${stats.wasm_threads||1}스레드)`):(backend()==='local'?'초기화 중':'미사용');
 if($('stat-precision'))$('stat-precision').textContent=stats?.precision||'FP32 (비양자화)';
 if($('stat-cache')){
  if(stats){
   const totalLookups=(stats.raw_cache_hits||0)+(stats.raw_cache_misses||0);
   const hitRate=totalLookups?` (${Math.round((stats.raw_cache_hits/totalLookups)*100)}%)`:'';
   const mdl=stats.model_cache==='cache'?'모델 캐시':'모델 다운로드';
   $('stat-cache').textContent=`${mdl} · 평가 ${stats.raw_cache_size}/${stats.raw_cache_max}${hitRate} · 트리 ${stats.tree_cache_size}/${stats.tree_cache_max}`;
  }else{$('stat-cache').textContent='대기 중';}
 }
 if($('stat-speed'))$('stat-speed').textContent=vpsText;
 
 // 2.2 현재 국면 분석 버튼 & 강제 재탐색 & 분석 고정 토글
 if($('analyze-button')){$('analyze-button').textContent=analyzing?'분석 중지':'현재 국면 분석';$('analyze-button').classList.toggle('active',analyzing);$('analyze-button').disabled=moving||batching||!modelAvailable()||Boolean(node?.position?.result&&!analyzing);}
 if($('reanalyze-button')){$('reanalyze-button').disabled=moving||batching||!modelAvailable()||Boolean(node?.position?.result);}
 setSwitch('analysis-pin',settings.analysisPinned);
 setSwitch('once-auto-show',settings.onceAutoShow);
 
 // 2.3 이번 턴부터 계속 분석 토글 (빨강 / 파랑)
 for(const s of SIDES){
  setSwitch(`continuous-${s}`,controls.continuous[s]);
  if($(`continuous-${s}-tag`))$(`continuous-${s}-tag`).hidden=!controls.aiSide[s];
 }

 // 2.35 탐색 알고리즘 (PUCT / Gumbel SH)
 const modeTabs=$('search-mode-tabs');
 if(modeTabs){
  for(const btn of (modeTabs.children||[])){
   const activeMode=btn.dataset?.mode===settings.searchMode;
   btn.classList?.toggle?.('active',activeMode);
   btn.setAttribute?.('aria-pressed',String(activeMode));
  }
 }
 if($('search-mode-hint')){
  $('search-mode-hint').textContent=settings.searchMode==='gumbel'?'Gumbel SH: 단계별 후보 압축 · 개선 정책(%)과 결선/탈락 상태 시각화':'PUCT: 방문 비중 비례 원 크기 시각화';
 }
 if($('d4-samples-range'))$('d4-samples-range').value=String(settings.d4Samples);
 if($('d4-samples-value')&&document.activeElement!==$('d4-samples-value'))$('d4-samples-value').value=String(settings.d4Samples);
 const d4Tabs=$('d4-samples-tabs');
 if(d4Tabs){
  for(const btn of (d4Tabs.children||[])){
   const activeD4=Number(btn.dataset?.d4)===settings.d4Samples;
   btn.classList?.toggle?.('active',activeD4);
   btn.setAttribute?.('aria-pressed',String(activeD4));
  }
 }
 if($('d4-samples-hint')){
  $('d4-samples-hint').textContent=settings.d4Samples===1?'표준 1방향만 추론 (완전 대칭 판은 자동 8방향 평균)':settings.d4Samples===8?'가능한 모든 대칭 방향을 전부 추론해 평균냅니다':`가능한 대칭 방향 중 최대 ${settings.d4Samples}개(랜덤)를 추론해 평균냅니다`;
 }
 
 // 2.4 최대 시간 or visit
 const l=settings.analysisLimit;
 const f=floor();
 const tabs=$('analysis-limit-tabs');
 if(tabs){
   for(const btn of (tabs.children||[])){
     btn.classList?.toggle?.('active', btn.dataset?.unit===l.unit);
   }
 }
 const wrap=$('analysis-limit-input-wrap');
 const presets=$('analysis-presets');
 const input=$('analysis-limit-value');
 const unitLabel=$('analysis-limit-unit-label');
 if($('analysis-limit-unit'))$('analysis-limit-unit').value=l.unit;

 if(l.unit==='none'){
   if(wrap)wrap.hidden=true;
   if(presets)presets.hidden=true;
   if($('analysis-limit-hint'))$('analysis-limit-hint').textContent='수동으로 중지하거나 착수할 때까지 계속 탐색합니다.';
 }else{
   if(wrap)wrap.hidden=false;
   if(presets)presets.hidden=false;
   if(unitLabel)unitLabel.textContent=l.unit==='visits'?'visits':'초';
   const range=BUDGET_RANGE[l.unit];
   if(input){
     input.disabled=false;
     input.min=String(f!==null&&f>range.min?f:range.min);
     input.max=String(range.max);
     input.step=l.unit==='visits'?'1':'0.1';
     if(document.activeElement!==input)input.value=String(l.value);
   }
   if(presets){
     const list=l.unit==='visits'?[400,800,1600,3200,10000]:[0.5,1,2,5,10];
     presets.replaceChildren();
     for(const val of list){
       const b=document.createElement('button');b.type='button';b.className='preset-btn';
       b.textContent=l.unit==='visits'?`${val.toLocaleString()} visits`:`${val}초`;
       b.addEventListener('click',()=>{
         settings.analysisLimit={unit:l.unit,value:val};
         if(enforceFloor())notice(`분석 탐색량을 ${budgetLabel(settings.analysisLimit)} 이상으로 맞췄어요.`);
         saveSettings();render();
       });
       presets.append(b);
     }
   }
   if($('analysis-limit-hint')){
     $('analysis-limit-hint').textContent=l.unit==='seconds'?`한 수당 최대 ${l.value}초 동안 탐색 후 정지합니다.${f!==null?` (AI 착수 설정 ${f}초 이상으로 제한)`:''}`:`한 수당 최대 ${l.value.toLocaleString()} visits에 도달하면 정지합니다.${f!==null?` (AI 착수 설정 ${f.toLocaleString()} visits 이상으로 제한)`:''}`;
   }
 }

 // 3. 시각화 스택 버튼 및 고정 토글
 for(const [k,layerKey] of [
   ['ownership','ownership'],['policy','policy'],['pv','pv'],
   ['win','win'],['margin','margin'],['territory','territory'],['numbers','numbers']
 ]){
   const btn=$(`vis-btn-${k}`);
   const isActive=k==='territory'?settings.territory:k==='numbers'?settings.numbers:settings.layers[layerKey];
   if(btn){
     btn.classList.toggle('active',Boolean(isActive));
     btn.setAttribute('aria-pressed',String(Boolean(isActive)));
   }
   setSwitch(`vis-pin-${k}`,settings.pins[k]);
 }
 setSwitch('ownership-toggle',settings.layers.ownership);for(const k of ['policy','win','margin','pv'])setSwitch(`layer-${k}`,settings.layers[k]);
 setSwitch('territory-toggle',settings.territory);setSwitch('numbers-toggle',settings.numbers);

 // 4. 착수
 for(const s of SIDES){
   setSwitch(`play-${s}`,controls.aiSide[s]);
   const pVal=$(`play-${s}-value`),pUnit=$(`play-${s}-unit`);
   if(pUnit)pUnit.value=settings.play[s].unit;
   if(pVal&&document.activeElement!==pVal)pVal.value=String(settings.play[s].value);
 }
 const tVal=$('play-temperature');
 if(tVal&&document.activeElement!==tVal)tVal.value=String(settings.playTemperature);
 setSwitch('play-force-proven-win',settings.forceProvenWin);
 setSwitch('play-ignore-proven-loss',settings.ignoreProvenLoss);
 setSwitch('play-ponder',settings.ponder);
 if($('ponder-hint'))$('ponder-hint').textContent=settings.ponder?'무제한(♾️) 자동 분석 연동 중 · 내 차례에도 계속 탐색합니다.':'켜면 분석 제한이 무제한(♾️)으로 설정되어 내 차례에도 계속 자동 분석합니다.';
 const isLeaf=isLeafNode(doc,node?.id);
 const who=SIDES.filter(s=>controls.aiSide[s]).map(sideName).join('·');
 const pondering=analyzing&&analysisKind==='ponder';
 if($('play-status'))$('play-status').textContent=placeMode!=='alternate'?'성 배치 모드 · AI 착수 대기':!who?'AI 착수 꺼짐 · 양쪽을 직접 둡니다':isLeaf?(pondering?`AI가 ${who}을(를) 둡니다 · 미리 탐색 중…`:`AI가 ${who}을(를) 둡니다`):`AI ${who} 대기 중 · 과거 수 탐색 중`;
 if($('play-clone-leaf'))$('play-clone-leaf').hidden=Boolean(isReading()||!node||node.position?.result||isLeaf);

 // 2. 일반 시각화
 setSwitch('territory-toggle',settings.territory);setSwitch('numbers-toggle',settings.numbers);

 // 3. 브랜칭 트리 일괄 분석
 if($('batch-scope')&&!$('batch-scope').value)$('batch-scope').value=settings.batch.scope;
 if($('batch-target')&&!$('batch-target').value)$('batch-target').value=settings.batch.target;
 const bVal=$('batch-value'),bUnit=$('batch-unit');
 if(bUnit)bUnit.value=settings.batch.budget.unit;
 if(bVal&&document.activeElement!==bVal)bVal.value=String(settings.batch.budget.value);
 if($('batch-start')){$('batch-start').textContent=batching?'일괄 분석 중지':settings.batch.target==='all'?'한번에 다시 분석':'미분석 국면 분석';$('batch-start').disabled=!modelAvailable()||moving;}
}
function renderMemos(){
 const list=$('memo-list');if(!list)return;
 const memos=doc.nodes.filter(n=>(n.notes||'').trim());list.replaceChildren();
 if(!memos.length){const span=document.createElement('span');span.className='muted';span.textContent='메모가 있는 국면이 여기에 모여요.';list.append(span);return;}
 for(const n of memos){const b=document.createElement('button');b.type='button';b.className=n.id===doc.selected?'active':'';b.textContent=`${n.ply}수 ${n.action===null?'시작':coord(n.action)} · ${n.notes.trim().slice(0,24)}`;b.addEventListener('click',()=>run(()=>selectNode(n.id)));list.append(b);}
}
function renderBranchBar(){
 const bar=$('branch-bar');if(!bar||!doc)return;
 const leaves=branchLeaves(doc);
 if(leaves.length<=1){bar.hidden=true;bar.replaceChildren();return;}
 bar.hidden=false;bar.replaceChildren();
 const activeLeaf=resolveBranchLeaf(doc,doc.selected,doc.branch_leaf);
 doc.branch_leaf=activeLeaf;
 const label=document.createElement('span');label.className='branch-bar-label';label.textContent='현재 가지';bar.append(label);
 leaves.forEach((leaf,i)=>{
  const b=document.createElement('button');b.type='button';
  b.className=`branch-pill${leaf.id===activeLeaf?' active':''}`;
  b.setAttribute('aria-pressed',String(leaf.id===activeLeaf));
  b.textContent=`가지 ${i+1} · ${leaf.ply}수(${leaf.action===null?'시작':coord(leaf.action)})`;
  b.addEventListener('click',()=>run(async()=>{doc.branch_leaf=leaf.id;await selectNode(leaf.id);}));
  bar.append(b);
 });
}
function renderTimeline(){const viewport=$('timeline');if(!viewport)return;const left=viewport.scrollLeft;doc.branch_leaf=resolveBranchLeaf(doc,doc.selected,doc.branch_leaf);viewport.innerHTML=timelineSvg(doc,graphAnalysis,graphMode,doc.branch_leaf,reading);viewport.scrollLeft=left;renderBranchBar();renderMemos();}
function render(){if(!active()?.position)return;
 applyTheme();
 if($('title')&&document.activeElement!==$('title'))$('title').value=doc.title;
 if($('notes')){
  $('notes').disabled=isReading();
  if(isReading())$('notes').value='';
  else if(document.activeElement!==$('notes'))$('notes').value=active().notes||'';
 }
 if($('setup-label'))$('setup-label').textContent=doc.setup.neutral===null?'중립 성 없음':`중립 성 ${doc.setup.neutral.map(n=>n+1).join('·')}`;
 if($('komi-label'))$('komi-label').textContent=`덤 ${doc.setup.komi}`;
 renderSettings();renderPlacementBar();renderBoard();renderAnalysis();renderTimeline();
}
async function previewPV(count){
 const a=visibleAnalysis();if(!a||moving)return;
 const epoch=controls.epoch,node=active(),actions=a.mcts.principal_variation.slice(0,count);
 const fullPath=isReading()?[...pathTo(doc,reading.anchorId),...pathTo(reading.doc,node.id)]:pathTo(doc,node.id);
 let p;
 if(backend()==='host'&&!staticOnly&&fullPath.every(x=>x<=81)&&actions.every(x=>x<=81)){
  p=await position({...positionRequest(),actions:[...fullPath,...actions]});
 }else{
  p=node.position;
  for(const act of actions){if(p.result)break;p=await finalizePosition(makeNextPosition(p,act));}
 }
 if(epoch!==controls.epoch)return;
 preview={position:p,actions};renderBoard();
}
async function importPV(){
 const actions=visibleAnalysis()?.mcts?.principal_variation?.slice(0,16)||[];
 if(!actions.length)return;
 cancel();
 moving=true;
 const targetDoc=currentDoc();
 let parentId=targetDoc.selected;
 try{
  for(const a of actions){
   const parentNode=targetDoc.nodes.find(n=>n.id===parentId);
   if(!parentNode||parentNode.position.result)break;
   if(a<81&&!parentNode.position.legal_actions.includes(a))break;
   const next=await finalizePosition(makeNextPosition(parentNode.position,a));
   const child=addNode(targetDoc,parentId,a,next);
   parentId=child.id;
  }
  targetDoc.branch_leaf=resolveBranchLeaf(targetDoc,targetDoc.selected,targetDoc.branch_leaf);
  onceNode=null;
  if(!isReading()){save();notice(`${actions.length}수의 예상 수순을 분기로 가져왔습니다.`);}
  else notice(`${actions.length}수의 예상 수순을 수읽기 분기에 추가했습니다.`);
 }finally{
  moving=false;
  render();
  if(!isReading())schedule();
 }
}
function populateModels(){
 const select=$('model-select');if(!select)return;
 select.replaceChildren();for(const m of (config?.models||[])){const o=new Option(m.label,m.id);select.append(o);}
 if(!config?.models?.length)select.append(new Option('연결된 모델 없음',''));
 const modelId=doc?.model_id||config?.models?.[0]?.id||'';
 if(doc?.model_id&&!config?.models?.some(m=>m.id===doc.model_id))select.append(new Option('저장된 모델 · 사용 불가',doc.model_id));
 select.value=modelId;
 if($('model-detail'))$('model-detail').textContent=modelId?`선택 모델 SHA ${modelId.slice(0,16)} · 기보 중 자동 교체 없음`:'모델을 연결해 주세요.';
}
async function setupBackend(){
 cancel();controls.playing=false;backendReady=false;const requested=backend(),model=doc.model_id;render();
 try{if(requested==='local'){
 if(globalThis.isSecureContext===false)throw Error('기기 내 추론은 HTTPS 주소로 접속해 주세요. IP의 HTTP 주소에서는 Mac 계산을 사용할 수 있어요.');
 if(!config?.browser_models?.includes(model))throw Error(staticOnly?'이 기보의 모델은 사이트에서 제외됐어요. 기보와 메모는 보존돼요. 사용 모델에서 세대 모델을 선택해 주세요.':'이 모델의 브라우저 실행 파일이 준비되지 않았어요. 사용법의 준비 명령을 실행해 주세요.');
 if($('runtime-note'))$('runtime-note').textContent='모델을 이 기기에 불러오는 중…';
 local?.close();local=new LocalEngine();localModel=null;const current=local,manifest=staticOnly?await loadStaticManifest(config,model):await api(`browser-model/${model}`),status=await current.initialize(manifest,progress=>{if(local!==current)return;if($('runtime-note'))$('runtime-note').textContent=({runtime:'실행 파일을 불러오는 중…',model:'모델을 기기에 내려받는 중…',session:'기기에서 모델을 준비하는 중…'}[progress.stage]||'기기 내 엔진 준비 중…');});
 if(requested!==backend()||model!==doc.model_id||local!==current)return;
 localModel=model;lastRuntimeStats=status.stats||null;
 if($('runtime-note'))$('runtime-note').textContent=`서버 추론 미사용 · 브라우저 로컬 전용 · ${(status.execution_provider||status.backend||status.provider||'WebGPU / WASM').toUpperCase()}`;
 }else{if($('runtime-note'))$('runtime-note').textContent='연결된 Mac에서 계산';local?.close();local=null;localModel=null;}
 backendReady=true;if($('connection'))$('connection').textContent=requested==='local'?'기기 내 엔진 준비됨':`Mac ${config?.device?.toUpperCase?.()||'CPU'} 연결됨`;notice('');render();schedule();
 }catch(e){if(requested===backend()&&model===doc.model_id){backendReady=false;if($('connection'))$('connection').textContent='실행부 준비 실패';notice(e.message,true);render();}}
}
async function rebuildStudy(imported){
 if(backend()==='host')return api('validate-study',studyForSave(imported));
 const nodes=[];
 for(const n of imported.nodes){
  let p;
  if(n.parent===null){
   if(n.board&&n.side_to_move){
    const s={board:n.board,side_to_move:n.side_to_move,previous_move_was_pass:false,komi:imported.setup.komi,result:n.result??null,ruleset_version:imported.ruleset_version};
    p=await finalizePosition(positionPayload(s));
   }else{
    p=await position({ruleset_version:imported.ruleset_version,setup:imported.setup,actions:[]});
   }
  }else{
   const parentNode=nodes.find(parent=>parent.id===n.parent);
   if(n.board&&n.side_to_move){
    const s={board:n.board,side_to_move:n.side_to_move,previous_move_was_pass:n.action===81,komi:imported.setup.komi,result:n.result??null,ruleset_version:imported.ruleset_version};
    p=await finalizePosition(positionPayload(s));
   }else{
    p=await finalizePosition(makeNextPosition(parentNode.position,n.action));
   }
  }
  nodes.push({...n,ply:n.parent===null?0:nodes.find(parent=>parent.id===n.parent).ply+1,position:p,analysis:null});
 }
 return {...imported,nodes};
}
async function loadStudy(value,{initializeModel=true,preserveCurrent=true}={}){const imported=importDocument(value);clearTimeout(saveTimer);if(preserveCurrent&&!saveNow())throw Error('현재 기보를 내보내기로 보관해 주세요.');cancel();controls.playing=false;const epoch=controls.epoch,rebuilt=await rebuildStudy(imported);if(epoch!==controls.epoch)return;reading=null;clearReadingShown();doc={...rebuilt,storage_id:value.storage_id||crypto.randomUUID()};doc.branch_leaf=resolveBranchLeaf(doc,doc.selected,doc.branch_leaf);placeMode='alternate';onceNode=null;shown.clear();populateModels();render();save();if(initializeModel&&backend()==='local'&&localModel!==doc.model_id)await setupBackend();else if(initializeModel)schedule();}
async function createGame(setup,{keepPlaceMode=false}={}){cancel();controls.playing=false;const epoch=controls.epoch,p=await position({ruleset_version:doc?.ruleset_version||'gk-v2.2',setup,actions:[]});if(epoch!==controls.epoch)return;clearTimeout(saveTimer);if(!saveNow())throw Error('현재 기보를 먼저 보관해 주세요.');const model=doc?.model_id||config?.models?.[0]?.id||null;reading=null;clearReadingShown();doc={...newStudy(setup,p),storage_id:crypto.randomUUID(),model_id:model};doc.branch_leaf=resolveBranchLeaf(doc,doc.selected,doc.branch_leaf);doc.title=`${new Date().toLocaleDateString('ko-KR',{month:'long',day:'numeric'})}의 연습`;if(!keepPlaceMode)placeMode='alternate';onceNode=null;shown.clear();if(placeMode==='alternate'&&controls.anyAI())controls.playing=true;populateModels();save();render();if($('new-dialog'))$('new-dialog').close();if(placeMode==='alternate')schedule();}
function showNew(){if(!$('recent-studies'))return;$('recent-studies').replaceChildren();for(const entry of library()){const b=document.createElement('button');b.type='button';b.textContent=`${entry.title||'이름 없는 연습'} · ${entry.nodes.length}개 국면`;b.addEventListener('click',()=>run(async()=>{await loadStudy(entry);$('new-dialog').close();}));$('recent-studies').append(b);}$('new-dialog').showModal();}
async function batch(){if(batching){cancel();render();return;}if(!modelAvailable())return;
 cancel();controls.playing=false;
 const scope=$('batch-scope')?.value||settings.batch.scope;
 const target=$('batch-target')?.value||settings.batch.target;
 const budget=$('batch-value')?.value?settings.batch.budget:{unit:'visits',value:Number($('batch-visits')?.value||160)};
 const nodes=missingNodes(doc,scope,backend(),target);
 const study=doc,model=doc.model_id,execution=backend(),epoch=controls.epoch,controller=new AbortController();
 analysisController=controller;batching=true;controls.visible=true;capture();let completed=0;render();
 try{for(const n of nodes){if(controller.signal.aborted||study!==doc||epoch!==controls.epoch)break;if($('batch-status'))$('batch-status').textContent=`${completed}/${nodes.length} · ${n.ply}수 계산 중`;
 const a=await search(n,budget,{signal:controller.signal});if(study!==doc||epoch!==controls.epoch)break;acceptResult(a,n,model,execution);completed++;renderTimeline();}
 }finally{if(epoch===controls.epoch){batching=false;analysisController=null;if($('batch-status'))$('batch-status').textContent=`${completed}/${nodes.length} 국면 완료`;render();schedule();}}
}
async function cloneLeafHere(){
 const node=active();
 if(!node||isReading()||moving||batching)return;
 cancel();
 if(!saveNow())throw Error('현재 기보를 먼저 저장하지 못했어요.');
 const storageId=globalThis.crypto?.randomUUID?.()??`s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
 const cloned=cloneStudyAsLeaf(doc,node.id,storageId);
 doc=cloned;
 shown.clear();
 onceNode=null;
 placeMode='alternate';
 if(controls.anyAI())controls.playing=true;
 saveNow();
 render();
 notice(`현재 국면(${node.ply}수)까지 새 기보 리프로 복제했어요. 원본은 [새 연습]에서 다시 열 수 있어요.`);
 schedule();
}
function ask(title,message,ok='확인'){const d=$('confirm-dialog');if(!d)return Promise.resolve(true);if($('confirm-title'))$('confirm-title').textContent=title;if($('confirm-message'))$('confirm-message').textContent=message;if($('confirm-ok'))$('confirm-ok').textContent=ok;d.returnValue='';return new Promise(resolve=>{d.addEventListener('close',()=>resolve(d.returnValue==='ok'),{once:true});d.showModal();});}
async function run(fn){try{await fn();}catch(e){if(e.name!=='AbortError')notice(e.message||'작업 실패',true);}}

// ---- Events ---------------------------------------------------------------
$('board')?.addEventListener('click',e=>{const t=e.target?.closest?.('[data-action]');if(t){const a=Number(t.dataset.action);run(()=>handleBoardClick(a));}});
$('board')?.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){const t=e.target?.closest?.('[data-action]');if(t){e.preventDefault();const a=Number(t.dataset.action);run(()=>handleBoardClick(a));}}});
$('mode-alternate')?.addEventListener('click',()=>setPlaceMode('alternate'));
$('mode-place-red')?.addEventListener('click',()=>setPlaceMode(placeMode==='place-red'?'alternate':'place-red'));
$('mode-place-blue')?.addEventListener('click',()=>setPlaceMode(placeMode==='place-blue'?'alternate':'place-blue'));
$('mode-place-neutral')?.addEventListener('click',()=>setPlaceMode(placeMode==='place-neutral'?'alternate':'place-neutral'));
$('mode-remove')?.addEventListener('click',()=>setPlaceMode(placeMode==='remove'?'alternate':'remove'));
$('turn-order-blue')?.addEventListener('click',()=>run(()=>setTurnSide('first')));
$('turn-order-red')?.addEventListener('click',()=>run(()=>setTurnSide('second')));
$('analyze-button')?.addEventListener('click',()=>{
 if(analyzing){if(analysisKind==='ai')controls.playing=false;cancel();render();return;}
 const n=active();if(!n)return;
 onceNode=n.id;controls.visible=true;render();
 const aiTurn=currentAiTurn(n);
 if(aiTurn)controls.playing=true;
 run(()=>startAnalysis({ai:aiTurn,kind:aiTurn?'ai':'once'}));
});
$('reanalyze-button')?.addEventListener('click',()=>{
 const n=active();if(!n||moving||batching||!modelAvailable()||n.position?.result)return;
 cancel();
 onceNode=n.id;controls.visible=true;
 const aiTurn=canAiPlay()&&isLeafNode(doc,n.id)&&controls.aiTurn(n.position);
 run(()=>startAnalysis({ai:aiTurn,kind:aiTurn?'ai':'once',force:true}));
});
$('clone-leaf-button')?.addEventListener('click',()=>run(cloneLeafHere));
$('play-clone-leaf')?.addEventListener('click',()=>run(cloneLeafHere));
$('once-auto-show')?.addEventListener('change',e=>{settings.onceAutoShow=e.target.checked;saveSettings();render();});
for(const s of SIDES)$(`continuous-${s}`)?.addEventListener('change',e=>{
 controls.continuous[s]=e.target.checked;if(!controls.anyContinuous())controls.visualContinuous=false;saveSettings();
 const p=active()?.position;
 if(!controls.continuous[s]&&analysisKind==='continuous'&&p?.side_to_move===s){cancel();render();return;}
 render();if(controls.continuous[s]&&p?.side_to_move===s&&!analyzing&&!batching&&!moving)schedule();
});

// 2.4 최대 시간 or visit 탭 전환 및 숫자 입력
$('analysis-limit-tabs')?.addEventListener('click',e=>{
 const btn=e.target?.closest?.('button[data-unit]');
 if(!btn)return;
 const unit=btn.dataset.unit;
 const current=settings.analysisLimit;
 let val=current.value;
 if(unit==='none')val=null;
 else if(unit==='seconds'&&(current.unit!=='seconds'||!val))val=2.0;
 else if(unit==='visits'&&(current.unit!=='visits'||!val))val=1600;
 settings.analysisLimit=normalizeBudget({unit,value:val},{allowNone:true,fallback:'seconds'});
 if(enforceFloor())notice(`AI 착수 탐색량 이하로 둘 수 없어 ${budgetLabel(settings.analysisLimit)}로 조정되었습니다.`);
 saveSettings();
 render();
});
$('analysis-limit-value')?.addEventListener('change',()=>{
 const val=Number($('analysis-limit-value').value);
 settings.analysisLimit=normalizeBudget({unit:settings.analysisLimit.unit,value:val},{allowNone:true,fallback:'seconds'});
 if(enforceFloor())notice(`분석 최대 탐색량을 ${budgetLabel(settings.analysisLimit)} 이상으로 맞췄어요.`);
 saveSettings();
 render();
});
$('analysis-limit-unit')?.addEventListener('change',()=>{
 settings.analysisLimit=readBudget('analysis-limit',settings.analysisLimit,{allowNone:true,fallback:'seconds'});
 enforceFloor();saveSettings();render();
});

// Drawer Controls
$('drawer-toggle')?.addEventListener('click',()=>{
 $('settings-drawer')?.classList.add('open');
 if($('drawer-backdrop'))$('drawer-backdrop').hidden=false;
});
const closeDrawer=()=>{
 $('settings-drawer')?.classList.remove('open');
 if($('drawer-backdrop'))$('drawer-backdrop').hidden=true;
};
$('drawer-close')?.addEventListener('click',closeDrawer);
$('drawer-backdrop')?.addEventListener('click',closeDrawer);

// Analysis Pin Toggle
$('analysis-pin')?.addEventListener('change',e=>{
 settings.analysisPinned=e.target.checked;
 saveSettings();
 render();
 if(settings.analysisPinned&&!analyzing&&!moving&&!batching)schedule();
});

function applySearchOptionChange(updater){
 const cur=active();
 const hadAnalysis=Boolean(visibleAnalysis()||cur?.analysis);
 cancel();
 updater();
 saveSettings();
 render();
 if(cur&&!moving&&!batching&&modelAvailable()&&!cur.position?.result){
  const aiTurn=canAiPlay()&&isLeafNode(doc,cur.id)&&controls.aiTurn(cur.position);
  if(aiTurn||settings.analysisPinned||controls.anyContinuous()||hadAnalysis){
   run(()=>startAnalysis({ai:aiTurn,kind:aiTurn?'ai':(settings.analysisPinned?'pinned':'once')}));
  }
 }
}
// Search Mode Toggle (PUCT vs Gumbel)
for(const mode of ['puct','gumbel']){
 $(`search-mode-${mode}`)?.addEventListener('click',()=>{
  if(settings.searchMode===mode)return;
  applySearchOptionChange(()=>{settings.searchMode=mode;});
 });
}
// D4 Symmetry Evaluation Sample Count (1..8)
const normalizeD4Samples=v=>{const n=Math.round(Number(v));return Number.isFinite(n)?Math.min(8,Math.max(1,n)):1;};
$('d4-samples-range')?.addEventListener('input',e=>{
 const n=normalizeD4Samples(e.target.value);
 if($('d4-samples-value'))$('d4-samples-value').value=String(n);
 if($('d4-samples-hint'))$('d4-samples-hint').textContent=n===1?'표준 1방향만 추론 (완전 대칭 판은 자동 8방향 평균)':n===8?'가능한 모든 대칭 방향을 전부 추론해 평균냅니다':`가능한 대칭 방향 중 최대 ${n}개(랜덤)를 추론해 평균냅니다`;
});
$('d4-samples-range')?.addEventListener('change',e=>{
 const n=normalizeD4Samples(e.target.value);
 if(settings.d4Samples===n)return;
 applySearchOptionChange(()=>{settings.d4Samples=n;});
});
$('d4-samples-value')?.addEventListener('change',e=>{
 const n=normalizeD4Samples(e.target.value);
 e.target.value=String(n);
 if(settings.d4Samples===n){renderSettings();return;}
 applySearchOptionChange(()=>{settings.d4Samples=n;});
});
for(const n of [1,2,4,8]){
 $(`d4-samples-${n}`)?.addEventListener('click',()=>{
  if(settings.d4Samples===n)return;
  applySearchOptionChange(()=>{settings.d4Samples=n;});
 });
}

// 3. 시각화 스택 버튼 및 고정 토글
const VIS_KEYS=[
 ['ownership','ownership'],['policy','policy'],['pv','pv'],
 ['win','win'],['margin','margin'],['territory','territory'],['numbers','numbers']
];
for(const [k,layerKey] of VIS_KEYS){
 $(`vis-btn-${k}`)?.addEventListener('click',()=>{
  if(k==='territory'){
   settings.territory=!settings.territory;
   if(!settings.territory)settings.pins.territory=false;
  }else if(k==='numbers'){
   settings.numbers=!settings.numbers;
   if(!settings.numbers)settings.pins.numbers=false;
  }else{
   settings.layers[layerKey]=!settings.layers[layerKey];
   if(!settings.layers[layerKey]){
    settings.pins[k]=false;
    if(k==='pv')preview=null;
   }
  }
  saveSettings();
  render();
  if(k!=='territory'&&k!=='numbers'&&settings.layers[layerKey]&&!nodeAnalysis(active())&&!analyzing&&!moving&&!batching&&modelAvailable()){
   const aiTurn=currentAiTurn(active());
   run(()=>startAnalysis({ai:aiTurn,kind:aiTurn?'ai':'once'}));
  }
 });
 $(`vis-pin-${k}`)?.addEventListener('change',e=>{
  const on=e.target.checked;
  settings.pins[k]=on;
  if(on){
   if(k==='territory')settings.territory=true;
   else if(k==='numbers')settings.numbers=true;
   else settings.layers[layerKey]=true;
  }
  saveSettings();
  render();
  if(k!=='territory'&&k!=='numbers'&&settings.layers[layerKey]&&!nodeAnalysis(active())&&!analyzing&&!moving&&!batching&&modelAvailable()){
   const aiTurn=currentAiTurn(active());
   run(()=>startAnalysis({ai:aiTurn,kind:aiTurn?'ai':'once'}));
  }
 });
}

$('visual-once')?.addEventListener('click',()=>run(async()=>{
 const n=active();if(onceNode===n.id){onceNode=null;render();return;}
 if(nodeAnalysis(n)||analyzing){onceNode=n.id;render();return;}
 if(!modelAvailable())throw Error('모델이 준비되면 분석할 수 있어요.');
 if(!await ask('아직 분석하지 않은 국면이에요','현재 국면 분석을 시작하고 결과를 실시간으로 볼까요?','분석하고 보기')||active()!==n)return;
 onceNode=n.id;
 const aiTurn=currentAiTurn(n);
 await startAnalysis({ai:aiTurn,kind:aiTurn?'ai':'once'});
}));
$('visual-continuous')?.addEventListener('click',e=>{
 if(controls.anyContinuous()){controls.visualContinuous=e.target.checked;saveSettings();render();return;}
 e.preventDefault?.();
 run(async()=>{if(!await ask('계속 분석이 꺼져 있어요','빨강·파랑 턴 계속 분석을 켜고, 계속 실시간 보기도 켤까요?','둘 다 켜기')){render();return;}controls.continuous.first=controls.continuous.second=true;controls.visualContinuous=true;saveSettings();render();if(!analyzing&&!batching&&!moving)schedule();});
});
for(const [id,key] of [['ownership-toggle','ownership'],['layer-policy','policy'],['layer-win','win'],['layer-margin','margin'],['layer-pv','pv']])$(id)?.addEventListener('change',e=>{settings.layers[key]=e.target.checked;if(!e.target.checked&&key==='pv')preview=null;saveSettings();render();});

// 4. 착수
for(const s of SIDES){
 $(`play-${s}`)?.addEventListener('change',e=>{
   cancel();controls.aiSide[s]=e.target.checked;
   if(e.target.checked){
    controls.continuous[s]=true;
    if(settings.ponder){
     settings.analysisLimit={unit:'none',value:null};
     for(const side of SIDES)controls.continuous[side]=true;
    }
    if(enforceFloor())notice(`분석 제한을 ${sideName(s)} 착수 탐색량(${budgetLabel(settings.analysisLimit)}) 이상으로 올렸어요.`);
   }
   saveSettings();render();schedule();
 });
 const budgetChanged=()=>{
   settings.play[s]=readBudget(`play-${s}`,settings.play[s],{fallback:'seconds'});
   if(enforceFloor())notice(`분석 제한을 ${sideName(s)} 착수 탐색량(${budgetLabel(settings.analysisLimit)}) 이상으로 올렸어요.`);
   saveSettings();render();
   const n=active();
   if(currentAiTurn(n)&&n.position.side_to_move===s&&!moving&&!batching&&modelAvailable()){
    if(analyzing)cancel();
    render();
    schedule();
   }
 };
 $(`play-${s}-unit`)?.addEventListener('change',budgetChanged);$(`play-${s}-value`)?.addEventListener('change',budgetChanged);
}
$('ai-resume')?.addEventListener('click',()=>{cancel();render();schedule();});
$('play-temperature')?.addEventListener('change',()=>{settings.playTemperature=normalizeTemperature($('play-temperature').value,{fallback:TEMPERATURE_DEFAULT});saveSettings();render();});
$('play-force-proven-win')?.addEventListener('change',e=>{settings.forceProvenWin=e.target.checked;saveSettings();render();});
$('play-ignore-proven-loss')?.addEventListener('change',e=>{settings.ignoreProvenLoss=e.target.checked;saveSettings();render();});
$('play-ponder')?.addEventListener('change',e=>{
 settings.ponder=e.target.checked;
 if(settings.ponder){
  settings.analysisLimit={unit:'none',value:null};
  if(controls.anyAI()){for(const side of SIDES)controls.continuous[side]=true;}
 }
 saveSettings();if(!settings.ponder&&analysisKind==='ponder')cancel();render();if(settings.ponder&&!analyzing)schedule();
});
$('ai-seconds')?.addEventListener('change',()=>{
 const val=Number($('ai-seconds').value);
 for(const s of SIDES)settings.play[s]={unit:'seconds',value:val};
 saveSettings();render();
});

// 2. 일반 시각화
$('territory-toggle')?.addEventListener('change',e=>{settings.territory=e.target.checked;saveSettings();render();});
$('numbers-toggle')?.addEventListener('change',e=>{settings.numbers=e.target.checked;saveSettings();render();});

// 3. 브랜칭 트리 일괄 분석
$('batch-scope')?.addEventListener('change',()=>{settings.batch.scope=$('batch-scope').value==='all'?'all':'branch';saveSettings();render();});
$('batch-target')?.addEventListener('change',()=>{settings.batch.target=$('batch-target').value==='all'?'all':'missing';saveSettings();render();});
const batchBudgetChanged=()=>{settings.batch.budget=readBudget('batch',settings.batch.budget,{fallback:'seconds'});saveSettings();render();};
$('batch-unit')?.addEventListener('change',batchBudgetChanged);$('batch-value')?.addEventListener('change',batchBudgetChanged);
$('batch-start')?.addEventListener('click',()=>run(batch));

// 테마 및 수읽기 모드
for(const mode of ['system','light','dark']){
 $(`theme-${mode}`)?.addEventListener('click',()=>{settings.theme=mode;applyTheme();saveSettings();});
}
try{
 const mq=globalThis.window?.matchMedia?.('(prefers-color-scheme: dark)');
 mq?.addEventListener?.('change',()=>{if(settings.theme==='system')applyTheme();});
}catch{/* optional */}
$('reading-toggle')?.addEventListener('click',()=>run(()=>isReading()?exitReadingMode():enterReadingMode()));
$('reading-prev')?.addEventListener('click',()=>run(()=>readingPrev()));
$('reading-next')?.addEventListener('click',()=>run(()=>readingNext()));
$('reading-reset')?.addEventListener('click',()=>run(()=>resetReadingMode()));
$('reading-exit')?.addEventListener('click',()=>run(()=>exitReadingMode()));

// 기타
$('backend')?.addEventListener('change',()=>run(setupBackend));
$('model-select')?.addEventListener('change',()=>{cancel();controls.playing=false;reading=null;clearReadingShown();doc.model_id=$('model-select').value||null;populateModels();save();render();run(setupBackend);});
$('first')?.addEventListener('click',()=>run(()=>selectNode(doc.nodes[0].id)));$('previous')?.addEventListener('click',()=>{if(active().parent)run(()=>selectNode(active().parent));});$('next')?.addEventListener('click',()=>{const n=nextInBranch(doc,doc.selected,doc.branch_leaf);if(n)run(()=>selectNode(n.id));});$('last')?.addEventListener('click',()=>{const n=lineThrough(doc,doc.selected,doc.branch_leaf).at(-1);if(n)run(()=>selectNode(n.id));});$('pass')?.addEventListener('click',()=>run(()=>place(81)));
$('timeline')?.addEventListener('click',e=>{const rt=e.target?.closest?.('[data-reading-node]');if(rt){run(()=>selectReadingNode(rt.dataset.readingNode));return;}const t=e.target?.closest?.('[data-node]');if(t)run(()=>selectNode(t.dataset.node));});$('timeline')?.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){const rt=e.target?.closest?.('[data-reading-node]');if(rt){e.preventDefault();run(()=>selectReadingNode(rt.dataset.readingNode));return;}const t=e.target?.closest?.('[data-node]');if(t){e.preventDefault();run(()=>selectNode(t.dataset.node));}}});
for(const [id,value]of [['graph-win','win'],['graph-score','score']])$(id)?.addEventListener('click',()=>{graphMode=value;$('graph-win')?.classList.toggle('active',value==='win');$('graph-score')?.classList.toggle('active',value==='score');renderTimeline();});
$('pv-import')?.addEventListener('click',()=>run(importPV));$('preview-exit')?.addEventListener('click',()=>{preview=null;renderBoard();if(!analyzing)schedule();});
$('notes')?.addEventListener('input',()=>{if(isReading())return;const had=Boolean((active().notes||'').trim());active().notes=$('notes').value;save();if(had!==Boolean(active().notes.trim()))renderTimeline();else renderMemos();});$('title')?.addEventListener('input',()=>{doc.title=$('title').value;save();});
$('new-button')?.addEventListener('click',()=>run(showNew));$('new-close')?.addEventListener('click',()=>$('new-dialog')?.close());$('neutral-setup')?.addEventListener('change',()=>{$('neutral-coordinates').hidden=$('neutral-setup').value!=='custom';});
$('new-form')?.addEventListener('submit',e=>{e.preventDefault();run(()=>createGame({neutral:$('neutral-setup').value==='none'?null:$('neutral-setup').value==='center'?[4,4]:[Number($('neutral-row').value)-1,Number($('neutral-col').value)-1],komi:Number($('komi').value)}));});
$('export-button')?.addEventListener('click',()=>{if(!doc)return;saveNow();const url=URL.createObjectURL(new Blob([JSON.stringify(studyForSave(doc),null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${doc.title.replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,60)||'great-kingdom'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('import-button')?.addEventListener('click',()=>$('import-file')?.click());$('import-file')?.addEventListener('change',e=>run(async()=>{const f=e.target.files[0];if(!f)return;if(f.size>2*1024*1024)throw Error('최대 2MB 기보를 지원합니다.');await loadStudy(JSON.parse(await f.text()));e.target.value='';}));
window.addEventListener('pagehide',()=>{saveNow();cancel();});document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)||document.querySelector('dialog[open]'))return;if(e.key==='ArrowLeft'){if(isReading())readingPrev();else $('previous')?.click();e.preventDefault();}if(e.key==='ArrowRight'){if(isReading())readingNext();else $('next')?.click();e.preventDefault();}});

run(async()=>{
 loadSettings();
 applyTheme();
 config=staticOnly?await loadStaticConfig():await api('config');
 populateModels();
 if($('backend')){
  if(staticOnly){
   $('backend').replaceChildren(new Option('이 기기 · WebGPU / WASM','local'));
   $('backend').value='local';
   $('backend').disabled=true;
  }
 }
 if(staticOnly){
  local=new LocalEngine();
  if($('connection'))$('connection').textContent='기기 내 규칙 엔진 준비 중';
 }else if($('connection'))$('connection').textContent=`Mac ${config?.device?.toUpperCase?.()||'CPU'} 연결됨`;
 const setup={neutral:[4,4],komi:2.5},p=await position({setup,actions:[]});
 doc={...newStudy(setup,p),storage_id:crypto.randomUUID(),model_id:config?.models?.[0]?.id||null};
 populateModels();
 let saved;try{saved=library()[0];}catch(e){notice(e.message,true);}
 if(saved){try{await loadStudy(saved,{initializeModel:!staticOnly,preserveCurrent:false});}catch(e){notice(`저장 기보를 복원하지 못했어요: ${e.message}`,true);render();}}
 else {render();save();}
 if(staticOnly)await setupBackend();
});
