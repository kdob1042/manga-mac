import { sourceUnits } from './core.js';
import { layoutWarnings, layoutSplice, validateLayoutPatch, applyLayoutSplices } from './layout.js';
export const layoutSchema={type:'object',properties:{reason:{type:'string'},pages:{type:'array',items:{type:'object',properties:{id:{type:'string'},slots:{type:'array',items:{type:'object',properties:{id:{type:'string'},panelId:{type:'string'},points:{type:'array',minItems:4,maxItems:4,items:{type:'array',minItems:2,maxItems:2,items:{type:'number'}}},overflow:{type:'object',properties:{points:{type:'array',minItems:4,maxItems:4,items:{type:'array',minItems:2,maxItems:2,items:{type:'number'}}},z:{type:'integer',minimum:0,maximum:15}},required:['points'],additionalProperties:false}},required:['id','panelId','points'],additionalProperties:false}}},required:['id','slots'],additionalProperties:false}}},required:['reason','pages'],additionalProperties:false};
export function layoutBase(project){return JSON.stringify({layout:project.layout,active:project.active,panels:project.panels.map(({image,...p})=>p)});}
function scopeInfo(project,scope){const indexes=scope.map(id=>project.layout.pages.findIndex(p=>p.id===id));if(indexes.some((v,i)=>v<0||(i>0&&v!==indexes[i-1]+1))||!indexes.length)throw Error('対象ページがありません');const first=Math.min(...indexes),suffix=indexes.length===project.layout.pages.length-first&&indexes.every((v,i)=>v===first+i);return {first,suffix,whole:first===0&&suffix};}
export function validateProposal(project,proposal,scope,opId=null){
 if(!proposal||typeof proposal.reason!=='string'||proposal.reason.length>2000||!Array.isArray(proposal.pages))throw Error('AIのコマ割り応答が不正です');
 const {first,suffix,whole}=scopeInfo(project,scope),targets=project.layout.pages.slice(first,first+scope.length),ids=targets.flatMap(p=>p.slots.map(s=>s.panelId)).filter(Boolean),actual=proposal.pages.flatMap(p=>p.slots.map(s=>s.panelId));
 if(JSON.stringify(ids)!==JSON.stringify(actual))throw Error('AI案がコマの本文参照・読書順を変更しています');
 const pageIds=new Set(targets.map(p=>p.id)),slotIds=new Set(targets.flatMap(p=>p.slots.map(s=>s.id)));
 const stable=(kind,id,known)=>!opId||known.has(id)||id.startsWith(`layout:${opId}:`)?id:`layout:${opId}:${kind}:${id}`;
 const pages=proposal.pages.map(p=>({...p,id:stable('page',p.id,pageIds),slots:p.slots.map(s=>({...s,id:stable('slot',s.id,slotIds)}))}));
 const splice=layoutSplice(project,first,scope.length,pages),layout=validateLayoutPatch(project,project.panels,[splice]);
 const warnings=layoutWarnings({...layout,pages},project.panels.filter(p=>ids.includes(p.id)));if(warnings.length)throw Error(warnings.join(' / '));
 return {base:layoutBase(project),layout,reason:proposal.reason,scope,opId,replacementCount:pages.length,suffixPagination:suffix&&!whole};
}
export function adoptLayoutProposal(project,candidate){
 if(candidate.base!==layoutBase(project))throw Error('要求後に作品が変更されました。現在の版から再提案してください');
 const {first}=scopeInfo(project,candidate.scope),count=candidate.layout.pages.length-project.layout.pages.length+candidate.scope.length;
 const pages=candidate.layout.pages.slice(first,first+count),checked=validateProposal(project,{reason:candidate.reason,pages},candidate.scope,candidate.opId);
 if(JSON.stringify(checked.layout)!==JSON.stringify(candidate.layout))throw Error('対象外のページまたは画像配置が変更されています');
 return applyLayoutSplices(project,[layoutSplice(project,first,candidate.scope.length,pages)],'AIコマ割りを採用');
}
export async function proposeLayout(project,scope,instruction,ask){const effective=scope;const {first,suffix,whole}=scopeInfo(project,effective),pages=project.layout.pages.slice(first,first+effective.length),ids=new Set(pages.flatMap(p=>p.slots.map(s=>s.panelId))),panels=project.panels.filter(p=>ids.has(p.id));if(!panels.length)throw Error('対象ページにコマを割り当ててください');const prompt=JSON.stringify({task:`漫画のページ配置だけを提案。コマID、順序、本文、人物を保持。対象は連続した選択区間。区間内のページ数・割当は変更可能。前後の対象外ページは出力せず変更しない。各枠はページ内0〜1の時計回り凸四角形4頂点。ホーム枠は重ねない。枠破りが必要なときだけ overflow.points をホーム枠を含むページ内凸四角形で返す。overflow 同士の重なりは可。指定しなければ従来クリップ。文字量、テンポ、強調に応じ大小・横長・斜め境界を使う。空枠は作らない。画像・Blender・動画は生成しない。reasonに判断理由を短く記載。`,instruction,wholeWork:whole,suffixReplan:suffix&&!whole,pages,panels:panels.map(p=>({id:p.id,prompt:p.prompt,unitIds:p.unitIds,characterIds:p.characterIds})),sources:project.snapshots.filter(s=>panels.some(p=>p.snapshotId===s.id)).map(s=>({id:s.id,scenes:s.scenes.filter(scene=>panels.some(p=>p.sceneId===scene.id)).map(scene=>({id:scene.id,design:scene.design,units:sourceUnits(scene.id,scene.text).filter(unit=>panels.some(p=>p.unitIds?.includes(unit.id)))}))}))});return validateProposal(project,JSON.parse(await ask(prompt,layoutSchema)),effective,crypto.randomUUID());}
