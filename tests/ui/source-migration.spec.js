import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-v1.json',import.meta.url)));
test('startup migration saves once, preserves artwork and layout, and does not expose failed migration',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async legacy=>{
  const {loadProject}=await import('/src/bridge.js');const {migrateProject}=await import('/src/revisions.js');
  const before=await migrateProject(legacy);let stored=JSON.stringify(before),saves=0,fail=false;const original=stored;
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if(command==='load_project'){const p=JSON.parse(stored);if(p.version===5){p.workId='native-work';p.contentToken='native-token';}return JSON.stringify(p);}
   if(command==='save_project'){saves++;if(fail)throw Error('injected save failure');stored=args.data;return;}
   throw Error(command);
  }};
  const first=await loadProject(),second=await loadProject();
  const goodSaves=saves;stored=original;fail=true;let rejected=false;try{await loadProject();}catch(e){rejected=e.message==='injected save failure';}
  return {first,second,before,goodSaves,rejected,unchanged:stored===original};
 },legacy);
 expect(result.first.version).toBe(5);expect(result.first.workId).toBe('native-work');expect(result.first.contentToken).toBe('native-token');expect(result.goodSaves).toBe(1);expect(result.first).toEqual(result.second);
 expect(result.first.panels.map(p=>p.image)).toEqual(result.before.panels.map(p=>p.image));expect(result.first.layout).toEqual(result.before.layout);expect(result.rejected&&result.unchanged).toBe(true);
});
