import {buildChangeSet,buildExpectedApplication} from './source-diff.js';
import {buildAffectedScope} from './source-application.js';
import {intersect} from './source-refs.js';
// Mirror native scope only to group execution; native remains the acceptance gate.
export function sourceRunKeys(project,edits){
 const scope=buildAffectedScope(project,edits),units=project.sourceApplication.units;
 const anchors=units.filter(u=>edits.some(e=>e.beforeUnitId===u.id||e.afterUnitId===u.id));
 const neighborIds=project.panels.filter(p=>(p.sourceRefs??[]).some(r=>anchors.some(u=>intersect(r,u.source)))).map(p=>p.id);
 const pageIds=project.layout.pages.filter(p=>p.slots.some(s=>scope.contentPanelIds.includes(s.panelId)||neighborIds.includes(s.panelId))).map(p=>p.id);
 const context=scope.contextRefs;
 const readPanels=project.panels.filter(p=>(p.sourceRefs??[]).some(r=>context.some(c=>intersect(r,c)))).map(p=>p.id);
 return [...new Set([...scope.contentPanelIds,...readPanels].map(id=>`panel:${id}`).concat(pageIds.map(id=>`page:${id}`),edits.flatMap(e=>e.oldUnitIds.map(id=>`unit:${id}`)),edits.map(e=>`boundary:${e.beforeUnitId??''}:${e.afterUnitId??''}`)))];
}
export function sourceRunGroups(project,selection){
 const changes=buildChangeSet(project);
 if(selection.workId&&selection.workId!==project.workId||selection.changeSetId!==changes.id||selection.baseContentToken!==project.contentToken||selection.targetSnapshotId!==project.active)throw Error('原稿または作品が変わりました');
 buildExpectedApplication(project,changes,selection.selectedBlockIds);
 const groups=[];
 for(const block of changes.blocks.filter(b=>selection.selectedBlockIds.includes(b.id))){let group={blocks:[block],keys:sourceRunKeys(project,[block])};
  for(let i=groups.length-1;i>=0;i--)if(groups[i].keys.some(key=>group.keys.includes(key))){const other=groups.splice(i,1)[0];group={blocks:[...other.blocks,...group.blocks],keys:[...new Set([...other.keys,...group.keys])]};i=groups.length;}
  groups.push(group);
 }
 return groups.map(group=>({...group,selection:{...structuredClone(selection),workId:project.workId,selectedBlockIds:group.blocks.sort((a,b)=>changes.blocks.indexOf(a)-changes.blocks.indexOf(b)).map(b=>b.id)}}));
}
