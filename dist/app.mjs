import {newStudy,addNode,pathTo,lineThrough,importDocument,redEvaluation,studyForSave} from './study.mjs';
import {boardSvg} from './board.mjs';
import {STORE,persistStudy,retryAnalysis} from './client.mjs';
import {PracticeControls,missingNodes} from './controls.mjs';
import {timelineSvg} from './timeline.mjs';
import {LocalEngine} from './local-client.mjs';
import {loadStaticConfig,loadStaticManifest} from './deployment.mjs?v=2';
const staticOnly=document.documentElement?.dataset?.execution==='local';

const $=id=>document.getElementById(id),controls=new PracticeControls(),shown=new Map();
let lastPaint=0;
let doc=null,config=null,analyzing=false,moving=false,analysisController=null,preview=null,graphMode='win',saveTimer=null,local=null,localModel=null,batching=false,backendReady=true;
const active=()=>doc?.nodes.find(n=>n.id===doc.selected),backend=()=>$('backend').value;
const modelAvailable=()=>backendReady&&Boolean(config?.models.some(m=>m.id===doc?.model_id))&&(backend()==='host'||localModel===doc?.model_id);
const nodeAnalysis=n=>n?.analysis&&n.analysis.backend===backend()&&(!n.analysis.model||n.analysis.model.id===doc.model_id)?n.analysis:null;
const displayAnalysis=n=>{const a=shown.get(n.id);return controls.visible&&a&&a.backend===backend()&&(!a.model||a.model.id===doc.model_id)?a:null;};
const visibleAnalysis=()=>displayAnalysis(active());
const coord=a=>a===81?'패스':`${Math.floor(a/9)+1}·${a%9+1}`;
const pct=v=>typeof v==='number'?`${(v*100).toFixed(1)}%`:'—';
const signed=v=>typeof v==='number'?`${v>0?'+':''}${v.toFixed(1)}`:'—';
const sourceLabel=s=>({network:'모델 원평가',mcts:'MCTS 탐색',tactical:'전술 증명',rule:'규칙 판정'}[s]||'분석 전');
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=!message;}
async function api(path,payload,signal){if(staticOnly)throw Error('이 배포본은 모든 대국과 분석을 기기에서 실행합니다.');const response=await fetch(`/api/v1/${path}`,payload===undefined?{signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'실행부 요청 실패'),{status:response.status});return data;}
function library(){const v=JSON.parse(localStorage.getItem(STORE)||'[]');if(!Array.isArray(v))throw Error('저장 목록을 읽을 수 없어요.');return v;}
function saveNow(){if(!doc)return true;try{persistStudy(localStorage,doc);$('save-state').textContent='기기에 저장됨';return true;}catch{notice('자동 저장 실패 · 내보내기로 기보를 보관해 주세요.',true);$('save-state').textContent='저장 실패';return false;}}
function save(){clearTimeout(saveTimer);$('save-state').textContent='저장 중';saveTimer=setTimeout(saveNow,200);}
function cancel(){controls.invalidate();analysisController?.abort();analysisController=null;local?.cancel();analyzing=false;batching=false;moving=false;preview=null;}
function positionRequest(node=active()){return {ruleset_version:doc.ruleset_version,setup:doc.setup,actions:pathTo(doc,node.id)};}
async function position(payload){if(backend()==='local'){if(!local)throw Error('기기 내 엔진을 먼저 준비해 주세요.');return local.position(payload);}return api('position',payload);}
function capture(){for(const n of doc.nodes){const a=nodeAnalysis(n);if(a)shown.set(n.id,a);}}

async function streamHost(payload,onUpdate,signal){
 const response=await fetch('/api/v1/analyze-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});
 if(!response.ok){const error=await response.json();throw Object.assign(Error(error.error||'분석 실패'),{status:response.status});}
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',last=null;
 try{while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim()){last=JSON.parse(line);if(last.error)throw Error(last.error);onUpdate(last);}}if(done)break;}
 if(buffer.trim()){last=JSON.parse(buffer);onUpdate(last);}if(!last?.done)throw Error('분석 연결이 끝났어요. 다시 분석을 시작해 주세요.');return last;
 }finally{await reader.cancel().catch(()=>{});}
}
async function search(node,{continuous=false,seconds=2,visits=1600,onUpdate=()=>{},signal}={}){
 const payload={...positionRequest(node),model_id:doc.model_id,visits,seconds,continuous};
 return retryAnalysis(()=>backend()==='local'?local.analyze(payload,onUpdate,{signal,continuous}):streamHost(payload,onUpdate,signal),signal);
}
function acceptResult(result,node,model,execution){if(result.state_id!==node.position.state_id)throw Error('국면 해시가 일치하지 않습니다.');if(result.model&&result.model.id!==model)throw Error('선택 모델과 분석 모델이 다릅니다.');node.analysis={...result,provider:result.execution==='browser'?result.backend:null,backend:execution};if(execution==='local'&&result.backend)$('runtime-note').textContent=`이 기기에서 계산 · ${result.backend} · 서버 추론 없음`;if(controls.autoVisual)shown.set(node.id,node.analysis);}
async function startAnalysis({ai=false}={}){
 if(!active()||moving||batching||!modelAvailable())return;
 cancel();const node=active(),study=doc,model=doc.model_id,execution=backend(),token=controls.begin(node.id,model,execution),controller=new AbortController();analysisController=controller;analyzing=true;render();
 const valid=()=>study===doc&&controls.accepts(token,doc.selected,doc.model_id,backend());let result;
 try{result=await search(node,{continuous:!ai,seconds:Number($('ai-seconds').value),visits:ai?1600:1600,signal:controller.signal,onUpdate:r=>{if(valid()){acceptResult(r,node,model,execution);if(r.done||Date.now()-lastPaint>=180){lastPaint=Date.now();render();}}}});
 if(!valid())return;acceptResult(result,node,model,execution);notice('');
 }catch(error){if(error.name!=='AbortError'&&valid())notice(error.message,true);return;}
 finally{if(valid()){analyzing=false;analysisController=null;render();}}
 if(ai&&valid()&&controls.aiTurn(node.position)&&result?.recommended_action!==null){await place(result.recommended_action,true);}
}
function schedule(){if(!active())return;if(active().position.result){controls.playing=false;render();return;}if(controls.aiTurn(active().position))queueMicrotask(()=>run(()=>startAnalysis({ai:true})));else if(controls.autoAnalysis)queueMicrotask(()=>run(()=>startAnalysis()));}
async function selectNode(id){cancel();controls.playing=false;doc.selected=id;if(controls.autoVisual){const a=nodeAnalysis(active());if(a)shown.set(id,a);}save();render();schedule();}
async function place(action,fromAI=false){
 const node=active();if(moving||preview||node.position.result)return;
 if(!fromAI&&controls.aiTurn(node.position))return notice('AI 차례입니다. AI 대국을 중지하면 직접 둘 수 있어요.');
 if(!node.position.legal_actions.includes(action))return notice('그 칸에는 둘 수 없어요.',true);
 cancel();const token=controls.epoch,study=doc;moving=true;render();
 try{const next=await position({...positionRequest(node),actions:[...pathTo(doc,node.id),action]});if(study!==doc||token!==controls.epoch)return;addNode(doc,node.id,action,next);save();notice('');}
 finally{if(token===controls.epoch){moving=false;render();}}
 if(token===controls.epoch)schedule();
}
function renderBoard(){
 const node=active(),p=preview?.position||node.position;
 $('board').innerHTML=boardSvg(p,{actions:[...pathTo(doc,node.id),...(preview?.actions||[])],lastAction:preview?.actions.at(-1)??node.action,analysis:preview?null:visibleAnalysis(),showTerritory:$('territory-toggle').checked,showOwnership:$('ownership-toggle').checked,showCandidates:controls.visible&&!preview,showNumbers:$('numbers-toggle').checked});
 $('board').setAttribute('aria-busy',String(moving));$('red-score').innerHTML=`${p.score.red}<small>영토</small>`;$('blue-score').innerHTML=`${p.score.blue}<small>영토</small>`;
 $('red-player').textContent=['first','both'].includes(controls.ai)?'AI':'사람';$('blue-player').textContent=['second','both'].includes(controls.ai)?'AI':'사람';
 $('turn-dot').className=`turn-dot ${p.side_to_move==='first'?'red':'blue'}`;
 $('turn-label').textContent=preview?`예상 수순 ${preview.actions.length}수`:p.result?`${p.result.winner==='first'?'빨간':'파란'} 성 승리 · ${p.result.reason==='siege'?'포위':'영토 점수'}`:`${p.side_to_move==='first'?'빨간':'파란'} 성 차례${controls.aiTurn(p)?' · AI 생각 중':''}`;
 $('ply-label').textContent=`${node.ply}수째`;$('nav-label').textContent=`${node.ply}수`;
 $('first').disabled=$('previous').disabled=node.parent===null;$('next').disabled=$('last').disabled=!doc.nodes.some(n=>n.parent===node.id);
 $('pass').disabled=Boolean(p.result||preview||moving||controls.aiTurn(p)||(backend()==='local'&&!local));$('preview-exit').hidden=!preview;$('preview-label').hidden=!$('ownership-toggle').checked;
}
function renderAnalysis() {
  const analysis=visibleAnalysis(),values=redEvaluation(analysis,doc.setup.komi);
  $('analysis-source').textContent=analysis?sourceLabel(analysis.source):'분석 전';
  $('win-value').textContent=pct(values.win);
  $('red-percent').textContent=pct(values.win);
  $('blue-percent').textContent=pct(values.win===null?null:1-values.win);
  $('win-fill').style.width=values.win===null?'0%':`${values.win*100}%`;
  $('margin-caption').textContent=analysis?.source==='rule'?'종국 영토 차이':'예상 점수 차이';
  $('margin-value').textContent=values.margin===null?'—':`${signed(values.margin)}집`;
  $('visits-value').textContent=analysis?analysis.mcts.root_visits.toLocaleString():'—';
  $('raw-value').textContent=analysis?.source==='rule'?'규칙 판정 · 종국의 실제 영토 차이 · 포위 승패는 집수와 별도':analysis?`모델 원평가 ${pct(values.rawWin)} · 점수 차이는 원평가에 덤 반영`:'모델 원평가와 탐색 결과를 구분해서 보여줘요.';

  const candidates=analysis?.mcts.candidates.slice(0,6)||[];
  $('candidate-count').textContent=candidates.length?`${analysis.mcts.candidates.length}개 후보`:'상위 후보';
  $('candidates').replaceChildren();
  if(!candidates.length) {
    const p=document.createElement('p');p.className='empty-state';
    p.textContent=active().position.result?'대국이 종료되었어요. 이전 수로 돌아가 새 가지를 만들어 보세요.':!doc.model_id?'모델이 연결되지 않았어요. 양쪽 성을 직접 두며 국면을 살펴볼 수 있어요.':!controls.visible?'힌트를 숨겼어요. 내 판단으로 한 수를 두어 보세요.':'분석하면 후보수가 여기에 나타나요.';
    $('candidates').append(p);
  }
  candidates.forEach((candidate,i)=>{
    const button=document.createElement('button');button.className='candidate-row';
    const probability=candidate.win_probability===null?null:analysis.perspective==='first'?candidate.win_probability:1-candidate.win_probability;
    button.innerHTML=`<span><span class="candidate-rank">${i+1}</span><span class="candidate-coordinate">${coord(candidate.action)}<small>모델 선호도 ${pct(analysis.raw_network?.policy[candidate.action])}</small></span></span><span>${pct(candidate.visit_share)}<small>${candidate.visits} visits</small></span><span>${pct(probability)}<small>Q ${signed(candidate.q===null?null:(analysis.perspective==='first'?1:-1)*candidate.q)} · 덤 전 ${signed(candidate.expected_score===null?null:(analysis.perspective==='first'?1:-1)*candidate.expected_score)}집</small></span>`;
    button.addEventListener('click',()=>{controls.playing=false;run(()=>place(candidate.action));});$('candidates').append(button);
  });
  const pv=analysis?.mcts.principal_variation||[];$('pv').replaceChildren();
  if(!pv.length){const span=document.createElement('span');span.className='muted';span.textContent=analysis?'이 국면의 예상 수순이 없어요.':'분석 후 확인할 수 있어요.';$('pv').append(span);}
  pv.slice(0,16).forEach((action,i)=>{
    const button=document.createElement('button');
    const red=(analysis.perspective==='first')===(i%2===0);
    button.innerHTML=`<i class="castle-mini ${red?'red':'blue'}"></i>${coord(action)}`;
    button.setAttribute('aria-label',`예상 ${i+1}수까지 보기`);
    button.addEventListener('click',()=>run(()=>previewPV(i+1)));
    $('pv').append(button);
  });
  $('pv-import').disabled=!pv.length||moving;
  if(analysis){
    const model=analysis.model;
    const text=[`출처: ${sourceLabel(analysis.source)}`,`모델 원승률: ${pct(values.rawWin)}`,`예상 영토 차이(덤 전): ${signed(values.rawScore)}`,`탐색 시간: ${(analysis.cumulative_elapsed_seconds??analysis.mcts.elapsed_seconds).toFixed(3)}초`,
      `모델 SHA: ${model?.sha256?.slice(0,16)||'규칙 판정'}`,`국면: ${analysis.state_id.slice(0,16)}`,`실행: ${analysis.provider||analysis.execution||analysis.backend} · 규칙 ${analysis.position.ruleset_version}`,`전술 상태: ${analysis.exact?.status||'없음'} · 위협 ${(analysis.exact?.threats||[]).map(coord).join(', ')||'없음'}`,`정책 엔트로피: ${(-(analysis.raw_network?.policy||[]).reduce((sum,p)=>sum+(p>0?p*Math.log(p):0),0)).toFixed(3)}`,
      ...(analysis.proven_winner?[`증명된 승자: ${analysis.proven_winner==='first'?'빨간 성':'파란 성'}`]:[])];
    $('more-metrics').replaceChildren(...text.map(t=>{const div=document.createElement('div');div.textContent=t;return div;}));
    const dist=analysis.raw_network?.score_distribution||[],max=Math.max(...dist,0.00001),step=300/Math.max(dist.length,1);
    $('score-distribution').innerHTML=dist.length?`<svg class="distribution-svg" viewBox="0 0 300 50" role="img" aria-label="현재 둘 차례 관점의 예상 영토 차이 분포">${dist.map((p,i)=>`<rect x="${i*step}" y="${48-p/max*42}" width="${Math.max(.3,step*.85)}" height="${p/max*42}" fill="#809caa"/>`).join('')}</svg>`:'';
  }else{$('more-metrics').textContent='분석 전';$('score-distribution').replaceChildren();}
}


function renderTimeline(){const viewport=$('timeline'),left=viewport.scrollLeft;viewport.innerHTML=timelineSvg(doc,displayAnalysis,graphMode);viewport.scrollLeft=left;}
function render(){if(!active()?.position)return;
 if(document.activeElement!==$('title'))$('title').value=doc.title;if(document.activeElement!==$('notes'))$('notes').value=active().notes||'';
 $('setup-label').textContent=doc.setup.neutral===null?'중립 성 없음':`중립 성 ${doc.setup.neutral.map(n=>n+1).join('·')}`;$('komi-label').textContent=`덤 ${doc.setup.komi}`;
 for(const [id,on] of [['auto-analysis',controls.autoAnalysis],['visualize',controls.visible],['auto-visual',controls.autoVisual]]){$(id).classList.toggle('active',on);$(id).setAttribute('aria-pressed',String(on));}
 $('analyze-button').textContent=analyzing?'분석 중지':'분석';$('analyze-button').disabled=moving||batching||!modelAvailable();
 $('ai-play').textContent=controls.playing?'AI 대국 중지':'AI 대국 시작';$('ai-play').disabled=controls.ai==='none'||!modelAvailable()||batching||Boolean(active().position.result);
 $('batch-start').textContent=batching?'일괄 계산 중지':'미분석 구간 계산';$('batch-start').disabled=!modelAvailable()||moving;
 const a=nodeAnalysis(active());$('search-status').textContent=`${batching?'일괄 계산 중':analyzing?'탐색 중':a?'탐색 대기':'대기 중'} · ${(a?.mcts.root_visits||0).toLocaleString()} visits${a?` · ${(a.cumulative_elapsed_seconds??a.mcts.elapsed_seconds).toFixed(1)}초`:''}${controls.visible?(controls.autoVisual?' · 실시간 표시':' · 시각화 고정'):' · 시각화 꺼짐'}`;
 renderBoard();renderAnalysis();renderTimeline();
}
async function previewPV(count){const a=visibleAnalysis();if(!a||moving)return;const epoch=controls.epoch,node=active(),actions=a.mcts.principal_variation.slice(0,count),p=await position({...positionRequest(),actions:[...pathTo(doc,node.id),...actions]});if(epoch!==controls.epoch)return;preview={position:p,actions};renderBoard();}
async function importPV(){const actions=visibleAnalysis()?.mcts.principal_variation.slice(0,16)||[];if(!actions.length)return;cancel();controls.playing=false;const epoch=controls.epoch;moving=true;try{for(const a of actions){const p=await position({...positionRequest(),actions:[...pathTo(doc,doc.selected),a]});if(epoch!==controls.epoch)return;addNode(doc,doc.selected,a,p);}save();}finally{if(epoch===controls.epoch){moving=false;render();schedule();}}}
function populateModels(){const select=$('model-select');select.replaceChildren();for(const m of config.models){const o=new Option(m.label,m.id);select.append(o);}if(!config.models.length)select.append(new Option('연결된 모델 없음',''));if(doc.model_id&&!config.models.some(m=>m.id===doc.model_id))select.append(new Option('저장된 모델 · 사용 불가',doc.model_id));select.value=doc.model_id||'';$('model-detail').textContent=doc.model_id?`선택 모델 SHA ${doc.model_id.slice(0,16)} · 기보 중 자동 교체 없음`:'모델을 연결해 주세요.';}
async function setupBackend(){
 cancel();controls.playing=false;backendReady=false;const requested=backend(),model=doc.model_id;render();
 try{if(requested==='local'){
 if(globalThis.isSecureContext===false)throw Error('기기 내 추론은 HTTPS 주소로 접속해 주세요. IP의 HTTP 주소에서는 Mac 계산을 사용할 수 있어요.');
 if(!config.browser_models?.includes(model))throw Error('이 모델의 브라우저 실행 파일이 준비되지 않았어요. 사용법의 준비 명령을 실행해 주세요.');
 $('runtime-note').textContent='모델을 이 기기에 불러오는 중…';local?.close();local=new LocalEngine();localModel=null;const current=local,manifest=staticOnly?await loadStaticManifest(config,model):await api(`browser-model/${model}`),status=await current.initialize(manifest,progress=>{if(local!==current)return;$('runtime-note').textContent=({runtime:'실행 파일을 불러오는 중…',model:'모델을 기기에 내려받는 중…',session:'기기에서 모델을 준비하는 중…'}[progress.stage]||'기기 내 엔진 준비 중…');});
 if(requested!==backend()||model!==doc.model_id||local!==current)return;
 localModel=model;$('runtime-note').textContent=`이 기기에서 계산 · ${status.execution_provider||status.backend||status.provider||'WebGPU / WASM'} · 서버 추론 없음`;
 }else{$('runtime-note').textContent='연결된 Mac에서 계산';local?.close();local=null;localModel=null;}
 backendReady=true;$('connection').textContent=requested==='local'?'기기 내 엔진 준비됨':`Mac ${config.device.toUpperCase()} 연결됨`;notice('');render();schedule();
 }catch(e){if(requested===backend()&&model===doc.model_id){backendReady=false;$('connection').textContent='실행부 준비 실패';notice(e.message,true);render();}}
}
async function rebuildStudy(imported){if(backend()==='host')return api('validate-study',studyForSave(imported));const nodes=[];for(const n of imported.nodes){const p=await position({ruleset_version:imported.ruleset_version,setup:imported.setup,actions:pathTo(imported,n.id)});nodes.push({...n,ply:n.parent===null?0:nodes.find(p=>p.id===n.parent).ply+1,position:p,analysis:null});}return {...imported,nodes};}
async function loadStudy(value,{initializeModel=true,preserveCurrent=true}={}){const imported=importDocument(value);clearTimeout(saveTimer);if(preserveCurrent&&!saveNow())throw Error('현재 기보를 내보내기로 보관해 주세요.');cancel();controls.playing=false;const epoch=controls.epoch,rebuilt=await rebuildStudy(imported);if(epoch!==controls.epoch)return;doc={...rebuilt,storage_id:value.storage_id||crypto.randomUUID()};shown.clear();populateModels();render();save();if(initializeModel&&backend()==='local'&&localModel!==doc.model_id)await setupBackend();else if(initializeModel)schedule();}
async function createGame(setup){cancel();controls.playing=false;const epoch=controls.epoch,p=await position({setup,actions:[]});if(epoch!==controls.epoch)return;clearTimeout(saveTimer);if(!saveNow())throw Error('현재 기보를 먼저 보관해 주세요.');const model=doc.model_id;doc={...newStudy(setup,p),storage_id:crypto.randomUUID(),model_id:model};doc.title=`${new Date().toLocaleDateString('ko-KR',{month:'long',day:'numeric'})}의 연습`;shown.clear();populateModels();save();render();$('new-dialog').close();schedule();}
function showNew(){$('recent-studies').replaceChildren();for(const entry of library()){const b=document.createElement('button');b.type='button';b.textContent=`${entry.title||'이름 없는 연습'} · ${entry.nodes.length}개 국면`;b.addEventListener('click',()=>run(async()=>{await loadStudy(entry);$('new-dialog').close();}));$('recent-studies').append(b);}$('new-dialog').showModal();}
async function batch(){if(batching){cancel();render();return;}if(!modelAvailable())return;
 cancel();controls.playing=false;const nodes=missingNodes(doc,$('batch-scope').value,backend()),study=doc,model=doc.model_id,execution=backend(),epoch=controls.epoch,controller=new AbortController();analysisController=controller;batching=true;controls.visible=true;capture();let completed=0;const seconds=Number($('batch-seconds').value),visits=Number($('batch-visits').value);if(!Number.isInteger(visits)||visits<1||visits>1600){cancel();throw Error('방문수는 1~1600 정수로 정해 주세요.');}render();
 try{for(const n of nodes){if(controller.signal.aborted||study!==doc||epoch!==controls.epoch)break;$('batch-status').textContent=`${completed}/${nodes.length} · ${n.ply}수 계산 중`;
 const a=await search(n,{seconds,visits,signal:controller.signal});if(study!==doc||epoch!==controls.epoch)break;acceptResult(a,n,model,execution);shown.set(n.id,n.analysis);completed++;renderTimeline();}
 }finally{if(epoch===controls.epoch){batching=false;analysisController=null;$('batch-status').textContent=`${completed}/${nodes.length} 국면 완료`;render();}}
}
async function run(fn){try{await fn();}catch(e){if(e.name!=='AbortError')notice(e.message||'작업 실패',true);}}
$('board').addEventListener('click',e=>{const t=e.target.closest('[data-action]');if(t)run(()=>place(Number(t.dataset.action)));});
$('board').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){const t=e.target.closest('[data-action]');if(t){e.preventDefault();run(()=>place(Number(t.dataset.action)));}}});
for(const id of ['territory-toggle','ownership-toggle','numbers-toggle'])$(id).addEventListener('change',render);
$('analyze-button').addEventListener('click',()=>{if(analyzing){cancel();render();}else run(()=>startAnalysis());});
$('auto-analysis').addEventListener('click',()=>{controls.autoAnalysis=!controls.autoAnalysis;if(!controls.autoAnalysis&&!controls.aiTurn(active().position))cancel();render();if(controls.autoAnalysis&&!analyzing)schedule();});
$('visualize').addEventListener('click',()=>{controls.visualize();if(controls.visible)capture();render();});
$('auto-visual').addEventListener('click',()=>{controls.autoVisual=!controls.autoVisual;controls.visible=controls.autoVisual;if(controls.visible)capture();render();});
$('ai-color').addEventListener('change',()=>{cancel();controls.ai=$('ai-color').value;controls.playing=false;render();schedule();});
$('ai-seconds').addEventListener('change',()=>{cancel();render();schedule();});
$('ai-play').addEventListener('click',()=>{const next=!controls.playing;cancel();controls.playing=next;render();schedule();});
$('backend').addEventListener('change',()=>run(setupBackend));
$('model-select').addEventListener('change',()=>{cancel();controls.playing=false;doc.model_id=$('model-select').value||null;populateModels();save();render();run(setupBackend);});
$('first').addEventListener('click',()=>run(()=>selectNode(doc.nodes[0].id)));$('previous').addEventListener('click',()=>{if(active().parent)run(()=>selectNode(active().parent));});$('next').addEventListener('click',()=>{const n=doc.nodes.find(n=>n.parent===doc.selected);if(n)run(()=>selectNode(n.id));});$('last').addEventListener('click',()=>{const n=lineThrough(doc,doc.selected).at(-1);run(()=>selectNode(n.id));});$('pass').addEventListener('click',()=>run(()=>place(81)));
$('timeline').addEventListener('click',e=>{const t=e.target.closest('[data-node]');if(t)run(()=>selectNode(t.dataset.node));});$('timeline').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){const t=e.target.closest('[data-node]');if(t){e.preventDefault();run(()=>selectNode(t.dataset.node));}}});
for(const [id,value]of [['graph-win','win'],['graph-score','score']])$(id).addEventListener('click',()=>{graphMode=value;$('graph-win').classList.toggle('active',value==='win');$('graph-score').classList.toggle('active',value==='score');renderTimeline();});
$('batch-start').addEventListener('click',()=>run(batch));$('pv-import').addEventListener('click',()=>run(importPV));$('preview-exit').addEventListener('click',()=>{preview=null;renderBoard();});
$('notes').addEventListener('input',()=>{active().notes=$('notes').value;save();});$('title').addEventListener('input',()=>{doc.title=$('title').value;save();});
$('new-button').addEventListener('click',()=>run(showNew));$('new-close').addEventListener('click',()=>$('new-dialog').close());$('neutral-setup').addEventListener('change',()=>{$('neutral-coordinates').hidden=$('neutral-setup').value!=='custom';});
$('new-form').addEventListener('submit',e=>{e.preventDefault();run(()=>createGame({neutral:$('neutral-setup').value==='none'?null:$('neutral-setup').value==='center'?[4,4]:[Number($('neutral-row').value)-1,Number($('neutral-col').value)-1],komi:Number($('komi').value)}));});
$('export-button').addEventListener('click',()=>{if(!doc)return;saveNow();const url=URL.createObjectURL(new Blob([JSON.stringify(studyForSave(doc),null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${doc.title.replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,60)||'great-kingdom'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('import-button').addEventListener('click',()=>$('import-file').click());$('import-file').addEventListener('change',e=>run(async()=>{const f=e.target.files[0];if(!f)return;if(f.size>2*1024*1024)throw Error('최대 2MB 기보를 지원합니다.');await loadStudy(JSON.parse(await f.text()));e.target.value='';}));
window.addEventListener('pagehide',()=>{saveNow();cancel();});document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)||document.querySelector('dialog[open]'))return;if(e.key==='ArrowLeft'){$('previous').click();e.preventDefault();}if(e.key==='ArrowRight'){$('next').click();e.preventDefault();}});
run(async()=>{
 config=staticOnly?await loadStaticConfig():await api('config');
 if(staticOnly){
  $('backend').replaceChildren(new Option('이 기기 · WebGPU / WASM','local'));$('backend').value='local';$('backend').disabled=true;
  local=new LocalEngine();$('connection').textContent='기기 내 규칙 엔진 준비 중';
 }else $('connection').textContent=`Mac ${config.device.toUpperCase()} 연결됨`;
 const setup={neutral:[4,4],komi:2.5},p=await position({setup,actions:[]});
 doc={...newStudy(setup,p),storage_id:crypto.randomUUID(),model_id:config.models[0]?.id||null};populateModels();
 let saved;try{saved=library()[0];}catch(e){notice(e.message,true);}
 if(saved){try{await loadStudy(saved,{initializeModel:!staticOnly,preserveCurrent:false});}catch(e){notice(`저장 기보를 복원하지 못했어요: ${e.message}`,true);render();}}
 else {render();save();}
 if(staticOnly)await setupBackend();
});
