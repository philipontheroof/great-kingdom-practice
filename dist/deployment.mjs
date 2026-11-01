/** Static hosting uses only immutable files, never a game or inference API. */
const DEFAULT_BASE=new URL('./',import.meta.url);
function assetUrl(value,base){
 const url=new URL(value,base);
 if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||!['http:','https:','file:'].includes(url.protocol))throw Error('모델 파일이 현재 배포 경로 밖을 가리킵니다.');
 return url.href;
}
function modelAssetUrl(value,base,id){
 const url=new URL(value,base);
 if(url.origin===base.origin)return assetUrl(value,base);
 const match=typeof value==='string'&&value.match(/^https:\/\/raw\.githubusercontent\.com\/philipontheroof\/great-kingdom-practice\/[a-f0-9]{40}\/model-files\/([a-f0-9]{64})\/model\.onnx$/);
 if(!match||match[1]!==id)throw Error('모델 파일의 저장소·고정 버전·identity가 올바르지 않습니다.');
 return url.href;
}
async function jsonFile(url,fetchImpl){const response=await fetchImpl(url,{credentials:'same-origin'});if(!response.ok)throw Error('기기 내 실행 설정 파일을 불러오지 못했어요. 페이지를 새로고침해 주세요.');return response.json();}
export async function loadStaticConfig({base=DEFAULT_BASE,fetchImpl=fetch}={}){
 const config=await jsonFile(assetUrl('./config.json',base),fetchImpl);
 if(config.execution!=='browser'||!Array.isArray(config.models)||!config.models.length)throw Error('기기 내 실행 설정이 올바르지 않습니다.');
 return config;
}
export async function loadStaticManifest(config,id,{base=DEFAULT_BASE,fetchImpl=fetch}={}){
 const model=config.models.find(m=>m.id===id);if(!model?.manifest_url)throw Error('저장된 모델이 이 배포본에 없습니다. 사용할 모델을 직접 선택해 주세요.');
 const manifest=await jsonFile(assetUrl(model.manifest_url,base),fetchImpl);
 if(manifest.model_id!==id||manifest.sha256!==model.sha256||manifest.sha256!==id||manifest.assets?.model!==manifest.model_url)throw Error('선택한 모델의 manifest identity가 일치하지 않습니다.');
 const modelUrl=modelAssetUrl(manifest.model_url,base,id);
 return {...manifest,model_url:modelUrl,assets:Object.fromEntries(Object.entries(manifest.assets).map(([k,v])=>[k,k==='model'?modelUrl:assetUrl(v,base)]))};
}
