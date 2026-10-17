import {lineThrough,redEvaluation} from './study.mjs';
export function treeLayout(doc){
 const children=new Map(doc.nodes.map(n=>[n.id,[]]));for(const n of doc.nodes)if(n.parent!==null)children.get(n.parent).push(n);
 const placed=new Map();let row=0;
 function visit(n){const cs=children.get(n.id);let y;if(!cs.length)y=row++*47;else{const ys=cs.map(visit);y=ys[0];}placed.set(n.id,{...n,x:54+n.ply*70,y});return y;}
 visit(doc.nodes[0]);const nodes=doc.nodes.map(n=>placed.get(n.id));return {nodes,edges:nodes.filter(n=>n.parent!==null).map(n=>({parent:n.parent,child:n.id,from:placed.get(n.parent),to:n})),width:Math.max(800,110+Math.max(...nodes.map(n=>n.ply))*70),height:Math.max(65,row*47+20)};
}
export function timelineSvg(doc,analysisFor,mode='win'){
 const l=treeLayout(doc),line=lineThrough(doc,doc.selected),selected=new Set(line.map(n=>n.id)),x=p=>54+p*70;
 const points=line.map(n=>({n,v:redEvaluation(analysisFor(n),doc.setup.komi)})),score=mode==='score';
 const max=Math.max(10,...points.map(p=>Math.abs(p.v.margin??0))),value=p=>score?p.v.margin:p.v.win,y=v=>score?80-v/max*52:132-v*104;
 let svg=`<svg width="${l.width}" height="${l.height+205}" viewBox="0 0 ${l.width} ${l.height+205}" role="group" aria-label="선택 가지 평가와 수순 분기 트리"><line x1="34" x2="${l.width-20}" y1="80" y2="80" stroke="#d7dee6" stroke-dasharray="4 4"/><text x="10" y="32" class="axis-label">${score?max.toFixed(0):'100%'}</text><text x="10" y="84" class="axis-label">${score?'0':'50%'}</text><text x="10" y="136" class="axis-label">${score?'-'+max.toFixed(0):'0%'}</text>`;
 let prev=null;for(const p of points){const v=value(p);if(v!==null){if(prev)svg+=`<line x1="${x(prev.n.ply)}" y1="${y(value(prev))}" x2="${x(p.n.ply)}" y2="${y(v)}" stroke="#ce8062" stroke-width="2.5"/>`;svg+=`<circle cx="${x(p.n.ply)}" cy="${y(v)}" r="3.5" fill="#ce8062"/>`;prev=p;}else prev=null;svg+=`<g data-node="${p.n.id}" tabindex="0" role="button" aria-label="${p.n.ply}수로 이동"><rect x="${x(p.n.ply)-25}" y="20" width="50" height="130" fill="transparent"/><text x="${x(p.n.ply)}" y="164" text-anchor="middle" class="axis-label">${p.n.ply}수</text></g>`;}
 svg+=`<line x1="${x(doc.nodes.find(n=>n.id===doc.selected).ply)}" x2="${x(doc.nodes.find(n=>n.id===doc.selected).ply)}" y1="15" y2="175" stroke="#365969" stroke-opacity=".25"/>`;
 if(!points.some(p=>value(p)!==null))svg+='<text x="340" y="60" text-anchor="middle" class="axis-label">미분석 구간 · 아래에서 일괄 계산할 수 있어요</text>';
 for(const e of l.edges){const a=e.from,b=e.to;svg+=`<path d="M${a.x+23} ${a.y+211} C${a.x+36} ${a.y+211},${b.x-36} ${b.y+211},${b.x-23} ${b.y+211}" fill="none" stroke="${selected.has(b.id)?'#73918d':'#d8dfe6'}" stroke-width="${selected.has(b.id)?2:1.5}"/>`;}
 for(const n of l.nodes){const parent=doc.nodes.find(p=>p.id===n.parent),red=parent?.position?parent.position.side_to_move==='first':n.ply%2===1,color=n.parent===null?'#e4e9ed':red?'#ee6338':'#4173e6',label=n.action===null?'시작':n.action===81?'패스':`${Math.floor(n.action/9)+1}·${n.action%9+1}`;svg+=`<g data-node="${n.id}" tabindex="0" role="button" aria-label="${n.ply}수 ${label}"><rect x="${n.x-23}" y="${n.y+195}" width="46" height="32" rx="7" fill="${color}" stroke="${n.id===doc.selected?'#172e45':'none'}" stroke-width="3"/><text x="${n.x}" y="${n.y+215}" text-anchor="middle" fill="${n.parent===null?'#526474':'white'}" font-size="12" font-weight="650">${label}</text></g>`;}
 return svg+'</svg>';
}
