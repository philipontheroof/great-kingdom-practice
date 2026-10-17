import {studyForSave} from './study.mjs';

export const STORE='gk-practice-library-v1';

export function persistStudy(storage,doc,now=Date.now()) {
  const entries=JSON.parse(storage.getItem(STORE)||'[]');
  if(!Array.isArray(entries))throw Error('저장한 연습 목록을 읽을 수 없습니다.');
  storage.setItem(STORE,JSON.stringify([{...studyForSave(doc),updated_at:now},
    ...entries.filter(e=>e.storage_id!==doc.storage_id)]));
}

function wait(milliseconds,signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new DOMException('취소됨','AbortError'));
    const abort=()=>{clearTimeout(timer);reject(new DOMException('취소됨','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},milliseconds);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

export async function retryAnalysis(request,signal,{attempts=32,wait:delay=wait}={}) {
  for(let i=0;i<attempts;i++) {
    if(signal?.aborted)throw new DOMException('취소됨','AbortError');
    try{return await request();}
    catch(error){
      if(error.status!==429||i===attempts-1)throw error;
      await delay(400,signal);
    }
  }
}
