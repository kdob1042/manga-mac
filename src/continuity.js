import {recordNameEdit} from './name-v2.js';

export function effectiveContinuity(panel) {
  return panel?.continuityOverride ?? panel?.continuity ?? null;
}

export function setContinuityOverride(project,panelId,override) {
  const panel=project.panels.find(p=>p.id===panelId);
  if(!panel||panel.namePlanVersion!==2||project.namePlan?.status!=='adopted')throw Error('確定ネームのコマを選んでください');
  if(override!==null){
    if(!override||typeof override!=='object'||Array.isArray(override))throw Error('作画状態の指定が不正です');
    const validText=(value,max)=>value===undefined||typeof value==='string'&&value.length<=max;
    if(!['location','timeOfDay','storyIntent','spatial'].every(key=>validText(override[key],500))||!Array.isArray(override.characters)||override.characters.length>32||!Array.isArray(override.props)||override.props.length>16||!Array.isArray(override.hardConstraints)||override.hardConstraints.length>12)throw Error('作画状態の形式・長さが不正です');
    const charIds=new Set(panel.characterIds);
    if(new Set(override.characters.map(c=>c.id)).size!==override.characters.length||override.characters.some(c=>!charIds.has(c.id)||!['costume','visualState','emotion'].every(key=>validText(c[key],200))||!Array.isArray(c.holding)||c.holding.length>8||c.holding.some(x=>!validText(x,100)))||override.props.some(x=>!validText(x,120))||override.hardConstraints.some(x=>!validText(x,180)))throw Error('人物・持ち物の指定が不正です');
    if(override.previousPanelId!=null){const previous=project.panels.find(p=>p.id===override.previousPanelId);if(!previous||previous.sceneId!==panel.sceneId||project.panels.indexOf(previous)>=project.panels.indexOf(panel))throw Error('参照元は同じ場面の既出コマにしてください');}
  }
  const panels=project.panels.map(p=>p.id===panelId?(()=>{const next={...p};if(override===null)delete next.continuityOverride;else next.continuityOverride=structuredClone(override);return next})():p);
  return recordNameEdit(project,{...project,panels},override===null?'作画状態の固定解除':'作画状態を明示固定');
}
