import {RULESET,canonicalD4State,legalActions,features,positionPayload,replayPosition,canonicalState,sampleD4Orientations,averageD4Evaluations,inverseTransformEvaluation} from './engine.mjs?v=28';
import {BrowserSearch} from './browser-search.mjs?v=29';
import {decodeNetworkHeads} from './local-client.mjs?v=29';

let ort=null,session=null,manifest=null,backend=null,generation=0,modelCacheSource='network',rawCacheHits=0,rawCacheMisses=0;
const rawCache=new Map(),treeCache=new Map(),MAX_RAW_CACHE=1024,MAX_TREE_CACHE=24;
function lruGet(map,key){if(!map.has(key))return undefined;const val=map.get(key);map.delete(key);map.set(key,val);return val;}
function lruSet(map,key,val,max){if(map.has(key))map.delete(key);map.set(key,val);while(map.size>max)map.delete(map.keys().next().value);}
async function cachedInfer(state,{d4Samples=1,force=false,exactOrientation=false}={}){
  const canonical=exactOrientation?{state,sym:0}:canonicalD4State(state);
  const {state:canon,sym:toCanon}=canonical;
  const key=`${manifest.model_id}:d4:${d4Samples}:${exactOrientation?'exact':'canonical'}:${canonicalState(canon)}`;
  if(force)rawCache.delete(key);
  let canonEval=lruGet(rawCache,key);
  if(canonEval){
    rawCacheHits++;
  }else{
    rawCacheMisses++;
    if(exactOrientation){
      canonEval=await infer(state);
    }else{
      const {chosenGroups}=sampleD4Orientations(state,d4Samples,Math.random,canonical);
      const groupEvals=[];
      for(const group of chosenGroups)groupEvals.push({eval:await infer(group.boardState),syms:group.syms});
      canonEval=averageD4Evaluations(groupEvals);
    }
    lruSet(rawCache,key,canonEval,MAX_RAW_CACHE);
  }
  return inverseTransformEvaluation(canonEval,toCanon);
}
function isAllFinite(values){
  for(let i=0;i<values.length;i++)if(!Number.isFinite(values[i]))return false;
  return true;
}
function runtimeStats(visitsPerSecond=null){
  const precision=manifest?.precision||manifest?.quantization||'FP32 (비양자화)';
  const quantized=Boolean(manifest?.quantization&&!/^fp32$/i.test(String(manifest.quantization)));
  return {
    backend,
    precision,
    quantized,
    wasm_threads:backend==='wasm'?(ort?.env?.wasm?.numThreads??1):null,
    model_cache:modelCacheSource,
    raw_cache_size:rawCache.size,
    raw_cache_max:MAX_RAW_CACHE,
    raw_cache_hits:rawCacheHits,
    raw_cache_misses:rawCacheMisses,
    tree_cache_size:treeCache.size,
    tree_cache_max:MAX_TREE_CACHE,
    visits_per_second:visitsPerSecond,
    server_inference:false,
  };
}
let inferenceLock=Promise.resolve();
function acquireInferenceLock(){
  let release;
  const nextLock=new Promise(resolve=>{release=resolve;});
  const currentLock=inferenceLock;
  inferenceLock=inferenceLock.then(()=>nextLock);
  return currentLock.then(()=>release);
}
const reply=(id,type,value)=>postMessage({id,type,value});
const errorText=e=>String(e?.message||e||'Browser model runtime failed');
const sha256=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');

async function cachedModel(url,expectedHash){
  const request=new Request(`${url}?sha256=${expectedHash}`),cache=globalThis.caches?await caches.open('gk-practice-onnx-v1'):null;
  let response=cache?await cache.match(request):null;
  if(response){const bytes=await response.clone().arrayBuffer();if(await sha256(bytes)!==expectedHash){await cache.delete(request);response=null;}else{modelCacheSource='cache';}}
  if(!response){modelCacheSource='network';response=await fetch(url,{cache:'no-cache',credentials:'same-origin'});if(!response.ok)throw Error(`ONNX model download failed (${response.status})`);const bytes=await response.clone().arrayBuffer();if(await sha256(bytes)!==expectedHash)throw Error('ONNX export SHA-256 does not match its manifest');if(cache)await cache.put(request,response.clone());}
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
  return {model_id:value.model_id,sha256:value.sha256,onnx_sha256:value.onnx_sha256,backend,stats:runtimeStats(null),
    message:backend==='webgpu'?'Browser local model ready · WebGPU':'Browser local model ready · WASM fallback'};
}

function tensor(array,dims){return new ort.Tensor('float32',array,dims);}
async function infer(state){
  const release=await acquireInferenceLock();
  try{
    const f=features(state),feeds={spatial:tensor(f.spatial,[1,12,9,9]),global_features:tensor(f.global_features,[1,3])};let out;
    try{out=await session.run(feeds);}catch(error){if(backend!=='webgpu')throw error;console.warn('WebGPU inference failed, attempting WASM fallback:',error);await fallbackToWasm();out=await session.run(feeds);}
    if(out.policy_logits.data.length!==82||out.value_logit.data.length!==1||out.score_logits.data.length!==manifest.shapes.score_logits[0]||out.ownership_logits.data.length!==243)throw Error('ONNX session returned unexpected output dimensions');
    if(!isAllFinite(out.policy_logits.data)||!isAllFinite(out.value_logit.data)||!isAllFinite(out.score_logits.data)||!isAllFinite(out.ownership_logits.data))throw Error('ONNX session returned a non-finite model output');
    return decodeNetworkHeads({policy_logits:out.policy_logits.data,value_logit:out.value_logit.data,
      score_logits:out.score_logits.data,ownership_logits:out.ownership_logits.data},
      {legalActions:legalActions(state),scoreMin:manifest.score_min});
  }finally{release();}
}

async function position(payload,state=replayPosition(payload)){
  const canonical=canonicalState(state),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  return {...positionPayload(state),state_id:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')};
}

async function analyze(id,payload,options,runGeneration){
  const streamStartedAt=performance.now(),state=replayPosition(payload),pos=await position(payload,state),visits=payload.visits??160,seconds=payload.seconds??2;
  if(!Number.isInteger(visits)||visits<1||visits>1600||!Number.isFinite(seconds)||seconds<.05||seconds>10)throw Error('Analysis budget is outside the supported range');
  const continuous=payload.continuous??options.continuous??false;
  if(typeof continuous!=='boolean')throw Error('continuous must be a boolean');
  const searchMode=payload.search_mode??'puct';
  if(searchMode!=='puct'&&searchMode!=='gumbel')throw Error('search_mode must be "puct" or "gumbel"');
  const d4Samples=payload.d4_samples??1;
  if(!Number.isInteger(d4Samples)||d4Samples<1||d4Samples>8)throw Error('d4_samples must be an integer between 1 and 8');
  let maxVisits=visits,maxSeconds=null;
  if(continuous){maxVisits=payload.max_visits??10_000_000;if(!Number.isInteger(maxVisits)||maxVisits<1||maxVisits>10_000_000)throw Error('Continuous visit limit must be 1–10,000,000 visits');
    // Optional wall-clock cap for continuous analysis and timed AI moves.
    if(payload.max_seconds!==undefined&&payload.max_seconds!==null){maxSeconds=payload.max_seconds;if(typeof maxSeconds!=='number'||!Number.isFinite(maxSeconds)||maxSeconds<.05||maxSeconds>3600)throw Error('Continuous time limit must be 0.05–3600 seconds');}}
  else if(Object.hasOwn(payload,'max_visits')||Object.hasOwn(payload,'max_seconds'))throw Error('max_visits/max_seconds are only valid for continuous analysis');
  const base=()=>({api_version:1,state_id:pos.state_id,position:pos,perspective:state.side_to_move,score_kind:'raw_territory_difference',search_mode:searchMode,d4_samples:d4Samples,budget:{visits,seconds},model:{id:manifest.model_id,sha256:manifest.sha256,label:manifest.source_model_label,feature_schema:manifest.feature_schema,ruleset_version:manifest.ruleset_version,score_min:manifest.score_min},execution:'browser',backend});
  if(state.result)return {...base(),source:'rule',raw_network:null,exact:{source:'rule',proven_winner:state.result.winner,status:'terminal',threats:[]},proven_winner:state.result.winner,recommended_action:null,mcts:{root_visits:0,root_win_probability:state.result.winner===state.side_to_move?1:0,candidates:[],principal_variation:[],elapsed_seconds:0},done:true,cumulative_elapsed_seconds:(performance.now()-streamStartedAt)/1000};
  // Keep the four raw heads available even when tactics bypass neural expansion.
  // BrowserSearch consumes this cached result for its root expansion.
  const v6=manifest.ruleset_version===RULESET;
  const targetCanonical=canonicalState(state),treeKey=`${manifest.model_id}:${searchMode}:d4-${d4Samples}:${pos.state_id}`;
  const force=Boolean(payload.force);
  if(force)treeCache.delete(treeKey);
  let cached=force?undefined:lruGet(treeCache,treeKey),raw,search;
  if(cached){
    raw=cached.raw;search=cached.search;search.started=performance.now();
  }else{
    let promoted=null;
    if(!force){
      const entries=[...treeCache.values()].reverse();
      for(const entry of entries){
        if(entry.search.modelId!==manifest.model_id||entry.search.searchMode!==searchMode||entry.search.samples!==d4Samples)continue;
        const sub=entry.search.findSubtree(targetCanonical);
        if(sub&&(!v6||!entry.search.shareD4)){promoted={node:sub,shared:entry.search.shared};break;}
      }
    }
    raw=await cachedInfer(state,{d4Samples,force});
    const evalFn=s=>s===state?raw:cachedInfer(s,{d4Samples,exactOrientation:v6&&d4Samples===1});
    search=promoted?BrowserSearch.fromNode(promoted.node,evalFn,{searchMode,rootSymmetryQuotient:true,v6,shared:promoted.shared}):new BrowserSearch(state,evalFn,{searchMode,rootSymmetryQuotient:true,v6});
    search.modelId=manifest.model_id;search.samples=d4Samples;
    lruSet(treeCache,treeKey,{search,raw},MAX_TREE_CACHE);
  }
  const initialVisits=search.rootVisits;
  const searchStartedAt=performance.now();
  const deadline=searchStartedAt+seconds*1000,continuousDeadline=maxSeconds===null?Infinity:searchStartedAt+maxSeconds*1000;let snapshot,lastUpdateAt=null;
  const currentVps=()=>{
    const elapsedSec=(performance.now()-searchStartedAt)/1000;
    const newVisits=search.rootVisits-initialVisits;
    return elapsedSec>0&&newVisits>0?newVisits/elapsedSec:0;
  };
  const totalBudget=continuous?maxVisits:visits;
  const gumbelBudget=(!continuous||payload.max_visits!==undefined)?totalBudget:null;
  const earlyStop=v6||totalBudget>=32;
  const chunkSize=d4Samples>1?1:8;
  do{
    if(runGeneration!==generation)throw new DOMException('Analysis cancelled','AbortError');
    const remaining=maxVisits-search.rootVisits;
    const minInit=search.root?1:2;
    const targetStep=Math.max(chunkSize,minInit);
    const stepVisits=continuous?Math.max(0,Math.min(targetStep,remaining)):Math.max(0,Math.min(targetStep,visits-search.rootVisits));
    snapshot=await search.advance(stepVisits,{deadline:continuous?continuousDeadline:deadline,stopped:()=>runGeneration!==generation,earlyStop,gumbelBudget});
    const earlyDone=(earlyStop||Boolean(search.root?.proof))&&search.shouldStopEarly();
    const done=earlyDone||(!continuous?(snapshot.mcts.root_visits>=visits||performance.now()>=deadline):(snapshot.mcts.root_visits>=maxVisits||performance.now()>=continuousDeadline));
    const vps=currentVps();
    const result={...snapshot,...base(),stats:runtimeStats(vps),raw_network:{policy:raw.policy82,win_probability:raw.win_probability,expected_score:raw.expected_score,score_min:raw.score_min,score_distribution:raw.score_distribution,territory_probabilities:raw.territory_probabilities},done,cumulative_elapsed_seconds:(performance.now()-streamStartedAt)/1000};
    const now=performance.now();
    // Coalesce very fast tactical batches so a continuous search does not
    // flood the UI with hundreds of renders per second. Always send the first
    // available snapshot and the final one.
    if(lastUpdateAt===null||done||now-lastUpdateAt>=200){reply(id,'update',result);lastUpdateAt=now;}
    if(done)break;
    if(continuous)await new Promise(resolve=>setTimeout(resolve,0));
  }while(runGeneration===generation);
  if(runGeneration!==generation)throw new DOMException('Analysis cancelled','AbortError');
  return {...snapshot,...base(),stats:runtimeStats(currentVps()),raw_network:{policy:raw.policy82,win_probability:raw.win_probability,expected_score:raw.expected_score,score_min:raw.score_min,score_distribution:raw.score_distribution,territory_probabilities:raw.territory_probabilities},done:true,cumulative_elapsed_seconds:(performance.now()-streamStartedAt)/1000};
}

onmessage=async event=>{
  const {id,type,value,options={}}=event.data||{};
  try{
    if(type==='cancel'){generation++;return;}
    if(type==='initialize'){
      generation++;
      rawCache.clear();treeCache.clear();rawCacheHits=0;rawCacheMisses=0;modelCacheSource='network';rawCacheHits=0;rawCacheMisses=0;modelCacheSource='network';
      const release=await acquireInferenceLock();
      try{
        reply(id,'update',{stage:'runtime',status:'loading'});
        reply(id,'result',await initialize(value,id));
      }finally{release();}
      return;
    }
    if(type==='position'){reply(id,'result',await position(value));return;}
    if(!session)throw Error('Initialize the browser model first');
    if(type==='analyze'){const thisGeneration=++generation;reply(id,'result',await analyze(id,value,options,thisGeneration));return;}
    if(type==='close'){
      generation++;
      rawCache.clear();treeCache.clear();rawCacheHits=0;rawCacheMisses=0;modelCacheSource='network';
      const release=await acquireInferenceLock();
      try{
        await session?.release?.();
        session=null;manifest=null;backend=null;
        reply(id,'result',true);
      }finally{release();}
      return;
    }
    throw Error('Unknown local engine request');
  }catch(error){reply(id,'error',{name:error?.name||'Error',message:errorText(error)});}
};
