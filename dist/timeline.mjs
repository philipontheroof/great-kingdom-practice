import {lineThrough,blueEvaluation} from './study.mjs';
export function treeLayout(doc){
 const children=new Map(doc.nodes.map(n=>[n.id,[]]));for(const n of doc.nodes)if(n.parent!==null)children.get(n.parent).push(n);
 const placed=new Map();let row=0;
 function visit(n){const cs=children.get(n.id);let y;if(!cs.length)y=row++*47;else{const ys=cs.map(visit);y=ys[0];}placed.set(n.id,{...n,x:54+n.ply*70,y});return y;}
 visit(doc.nodes[0]);const nodes=doc.nodes.map(n=>placed.get(n.id));return {nodes,edges:nodes.filter(n=>n.parent!==null).map(n=>({parent:n.parent,child:n.id,from:placed.get(n.parent),to:n})),width:Math.max(800,110+Math.max(...nodes.map(n=>n.ply))*70),height:Math.max(65,row*47+20)};
}
export function timelineSvg(doc,analysisFor,mode='win'){
 const l=treeLayout(doc),line=lineThrough(doc,doc.selected),selected=new Set(line.map(n=>n.id)),x=p=>54+p*70;
 const points=line.map(n=>({n,v:blueEvaluation(analysisFor(n),doc.setup.komi)})),score=mode==='score';
 const max=Math.max(10,...points.map(p=>Math.abs(p.v.margin??0))),value=p=>score?p.v.margin:p.v.win,y=v=>score?80-v/max*52:132-v*104;
 let svg=`<svg width="${l.width}" height="${l.height+205}" viewBox="0 0 ${l.width} ${l.height+205}" role="group" aria-label="선택 가지 평가와 수순 분기 트리"><line x1="34" x2="${l.width-20}" y1="80" y2="80" stroke="#d7dee6" stroke-dasharray="4 4"/><text x="12" y="32" class="axis-label" fill="#4173e6" font-weight="750">${score?`+${max.toFixed(0)}집`:'파랑'}</text><text x="12" y="84" class="axis-label" fill="#7a8795" font-weight="600">균형</text><text x="12" y="136" class="axis-label" fill="#ee6338" font-weight="750">${score?`-${max.toFixed(0)}집`:'빨강'}</text>`;
 let prev=null;for(const p of points){
  const v=value(p);
  if(v!==null){
   const currY=y(v);
   const currColor=currY<79?'#4173e6':currY>81?'#ee6338':'#8a9ba8';
   if(prev){
    const prevY=y(value(prev));
    const lineColor=(currY<80&&prevY<80)?'#4173e6':(currY>80&&prevY>80)?'#ee6338':'#b0bec5';
    svg+=`<line x1="${x(prev.n.ply)}" y1="${prevY}" x2="${x(p.n.ply)}" y2="${currY}" stroke="${lineColor}" stroke-width="2.5"/>`;
   }
   svg+=`<circle cx="${x(p.n.ply)}" cy="${currY}" r="4" fill="${currColor}" stroke="#ffffff" stroke-width="1.5"/>`;
   prev=p;
  }else prev=null;
  svg+=`<g data-node="${p.n.id}" tabindex="0" role="button" aria-label="${p.n.ply}수로 이동"><rect x="${x(p.n.ply)-25}" y="20" width="50" height="130" fill="transparent"/><text x="${x(p.n.ply)}" y="164" text-anchor="middle" class="axis-label">${p.n.ply}수</text></g>`;
 }
 svg+=`<line x1="${x(doc.nodes.find(n=>n.id===doc.selected).ply)}" x2="${x(doc.nodes.find(n=>n.id===doc.selected).ply)}" y1="15" y2="175" stroke="#365969" stroke-opacity=".25"/>`;
 if(!points.some(p=>value(p)!==null))svg+='<text x="340" y="60" text-anchor="middle" class="axis-label">미분석 구간 · 아래 한번에 다시 분석에서 계산할 수 있어요</text>';
 for(const e of l.edges){const a=e.from,b=e.to;svg+=`<path d="M${a.x+23} ${a.y+211} C${a.x+36} ${a.y+211},${b.x-36} ${b.y+211},${b.x-23} ${b.y+211}" fill="none" stroke="${selected.has(b.id)?'#73918d':'#d8dfe6'}" stroke-width="${selected.has(b.id)?2:1.5}"/>`;}
 for(const n of l.nodes){
  const parent=doc.nodes.find(p=>p.id===n.parent);
  const blue=parent?.position?parent.position.side_to_move==='first':n.ply%2===1;
  const a=n.action;
  const coord = c => `${Math.floor(c/9)+1}·${c%9+1}`;
  let label, color;
  if(n.parent===null){ label='시작'; color='#e4e9ed'; }
  else if(a===81){ label='패스'; color=blue?'#4173e6':'#ee6338'; }
  else if(a>=400){ label='제거 '+coord(a-400); color='#64748b'; }
  else if(a>=300){ label='중립 '+coord(a-300); color='#94a3b8'; }
  else if(a>=200){ label='빨강 '+coord(a-200); color='#ee6338'; }
  else if(a>=100){ label='파랑 '+coord(a-100); color='#4173e6'; }
  else { label=coord(a); color=blue?'#4173e6':'#ee6338'; }

  const rw = Math.max(46, label.length * 8.5 + 10);
  const rx = n.x - rw / 2;
  const hasNote = Boolean(n.notes && n.notes.trim().length > 0);
  svg+=`<g data-node="${n.id}" tabindex="0" role="button" aria-label="${n.ply}수 ${label}"><rect x="${rx}" y="${n.y+195}" width="${rw}" height="32" rx="7" fill="${color}" stroke="${n.id===doc.selected?'#172e45':'none'}" stroke-width="3"/><text x="${n.x}" y="${n.y+215}" text-anchor="middle" fill="${n.parent===null?'#526474':'white'}" font-size="${label.length > 4 ? 11 : 12}" font-weight="650">${label}</text>${hasNote ? `<circle cx="${rx+rw-4}" cy="${n.y+197}" r="4.5" fill="#f59e0b" stroke="#ffffff" stroke-width="1.5"/>` : ''}</g>`;
 }
 return svg+'</svg>';
}
