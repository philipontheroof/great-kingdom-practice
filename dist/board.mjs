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

export function candidateOutcome(candidate,analysis=null) {
  if(!candidate)return null;
  if(candidate.proven_winner&&analysis?.perspective)return candidate.proven_winner===analysis.perspective?'win':'loss';
  if(analysis?.exact?.status==='immediate_win'&&candidate.visits>0)return 'win';
  if(candidate.q===1)return 'win';
  if(candidate.visits>0&&candidate.q===-1)return 'loss';
  return null;
}

export function candidateShare(candidate,analysis=null) {
  if(!candidate)return 0;
  if(analysis?.search_mode==='gumbel'&&typeof candidate.improved_policy==='number'&&Number.isFinite(candidate.improved_policy)){
    return candidate.improved_policy;
  }
  return typeof candidate.visit_share==='number'&&Number.isFinite(candidate.visit_share)?candidate.visit_share:0;
}

export function candidateRadius(share,maxShare,{hasProven=false,hasOwnership=false}={}){
  const ratio=maxShare>0?Math.max(0,Math.min(1,share/maxShare)):0;
  const minR=hasProven?15:11;
  const maxR=hasOwnership?21:23;
  return Number((minR+(maxR-minR)*Math.sqrt(ratio)).toFixed(1));
}

export function boardSvg(position,{actions=[],lastAction=null,analysis=null,showTerritory=true,showOwnership=false,showCandidates=false,showPV=false,showNumbers=true,readingMode=false,readingStartIndex=null}={}) {
  const nums=new Map(),readingNums=new Map();
  const splitIdx=readingMode&&Number.isInteger(readingStartIndex)?readingStartIndex:actions.length;
  actions.forEach((a,i)=>{
    if(a===null||a===81)return;
    const cell=a>=400?a-400:a>=100?a%100:a;
    if(a>=400){nums.delete(cell);readingNums.delete(cell);return;}
    if(readingMode&&i>=splitIdx){
      nums.delete(cell);
      readingNums.set(cell,i-splitIdx+1);
    }else{
      readingNums.delete(cell);
      nums.set(cell,i+1);
    }
  });
  const lastCell=(lastAction===null||lastAction===81)?null:(lastAction>=400?null:(lastAction>=100?(lastAction%100):lastAction));
  const isGumbel=analysis?.search_mode==='gumbel';
  const allVisited=(analysis?.mcts?.candidates||[]).filter(c=>c.visits>0);
  const nonPassVisited=allVisited.filter(c=>c.action!==81);
  const candidates=nonPassVisited.slice(0,8);
  if(nonPassVisited.length>8&&nonPassVisited[7]?.orbit_size>1){
    const rep=nonPassVisited[7].orbit_rep;
    for(let k=8;k<nonPassVisited.length&&k<16;k++){
      if(nonPassVisited[k].orbit_rep===rep)candidates.push(nonPassVisited[k]);
      else break;
    }
  }
  const maxShare=candidates.reduce((mx,c)=>Math.max(mx,candidateShare(c,analysis)),0)||1;
  const passCandidate=showCandidates?allVisited.find(c=>c.action===81):null;
  const passIsBest=Boolean(passCandidate&&allVisited[0]?.action===81);
  const ranks=new Map(candidates.map((c,i)=>[c.action,{...c,rank:i+1,isBest:allVisited[0]?.action===c.action}]));
  const extraProven=new Map();
  if(showCandidates){
    for(const c of allVisited){
      if(c.action!==81&&!ranks.has(c.action)&&candidateOutcome(c,analysis)!==null){
        extraProven.set(c.action,c);
      }
    }
  }
  const legal=new Set(position.legal_actions||[]),marks=new Set(position.terminal_marks||[]);
  const tacticalStatus=analysis?.exact?.status;
  const candidateActions=new Set((analysis?.mcts?.candidates||[]).map(c=>c.action));
  const isTacticalPrunedLoss=action=>{
    if(!showCandidates||!analysis?.mcts||!legal.has(action))return false;
    if(tacticalStatus==='proven_loss')return true;
    return tacticalStatus==='must_defend'&&candidateActions.size>0&&!candidateActions.has(action);
  };
  const pvMap=new Map();
  if(showPV&&analysis?.mcts?.principal_variation?.length){
    analysis.mcts.principal_variation.forEach((action,i)=>{
      if(action!==null&&action<81&&!pvMap.has(action)){
        const side=(analysis.perspective==='first')===(i%2===0)?'first':'second';
        pvMap.set(action,{step:i+1,side});
      }
    });
  }
  let svg=`<svg class="kingdom-board${readingMode?' reading-board':''}" viewBox="0 0 602 602" role="group" aria-label="그레이트 킹덤 9×9 판">
    <defs>
      <linearGradient id="redStone" x2="1" y2="1"><stop stop-color="#f78154"/><stop offset=".55" stop-color="#ee6338"/><stop offset="1" stop-color="#d84a20"/></linearGradient>
      <linearGradient id="blueStone" x2="1" y2="1"><stop stop-color="#5b8df8"/><stop offset=".55" stop-color="#4173e6"/><stop offset="1" stop-color="#295bcc"/></linearGradient>
      <linearGradient id="neutralStone" x2="1" y2="1"><stop stop-color="#f0f2f5"/><stop offset=".55" stop-color="#d8dde5"/><stop offset="1" stop-color="#b8c0cc"/></linearGradient>
      <filter id="castleShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-opacity=".28"/></filter>
    </defs><rect class="board-bg" x="22" y="22" width="558" height="558" rx="15" fill="#fffdf9" stroke="#dce2eb"/>`;
  for(let i=0;i<9;i++) {
    const p=69+i*58;
    svg+=`<text class="board-axis" x="${p}" y="15">${i+1}</text><text class="board-axis" x="10" y="${p+4}">${i+1}</text>`;
  }
  for(let i=0;i<81;i++) {
    const x=69+(i%9)*58,y=69+Math.floor(i/9)*58;
    const tile=tileLayers(position,i,showOwnership?analysis:null),rank=ranks.get(i),extra=extraProven.get(i);
    const territory=showTerritory?tile.territory:0;
    const fill=territory===1?'#98b7f7':territory===2?'#f4b497':'#f8fafc';
    const tileClass=territory===1?'territory-blue':territory===2?'territory-red':'empty';
    svg+=`<g class="board-cell${legal.has(i)?' playable':''}" data-action="${i}" role="button" tabindex="${legal.has(i)?0:-1}" aria-disabled="${!legal.has(i)}" aria-label="${Math.floor(i/9)+1}행 ${i%9+1}열${tile.castle===1?' 파란 성':tile.castle===2?' 빨간 성':tile.castle===3?' 중립 성':''}">
      <rect class="board-cell-frame" x="${x-27}" y="${y-27}" width="54" height="54" rx="6" fill="#e7ebf1"/>
      <rect class="board-cell-tile ${tileClass}" x="${x-24}" y="${y-24}" width="48" height="48" rx="4" fill="${fill}"/>`;
    if(tile.predictedOwner){const color=tile.predictedOwner===1?'#477def':tile.predictedOwner===2?'#ed764c':'#aab4c0';
      svg+=`<rect class="predicted-tile" x="${x-23}" y="${y-23}" width="46" height="46" rx="3" fill="${color}" fill-opacity="${tile.confidence.toFixed(3)}" stroke="${color}" stroke-dasharray="3 3"/><text class="ownership-number" x="${x}" y="${y+(showCandidates&&rank?18:4)}" fill="#18334b">${Math.round(tile.confidence*100)}%</text><title>${tile.predictedOwner===1?'파랑':tile.predictedOwner===2?'빨강':'미소유'} 예상 ${Math.round(tile.confidence*100)}%</title>`;
    }
    if(tile.castle) {
      const isReadingStone=readingMode&&readingNums.has(i);
      const stoneClass=readingMode?(isReadingStone?'reading-stone':'anchor-stone'):'';
      svg+=`<g${stoneClass?` class="${stoneClass}"`:''}><rect x="${x-24}" y="${y-24}" width="48" height="48" rx="4" fill="url(#${tile.castle===1?'blue':tile.castle===2?'red':'neutral'}Stone)" filter="url(#castleShadow)" opacity="${marks.has(i)?.58:1}"/>
      <circle cx="${x}" cy="${y}" r="14" fill="none" stroke="#172033" stroke-opacity=".18" stroke-width="1.5"/>`;
      if(isReadingStone)svg+=`<rect class="reading-stone-ring" x="${x-24}" y="${y-24}" width="48" height="48" rx="4" fill="none" stroke="#c084fc" stroke-width="2" stroke-dasharray="5 3"/>`;
      if(marks.has(i))svg+=`<path data-terminal="${i}" d="M${x-20} ${y-20}l40 40m0-40l-40 40" stroke="#ff3b30" stroke-width="8" stroke-linecap="round"/>`;
      if(showNumbers&&isReadingStone)svg+=`<text class="move-number reading-move-number" x="${x}" y="${y}" fill="${tile.castle===3?'#233042':'#fef08a'}">${readingNums.get(i)}</text>`;
      else if(showNumbers&&nums.has(i))svg+=`<text class="move-number" x="${x}" y="${y}" fill="${tile.castle===3?'#233042':'white'}">${nums.get(i)}</text>`;
      svg+=`</g>`;
      if(lastCell===i)svg+=`<rect class="last-move-ring" data-last="${i}" x="${x-27}" y="${y-27}" width="54" height="54" rx="6" fill="none" stroke="#172f48" stroke-width="2.5"/>`;
    } else if(showCandidates&&rank) {
      const outcome=candidateOutcome(rank,analysis);
      const share=candidateShare(rank,analysis);
      const r=candidateRadius(share,maxShare,{hasProven:Boolean(outcome),hasOwnership:Boolean(tile.predictedOwner)});
      const cy=y-(tile.predictedOwner?5:0);
      const gStatus=isGumbel?(rank.gumbel_status||(rank.isBest?'selected':'active')):null;
      const gClass=isGumbel?` gumbel${gStatus==='eliminated'?' gumbel-eliminated':gStatus==='finalist'?' gumbel-finalist':gStatus==='unconsidered'?' gumbel-unconsidered':''}`:'';
      const numSize=outcome?(r<17?'8.5':'9'):(r<13.5?'8.5':(r>=20?'10.5':'10'));
      svg+=`<circle cx="${x}" cy="${cy}" r="${r}" class="candidate-dot${gClass} ${rank.isBest?'best':''}${outcome==='win'?' proven-win':outcome==='loss'?' proven-loss':''}"/>`;
      if(outcome){
        svg+=`<text class="candidate-number${isGumbel?' gumbel':''} has-proven ${outcome}" style="font-size:${numSize}px" x="${x}" y="${cy-4}">${(share*100).toFixed(1)}%</text><text class="candidate-proven ${outcome}" x="${x}" y="${cy+9}">${outcome==='win'?'필승':'필패'}</text>`;
      }else{
        svg+=`<text class="candidate-number${isGumbel?' gumbel':''}" style="font-size:${numSize}px" x="${x}" y="${cy}">${(share*100).toFixed(1)}%</text>`;
      }
    } else if(showCandidates&&(extra||isTacticalPrunedLoss(i))) {
      const outcome=extra?candidateOutcome(extra,analysis):'loss';
      const cy=y-(tile.predictedOwner?5:0);
      svg+=`<circle cx="${x}" cy="${cy}" r="15" class="candidate-dot compact ${outcome==='win'?'proven-win':'proven-loss'}"/><text class="candidate-proven compact ${outcome}" x="${x}" y="${cy}">${outcome==='win'?'필승':'필패'}</text>`;
    }
    if(pvMap.has(i)) {
      const pv=pvMap.get(i);
      svg+=`<g class="pv-marker" aria-label="예상 ${pv.step}수"><circle cx="${x-13}" cy="${y-13}" r="10" fill="url(#${pv.side==='first'?'blue':'red'}Stone)" stroke="#ffffff" stroke-width="1.5" filter="url(#castleShadow)"/><text class="pv-step-number" x="${x-13}" y="${y-13}" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="10" font-weight="800">${pv.step}</text></g>`;
    }
    svg+='</g>';
  }
  if(position.result?.reason==='pass_score'){
    svg+=`<g class="pass-badge" pointer-events="none" aria-label="연속 패스 종국"><rect x="226" y="575" width="150" height="24" rx="12" fill="#1e293b" filter="url(#castleShadow)"/><text x="301" y="587" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="11.5" font-weight="750">연속 패스 · 종국</text></g>`;
  }else if(position.previous_move_was_pass){
    const passedBlue=position.side_to_move==='second';
    svg+=`<g class="pass-badge" pointer-events="none" aria-label="${passedBlue?'파란':'빨간'} 성 패스"><rect x="233" y="575" width="136" height="24" rx="12" fill="${passedBlue?'#4173e6':'#ee6338'}" filter="url(#castleShadow)"/><text x="301" y="587" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="11.5" font-weight="750">${passedBlue?'파란':'빨간'} 성 패스</text></g>`;
  }
  const showTacticalPassLoss=!passCandidate&&isTacticalPrunedLoss(81);
  if(passCandidate||showTacticalPassLoss){
    const passOutcome=passCandidate?candidateOutcome(passCandidate,analysis):'loss';
    const passShare=passCandidate?candidateShare(passCandidate,analysis):0;
    const label=passCandidate?`${passOutcome==='win'?'패스 필승':passOutcome==='loss'?'패스 필패':'패스'} ${(passShare*100).toFixed(1)}%`:'패스 필패';
    const w=passCandidate?(passOutcome?148:128):96,rx=580-w;
    const fill=passOutcome==='win'?'#15803d':passOutcome==='loss'?'#fee2e2':passIsBest?(isGumbel?'#4f46e5':'#327967'):(isGumbel?'#eef2ff':'#e0ece8');
    const stroke=passOutcome==='win'?'#fbbf24':passOutcome==='loss'?'#ef4444':passIsBest?(isGumbel?'#4338ca':'#327967'):(isGumbel?'#a5b4fc':'#b5cec4');
    const textFill=passOutcome==='win'?'#ffffff':passOutcome==='loss'?'#b91c1c':passIsBest?'#ffffff':(isGumbel?'#3730a3':'#2c5646');
    const ariaLabel=passCandidate?`패스 착수 비중 ${(passShare*100).toFixed(1)}%${passOutcome==='win'?' 필승':passOutcome==='loss'?' 필패':''}`:'패스 필패';
    svg+=`<g class="pass-candidate-badge${passOutcome==='win'?' proven-win':passOutcome==='loss'?' proven-loss':''}" pointer-events="none" aria-label="${ariaLabel}"><rect x="${rx}" y="575" width="${w}" height="24" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#castleShadow)"/><text x="${rx+w/2}" y="587" text-anchor="middle" dominant-baseline="central" fill="${textFill}" font-size="11" font-weight="750">${label}</text></g>`;
  }
  return svg+'</svg>';
}
