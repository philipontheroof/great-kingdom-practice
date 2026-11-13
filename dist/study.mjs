export const FORMAT='gk-practice-v1';
export const RULESET='gk-v2.2';

export function newStudy(setup, position) {
  return {format:FORMAT,ruleset_version:RULESET,title:'새로운 연습',setup:{neutral:[4,4],komi:2.5,...setup},
    selected:'root',model_id:null,nodes:[{id:'root',parent:null,action:null,ply:0,notes:'',position,analysis:null}]};
}

export function pathTo(doc,id) {
  const map=new Map(doc.nodes.map(n=>[n.id,n]));
  const path=[],seen=new Set();let node=map.get(id);
  if(!node) throw Error('선택한 국면이 없습니다.');
  while(node.parent!==null) {
    if(seen.has(node.id)) throw Error('순환 분기입니다.');
    seen.add(node.id);path.push(node.action);node=map.get(node.parent);
    if(!node) throw Error('부모 국면이 없습니다.');
  }
  return path.reverse();
}

export function lineThrough(doc,id) {
  const map=new Map(doc.nodes.map(n=>[n.id,n])),ancestors=[];
  let node=map.get(id);
  if(!node)throw Error('선택한 국면이 없습니다.');
  while(node){ancestors.push(node);node=map.get(node.parent);}
  const line=ancestors.reverse();node=line.at(-1);
  for(let i=0;i<doc.nodes.length;i++){
    node=doc.nodes.find(n=>n.parent===node.id);if(!node)break;line.push(node);
  }
  return line;
}

export function addNode(doc,parent,action,position) {
  if(!Number.isInteger(action)||action<0||action>500) throw Error('잘못된 착수입니다.');
  const ancestor=doc.nodes.find(n=>n.id===parent);
  if(!ancestor) throw Error('부모 국면이 없습니다.');
  let child=doc.nodes.find(n=>n.parent===parent&&n.action===action);
  if(!child) {
    if(doc.nodes.length>=1000) throw Error('기보는 최대 1,000개 국면을 지원합니다.');
    const id=`n${Math.max(0,...doc.nodes.map(n=>Number(n.id.slice(1))||0))+1}`;
    child={id,parent,action,ply:ancestor.ply+1,notes:'',position,analysis:null};doc.nodes.push(child);
  }
  doc.selected=child.id;
  return child;
}

export function importDocument(value) {
  if(!value||value.format!==FORMAT||value.ruleset_version!==RULESET||!Array.isArray(value.nodes)||!value.nodes.length||value.nodes.length>1000)
    throw Error('지원하지 않는 연습 기보입니다.');
  const seen=new Set(),edges=new Set();
  value.nodes.forEach((node,i)=>{
    if(!node||typeof node.id!=='string'||!(/^[A-Za-z0-9_-]{1,64}$/).test(node.id)||seen.has(node.id))throw Error('중복되거나 잘못된 국면 ID입니다.');
    if(i===0?(node.parent!==null||node.action!==null):(!seen.has(node.parent)||!Number.isInteger(node.action)||node.action<0||node.action>500))throw Error('잘못된 분기 구조입니다.');
    const edge=JSON.stringify([node.parent,node.action]);if(edges.has(edge))throw Error('중복된 분기입니다.');
    edges.add(edge);seen.add(node.id);
  });
  if(!seen.has(value.selected))throw Error('선택한 국면이 없습니다.');
  return {...value,nodes:value.nodes.map(n=>({...n,analysis:null}))};
}

export function studyForSave(doc) {
  return {
    ...doc,
    nodes: doc.nodes.map(({analysis, position, ...node}) => ({
      ...node,
      board: position?.board,
      side_to_move: position?.side_to_move,
      result: position?.result ?? null
    }))
  };
}

export const requestKey=(node,model,visits,seconds)=>JSON.stringify([node,model,visits,seconds]);

export function blueEvaluation(analysis,komi) {
  if(!analysis)return {rawWin:null,win:null,rawScore:null,margin:null};
  const first=analysis.perspective==='first',raw=analysis.raw_network;
  const orient=p=>typeof p==='number'?Math.max(0,Math.min(1,first?p:1-p)):null;
  const rawScore=typeof raw?.expected_score==='number'?(first?1:-1)*raw.expected_score:null;
  const ruleMargin=analysis.position?.score?.blue_margin??(analysis.position?.score?analysis.position.score.blue-analysis.position.score.red-komi:null);
  return {rawWin:orient(raw?.win_probability),win:orient(analysis.mcts?.root_win_probability),
    rawScore,margin:analysis.source==='rule'&&analysis.position?.result?ruleMargin:rawScore===null?null:rawScore-komi};
}
