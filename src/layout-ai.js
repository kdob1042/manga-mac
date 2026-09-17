import { sourceUnits } from './core.js';
import { validateLayout, layoutWarnings, changeLayout } from './layout.js';
export const layoutSchema={type:'object',properties:{reason:{type:'string'},pages:{type:'array',items:{type:'object',properties:{id:{type:'string'},slots:{type:'array',items:{type:'object',properties:{id:{type:'string'},panelId:{type:'string'},points:{type:'array',minItems:4,maxItems:4,items:{type:'array',minItems:2,maxItems:2,items:{type:'number'}}}},required:['id','panelId','points'],additionalProperties:false}}},required:['id','slots'],additionalProperties:false}}},required:['reason','pages'],additionalProperties:false};
export function layoutBase(project) {return JSON.stringify({layout:project.layout,active:project.active,panels:project.panels.map(({image,...p})=>p)});}
export function validateProposal(project,proposal,scope) {
  if(!proposal || typeof proposal.reason!=='string'||proposal.reason.length>2000||!Array.isArray(proposal.pages))throw Error('AIのコマ割り応答が不正です');
  const targets=project.layout.pages.filter(p=>scope.includes(p.id));
  if(targets.length!==scope.length || !targets.length)throw Error('対象ページがありません');
  const whole=scope.length===project.layout.pages.length;
  const ids=whole?project.panels.map(p=>p.id):targets.flatMap(p=>p.slots.map(s=>s.panelId)).filter(Boolean);
  const actual=proposal.pages.flatMap(p=>p.slots.map(s=>s.panelId));
  if(JSON.stringify(ids)!==JSON.stringify(actual))throw Error('AI案がコマの本文参照・読書順を変更しています');
  // Page-scoped proposals are local edits: reshape the current assignment only.
  if(!whole && (proposal.pages.length!==targets.length || proposal.pages.some((p,i)=>p.id!==targets[i].id)))throw Error('指定外のページ変更は採用できません');
  const layout={...project.layout,pages:whole?proposal.pages:project.layout.pages.map(p=>proposal.pages.find(x=>x.id===p.id)??p)};
  validateLayout(layout,project.panels);
  const warnings=layoutWarnings({...layout,pages:proposal.pages},project.panels.filter(p=>ids.includes(p.id)));
  if(warnings.length)throw Error(warnings.join(' / '));
  return {base:layoutBase(project),layout,reason:proposal.reason,scope};
}
export function adoptLayoutProposal(project,candidate) {
  if(candidate.base!==layoutBase(project))throw Error('要求後に作品が変更されました。現在の版から再提案してください');
  return changeLayout(project,candidate.layout,'AIコマ割りを採用');
}
export async function proposeLayout(project,scope,instruction,ask) {
  const pages=project.layout.pages.filter(p=>scope.includes(p.id)),ids=new Set(pages.flatMap(p=>p.slots.map(s=>s.panelId)));
  const panels=scope.length===project.layout.pages.length?project.panels:project.panels.filter(p=>ids.has(p.id));
  if(!panels.length)throw Error('対象ページにコマを割り当ててください');
  const prompt=JSON.stringify({task:'漫画のページ配置だけを提案。コマID、順序、本文、人物を保持。対象が全ページならページ数・ページ割当を変更可能。それ以外は現在ページのpanel割当・ページID・ページ数を保持し、形状だけを局所編集。各枠はページ内0〜1の時計回り凸四角形4頂点。枠を重ねない。文字量、テンポ、強調に応じ大小・横長・斜め境界を使う。座標は既存pagesと同形式。空枠は作らない。画像・Blender・動画は生成しない。reasonに判断理由を短く記載。',instruction,wholeWork:scope.length===project.layout.pages.length,pages,panels:panels.map(p=>({id:p.id,prompt:p.prompt,unitIds:p.unitIds,characterIds:p.characterIds})),sources:project.snapshots.filter(s=>panels.some(p=>p.snapshotId===s.id)).map(s=>({id:s.id,scenes:s.scenes.filter(scene=>panels.some(p=>p.sceneId===scene.id)).map(scene=>({id:scene.id,design:scene.design,units:sourceUnits(scene.id,scene.text).filter(unit=>panels.some(p=>p.unitIds.includes(unit.id)))}))}))});
  return validateProposal(project,JSON.parse(await ask(prompt,layoutSchema)),scope);
}
