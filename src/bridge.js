import { invoke } from '@tauri-apps/api/core';
export const desktop = () => !!window.__TAURI_INTERNALS__;
export async function call(command, args = {}) {
  if (!desktop()) throw Error('この操作はMacアプリで利用できます。ブラウザではサンプルの組版を確認できます。');
  return invoke(command, args);
}
export async function saveProject(project) {
  if (desktop()) await call('save_project', { data: JSON.stringify(project) });
  else await idb('readwrite', store => store.put(project, 'project'));
}
export async function loadProject() {
  if (desktop()) { const data = await call('load_project'); return data ? JSON.parse(data) : null; }
  return idb('readonly', store => store.get('project'));
}
function idb(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('manga-mac', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('data');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('data', mode); const req = action(tx.objectStore('data')); tx.oncomplete = () => { resolve(req.result); db.close(); }; tx.onerror = () => { reject(tx.error); db.close(); }; };
  });
}
