import {RULESET,features,positionPayload,replayPosition,canonicalState} from './engine.mjs';
import {BrowserSearch} from './browser-search.mjs';
import {decodeNetworkHeads} from './local-client.mjs';

let ort=null,session=null,manifest=null,backend=null,generation=0;
const reply=(id,type,value)=>postMessage({id,type,value});
const errorText=e=>String(e?.message||e||'Browser model runtime failed');
const sha256=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');

async function cachedModel(url,expectedHash){
  const request=new Request(`${url}?sha256=${expectedHash}`),cache=globalThis.caches?await caches.open('gk-practice-onnx-v1'):null;
  let response=cache?await cache.match(request):null;
  if(response){const bytes=await response.clone().arrayBuffer();if(await sha256(bytes)!==expectedHash){await cache.delete(request);response=null;}}
  if(!response){response=await fetch(url,{cache:'no-cache',credentials:'same-origin'});if(!response.ok)throw Error(`ONNX model download failed (${response.status})`);const bytes=await response.clone().arrayBuffer();if(await sha256(bytes)!==expectedHash)throw Error('ONNX export SHA-256 does not match its manifest');if(cache)await cache.put(request,response.clone());}
  return response.arrayBuffer();
}

async function fallbackToWasm(){
  if(backend==='wasm')throw Error('WASM inference failed after WebGPU fallback');
  await session?.release?.();
  session=await ort.InferenceSession.create(await cachedModel(manifest.model_url,manifest.onnx_sha256),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  backend='wasm';
}

async function initialize(value,id){
  if(!value||value.ruleset_version!==RULESET||value.feature_schema!=='spatial12-global3-v2'||value.runtime_version!=='1.23.2'||value.model_id!==value.sha256)throw Error('Browser model manifest does not match this ruleset, feature schema, runtime or model identity');
  if(!/^[a-f0-9]{64}$/.test(value.sha256)||!/^[a-f0-9]{64}$/.test(value.onnx_sha256)||value.assets?.model!==value.model_url)throw Error('Browser model manifest identity is incomplete');
  if(!Array.isArray(value.input_names)||value.input_names.join(',')!=='spatial,global_features'||!Array.isArray(value.output_names)||value.output_names.join(',')!=='policy_logits,value_logit,score_logits,ownership_logits')throw Error('Unsupported ONNX tensor contract');
  const shapes=value.shapes||{};
  if(JSON.stringify(shapes.spatial)!=='[12,9,9]'||JSON.stringify(shapes.global_features)!=='[3]'||JSON.stringify(shapes.policy_logits)!=='[82]'||JSON.stringify(shapes.value_logit)!=='[1]'||JSON.stringify(shapes.ownership_logits)!=='[3,81]'||!Array.isArray(shapes.score_logits)||shapes.score_logits.length!==1||shapes.score_logits[0]<2)throw Error('ONNX tensor dimensions do not match the practice model contract');
  const response=await fetch(value.assets.runtime_module,{cache:'no-cache',credentials:'same-origin'});if(!response.ok)throw Error(`ONNX Runtime Web failed to load (${response.status})`);
  const mod=await import(value.assets.runtime_module);ort=mod.default||mod;
  ort.env.wasm.wasmPaths=new URL('./',new URL(value.assets.wasm,self.location.href)).href;
  ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
  manifest=value;reply(id,'update',{stage:'model',status:'loading'});const modelBytes=await cachedModel(value.model_url,value.onnx_sha256);
  reply(id,'update',{stage:'session',status:'initializing'});
  let webgpuError;
  try { session=await ort.InferenceSession.create(modelBytes,{executionProviders:['webgpu'],graphOptimizationLevel:'all'});backend='webgpu'; }
  catch (error) {
    webgpuError=error;
    try { session=await ort.InferenceSession.create(modelBytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});backend='wasm'; }
    catch (wasmError) { throw Error(`WebGPU initialization failed: ${errorText(webgpuError)}; WASM initialization failed: ${errorText(wasmError)}`); }
  }
  if(session.inputNames.join(',')!==value.input_names.join(',')||session.outputNames.join(',')!==value.output_names.join(','))throw Error('ONNX session names do not match the verified manifest');
  return {model_id:value.model_id,sha256:value.sha256,onnx_sha256:value.onnx_sha256,backend,
    message:backend==='webgpu'?'Browser local model ready · WebGPU':'Browser local model ready · WASM fallback'};
}

function tensor(array,dims){return new ort.Tensor('float32',array,dims);}
async function infer(state){
  const f=features(state),feeds={spatial:tensor(f.spatial,[1,12,9,9]),global_features:tensor(f.global_features,[1,3])};let out;
  try{out=await session.run(feeds);}catch(error){if(backend!=='webgpu')throw error;await fallbackToWasm();out=await session.run(feeds);}
  if(out.policy_logits.data.length!==82||out.value_logit.data.length!==1||out.score_logits.data.length!==manifest.shapes.score_logits[0]||out.ownership_logits.data.length!==243)throw Error('ONNX session returned unexpected output dimensions');
  if(![out.policy_logits.data,out.value_logit.data,out.score_logits.data,out.ownership_logits.data].every(values=>Array.from(values).every(Number.isFinite)))throw Error('ONNX session returned a non-finite model output');
  return decodeNetworkHeads({policy_logits:out.policy_logits.data,value_logit:out.value_logit.data,
    score_logits:out.score_logits.data,ownership_logits:out.ownership_logits.data},
    {legalActions:positionPayload(state).legal_actions,scoreMin:manifest.score_min});
}

async function position(payload){
  const state=replayPosition(payload),canonical=canonicalState(state),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  return {...positionPayload(state),state_id:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')};
}

async function analyze(id,payload,options,runGeneration){
  const streamStartedAt=performance.now(),state=replayPosition(payload),pos=await position(payload),visits=payload.visits??160,seconds=payload.seconds??2;
  if(!Number.isInteger(visits)||visits<1||visits>1600||!Number.isFinite(seconds)||seconds<.05||seconds>10)throw Error('Analysis budget is outside the supported range');
  const continuous=payload.continuous??options.continuous??false;
  if(typeof continuous!=='boolean')throw Error('continuous must be a boolean');
  let maxVisits=visits,maxSeconds=null;
  if(continuous){maxVisits=payload.max_visits??10_000_000;if(!Number.isInteger(maxVisits)||maxVisits<1||maxVisits>10_000_000)throw Error('Continuous visit limit must be 1–10,000,000 visits');
    // Optional wall-clock cap for continuous analysis and timed AI moves.
    if(payload.max_seconds!==undefined&&payload.max_seconds!==null){maxSeconds=payload.max_seconds;if(typeof maxSeconds!=='number'||!Number.isFinite(maxSeconds)||maxSeconds<.05||maxSeconds>3600)throw Error('Continuous time limit must be 0.05–3600 seconds');}}
  else if(Object.hasOwn(payload,'max_visits')||Object.hasOwn(payload,'max_seconds'))throw Error('max_visits/max_seconds are only valid for continuous analysis');
  const base=()=>({api_version:1,state_id:pos.state_id,position:pos,perspective:state.side_to_move,score_kind:'raw_territory_difference',budget:{visits,seconds},model:{id:manifest.model_id,sha256:manifest.sha256,label:manifest.source_model_label,feature_schema:manifest.feature_schema,ruleset_version:manifest.ruleset_version,score_min:manifest.score_min},execution:'browser',backend});
  if(state.result)return {...base(),source:'rule',raw_network:null,exact:{source:'rule',proven_winner:state.result.winner,status:'terminal',threats:[]},proven_winner:state.result.winner,recommended_action:null,mcts:{root_visits:0,root_win_probability:state.result.winner===state.side_to_move?1:0,candidates:[],principal_variation:[],elapsed_seconds:0},done:true,cumulative_elapsed_seconds:(performance.now()-streamStartedAt)/1000};
  // Keep the four raw heads available even when tactics bypass neural expansion.
  // BrowserSearch consumes this cached result for its root expansion.
  const raw=await infer(state),searchStartedAt=performance.now(),search=new BrowserSearch(state,async s=>s===state?raw:infer(s));
  const deadline=searchStartedAt+seconds*1000,continuousDeadline=maxSeconds===null?Infinity:streamStartedAt+maxSeconds*1000;let snapshot,lastUpdateAt=null;
  do{
    if(runGeneration!==generation)throw new DOMException('Analysis cancelled','AbortError');
    const remaining=maxVisits-search.rootVisits;
    snapshot=await search.advance(continuous?Math.min(8,remaining):Math.min(8,visits-search.rootVisits),{deadline:continuous?continuousDeadline:deadline,stopped:()=>runGeneration!==generation});
    const done=!continuous?(snapshot.mcts.root_visits>=visits||performance.now()>=deadline):(snapshot.mcts.root_visits>=maxVisits||performance.now()>=continuousDeadline);
    const result={...snapshot,...base(),raw_network:{policy:raw.policy82,win_probability:raw.win_probability,expected_score:raw.expected_score,score_min:raw.score_min,score_distribution:raw.score_distribution,territory_probabilities:raw.territory_probabilities},done,cumulative_elapsed_seconds:(performance.now()-streamStartedAt)/1000};
    const now=performance.now();
    // Coalesce very fast tactical batches so a continuous search does not
    // flood the UI with hundreds of renders per second. Always send the first
    // available snapshot and the final one.
    if(lastUpdateAt===null||done||now-lastUpdateAt>=200){reply(id,'update',result);lastUpdateAt=now;}
    if(done)break;
    if(continuous)await new Promise(resolve=>setTimeout(resolve,8));
  }while(runGeneration===generation);
  if(runGeneration!==generation)throw new DOMException('Analysis cancelled','AbortError');
  return {...snapshot,...base(),raw_network:{policy:raw.policy82,win_probability:raw.win_probability,expected_score:raw.expected_score,score_min:raw.score_min,score_distribution:raw.score_distribution,territory_probabilities:raw.territory_probabilities},done:true,cumulative_elapsed_seconds:(performance.now()-streamStartedAt)/1000};
}

onmessage=async event=>{
  const {id,type,value,options={}}=event.data||{};
  try{
    if(type==='cancel'){generation++;return;}
    if(type==='initialize'){generation++;reply(id,'update',{stage:'runtime',status:'loading'});reply(id,'result',await initialize(value,id));return;}
    if(type==='position'){reply(id,'result',await position(value));return;}
    if(!session)throw Error('Initialize the browser model first');
    if(type==='analyze'){const thisGeneration=++generation;reply(id,'result',await analyze(id,value,options,thisGeneration));return;}
    if(type==='close'){generation++;await session?.release?.();session=null;manifest=null;backend=null;reply(id,'result',true);return;}
    throw Error('Unknown local engine request');
  }catch(error){reply(id,'error',{name:error?.name||'Error',message:errorText(error)});}
};
