/** Worker-owned, same-device local model, rules replay and MCTS adapter. */
const softmax=values=>{
  const max=Math.max(...values),weights=values.map(value=>Math.exp(value-max)),sum=weights.reduce((a,b)=>a+b,0);
  if(!Number.isFinite(sum)||sum<=0)throw Error('Model output cannot be normalized');
  return weights.map(value=>value/sum);
};

export function decodeNetworkHeads(outputs,{legalActions,scoreMin}){
  const {policy_logits,value_logit,score_logits,ownership_logits}=outputs||{};
  if(policy_logits?.length!==82||value_logit?.length!==1||!score_logits?.length||ownership_logits?.length!==243)throw Error('ONNX output dimensions do not match the practice head contract');
  const legal=[...new Set(legalActions)];
  if(!legal.length||legal.some(action=>!Number.isInteger(action)||action<0||action>81))throw Error('Position has no valid model actions');
  const policyProbs=softmax(legal.map(action=>policy_logits[action])),policy82=new Float32Array(82);
  legal.forEach((action,index)=>policy82[action]=policyProbs[index]);
  const logit=value_logit[0],winProbability=logit>=0?1/(1+Math.exp(-logit)):Math.exp(logit)/(1+Math.exp(logit));
  const scoreDistribution=softmax(Array.from(score_logits));
  const expectedScore=scoreDistribution.reduce((sum,p,index)=>sum+p*(scoreMin+index),0);
  const ownership=new Float32Array(243),territoryProbabilities=Array.from({length:81},(_,point)=>{
    const probs=softmax([ownership_logits[point],ownership_logits[81+point],ownership_logits[162+point]]);
    for(let channel=0;channel<3;channel++)ownership[channel*81+point]=probs[channel];
    return probs;
  });
  return {policy82:Array.from(policy82),value:2*winProbability-1,win_probability:winProbability,
    expected_score:expectedScore,score_min:scoreMin,score_distribution:scoreDistribution,
    ownership:Array.from(ownership),territory_probabilities:territoryProbabilities};
}

export class LocalEngine {
  constructor({workerUrl=new URL('./local-worker.mjs',import.meta.url)}={}){
    this.worker=new Worker(workerUrl,{type:'module'});this.nextId=1;this.pending=new Map();this.closed=false;
    this.worker.onmessage=event=>{const {id,type,value}=event.data||{},entry=this.pending.get(id);if(!entry)return;
      if(type==='update'){entry.onUpdate?.(value);return;}
      this.pending.delete(id);if(type==='error'){const error=Object.assign(Error(value?.message||'Local inference failed'),{name:value?.name||'Error'});entry.reject(error);}else entry.resolve(value);
    };
    this.worker.onerror=event=>{for(const entry of this.pending.values())entry.reject(Error(event.message||'Local worker failed'));this.pending.clear();};
  }
  _request(type,value,options,onUpdate){
    if(this.closed)return Promise.reject(Error('Local engine is closed'));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,onUpdate});this.worker.postMessage({id,type,value,options});});
  }
  initialize(manifest,onProgress=()=>{}){return this._request('initialize',manifest,{},onProgress);}
  position(payload){return this._request('position',payload);}
  analyze(payload,onUpdate=()=>{}, {signal,continuous=false}={}){
    if(signal?.aborted)return Promise.reject(new DOMException('Analysis cancelled','AbortError'));
    const promise=this._request('analyze',payload,{continuous},onUpdate);
    if(!signal)return promise;
    const cancel=()=>{this.cancel();};signal.addEventListener('abort',cancel,{once:true});
    return promise.finally(()=>signal.removeEventListener('abort',cancel));
  }
  cancel(){if(this.closed)return;this.worker.postMessage({id:0,type:'cancel'});}
  async close(){if(this.closed)return;this.closed=true;this.worker.terminate();for(const entry of this.pending.values())entry.reject(Error('Local engine closed'));this.pending.clear();}
}
