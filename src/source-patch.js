import {buildChangeSet,buildExpectedApplication} from './source-diff.js';
import {validateSourcePatch} from './source-application.js';
// Native persists the prepared plan on the existing Job before any AI runs.
export async function prepareSourceUpdate(project,selection,invoke,opId=crypto.randomUUID()) {
 const changes=buildChangeSet(project);
 if(selection.changeSetId!==changes.id||selection.baseContentToken!==changes.baseContentToken||selection.targetSnapshotId!==changes.targetSnapshotId)throw Error('原稿または漫画が変わりました。差分を選び直してください');
 if(!selection.selectedBlockIds?.length)throw Error('反映する原稿差分を選んでください');
 const expected=buildExpectedApplication(project,changes,selection.selectedBlockIds);
 const identity={workId:project.workId,opId,baseContentToken:project.contentToken,targetSnapshotId:project.active};
 const plan=await invoke('prepare_source_patch',{...identity,expected});
 return {identity,expected,plan};
}
export async function commitSourceUpdate(project,prepared,patch,invoke){
 if(project.workId!==prepared.identity.workId)throw Error('対象作品が変わりました');
 // A retry after a lost acknowledgement or Undo must reach the native receipt check.
 if(!project.sourcePatchReceipts?.[prepared.identity.opId])validateSourcePatch(project,prepared.expected,patch);
 return invoke('commit_source_patch',{...prepared.identity,patch});
}

// Legacy one-click drafting closes its completed scope through the same source
// transaction. Generation progress alone never marks text as applied.
export async function finalizeProducedSource(project,invoke){
 if(project.version<5)return project;
 const changes=buildChangeSet(project),scenes=new Set(project.draftScope?.sceneIds??project.snapshots.find(s=>s.id===project.active).scenes.map(s=>s.id));
 const selected=changes.blocks.filter(b=>b.kind==='insert'&&b.newRefs.every(r=>scenes.has(r.sceneId)));
 if(!selected.length)return project;
 const prepared=await prepareSourceUpdate(project,{changeSetId:changes.id,baseContentToken:changes.baseContentToken,targetSnapshotId:changes.targetSnapshotId,selectedBlockIds:selected.map(b=>b.id)},invoke);
 return commitSourceUpdate(project,prepared,{panels:project.panels,layout:project.layout,sourceApplication:{version:1,units:prepared.expected.afterUnits}},invoke);
}
