import {buildChangeSet,buildExpectedApplication} from './source-diff.js';
import {validateSourcePatch} from './source-application.js';
import {makeSourceCandidate} from './source-replan.js';
// Native persists the prepared plan on the existing Job before any AI runs.
export async function prepareSourceUpdate(project,selection,invoke,opId=crypto.randomUUID()) {
 const changes=buildChangeSet(project);
 if(selection.workId&&selection.workId!==project.workId)throw Error('対象作品が変わりました');
 if(selection.changeSetId!==changes.id||selection.baseContentToken!==changes.baseContentToken||selection.targetSnapshotId!==changes.targetSnapshotId)throw Error('原稿または漫画が変わりました。差分を選び直してください');
 if(!selection.selectedBlockIds?.length)throw Error('反映する原稿差分を選んでください');
 const expected=buildExpectedApplication(project,changes,selection.selectedBlockIds);
 const identity={workId:project.workId,opId,baseContentToken:project.contentToken,targetSnapshotId:project.active};
 const plan=await invoke('prepare_source_patch',{...identity,expected});
 return {identity,expected,plan,selection:structuredClone(selection)};
}
const signature=e=>JSON.stringify(['kind','oldUnitIds','newRefs','beforeUnitId','afterUnitId','targetStart'].map(key=>e[key]));
export function rebaseExpected(project,prepared){
 if(project.workId!==prepared.identity.workId||project.active!==prepared.identity.targetSnapshotId)throw Error('対象作品または原稿版が変わりました');
 const changes=buildChangeSet(project),selected=prepared.expected.sourceEdits.map(old=>changes.blocks.find(b=>signature(b)===signature(old)));
 if(selected.some(b=>!b))throw Error('対象範囲の依存が変わりました。候補を確認し、再計画してください');
 const expected=buildExpectedApplication(project,changes,selected.map(b=>b.id));
 // Generated panels keep their already verified immutable references/identities.
 const oldUnits=prepared.expected.afterUnits;
 expected.afterUnits=expected.afterUnits.map(u=>oldUnits.find(old=>JSON.stringify(old.source)===JSON.stringify(u.source))??u);
 return expected;
}
export async function refreshSourceCandidate(project,candidate,invoke){
 const old=candidate.prepared;
 if(project.workId!==old.identity.workId||project.active!==old.identity.targetSnapshotId)throw Error('対象作品または原稿版が変わりました');
 // Native validates the frozen read set even when only settings/references changed.
 const expected=rebaseExpected(project,old);
 const plan=await invoke('rebase_source_patch',{workId:project.workId,opId:old.identity.opId,baseContentToken:project.contentToken,expected});
 const prepared={...old,identity:{...old.identity,baseContentToken:project.contentToken},expected,plan};
 const ids=new Set(old.plan.scope.panelIds);
 const panels=project.panels.filter(p=>!ids.has(p.id)).concat(candidate.patch.panels.filter(p=>ids.has(p.id)||p.id.startsWith(`source:${old.identity.opId}:panel:`)));
 const updated=makeSourceCandidate(project,prepared,panels,candidate.redrawPanelIds,candidate.reason);
 // Unchanged content permits refreshing the native read set, not replanning the user's geometry.
 if (project.contentToken===old.identity.baseContentToken) updated.patch.layout=structuredClone(candidate.patch.layout);
 else if (candidate.nameConfirmed || candidate.manualLayout) throw Error('別の制作変更がありました。確定ネームを保持しています。対象範囲を再確認してください');
 return {...candidate,...updated};
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
