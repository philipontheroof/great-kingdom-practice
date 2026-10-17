import {lineThrough} from './study.mjs';
export class PracticeControls {
 constructor(){this.autoAnalysis=false;this.autoVisual=false;this.visible=false;this.ai='none';this.playing=false;this.epoch=0;}
 visualize(){this.visible=!this.visible;if(!this.visible)this.autoVisual=false;}
 invalidate(){this.epoch++;}
 begin(node,model,backend){return {epoch:++this.epoch,node,model,backend};}
 accepts(t,node,model,backend){return t.epoch===this.epoch&&t.node===node&&t.model===model&&t.backend===backend;}
 aiTurn(p){return this.playing&&!p.result&&(this.ai==='both'||this.ai===p.side_to_move);}
 shouldAnalyze(p){return !p.result&&(this.autoAnalysis||this.aiTurn(p));}
}
export function missingNodes(doc,scope='branch',backend=null){
 return (scope==='all'?doc.nodes:lineThrough(doc,doc.selected)).filter(n=>!n.analysis||(n.analysis.model&&n.analysis.model.id!==doc.model_id)||(backend&&n.analysis.backend!==backend));
}
