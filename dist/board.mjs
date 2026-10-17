export function tileLayers(position,index,prediction=null) {
  const castle=position.board[index],territory=castle?0:position.territory[index];
  const probs=prediction?.raw_network?.territory_probabilities?.[index];
  let predictedOwner=0,confidence=0;
  if(!castle&&probs) {
    const own=probs[0]>=probs[1];
    predictedOwner=probs[2]>=Math.max(probs[0],probs[1])?3:(prediction.perspective==='first')===own?1:2;
    confidence=Math.max(...probs);
  }
  return {castle,territory,predictedOwner,confidence};
}

export function boardSvg(position,{actions=[],lastAction=null,analysis=null,showTerritory=true,showOwnership=false,showCandidates=false,showNumbers=true}={}) {
  const nums=new Map();actions.forEach((a,i)=>{if(a!==81)nums.set(a,i+1);});
  const candidates=(analysis?.mcts?.candidates||[]).filter(c=>c.action!==81).slice(0,8);
  const ranks=new Map(candidates.map((c,i)=>[c.action,{...c,rank:i+1}]));
  const legal=new Set(position.legal_actions||[]),marks=new Set(position.terminal_marks||[]);
  let svg=`<svg class="kingdom-board" viewBox="0 0 602 602" role="group" aria-label="그레이트 킹덤 9×9 판">
    <defs>
      <linearGradient id="redStone" x2="1" y2="1"><stop stop-color="#f78154"/><stop offset=".55" stop-color="#ee6338"/><stop offset="1" stop-color="#d84a20"/></linearGradient>
      <linearGradient id="blueStone" x2="1" y2="1"><stop stop-color="#5b8df8"/><stop offset=".55" stop-color="#4173e6"/><stop offset="1" stop-color="#295bcc"/></linearGradient>
      <linearGradient id="neutralStone" x2="1" y2="1"><stop stop-color="#f0f2f5"/><stop offset=".55" stop-color="#d8dde5"/><stop offset="1" stop-color="#b8c0cc"/></linearGradient>
      <filter id="castleShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-opacity=".28"/></filter>
    </defs><rect x="22" y="22" width="558" height="558" rx="15" fill="#fffdf9" stroke="#dce2eb"/>`;
  for(let i=0;i<9;i++) {
    const p=69+i*58;
    svg+=`<text class="board-axis" x="${p}" y="15">${i+1}</text><text class="board-axis" x="10" y="${p+4}">${i+1}</text>`;
  }
  for(let i=0;i<81;i++) {
    const x=69+(i%9)*58,y=69+Math.floor(i/9)*58;
    const tile=tileLayers(position,i,showOwnership?analysis:null),rank=ranks.get(i);
    const territory=showTerritory?tile.territory:0;
    const fill=territory===1?'#f4b497':territory===2?'#98b7f7':'#f8fafc';
    svg+=`<g class="board-cell${legal.has(i)?' playable':''}" data-action="${i}" role="button" tabindex="${legal.has(i)?0:-1}" aria-disabled="${!legal.has(i)}" aria-label="${Math.floor(i/9)+1}행 ${i%9+1}열${tile.castle===1?' 빨간 성':tile.castle===2?' 파란 성':tile.castle===3?' 중립 성':''}">
      <rect x="${x-27}" y="${y-27}" width="54" height="54" rx="6" fill="#e7ebf1"/>
      <rect x="${x-24}" y="${y-24}" width="48" height="48" rx="4" fill="${fill}"/>`;
    if(tile.predictedOwner){const color=tile.predictedOwner===1?'#ed764c':tile.predictedOwner===2?'#477def':'#aab4c0';
      svg+=`<rect class="predicted-tile" x="${x-23}" y="${y-23}" width="46" height="46" rx="3" fill="${color}" fill-opacity="${tile.confidence.toFixed(3)}" stroke="${color}" stroke-dasharray="3 3"/><text class="ownership-number" x="${x}" y="${y+(showCandidates&&rank?18:4)}" fill="#18334b">${Math.round(tile.confidence*100)}%</text><title>${tile.predictedOwner===1?'빨강':tile.predictedOwner===2?'파랑':'미소유'} 예상 ${Math.round(tile.confidence*100)}%</title>`;
    }
    if(tile.castle) {
      svg+=`<rect x="${x-24}" y="${y-24}" width="48" height="48" rx="4" fill="url(#${tile.castle===1?'red':tile.castle===2?'blue':'neutral'}Stone)" filter="url(#castleShadow)" opacity="${marks.has(i)?.58:1}"/>
      <circle cx="${x}" cy="${y}" r="14" fill="none" stroke="#172033" stroke-opacity=".18" stroke-width="1.5"/>`;
      if(marks.has(i))svg+=`<path data-terminal="${i}" d="M${x-20} ${y-20}l40 40m0-40l-40 40" stroke="#ff3b30" stroke-width="8" stroke-linecap="round"/>`;
      if(showNumbers&&nums.has(i))svg+=`<text class="move-number" x="${x}" y="${y}" fill="${tile.castle===3?'#233042':'white'}">${nums.get(i)}</text>`;
      if(lastAction===i)svg+=`<rect data-last="${i}" x="${x-27}" y="${y-27}" width="54" height="54" rx="6" fill="none" stroke="#172f48" stroke-width="2.5"/>`;
    } else if(showCandidates&&rank) {
      svg+=`<circle cx="${x}" cy="${y-(tile.predictedOwner?5:0)}" r="20" class="candidate-dot ${rank.rank===1?'best':''}"/><text class="candidate-number" x="${x}" y="${y-(tile.predictedOwner?5:0)}">${(rank.visit_share*100).toFixed(1)}%</text>`;
    }
    svg+='</g>';
  }
  return svg+'</svg>';
}
