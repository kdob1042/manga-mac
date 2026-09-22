import {refreshNameBindings} from './name-v2.js';
import {upgradeSourceProject,sealSnapshots,migrateSourceApplication} from './source-application.js';
import { invoke } from '@tauri-apps/api/core';
import { migrateProject } from './revisions.js';
import { restoreVideoResults } from './video-remote.js';
import {withResource,holdsResource} from './execution.js';
export const desktop = () => !!window.__TAURI_INTERNALS__;
export async function call(command, args = {}, permit=null) {
  if (!desktop()) throw Error('この操作はMacアプリで利用できます。ブラウザではサンプルの組版を確認できます。');
  if((command==='generate_image'||command==='generate_layers'||command==='prepare_engine'||command==='prepare_media_engine')&&!holdsResource(permit,'local-inference'))return withResource('local-inference',1,()=>invoke(command,args));
  return invoke(command, args);
}
export async function saveProject(project) {
  let normalized = await migrateProject(project);
  if(desktop()&&normalized.version<5)normalized=await upgradeSourceProject(normalized);
  if(normalized.version>=5){await sealSnapshots(normalized.snapshots);migrateSourceApplication(normalized);}
  normalized=await refreshNameBindings(normalized);
  if (desktop()) {
    await call('save_project', { data: JSON.stringify(normalized) });
    if(normalized.version>=5){const saved=await call('load_project');return migrateProject(JSON.parse(saved));}
  }
  else await idb('readwrite', store => store.put(normalized, 'project'));
  return normalized;
}
export async function loadProject() {
  const data = desktop() ? await call('load_project') : await idb('readonly', store => store.get('project'));
  if (!data) return null;
  let normalized = await migrateProject(typeof data === 'string' ? JSON.parse(data) : data, true);
  if(desktop()&&normalized.version<5){
    // Existing native save creates the pre-migration backup and commits once.
    // Do not expose the migrated UI state until the save has succeeded.
    normalized=await saveProject(await upgradeSourceProject(normalized));
  }
  normalized=await refreshNameBindings(normalized);
  const restored = restoreVideoResults(normalized);
  // Persist recovered artifact references before playback asks native storage for them.
  if (JSON.stringify(restored) !== JSON.stringify(normalized)) return saveProject(restored);
  return restored;
}
function idb(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('manga-mac', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('data');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('data', mode); const req = action(tx.objectStore('data')); tx.oncomplete = () => { resolve(req.result); db.close(); }; tx.onerror = () => { reject(tx.error); db.close(); }; };
  });
}
