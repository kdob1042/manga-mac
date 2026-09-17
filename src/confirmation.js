// One contiguous confirmation boundary protects the accepted prefix. It is not a per-page lock.
export function confirmedPageIndex(project) {
  const id=project.confirmedThroughPanelId;
  if(!id)return -1;
  const index=project.layout?.pages?.findIndex(page=>page.slots.some(slot=>slot.panelId===id))??-1;
  if(index<0)throw Error('確定境界のコマが現在のページ割当にありません。確定境界を戻してください');
  const page=project.layout.pages[index],last=page.slots.filter(s=>s.panelId!==null).at(-1)?.panelId;
  if(last!==id)throw Error('確定境界はページ末尾に置いてください');
  return index;
}
export function confirmThroughPage(project,pageIndex) {
  if(!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=project.layout.pages.length)throw Error('確定するページが不正です');
  const page=project.layout.pages[pageIndex],id=page.slots.filter(s=>s.panelId!==null).at(-1)?.panelId;
  if(!id)throw Error('コマがないページは確定できません');
  return {...project,confirmedThroughPanelId:id};
}
export function moveConfirmationBeforePage(project,pageIndex) {
  if(!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>project.layout.pages.length)throw Error('確定境界が不正です');
  if(pageIndex===0)return {...project,confirmedThroughPanelId:null};
  return confirmThroughPage(project,pageIndex-1);
}
export function confirmedPrefix(project) {
  const index=confirmedPageIndex(project);
  if(index<0)return {pageIndex:-1,pages:[],panelIds:[]};
  const pages=project.layout.pages.slice(0,index+1);
  return {pageIndex:index,pages,panelIds:pages.flatMap(p=>p.slots.map(s=>s.panelId).filter(Boolean))};
}
export function assertConfirmedPrefixUnchanged(project,nextLayout) {
  const {pageIndex,pages}=confirmedPrefix(project);
  if(pageIndex<0)return;
  if(JSON.stringify(nextLayout.pages.slice(0,pageIndex+1))!==JSON.stringify(pages))throw Error('確定済みページは変更できません。先に確定境界を戻してください');
}
